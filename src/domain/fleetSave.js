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
// # Which leg counts (round-trip vs one-way)
//
// Round-trip missions (Transport, Espionage, Attack, …) show an OUTBOUND and
// a RETURN leg at send time; the fleet only lands back home on the return, so
// the outbound is skipped (see {@link isFleetSaveLeg} / {@link ONE_WAY_MISSIONS}).
// One-way missions (Deployment, Colonisation) keep their single outbound leg.
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
// first observed late is the benign case (no prior alarmClock to keep, almost
// no time left to act).
//
// # The decision is LOCKED once made — never cancel a scheduled FS
//
// Crucially the flight-time gate runs ONLY when a leg is first classified.
// {@link reconcileFleetSaves} carries an already-known FS forward unchanged,
// so a long fleet-save observed again 2 minutes before landing — when the
// remaining time is now tiny — is NEVER reclassified as a short hop and its
// already-queued ntfy alarmClock are NEVER swept. The lock lives in the gist
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

import { parseDurationList } from './duration.js';

/**
 * Total ship count parsed from a `detailsFleet` cell's text. OGame renders a
 * leg's total ships as a locale-formatted integer (e.g. `"8.256.872"`), so we
 * strip every non-digit and parse what's left — locale-independent. `NaN` when
 * the text carries no digits. The DOM read stays in the feature layer
 * (`features/alarmClock/fleetSaveScan`, `features/badges`); this is the shared
 * pure core both of them call, so the two counters can never drift.
 *
 * @param {string | null | undefined} text
 * @returns {number}
 */
export const shipCountFromText = (text) => {
  const digits = (text || '').replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : NaN;
};

/**
 * One fleet leg as read from the event list, before the threshold test.
 * DOM-derived (see `features/alarmClock/fleetSaveScan.js`) but a plain data shape so
 * this module stays DOM-free and Node-testable.
 *
 * @typedef {object} FleetSaveCandidate
 * @property {string} id         Event-row id (`eventRow-<n>`); the key.
 * @property {number} arrivalAt  Epoch SECONDS the leg arrives (`data-arrival-time`).
 * @property {number} shipCount  Total ships on the leg (from `detailsFleet`).
 * @property {string} label      Human description for the push body
 *   (e.g. `"Deployment → [4:478:14]"`), built at scan time from the row.
 * @property {string} [origin]      Launch coords, bracketed (push `{origin}`).
 * @property {string} [originName]  Launch body name (push `{originName}`).
 * @property {string} [target]      Mission-target coords (push `{target}`).
 * @property {string} [targetName]  Mission-target body name (push `{targetName}`).
 * @property {string} [landingKey]  Landing body identity (`g:s:p:type`) — where
 *   the leg lands (origin on a return, dest outbound). Feeds the landed-FS
 *   tracker so a vanished save can be flagged on the right body.
 */

/**
 * One detected fleet-save alarmClock, as persisted per-universe in the gist.
 *
 * @typedef {object} FleetSaveAlarmClock
 * @property {string} id          Event-row identity (`eventRow-<n>`); the key.
 * @property {number} arrivalAt   Epoch SECONDS the leg arrives — the anchor the
 *   relative offsets are measured from.
 * @property {number} shipCount   Total ships (display only; explains the badge).
 * @property {string} label       Human description for the push body.
 * @property {number[]} offsetsSec Offsets (seconds) relative to `arrivalAt`:
 *   negative = before arrival, 0 = at arrival, positive = after. Sorted asc.
 * @property {number[]} fireAts   Derived absolute fire times (`arrivalAt + o`
 *   for each offset, same order). Stored so the scheduler doesn't recompute.
 * @property {string} [origin]      Launch coords, bracketed (push `{origin}`).
 * @property {string} [originName]  Launch body name (push `{originName}`).
 * @property {string} [target]      Mission-target coords (push `{target}`).
 * @property {string} [targetName]  Mission-target body name (push `{targetName}`).
 * @property {string} [landingKey]  Landing body identity (`g:s:p:type`) — where
 *   the fleet lands; carried so the landed-FS tracker knows which body to flag.
 */

