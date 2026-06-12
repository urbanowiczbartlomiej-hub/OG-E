// @ts-check

// Pure planning core for the fleetdispatch buttons (Exp / Col / Daily).
// Zero DOM, timers, storage or chrome.* — plain functions over plain data,
// so the whole fleet-send decision surface is unit-testable without
// happy-dom. The impure half (driving the native fleetdispatch form,
// reading ship-availability labels, observing checkTarget) lives in
// features/shared/fleetCourier.js; this module only DECIDES.
//
// The two questions a button asks before it sends:
//
//   1. "Given the ships standing on this planet, can I fill the fleet I
//      need, and which exact ships do I select?" → resolveSelection().
//      A selection spec is either an explicit per-ship list with a
//      per-ship requirement fraction (Daily-micro: frac 1.0 = must have
//      all; Exp preset: frac 0.51 = send if ≥51% present), or "all"
//      (Daily-collect: take everything on the planet).
//
//   2. "Did the game accept this target+mission?" → isMissionAllowed()
//      reads the checkTarget `orders` map; classifyTargetError() turns a
//      checkTarget error code into a stable tag the button maps to a
//      label/colour (skip the target for Exp/Col, block for Daily — that
//      policy lives in the feature, not here).
//
// @see ../features/shared/fleetCourier.js — the impure form driver.
// @see ../bridges/checkTargetHook.js       — source of the error codes.
// @see ../bridges/fleetDispatcherSnapshot.js — source of orders/shipsOnPlanet.

/** checkTarget error: target has no moon (e.g. moon-only mission). */
export const ERR_NO_MOON = 140000;
/** checkTarget error: colonize attempted without a colony ship aboard. */
export const ERR_NO_COLONIZER = 140035;
/** checkTarget error: the slot is already reserved (colonize in flight). */
export const ERR_RESERVED = 140016;

/**
 * One ship requirement in an explicit selection list.
 *
 * @typedef {object} ShipReq
 * @property {number} id    OGame technology id (e.g. 202, 203, 208).
 * @property {number} qty   desired count to select.
 * @property {number} frac  requirement fraction 0..1: the req is "met"
 *   when `available >= frac * qty`. 0 ⇒ optional (always met); 1 ⇒ all.
 */

/**
 * A fleet selection spec.
 *
 * @typedef {(
 *   | { kind: 'list', ships: ShipReq[] }
 *   | { kind: 'all' }
 * )} SelectionSpec
 */

/**
 * The resolved outcome of {@link resolveSelection}.
 *
 * @typedef {object} SelectionResult
 * @property {boolean} ok                 requirements met AND something to send.
 * @property {boolean} requirementsMet    every required ship met its fraction.
 * @property {Array<{ id: number, count: number }>} selection  ships to set (>0).
 * @property {Array<{ id: number, want: number, have: number }>} shortfalls
 *   required ships that fell short (empty when requirementsMet).
 */

/**
 * Read an availability map for `id`, tolerating Map or plain object and a
 * missing/NaN entry (→ 0).
 *
 * @param {Map<number, number> | Record<number, number>} available
 * @param {number} id
 * @returns {number}
 */
const have = (available, id) => {
  const v =
    available instanceof Map ? available.get(id) : available[id];
  return typeof v === 'number' && v > 0 ? v : 0;
};

/**
 * Decide which ships to select for `spec` against the ships standing on
 * the planet. Pure.
 *
 * - `list`: for each req, select `min(qty, have)`; the req is met when
 *   `have >= frac*qty`. `ok` iff every req is met and the selection is
 *   non-empty.
 * - `all`: select every available ship at its full count; `ok` iff the
 *   selection is non-empty (nothing to send is not "ok").
 *
 * @param {SelectionSpec} spec
 * @param {Map<number, number> | Record<number, number>} available  id → count.
 * @returns {SelectionResult}
 */
export const resolveSelection = (spec, available) => {
  if (spec.kind === 'all') {
    /** @type {Array<{ id: number, count: number }>} */
    const selection = [];
    const entries =
      available instanceof Map
        ? [...available.entries()]
        : Object.entries(available).map(([k, v]) => [Number(k), v]);
    for (const [id, count] of /** @type {Array<[number, number]>} */ (entries)) {
      if (typeof count === 'number' && count > 0) selection.push({ id, count });
    }
    return {
      ok: selection.length > 0,
      requirementsMet: true,
      selection,
      shortfalls: [],
    };
  }

  /** @type {Array<{ id: number, count: number }>} */
  const selection = [];
  /** @type {Array<{ id: number, want: number, have: number }>} */
  const shortfalls = [];
  for (const req of spec.ships) {
    const h = have(available, req.id);
    const want = Math.ceil(req.frac * req.qty);
    if (h < want) shortfalls.push({ id: req.id, want, have: h });
    const count = Math.min(req.qty, h);
    if (count > 0) selection.push({ id: req.id, count });
  }
  const requirementsMet = shortfalls.length === 0;
  return {
    ok: requirementsMet && selection.length > 0,
    requirementsMet,
    selection,
    shortfalls,
  };
};

/**
 * Whether the checkTarget `orders` map permits `mission` on the current
 * target. The map keys are mission ids as strings (`orders['7'] === true`
 * ⇒ colonize allowed). Tolerates a null/absent map (→ false).
 *
 * @param {Record<string, boolean> | null | undefined} orders
 * @param {number} mission
 * @returns {boolean}
 */
export const isMissionAllowed = (orders, mission) =>
  !!orders && orders[String(mission)] === true;

/**
 * Whether every GENERAL fleet slot is in use (the game's "Floty: 37/37"
 * pair) — no fleet of any kind can launch until one returns. Pure over a
 * snapshot-shaped object so the courier, sendExp and tests share one
 * definition. `null`/absent snapshot ⇒ `false` (the gate is opt-in via
 * the bridge populating it), and `maxFleetCount > 0` guards the
 * uninitialised all-zeros snapshot from reading as "cap reached".
 *
 * @param {{ fleetCount?: number, maxFleetCount?: number } | null | undefined} counts
 * @returns {boolean}
 */
export const isFleetCapReached = (counts) => {
  if (!counts) return false;
  const max = counts.maxFleetCount ?? 0;
  const used = counts.fleetCount ?? 0;
  return max > 0 && used >= max;
};

/**
 * Turn a checkTarget error code into a stable tag. `null`/`0`/absent ⇒
 * `'ok'` (no error). Unknown non-zero codes ⇒ `'generic'`.
 *
 * @param {number | null | undefined} code
 * @returns {'ok' | 'noMoon' | 'noShip' | 'reserved' | 'generic'}
 */
export const classifyTargetError = (code) => {
  if (code == null || code === 0) return 'ok';
  switch (code) {
    case ERR_NO_MOON:
      return 'noMoon';
    case ERR_NO_COLONIZER:
      return 'noShip';
    case ERR_RESERVED:
      return 'reserved';
    default:
      return 'generic';
  }
};
