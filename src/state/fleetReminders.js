// Fleet reminders (FR) — the ONE per-body "a fleet is sitting here exposed,
// watch it" flag, shared by every FR surface: the planet badge
// (`features/badges`), the floating Fleet-reminder button
// (`features/alarmClock/guardian.js`) and the offline ntfy escalation push.
//
// UNIFIED (1.50): this store replaced the old two-set design (the producer's
// device-local auto `landedFleetSave` republish UNIONed with the user's synced
// manual marks). Both writers now land in the SAME entry map:
//
//   - AUTO — the alarmClock producer arms a body when a detected fleet-save
//     LANDS (its event row vanished past `arrivalAt`), stamping the entry with
//     the landing time itself (`ts = landedAt`). Using event time as the clock
//     makes the arm IDEMPOTENT across devices (both stamp the same landing the
//     same way) and lets a user's later dismiss (`ts = now > landedAt`) win.
//   - MANUAL — the fleet1 chip (`features/manualFsMark`) toggles a body with
//     `ts = now`.
//
// An entry is durable — NO expiry. It clears ONLY via the three explicit acts:
// the guardian's hold-to-dismiss, a successful guardian fleet-save send, or
// un-toggling the fleet1 chip. Deliberately NOT cleared by fleet activity:
// sending a fleet (even one that classifies as a fleet-save) used to auto-clear
// the watch, but a small "technical" send easily crosses the FS gates while 95%
// of the fleet still sits on the body — so automatic clearing is gone.
//
// CROSS-DEVICE: synced per universe through the user's gist via the
// `fleetRemindersPerUniverse` SYNC_SLOT — per-BODY last-writer-wins on `ts`,
// with `on: false` entries acting as tombstones so a dismiss propagates instead
// of being resurrected by a device still holding the arm (see
// sync/merge.mergeFleetReminders). Tombstones are GC'd after
// {@link FR_TOMBSTONE_TTL_SEC}. Every mutation takes a caller-supplied time —
// the module stays `Date.now()`-free for testability.
//
// Plain key-owner over `safeLS` (NO reactive store) — consumers pull on their
// own render cadence; mutation sites announce changes via the
// `FLEET_REMINDER_CHANGED_EVENT` DOM event instead. Per-origin localStorage =
// per-universe scoping (each OGame universe is its own subdomain).
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON slot of fleet-reminder entries. */
export const FLEET_REMINDERS_KEY = 'oge-fleet-reminders';

/**
 * How long a CLEARED entry (tombstone) is kept so the removal can still win
 * the cross-device merge, before it is GC'd from the slot. 30 days — far
 * beyond any realistic device-sync gap.
 */
export const FR_TOMBSTONE_TTL_SEC = 30 * 24 * 3600;

/**
 * @typedef {object} FleetReminderEntry
 * @property {boolean} on       Armed (`true`) or cleared tombstone (`false`).
 * @property {number} ts        Epoch SECONDS of the arming/clearing EVENT —
 *   the per-body last-writer-wins clock. For an auto arm this is the landing
 *   time itself; for a user act it is the tap time.
 * @property {number} [landedAt] Epoch SECONDS the fleet landed / was marked —
 *   display + escalation-push anchor. Present on armed entries.
 */

/**
 * @typedef {object} FleetReminderSlot
 * @property {Record<string, FleetReminderEntry>} marks  Keyed by bodyKey
 *   (`g:s:p:type`; type 1 = planet, 3 = moon).
 */

/** @param {*} v @returns {Record<string, FleetReminderEntry>} */
const cleanMarks = (v) => {
  /** @type {Record<string, FleetReminderEntry>} */
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [bodyKey, e] of Object.entries(v)) {
    if (!e || typeof e !== 'object') continue;
    const ts = Number(/** @type {any} */ (e).ts);
    if (!Number.isFinite(ts)) continue;
    /** @type {FleetReminderEntry} */
    const entry = { on: Boolean(/** @type {any} */ (e).on), ts };
    const landedAt = Number(/** @type {any} */ (e).landedAt);
    if (Number.isFinite(landedAt)) entry.landedAt = landedAt;
    out[bodyKey] = entry;
  }
  return out;
};

/**
 * Read the raw slot. Anything unreadable (including the pre-1.50
 * `oge-fleetsave-manual` era — deliberately NOT migrated) reads as empty.
 *
 * @returns {FleetReminderSlot}
 */