/**
 * Missions that do NOT auto-return: the fleet STAYS at the destination, so
 * its OUTBOUND arrival is the vulnerable landing a fleet-save alarmClock must
 * track.
 *
 *   4 = Deployment (Stacjonuj) — the fleet stations and stays.
 *   7 = Colonisation — the colony ship is consumed at the target.
 *
 * Every other mission is a ROUND-TRIP: OGame generates an outbound AND a
 * return leg at send time (e.g. Transport, Espionage). For those the fleet
 * only flies THROUGH the destination and lands back home on the RETURN leg,
 * so the outbound leg must not be treated as a fleet-save — otherwise we'd
 * schedule a alarmClock for a stop-over the fleet never pauses at.
 *
 * @type {Set<string>}
 */
const ONE_WAY_MISSIONS = new Set(['4', '7']);

/**
 * Whether a fleet leg is the one whose arrival a fleet-save alarmClock should
 * track:
 *
 *   - a RETURN leg always lands the fleet back home → yes;
 *   - an OUTBOUND leg only matters for a {@link ONE_WAY_MISSIONS} mission
 *     (the fleet stops and stays there). For a round-trip mission the
 *     outbound is a fly-through, so → no (its paired return leg is the one).
 *
 * Pure — the feature layer reads `data-mission-type` / `data-return-flight`
 * and feeds them here.
 *
 * @param {string} missionType  `data-mission-type` value (string).
 * @param {boolean} isReturn    `data-return-flight === 'true'`.
 * @returns {boolean}
 */
export const isFleetSaveLeg = (missionType, isReturn) =>
  isReturn || ONE_WAY_MISSIONS.has(missionType);

/**
 * Parse the FS offsets setting into whole-second offsets relative to
 * arrival. The setting is a comma-separated, minutes-first duration list
 * (e.g. `"-10m, 0m, 10m"` ⇒ `[-600, 0, 600]`); negatives are kept (before
 * landing). Just a thin signed wrapper over the shared duration grammar so
 * the FS field and the wave field parse identically — see
 * {@link parseDurationList} for the full token rules.
 *
 * @param {string} str
 * @returns {number[]}
 */
export const parseFsOffsets = (str) => parseDurationList(str, { signed: true });

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
 *     cancelling a scheduled save (see the module header). The lock also
 *     holds when EVERY offset has been cancelled: the entry is carried as
 *     an empty-series tombstone, so a cancelled, still-flying fleet can
 *     never be re-auto-classified and re-grow its alarmClock. (This is what
 *     lets the UI safely release such a row back to the ad-hoc toggle.)
 *   - **present, not yet FS** → classified now: kept only if
 *     `shipCount >= threshold` AND flight time `(arrivalAt - now) >=
 *     minFlightSec`. `minFlightSec <= 0` disables the flight-time gate.
 *   - **absent** (`prev` id not among candidates) → dropped (landed /
 *     recalled), so its queue is swept.
 *
 * @param {FleetSaveAlarmClock[]} prev  Previously-persisted FS set (the lock).
 * @param {FleetSaveCandidate[]} candidates  Own legs present this scan.
 * @param {object} opts
 * @param {number} opts.threshold    Minimum ship count to classify as FS.
 * @param {number[]} opts.offsetsSec Relative fire offsets (see {@link parseFsOffsets}).
 * @param {number} opts.minFlightSec Minimum flight time (s) for a NEW save.
 * @param {number} opts.now          Epoch SECONDS — first-sight reference.
 * @param {Record<string, number[]>} [opts.cancelledById] Per-id offsets the
 *   player has cancelled (see {@link fsOffsetsToCancel}). Those offsets are
 *   dropped from that save's series so the queue reconcile sweeps their ntfy
 *   messages while the rest of the series stays queued. Re-applied every scan
 *   (the suppression store outlives one sync), so a still-present fleet can't
 *   re-grow a cancelled slot.
 * @returns {FleetSaveAlarmClock[]}
 */
export const reconcileFleetSaves = (
  prev,
  candidates,
  { threshold, offsetsSec, minFlightSec, now, cancelledById = {} },
) => {
  const known = new Map(prev.map((e) => [e.id, e]));
  /** @type {FleetSaveAlarmClock[]} */
  const out = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.arrivalAt) || !Number.isFinite(c.shipCount)) continue;
    const locked = known.get(c.id);
    if (!locked) {
      // Classify a brand-new leg — BOTH gates apply, exactly once.
      if (c.shipCount < threshold) continue;
      if (minFlightSec > 0 && c.arrivalAt - now < minFlightSec) continue;
    }
    const cancelled = cancelledById[c.id];
    const eff = cancelled && cancelled.length
      ? offsetsSec.filter((o) => !cancelled.includes(o))
      : offsetsSec;
    out.push({
      ...(locked ?? {}),
      id: c.id,
      arrivalAt: c.arrivalAt,
      shipCount: c.shipCount,
      label: c.label,
      // Per-leg push metadata refreshed from the DOM each scan (the row is the
      // source of truth); overrides any stale locked value.
      origin: c.origin ?? '',
      originName: c.originName ?? '',
      target: c.target ?? '',
      targetName: c.targetName ?? '',
      landingKey: c.landingKey ?? locked?.landingKey ?? '',
      offsetsSec: eff,
      fireAts: eff.map((o) => c.arrivalAt + o),
    });
  }
  return out;
};

