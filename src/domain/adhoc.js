// @ts-check

import { parseDurationList } from './duration.js';

// Ad-hoc fleet-reminder domain logic — pure, no DOM, no storage, no
// `Date.now()`. Tests run in Node with zero mocks. Sibling of
// `domain/waves.js`; where waves are auto-detected expedition clusters,
// ad-hoc reminders are individual event-list rows the player marked ON
// PURPOSE (any mission, any direction — outbound or return).
//
// # Identity = the event-row id
//
// OGame's event list renders one `<tr class="eventFleet" id="eventRow-<n>">`
// per in-flight leg. That `<n>` is the *event* id — stable for the whole
// life of that leg and distinct from the *fleet* id (`data-fleet-id`,
// shared by a fleet's outbound + return legs). We key ad-hoc reminders by
// the event-row id, so the player marks a single LEG: "ping me when this
// fleet reaches its target" and "…when it gets home" are two separate,
// independently-armable rows. `data-arrival-time` on the row is the leg's
// arrival epoch — the anchor every reminder slot is measured from.
//
// # The schedule is per-server and applied LIVE (not frozen at arm time)
//
// Each armed entry stores only its IDENTITY + arrival anchor + the per-leg
// push metadata captured off the row (label / origin / target / ship count).
// The reminder CADENCE is the per-universe `adhocSchedule` — a signed
// offset list relative to arrival, in the SAME convention as fleet-save
// (`-` before, `0` at, `+` after arrival; `fireAt = arrivalAt + offset`).
// The producer resolves the schedule against each entry's `arrivalAt` on
// every scan ({@link adhocFireTimes}), so editing the schedule re-times all
// armed reminders — matching how waves and fleet-save read their offsets
// live. Nothing about the offsets is persisted on the entry.
//
// # Auto-cleanup when the row vanishes
//
// The player can't un-mark a row that's gone (recalled fleet, changed
// plan). So {@link reconcileAdhoc} drops any armed entry whose event id is
// no longer present in the live list:
//
//   - the leg ARRIVED → its row disappears at arrival. Before/at pings have
//     already fired; any AFTER-arrival pings already scheduled on ntfy still
//     fire if the player is away, and are swept if they're back in-game when
//     the row vanishes — exactly the fleet-save post-landing behaviour.
//   - the leg was RECALLED early → its row disappears before arrival, so the
//     still-future pings (before AND after) SHOULD be cancelled. Dropping
//     does exactly that (the ntfy reconcile sweeps the now-unwanted slots).
//
// Either way "absent ⇒ drop" is correct, and no grace window is needed
// (unlike waves, whose schedule is anchored to a return time we keep).
//
// The caller must only feed an AUTHORITATIVE present-set (a real, parsed
// event-list read — see the producer's `oge:eventBoxLoaded` gate). An
// empty list because nothing is in flight is authoritative and correctly
// drops everything; an empty list because the box hasn't loaded is NOT,
// and the producer must not call us in that state.

/**
 * One armed ad-hoc reminder, as persisted per-universe in the gist. Holds the
 * leg's identity + arrival anchor + the per-leg push metadata captured off the
 * row at arm time; the fire cadence is NOT stored here — it's the live
 * `adhocSchedule`, resolved against `arrivalAt` each scan ({@link adhocFireTimes}).
 *
 * @typedef {object} AdhocReminder
 * @property {string} id         Event-row identity (`eventRow-<n>`); the key.
 * @property {number} arrivalAt  Epoch SECONDS the leg arrives (`data-arrival-time`);
 *   the anchor every schedule offset is measured from.
 * @property {string} label      Human description for the push body, built at
 *   arm time from the row (e.g. `"Expedition → [4:467:16]"`). Display + body.
 * @property {string} [origin]      Launch coords, bracketed (push `{origin}`).
 * @property {string} [originName]  Launch body name (push `{originName}`).
 * @property {string} [target]      Mission-target coords (push `{target}`).
 * @property {string} [targetName]  Mission-target body name (push `{targetName}`).
 * @property {number} [shipCount]   Total ships on the leg (push `{shipCount}`).
 * @property {string} [fleetId]  OGame fleet id (`data-fleet-id`) — shared by a
 *   fleet's legs. Stored for future leg-linking / fleetSave auto-detect; not
 *   used for identity today.
 * @property {number} [createdAt] Epoch SECONDS the player armed it.
 */

