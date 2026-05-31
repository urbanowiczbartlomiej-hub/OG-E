// @ts-check

// Fleet-save (FS) auto-detection — pure domain logic, no DOM, no storage,
// no `Date.now()`. Tests run in Node with zero mocks. Third sibling of
// `domain/waves.js` and `domain/adhoc.js`:
//
//   - waves    — auto-detected expedition return CLUSTERS, multi-ping series.
//   - ad-hoc   — individual rows the player marks ON PURPOSE, one ping.
//   - fleetSave — auto-detected from a SINGLE signal (a fleet whose total
//                 ship count crosses a threshold), multi-ping series.
//
// # Why a third kind
//
// A fleet save is always one big fleet (lots of ships) the player parks to
// keep it out of an incoming hostile fleet's way. The player wants a push
// BEFORE it lands (re-save in time) and, optionally, AFTER it lands (it is
// then sitting vulnerable — come re-save). So unlike ad-hoc (one ping
// `offsetSec` BEFORE arrival) the schedule is a SERIES of offsets RELATIVE
// to arrival, where a negative offset is before arrival, 0 is at arrival,
// and a positive offset is after — e.g. `[-600, 0, 600]` ⇒ 10 min before
// landing, at landing, and 10 min after.
//
// # Two gates: ship count AND flight time
//
// "Big fleet" alone over-fires: players routinely shuttle their whole fleet
// between a planet and its moon — a huge fleet, but a SHORT flight, and not a
// fleet-save. So a leg becomes an FS only when BOTH hold:
//
//   - `shipCount >= threshold`, and
//   - its flight TIME is at least `minFlightSec` (server-speed dependent, so
//     configurable; default 10 min).
//
// We don't have the departure time in the event list, so flight time is
// approximated by the time remaining at FIRST sight (`arrivalAt - now`): a
// short hop reads as short however early we observe it, and a long flight
// first observed late is the benign case (no prior reminder to keep, almost
// no time left to act).
//
// # The decision is LOCKED once made — never cancel a scheduled FS
//
// Crucially the flight-time gate runs ONLY when a leg is first classified.
// {@link reconcileFleetSaves} carries an already-known FS forward unchanged,
// so a long fleet-save observed again 2 minutes before landing — when the
// remaining time is now tiny — is NEVER reclassified as a short hop and its
// already-queued ntfy reminders are NEVER swept. The lock lives in the gist
// (the persisted `fleetSave` set), so it survives reloads and crosses
// devices.
//
// # Still non-cancellable + self-cleaning
//
// The player never arms or cancels an FS. An FS whose row has vanished (the
// fleet landed, or was recalled) is simply absent from the candidates, so it
// drops out of the reconcile and the ntfy queue reconcile sweeps its
// remaining future slots. This is the mechanism behind "once the fleet has
// landed and you're back in-game, the post-landing pings auto-cancel": being
// in-game runs the producer, the landed row is gone, its slots fall out and
// are swept. Pre-landing slots stay queued while the row is present, so an
// offline player still gets the warning.

/**
 * One fleet leg as read from the event list, before the threshold test.
 * DOM-derived (see `features/reminders/fsScan.js`) but a plain data shape so
 * this module stays DOM-free and Node-testable.
 *
 * @typedef {object} FleetSaveCandidate
 * @property {string} id         Event-row id (`eventRow-<n>`); the key.
 * @property {number} arrivalAt  Epoch SECONDS the leg arrives (`data-arrival-time`).
 * @property {number} shipCount  Total ships on the leg (from `detailsFleet`).
 * @property {string} label      Human description for the push body
 *   (e.g. `"Deployment → [4:478:14]"`), built at scan time from the row.
 */

/**
 * One detected fleet-save reminder, as persisted per-universe in the gist.
 *
 * @typedef {object} FleetSaveReminder
 * @property {string} id          Event-row identity (`eventRow-<n>`); the key.
 * @property {number} arrivalAt   Epoch SECONDS the leg arrives — the anchor the
 *   relative offsets are measured from.
 * @property {number} shipCount   Total ships (display only; explains the badge).
 * @property {string} label       Human description for the push body.
 * @property {number[]} offsetsSec Offsets (seconds) relative to `arrivalAt`:
 *   negative = before arrival, 0 = at arrival, positive = after. Sorted asc.
 * @property {number[]} fireAts   Derived absolute fire times (`arrivalAt + o`
 *   for each offset, same order). Stored so the scheduler doesn't recompute.
 */