/**
 * How long before a fleet-save slot fires it becomes cancellable. The FS
 * alarmClock is a safety net, so cancelling is deliberately allowed only at the
 * last moment — when the player is clearly attending to this very arrival —
 * not hours ahead by accident.
 */
export const FS_CANCEL_WINDOW_SEC = 180;

/**
 * Whether a fleet-save still has a slot ahead of it. When every slot has
 * fired or been cancelled the series is SPENT: the badge releases the row
 * back to the ad-hoc toggle, while the persisted entry stays behind as an
 * empty-series lock (see {@link reconcileFleetSaves}) so the still-flying
 * fleet is never re-auto-classified. Pure.
 *
 * @param {{ fireAts: number[] }} fs
 * @param {number} now Epoch SECONDS.
 * @returns {boolean}
 */
export const hasUpcomingFsSlot = (fs, now) =>
  (fs.fireAts || []).some((t) => Number.isFinite(t) && t > now);

/**
 * The nearest still-upcoming slot of a fleet-save, but ONLY if it is inside
 * its final {@link FS_CANCEL_WINDOW_SEC}-second cancel window. Returns the
 * slot's `{ offset, fireAt }` or `null` (no upcoming slot, or the next one is
 * still further out than the window). Pure.
 *
 * @param {{ offsetsSec: number[], fireAts: number[] }} fs
 * @param {number} now Epoch SECONDS.
 * @returns {{ offset: number, fireAt: number } | null}
 */
export const nearestCancellableSlot = (fs, now) => {
  /** @type {{ offset: number, fireAt: number } | null} */
  let best = null;
  const fireAts = fs.fireAts || [];
  for (let i = 0; i < fireAts.length; i++) {
    const fireAt = fireAts[i];
    if (!Number.isFinite(fireAt) || fireAt <= now) continue;
    if (best === null || fireAt < best.fireAt) best = { offset: fs.offsetsSec[i], fireAt };
  }
  if (best === null) return null;
  return now >= best.fireAt - FS_CANCEL_WINDOW_SEC ? best : null;
};

/**
 * Which offsets a single cancel click removes. Normally just the chosen slot;
 * but if it is the LAST alarmClock before landing (the largest negative offset
 * still in the series), the player is in-game seeing it now, so every
 * at/after-landing alarmClock (offset ≥ 0) is pointless — they collapse too.
 * Pure.
 *
 * @param {number[]} offsetsSec  The save's current offsets.
 * @param {number} slotOffset    The offset being cancelled.
 * @returns {number[]} Offsets to suppress (includes `slotOffset`).
 */
export const fsOffsetsToCancel = (offsetsSec, slotOffset) => {
  const negatives = offsetsSec.filter((o) => o < 0);
  const lastPreLanding = negatives.length ? Math.max(...negatives) : null;
  if (slotOffset < 0 && slotOffset === lastPreLanding) {
    return offsetsSec.filter((o) => o === slotOffset || o >= 0);
  }
  return [slotOffset];
};

/**
 * Return a copy of `notify` containing only entries whose id still appears
 * in `entries`. Mirrors `domain/adhoc.pruneAdhocNotify` — keeps the gist
 * from accumulating dead bookkeeping for fleet-saves that have landed.
 *
 * @template T
 * @param {Record<string, T>} notify
 * @param {FleetSaveAlarmClock[]} entries
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

/**
 * How long a guardian DISMISS / ACK suppression record is retained after the
 * landing it silences. The exposed flag ITSELF has no timer — it clears only on
 * re-save, departure, or an explicit dismiss (see
 * {@link reconcileLandedFleetSaves}). This window merely bounds the local
 * dismiss/ack stores: it must outlive the gap between the user's tap and the
 * sync that drops the landing at the source, and (for ack) it snoozes the
 * one-shot escalation push. A couple of hours is ample.
 */