/**
 * A fleet leg currently present in the event list, as extracted by the
 * feature layer. The minimum {@link reconcileAdhoc} needs to match.
 *
 * @typedef {object} PresentFleet
 * @property {string} id         Event-row id (`eventRow-<n>`).
 * @property {number} arrivalAt  Current `data-arrival-time` (epoch SECONDS).
 */

/**
 * Parse the per-universe ad-hoc schedule string into signed second offsets
 * relative to arrival (negative = before, 0 = at, positive = after). Same
 * grammar + convention as `domain/fleetSave.parseFsOffsets`. Pure.
 *
 * @param {string} str
 * @returns {number[]}  Sorted unique whole-second offsets.
 */
export const parseAdhocOffsets = (str) => parseDurationList(str, { signed: true });

/**
 * Resolve a schedule (signed arrival-relative offsets) to absolute fire times
 * for one entry: `arrivalAt + offset` for each offset. Pure — window clamping
 * (ntfy's 3-day cap) and past-slot skipping happen in the scheduler, not here.
 *
 * @param {number} arrivalAt    Epoch SECONDS the leg arrives.
 * @param {number[]} offsetsSec Signed offsets (see {@link parseAdhocOffsets}).
 * @returns {number[]}
 */
export const adhocFireTimes = (arrivalAt, offsetsSec) =>
  offsetsSec.map((o) => arrivalAt + o);

/**
 * Reconcile the armed ad-hoc reminders against the fleets currently
 * present in the event list.
 *
 *   - **present, same arrival** → keep unchanged.
 *   - **present, arrival changed** → update `arrivalAt` (a redirect moved the
 *     leg; the live schedule re-resolves against the new anchor downstream).
 *   - **absent** → drop (landed: before/at pings already fired; or recalled:
 *     still-future pings should be cancelled — see the module header).
 *
 * Pure: returns fresh objects, never mutates the input. No `now` needed —
 * presence, not time, decides survival. The schedulable-window (ntfy's
 * 3-day cap) is enforced by the scheduler/orchestration, not here.
 *
 * @param {AdhocReminder[]} prev
 * @param {PresentFleet[]} present
 * @returns {{ entries: AdhocReminder[], droppedIds: string[] }}
 */
export const reconcileAdhoc = (prev, present) => {
  /** @type {Map<string, number>} */
  const arrivalById = new Map();
  for (const f of present) arrivalById.set(f.id, f.arrivalAt);

  /** @type {AdhocReminder[]} */
  const entries = [];
  /** @type {string[]} */
  const droppedIds = [];

  for (const e of prev) {
    if (!arrivalById.has(e.id)) {
      droppedIds.push(e.id);
      continue;
    }
    const arrivalAt = /** @type {number} */ (arrivalById.get(e.id));
    if (arrivalAt === e.arrivalAt) {
      entries.push(e);
    } else {
      entries.push({ ...e, arrivalAt });
    }
  }

  return { entries, droppedIds };
};

/**
 * Return a copy of `notify` containing only entries whose id still
 * appears in `entries`. Mirrors `domain/waves.pruneNotifyState` — keeps
 * the gist from accumulating dead bookkeeping for dropped reminders.
 *
 * @template T
 * @param {Record<string, T>} notify
 * @param {AdhocReminder[]} entries
 * @returns {Record<string, T>}
 */
export const pruneAdhocNotify = (notify, entries) => {
  const live = new Set(entries.map((e) => e.id));
  /** @type {Record<string, T>} */
  const next = {};
  for (const id of Object.keys(notify)) {
    if (live.has(id)) next[id] = notify[id];
  }
  return next;
};