/**
 * Parse the FS offsets setting — a comma-separated list of whole-second
 * offsets relative to arrival (e.g. `"-600,0,600"`). Tolerant of spaces, a
 * leading `+`, and a trailing comma. Drops non-integer tokens, de-dupes, and
 * sorts ascending so the fire order (and the resulting ntfy reconcile) is
 * stable.
 *
 * @param {string} str
 * @returns {number[]}
 */
export const parseFsOffsets = (str) => {
  /** @type {Set<number>} */
  const seen = new Set();
  for (const tok of String(str ?? '').split(',')) {
    const t = tok.trim();
    if (!t) continue;
    const n = Number(t);
    if (Number.isInteger(n)) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
};

/**
 * Reconcile the fleet-save set: carry forward already-classified saves,
 * newly classify qualifying candidates, and drop those whose row vanished.
 * Pure — returns fresh objects, never mutates the inputs, no `Date.now()`
 * (the caller injects `now`).
 *
 *   - **present, already FS** (`prev` has the id) → KEPT, with its
 *     arrival-derived fields refreshed (a redirect can move arrival; the
 *     player may have edited the offset schedule). The two gates are NOT
 *     re-applied — this is the lock that stops a late observation from
 *     cancelling a scheduled save (see the module header).
 *   - **present, not yet FS** → classified now: kept only if
 *     `shipCount >= threshold` AND flight time `(arrivalAt - now) >=
 *     minFlightSec`. `minFlightSec <= 0` disables the flight-time gate.
 *   - **absent** (`prev` id not among candidates) → dropped (landed /
 *     recalled), so its queue is swept.
 *
 * @param {FleetSaveReminder[]} prev  Previously-persisted FS set (the lock).
 * @param {FleetSaveCandidate[]} candidates  Own legs present this scan.
 * @param {object} opts
 * @param {number} opts.threshold    Minimum ship count to classify as FS.
 * @param {number[]} opts.offsetsSec Relative fire offsets (see {@link parseFsOffsets}).
 * @param {number} opts.minFlightSec Minimum flight time (s) for a NEW save.
 * @param {number} opts.now          Epoch SECONDS — first-sight reference.
 * @returns {FleetSaveReminder[]}
 */
export const reconcileFleetSaves = (prev, candidates, { threshold, offsetsSec, minFlightSec, now }) => {
  const known = new Map(prev.map((e) => [e.id, e]));
  /** @type {FleetSaveReminder[]} */
  const out = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.arrivalAt) || !Number.isFinite(c.shipCount)) continue;
    const locked = known.get(c.id);
    if (!locked) {
      // Classify a brand-new leg — BOTH gates apply, exactly once.
      if (c.shipCount < threshold) continue;
      if (minFlightSec > 0 && c.arrivalAt - now < minFlightSec) continue;
    }
    out.push({
      ...(locked ?? {}),
      id: c.id,
      arrivalAt: c.arrivalAt,
      shipCount: c.shipCount,
      label: c.label,
      offsetsSec,
      fireAts: offsetsSec.map((o) => c.arrivalAt + o),
    });
  }
  return out;
};

/**
 * Return a copy of `notify` containing only entries whose id still appears
 * in `entries`. Mirrors `domain/adhoc.pruneAdhocNotify` — keeps the gist
 * from accumulating dead bookkeeping for fleet-saves that have landed.
 *
 * @template T
 * @param {Record<string, T>} notify
 * @param {FleetSaveReminder[]} entries
 * @returns {Record<string, T>}
 */
export const pruneFsNotify = (notify, entries) => {
  const live = new Set(entries.map((e) => e.id));
  /** @type {Record<string, T>} */
  const next = {};
  for (const id of Object.keys(notify)) {
    if (live.has(id)) next[id] = notify[id];
  }
  return next;
};
