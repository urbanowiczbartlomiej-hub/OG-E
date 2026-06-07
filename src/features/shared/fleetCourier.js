// @ts-check
//
// ISOLATED-world fleet courier — the one place that drives the game's
// two-step fleetdispatch form for every button (Exp / Col / Daily), so no
// feature re-implements the select → continue → check → mission → dispatch
// choreography.
//
// Division of labour:
//   • The PURE decision (which ships, is the mission allowed, what does an
//     error mean) is domain/fleetPlan.js.
//   • The actions the isolated world CANNOT do — selecting ships and
//     setting the target via window.fleetDispatcher — are delegated to the
//     MAIN-world bridge bridges/fleetExecutor.js over the oge:fd:cmd /
//     oge:fd:res event pair (names in lib/fleetProtocol.js).
//   • The native step controls that DO work from isolated (continue,
//     load-all-resources, dispatch) are clicked here directly.
//   • Target validation is read from the game's own checkTarget XHR via
//     the existing oge:checkTargetResult bridge; ship availability + the
//     orders map come from the oge:fleetDispatcher snapshot bridge.
//
// The "two intentional player taps" model the buttons implement:
//   tap 1 → select(order): selects the fleet on step 1; if the fleet can
//           be filled, advances to step 2, sets target+mission+resources,
//           and waits until the game marks the dispatch control ready
//           (#dispatchFleet without `.off`). Returns ok / a failure reason.
//   tap 2 → dispatch(): clicks the now-ready native dispatch control.
//
// readiness is read from the game's `.off` class, NOT a timer — which is
// why a too-early "send" can't lock the button: it simply isn't ready yet.

import { resolveSelection, classifyTargetError } from '../../domain/fleetPlan.js';
import { FD_CMD_EVENT, FD_RES_EVENT, FD_SEND_RESULT_EVENT } from '../../lib/fleetProtocol.js';
import { GAME } from '../../lib/gameDom.js';
import { safeClick, waitFor } from '../../lib/dom.js';

/** RPC reply timeout (MAIN executor is synchronous; this is a safety net). */
const RPC_TIMEOUT_MS = 4000;
/** How long to wait for the game's checkTarget response after setTarget. */
const CHECK_TARGET_TIMEOUT_MS = 8000;
/** How long to wait for step 2 to render after "continue". */
const STEP2_TIMEOUT_MS = 8000;
/** How long to wait for the dispatch control to become ready. */
const READY_TIMEOUT_MS = 8000;
/** How long to wait for the sendFleet result after a dispatch click. */
const SEND_RESULT_TIMEOUT_MS = 8000;
const POLL_MS = 100;

/**
 * @typedef {{ galaxy: number, system: number, position: number, type: number }} Target
 */

/**
 * A fleet order for {@link select}.
 *
 * @typedef {object} FleetOrder
 * @property {import('../../domain/fleetPlan.js').SelectionSpec} spec
 * @property {Target} target
 * @property {number} mission
 * @property {'all'} [resources]  load all resources on step 2 when set.
 */

/**
 * Outcome of {@link select}.
 *
 * @typedef {object} SelectResult
 * @property {boolean} ok
 * @property {'offPage'|'noShips'|'empty'|'selectFailed'|'noFleet2'|'timeout'
 *   |'noMoon'|'noShip'|'reserved'|'generic'|'mission'|'notReady'} [reason]
 * @property {number} [errorCode]
 * @property {Array<{ id: number, want: number, have: number }>} [shortfalls]
 */

// ─── module state ────────────────────────────────────────────────────────

/** Latest fleetDispatcher snapshot (ship availability + orders). */
let snapshot = /** @type {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot | null} */ (
  null
);
/** Monotonic RPC id. */
let rpcSeq = 0;
/** @type {((e: Event) => void) | null} */
let onSnapshot = null;
let installed = false;

// ─── step / readiness (pure DOM reads) ─────────────────────────────────────

/**
 * Which step of the fleetdispatch form we're on, from live DOM — so a
 * back-button or manual navigation is reflected immediately (no internal
 * step counter to desync).
 *
 * @returns {'off' | 'fleet1' | 'fleet2'}
 */
