// Detected fleet-save (FS) entries — a one-way channel from the alarmClock
// producer to passive consumers that must NOT import the alarmClock feature.
//
// The producer owns FS detection (the ship-count + flight-time gates and the
// lock live in `domain/fleetSave.reconcileFleetSaves`). It re-derives the set
// LOCALLY on every event-box scan — with NO gist/token dependency since 1.50 —
// and republishes it here; a successful cloud sync then overwrites it with the
// gist-reconciled set (which can carry locks made on another device). Two
// consumers: `features/badges` (marks which planet/moon tiles are a fleet-save,
// by row id) and `features/alarmClock/eventList` (the amber FS badge + cancel
// window, which needs the full entry: offsets + fire times).
//
// Storage shape (1.50): the FULL `FleetSaveAlarmClock` entries, not bare ids —
// ids are derived via {@link readFleetSaveIds}. Pre-1.50 the key held a bare
// id array; that shape reads as empty (deliberately not migrated — the next
// scan rebuilds it).
//
// The LANDED (exposed) half that used to live here moved to
// `state/fleetReminders.js` — the unified, gist-synced fleet-reminder store.
//
// Plain key-owner over `safeLS` (NO reactive store): consumers pull on their
// own render cadence (the badges MutationObserver + safety poll), so a
// reactive subscription would be pure overhead — same rationale as
// `state/dailyActions.js`. Per-origin localStorage = per-universe scoping (each
// OGame universe is its own subdomain), so no universe prefix is needed.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON array of detected FS entries. */
export const FLEET_SAVE_SET_KEY = 'oge-fleetsave-set';

/**
 * The currently-detected FS entries, exactly as the last producer scan (or
 * successful sync) published them. `[]` when none / unreadable / legacy shape.
 *
 * @returns {import('../domain/fleetSave.js').FleetSaveAlarmClock[]}
 */
export const readFleetSaveEntries = () => {
  const v = safeLS.json(FLEET_SAVE_SET_KEY, []);
  return Array.isArray(v)
    ? v.filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
    : [];
};

/**
 * Republish the detected FS set. Called by the producer after every scan (and
 * again after a successful sync); the value persists, so a passive consumer
 * reading it right after a page reload (before the next scan lands) still sees
 * the previous scan's result.
 *
 * @param {import('../domain/fleetSave.js').FleetSaveAlarmClock[]} entries
 * @returns {void}
 */
export const writeFleetSaveEntries = (entries) => {
  safeLS.setJSON(FLEET_SAVE_SET_KEY, Array.isArray(entries) ? entries : []);
};

/**
 * The detected FS fleets as their event-row ids (`eventRow-<n>`) — the same
 * identity {@link import('../features/badges/pure.js').BadgeLeg} reads from
 * the DOM, so a badge leg can be matched directly against this set.
 *
 * @returns {string[]}
 */
export const readFleetSaveIds = () => readFleetSaveEntries().map((e) => e.id);