export const readFleetReminderSlot = () => {
  const v = /** @type {any} */ (safeLS.json(FLEET_REMINDERS_KEY, { marks: {} }));
  return { marks: cleanMarks(v?.marks) };
};

/**
 * Write the raw slot verbatim (the sync scheduler's `writeLocal`). GC of
 * expired tombstones happens in the merge, not here — a plain adopt must not
 * mutate what the merge decided.
 *
 * @param {FleetReminderSlot} slot
 * @returns {void}
 */
export const writeFleetReminderSlot = (slot) => {
  safeLS.setJSON(FLEET_REMINDERS_KEY, { marks: cleanMarks(slot?.marks) });
};

/**
 * The currently-ARMED reminders, as the display shape every surface consumes.
 * `landedAt` falls back to `ts` for entries that never carried one.
 *
 * @returns {Array<{ bodyKey: string, landedAt: number }>}
 */
export const readFleetReminders = () => {
  const { marks } = readFleetReminderSlot();
  return Object.entries(marks)
    .filter(([, e]) => e.on)
    .map(([bodyKey, e]) => ({ bodyKey, landedAt: e.landedAt ?? e.ts }));
};

/**
 * Is this body's reminder armed?
 *
 * @param {string} bodyKey `g:s:p:type`.
 * @returns {boolean}
 */
export const hasFleetReminder = (bodyKey) =>
  Boolean(readFleetReminderSlot().marks[bodyKey]?.on);

/**
 * Per-body LWW write: adopt `entry` only if it is newer than what the slot
 * holds. An EQUAL-`ts` entry is adopted only when it flips `on` — that keeps a
 * same-second chip toggle working while an identical re-arm (the producer
 * re-detecting the same landing) stays a no-op. Also GCs expired tombstones
 * (using `entry.ts` as "now" — every caller stamps a current-ish event time).
 * Returns whether the slot changed.
 *
 * @param {string} bodyKey
 * @param {FleetReminderEntry} entry
 * @returns {boolean}
 */
const putEntry = (bodyKey, entry) => {
  const { marks } = readFleetReminderSlot();
  const cur = marks[bodyKey];
  if (cur && (cur.ts > entry.ts || (cur.ts === entry.ts && cur.on === entry.on))) return false;
  marks[bodyKey] = entry;
  for (const [k, e] of Object.entries(marks)) {
    if (!e.on && e.ts < entry.ts - FR_TOMBSTONE_TTL_SEC) delete marks[k];
  }
  writeFleetReminderSlot({ marks });
  return true;
};

/**
 * Arm a body's reminder. For an AUTO arm pass the landing time as BOTH `at`
 * and `landedAt` — event-time stamping is what makes cross-device re-detection
 * of the same landing idempotent, and lets a later dismiss (stamped at tap
 * time) win over it. Returns whether anything changed (callers fire the
 * changed event / arm a sync upload only on `true`).
 *
 * @param {string} bodyKey  `g:s:p:type`.
 * @param {number} at       Epoch seconds of the arming event (LWW clock).
 * @param {number} [landedAt=at]  Landing/mark time for display + push anchor.
 * @returns {boolean}
 */
export const armFleetReminder = (bodyKey, at, landedAt = at) =>
  putEntry(bodyKey, { on: true, ts: at, landedAt });

/**
 * Clear a body's reminder, leaving a tombstone so the removal propagates
 * cross-device (idempotent). Returns whether anything changed.
 *
 * @param {string} bodyKey `g:s:p:type`.
 * @param {number} at      Epoch seconds of the clearing act.
 * @returns {boolean}
 */
export const removeFleetReminder = (bodyKey, at) =>
  putEntry(bodyKey, { on: false, ts: at });

/**
 * Toggle a body's reminder (the fleet1 chip); returns the NEW state
 * (`true` = now armed).
 *
 * @param {string} bodyKey `g:s:p:type`.
 * @param {number} at      Epoch seconds of the tap.
 * @returns {boolean}
 */
export const toggleFleetReminder = (bodyKey, at) => {
  const next = !hasFleetReminder(bodyKey);
  if (next) armFleetReminder(bodyKey, at);
  else removeFleetReminder(bodyKey, at);
  return next;
};