export const step = () => {
  if (document.querySelector(GAME.FD_DISPATCH)) return 'fleet2';
  if (document.querySelector(GAME.FD_FLEET1)) return 'fleet1';
  return 'off';
};

/**
 * Whether the native dispatch control exists AND the game has cleared its
 * not-ready `.off` class. This is the readiness signal the button gates
 * "send" on (replacing fragile timers).
 *
 * @returns {boolean}
 */
export const readyToDispatch = () => {
  const el = document.querySelector(GAME.FD_DISPATCH);
  return !!el && !el.classList.contains(GAME.FD_DISABLED_CLASS);
};

// ─── RPC to the MAIN executor ──────────────────────────────────────────────

/**
 * Send one command to the MAIN executor and await its reply. Resolves the
 * reply detail, or `null` on timeout.
 *
 * @param {string} op
 * @param {Record<string, any>} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, data?: any, error?: string } | null>}
 */
const rpc = (op, args = {}, timeoutMs = RPC_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const id = ++rpcSeq;
    let done = false;
    /** @param {{ ok: boolean, data?: any, error?: string } | null} val */
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener(FD_RES_EVENT, onRes);
      clearTimeout(timer);
      resolve(val);
    };
    /** @param {Event} e */
    const onRes = (e) => {
      const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
      if (d && d.id === id) finish(d);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    document.addEventListener(FD_RES_EVENT, onRes);
    document.dispatchEvent(new CustomEvent(FD_CMD_EVENT, { detail: { id, op, args } }));
  });

/**
 * Await the game's checkTarget result for `target`, ignoring stale results
 * for other coords. Resolves the detail or `null` on timeout.
 *
 * @param {Target} target
 * @returns {Promise<{ errorCode: number | null } | null>}
 */
const awaitCheckTarget = (target) =>
  new Promise((resolve) => {
    let done = false;
    /** @param {any} val */
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('oge:checkTargetResult', onCt);
      clearTimeout(timer);
      resolve(val);
    };
    /** @param {Event} e */
    const onCt = (e) => {
      const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
      if (
        d &&
        d.galaxy === target.galaxy &&
        d.system === target.system &&
        d.position === target.position
      ) {
        finish(d);
      }
    };
    const timer = setTimeout(() => finish(null), CHECK_TARGET_TIMEOUT_MS);
    document.addEventListener('oge:checkTargetResult', onCt);
  });

// ─── native step clicks (work from isolated) ───────────────────────────────

const clickContinue = () => safeClick(document.querySelector(GAME.FD_CONTINUE));
const clickAllResources = () =>
  safeClick(document.querySelector(GAME.FD_ALL_RESOURCES));

/**
 * Build an id→count availability map from the cached snapshot.
 *
 * @returns {Record<number, number>}
 */
const availability = () => {
  /** @type {Record<number, number>} */
  const map = {};
  const ships = snapshot && Array.isArray(snapshot.shipsOnPlanet)
    ? snapshot.shipsOnPlanet
    : [];
  for (const s of ships) {
    if (s && typeof s.id === 'number') map[s.id] = s.number || 0;
  }
  return map;
};

// ─── the two-tap surface ───────────────────────────────────────────────────

/**
 * Tap 1 — "Wybór". Select the fleet on step 1 and, if it can be filled,
 * walk through to a ready-to-send step 2. Pure decisions go through
 * domain/fleetPlan; ship/target setting goes through the MAIN executor;
 * validation is read from the game's own checkTarget.
 *
 * @param {FleetOrder} order
 * @returns {Promise<SelectResult>}
 */
