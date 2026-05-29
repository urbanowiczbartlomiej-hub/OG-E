// @ts-check

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
// arrival epoch; the reminder fires `offsetSec` BEFORE it.
//
// # Auto-cleanup when the row vanishes
//
// The player can't un-mark a row that's gone (recalled fleet, changed
// plan). So {@link reconcileAdhoc} drops any armed entry whose event id is
// no longer present in the live list. This is safe precisely because the
// fire time is at-or-before arrival (`offsetSec >= 0`):
//
//   - the leg ARRIVED → its row disappears at arrival, by which point the
//     ping (at arrival − offset) has already fired. Dropping cancels
//     nothing still pending.
//   - the leg was RECALLED early → its row disappears before arrival, so
//     the still-future ping SHOULD be cancelled. Dropping does exactly
//     that (the ntfy reconcile sweeps the now-unwanted message).
//
// Either way "absent ⇒ drop" is correct, and no grace window is needed
// (unlike waves, whose multi-ping schedule outlives the landing moment).
//
// The caller must only feed an AUTHORITATIVE present-set (a real, parsed
// event-list read — see the producer's `oge:eventBoxLoaded` gate). An
// empty list because nothing is in flight is authoritative and correctly
// drops everything; an empty list because the box hasn't loaded is NOT,
// and the producer must not call us in that state.

/**
 * One armed ad-hoc reminder, as persisted per-universe in the gist.
 *
 * @typedef {object} AdhocReminder
 * @property {string} id         Event-row identity (`eventRow-<n>`); the key.
 * @property {number} arrivalAt  Epoch SECONDS the leg arrives (`data-arrival-time`).
 * @property {number} offsetSec  Seconds BEFORE arrival to fire (>= 0). Captured
 *   at arm time so a later change to the global default doesn't move
 *   already-armed reminders.
 * @property {number} fireAt     Derived anchor: `arrivalAt - offsetSec`. Stored
 *   so the scheduler doesn't recompute it.
 * @property {string} label      Human description for the push body, built at
 *   arm time from the row (e.g. `"Expedition → [4:467:16]"`). Display only.
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
 * Recompute the fire anchor for an arrival + offset. Pure.
 *
 * @param {number} arrivalAt
 * @param {number} offsetSec
 * @returns {number}
 */
export const fireAtFor = (arrivalAt, offsetSec) => arrivalAt - offsetSec;

/**
 * Reconcile the armed ad-hoc reminders against the fleets currently
 * present in the event list.
 *
 *   - **present, same arrival** → keep unchanged.
 *   - **present, arrival changed** → reschedule: `fireAt =
 *     newArrival - offsetSec` (the player kept the same intent on a fleet
 *     whose timing moved — e.g. a redirect). `arrivalAt` is updated too.
 *   - **absent** → drop (landed: ping already fired; or recalled: ping
 *     should be cancelled — see the module header).
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
      entries.push({ ...e, arrivalAt, fireAt: fireAtFor(arrivalAt, e.offsetSec) });
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
