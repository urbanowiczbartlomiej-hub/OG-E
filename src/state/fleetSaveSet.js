// Detected fleet-save (FS) row-ids — a one-way channel from the reminders
// producer to passive consumers that must NOT import the reminders feature.
//
// The producer owns FS detection (the ship-count + flight-time gates and the
// gist lock live in `domain/fleetSave.reconcileFleetSaves`). After each sync it
// republishes the current universe's detected FS row-ids here; `features/badges`
// reads them to mark which planet/moon tiles are a fleet-save. That keeps the
// two features decoupled — both touch only `state/`, never each other.
//
// Plain key-owner over `safeLS` (NO reactive store): the sole consumer pulls on
// its own render cadence (the badges MutationObserver + safety poll), so a
// reactive subscription would be pure overhead — same rationale as
// `state/dailyActions.js`. Per-origin localStorage = per-universe scoping (each
// OGame universe is its own subdomain), so no universe prefix is needed.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the JSON array of detected FS row-ids. */
export const FLEET_SAVE_SET_KEY = 'oge-fleetsave-set';

/**
 * The currently-detected FS fleets as their event-row ids (`eventRow-<n>`),
 * the same identity {@link import('../features/badges/pure.js').BadgeLeg} reads
 * from the DOM, so a badge leg can be matched directly against this set.
 *
 * @returns {string[]} Detected FS row-ids, or `[]` when none / unreadable.
 */
export const readFleetSaveIds = () => {
  const v = safeLS.json(FLEET_SAVE_SET_KEY, []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
};

/**
 * Republish the detected FS set. Called by the producer after every successful
 * sync; the value persists, so a passive consumer reading it right after a page
 * reload (before the next sync lands) still sees the previous scan's result.
 *
 * @param {string[]} ids Event-row ids of the detected FS fleets.
 * @returns {void}
 */
export const writeFleetSaveIds = (ids) => {
  safeLS.setJSON(FLEET_SAVE_SET_KEY, Array.isArray(ids) ? ids : []);
};