export const GUARDIAN_SUPPRESS_TTL_SEC = 120 * 60;

/**
 * How long after a fleet-save touches down its GUARDIAN escalation push fires,
 * if the fleet is still sitting exposed (no re-save, not dismissed). Hardcoded
 * for now — the fleet-save subtab will make it per-universe in a later step.
 */
export const GUARDIAN_INTERVAL_SEC = 20 * 60;

/**
 * A fleet-save that has LANDED — its event row is gone but we keep flagging the
 * body it sits on, exposed, until the fleet visibly moves or the user dismisses
 * it. There is deliberately NO expiry: the flag is durable, like a manual mark.
 *
 * @typedef {object} LandedFleetSave
 * @property {string} bodyKey   Landing body identity (`g:s:p:type`).
 * @property {number} landedAt  Epoch SECONDS the fleet landed (its `arrivalAt`).
 */

/**
 * Track fleet-saves that have just LANDED, so a passive consumer (the planet
 * markers) can flag "your fleet is sitting here, exposed" for a while AFTER the
 * row vanishes from the event list — the most dangerous moment, and the one we
 * otherwise lose all sight of. Pure; the caller injects `now`.
 *
 *   - A previously-known FS ({@link FleetSaveAlarmClock}) that is ABSENT from the
 *     current candidates and whose `arrivalAt <= now` just landed → recorded at
 *     its `landingKey`.
 *   - Existing landed entries are carried forward indefinitely — there is NO
 *     timer. An exposed flag is durable; it clears only on the explicit events
 *     below, mirroring a manual mark.
 *   - A body that now has a LIVE candidate landing there is in motion again →
 *     dropped (the live/"saving" state wins).
 *   - CLEAR: a body in `departingKeys` (an own outbound leg left it this scan)
 *     OR in `dismissedKeys` (the user dismissed/acked this landing away) is
 *     dropped at once. Dismissal drops it at the SOURCE so it never re-arms once
 *     the local dismiss record is pruned.
 *
 * Keyed by body — one (latest) landed entry per body.
 *
 * @param {LandedFleetSave[]} prevLanded   Previously-persisted landed set.
 * @param {FleetSaveAlarmClock[]} prevFs      Previous live FS set (disappearance source).
 * @param {FleetSaveCandidate[]} candidates FS candidates present this scan.
 * @param {object} opts
 * @param {number} opts.now         Epoch SECONDS.
 * @param {Set<string>} [opts.departingKeys] Body keys with an own outbound leg now.
 * @param {Set<string>} [opts.dismissedKeys] Body keys the user dismissed this scan.
 * @returns {LandedFleetSave[]}
 */
export const reconcileLandedFleetSaves = (
  prevLanded,
  prevFs,
  candidates,
  { now, departingKeys = new Set(), dismissedKeys = new Set() },
) => {
  const liveIds = new Set(candidates.map((c) => c.id));
  const liveLandingKeys = new Set(
    candidates.map((c) => c.landingKey).filter((k) => typeof k === 'string' && k !== ''),
  );
  /** @type {Map<string, LandedFleetSave>} */
  const byBody = new Map();

  // Carry every previously-landed body forward — no timer. The drop pass below
  // is the ONLY way out.
  for (const e of prevLanded) byBody.set(e.bodyKey, { bodyKey: e.bodyKey, landedAt: e.landedAt });

  // Newly-landed: a known FS gone from candidates whose arrival is past. Keep
  // the latest landing per body.
  for (const fs of prevFs) {
    if (!fs.landingKey || liveIds.has(fs.id)) continue;
    if (!Number.isFinite(fs.arrivalAt) || fs.arrivalAt > now) continue;
    const cur = byBody.get(fs.landingKey);
    if (!cur || fs.arrivalAt > cur.landedAt) {
      byBody.set(fs.landingKey, { bodyKey: fs.landingKey, landedAt: fs.arrivalAt });
    }
  }

  // A body live again (an FS landing there now), one the fleet visibly departed
  // from, or one the user dismissed is no longer a "landed, sitting" body.
  for (const key of [...byBody.keys()]) {
    if (liveLandingKeys.has(key) || departingKeys.has(key) || dismissedKeys.has(key)) {
      byBody.delete(key);
    }
  }

  return [...byBody.values()];
};
