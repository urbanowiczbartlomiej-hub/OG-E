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
// # No user state ⇒ recompute each scan ⇒ non-cancellable + self-cleaning
//
// FS reminders are never armed or cancelled by the player: they are a pure
// function of the live event list + the threshold. The producer recomputes
// the whole set on every scan, so an FS whose row has vanished (the fleet
// landed, or was recalled) simply isn't recomputed, and the ntfy queue
// reconcile sweeps its remaining future slots. This is the mechanism behind
// "once the fleet has landed and you're back in-game, the post-landing pings
// auto-cancel": being in-game runs the producer, the landed row is gone, its
// future slots fall out of the live set and are swept. The pre-landing slots
// stay queued while the row is present, so an offline player still gets the
// warning.

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
 * Compute the fleet-save reminder set from the live candidates. Pure: a
 * function of the present event-list rows + the threshold + the offsets.
 * Re-run on every scan — survival is presence, so a vanished row drops out
 * (see the module header). Returns fresh objects, never mutates the input.
 *
 * @param {FleetSaveCandidate[]} candidates  Own legs with a ship count.
 * @param {object} opts
 * @param {number} opts.threshold    Minimum ship count to count as an FS.
 * @param {number[]} opts.offsetsSec Relative fire offsets (see {@link parseFsOffsets}).
 * @returns {FleetSaveReminder[]}
 */
export const computeFleetSaves = (candidates, { threshold, offsetsSec }) => {
  /** @type {FleetSaveReminder[]} */
  const out = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.arrivalAt) || !Number.isFinite(c.shipCount)) continue;
    if (c.shipCount < threshold) continue;
    out.push({
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