export const select = async (order) => {
  if (step() === 'off') return { ok: false, reason: 'offPage' };

  const sel = resolveSelection(order.spec, availability());
  if (!sel.ok) {
    return {
      ok: false,
      reason: sel.requirementsMet ? 'empty' : 'noShips',
      shortfalls: sel.shortfalls,
    };
  }

  // Step 1: select ships via the MAIN controller, then advance to step 2.
  if (step() === 'fleet1') {
    const r = await rpc('selectShips', { ships: sel.selection });
    if (!r || !r.ok) return { ok: false, reason: 'selectFailed' };
    clickContinue();
    const onF2 = await waitFor(() => (step() === 'fleet2' ? true : null), {
      timeoutMs: STEP2_TIMEOUT_MS,
      intervalMs: POLL_MS,
    });
    if (!onF2) return { ok: false, reason: 'noFleet2' };
  }

  // Step 2: set the target (the game fires checkTarget), read the result.
  const ctPromise = awaitCheckTarget(order.target);
  await rpc('setTarget', order.target);
  const ct = await ctPromise;
  if (!ct) return { ok: false, reason: 'timeout' };

  const tag = classifyTargetError(ct.errorCode);
  if (tag !== 'ok') {
    return { ok: false, reason: tag, ...(ct.errorCode != null ? { errorCode: ct.errorCode } : {}) };
  }

  // Mission must be allowed for this target.
  const m = await rpc('selectMission', { mission: order.mission });
  if (!m || !m.ok) return { ok: false, reason: 'mission' };

  if (order.resources === 'all') clickAllResources();

  const ready = await waitFor(() => (readyToDispatch() ? true : null), {
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: POLL_MS,
  });
  if (!ready) return { ok: false, reason: 'notReady' };

  return { ok: true };
};

/**
 * Await the game's own sendFleet result (published by
 * bridges/sendFleetResultHook.js). Resolves `{ ok, errorCode }` — `ok` is
 * the server's `success` flag, so a 200-but-rejected send (e.g. no fuel)
 * resolves `{ ok:false, errorCode:140026 }`. Times out to `notReady`-style
 * `{ ok:false, reason:'timeout' }`.
 *
 * @returns {Promise<{ ok: boolean, errorCode?: number | null, reason?: string }>}
 */
const awaitSendResult = () =>
  new Promise((resolve) => {
    let done = false;
    /** @param {{ ok: boolean, errorCode?: number | null, reason?: string }} v */
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener(FD_SEND_RESULT_EVENT, onRes);
      clearTimeout(timer);
      resolve(v);
    };
    /** @param {Event} e */
    const onRes = (e) => {
      const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
      finish({ ok: !!(d && d.success), errorCode: d ? d.errorCode : null });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), SEND_RESULT_TIMEOUT_MS);
    document.addEventListener(FD_SEND_RESULT_EVENT, onRes);
  });

/**
 * Tap 2 — "Wysłanie". Click the now-ready native dispatch control and await
 * the game's sendFleet result. Resolves `{ ok:false, reason:'notReady' }`
 * without clicking when not ready, so an early tap can never fire a send.
 *
 * @returns {Promise<{ ok: boolean, errorCode?: number | null, reason?: string }>}
 */
export const dispatch = () => {
  if (!readyToDispatch()) return Promise.resolve({ ok: false, reason: 'notReady' });
  const result = awaitSendResult();
  safeClick(document.querySelector(GAME.FD_DISPATCH));
  return result;
};

// ─── lifecycle ─────────────────────────────────────────────────────────────

/**
 * Install the courier's snapshot listener. Idempotent. Most consumers just
 * import {@link select}/{@link dispatch}/{@link step}; calling this ensures
 * the ship-availability snapshot is cached.
 *
 * @returns {void}
 */
export const installFleetCourier = () => {
  if (installed) return;
  installed = true;
  onSnapshot = (e) => {
    snapshot = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
  };
  document.addEventListener('oge:fleetDispatcher', onSnapshot);
  // Seed from a live fleetDispatcher if readable (tests / Firefox Xray).
  if (!snapshot) {
    const fd = /** @type {any} */ (window).fleetDispatcher;
    if (fd && Array.isArray(fd.shipsOnPlanet)) {
      snapshot = /** @type {any} */ ({
        shipsOnPlanet: fd.shipsOnPlanet,
        orders: fd.orders || null,
        currentPlanet: fd.currentPlanet || null,
        targetPlanet: fd.targetPlanet || null,
      });
    }
  }
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetFleetCourierForTest = () => {
  if (onSnapshot) document.removeEventListener('oge:fleetDispatcher', onSnapshot);
  onSnapshot = null;
  snapshot = null;
  installed = false;
  rpcSeq = 0;
};
