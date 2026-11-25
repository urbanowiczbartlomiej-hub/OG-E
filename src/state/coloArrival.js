// @ts-check

// Nearest upcoming colonization arrival — a one-number localStorage cache so
// the colony FAB's landing countdown can arm ON PAGE LOAD without waiting for
// OGame's event-list XHR (the eventbox often lands seconds after the page —
// too late for a ≤60 s countdown to feel instant).
//
// Written by `features/abandon/colonyFab.js` whenever it reads the live event
// list (the source of truth): the nearest OUTBOUND mission-7 arrival still in
// the future, or cleared when the list shows none. Consumed by the same
// feature on its own tick — nothing subscribes, so this is a sanctioned plain
// key-owner over `safeLS` (no reactive store; see CLAUDE.md). Per-origin
// localStorage = per-universe scoping (each OGame universe is its own
// subdomain).

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the nearest colonization arrival (epoch SECONDS). */
export const COLO_ARRIVAL_KEY = 'oge-colo-arrival';

/**
 * Nearest known upcoming colonization arrival, epoch SECONDS. 0 = none known.
 * Staleness (an arrival now in the past) is the reader's concern — the pure
 * derivation drops past values; this module just hands back what was stored.
 *
 * @returns {number}
 */
export const readColoArrival = () => {
  const v = safeLS.json(COLO_ARRIVAL_KEY, 0);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * Record the nearest upcoming arrival (epoch seconds); `0` removes the key.
 *
 * @param {number} arrivalAt
 * @returns {void}
 */
export const writeColoArrival = (arrivalAt) => {
  if (arrivalAt > 0) safeLS.setJSON(COLO_ARRIVAL_KEY, arrivalAt);
  else safeLS.remove(COLO_ARRIVAL_KEY);
};

// A landing that HAS arrived but that the server has not been seen to process
// yet (epoch SECONDS). The "landed while this page was open" fact lives only
// in page memory, so a reload during the server's processing lag used to lose
// it: the fresh page had no colony yet and simply counted down to the NEXT
// arrival. Persisting it lets the reloaded page keep waiting for this one.
// Same owner / same reader as the key above.

/** localStorage key holding the landed-but-unprocessed arrival (epoch SECONDS). */
export const COLO_SETTLING_KEY = 'oge-colo-settling';

/** @returns {number} landed-but-unprocessed arrival, epoch SECONDS (0 = none). */
export const readColoSettling = () => {
  const v = safeLS.json(COLO_SETTLING_KEY, 0);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * @param {number} arrivalAt epoch seconds; `0` removes the key.
 * @returns {void}
 */
export const writeColoSettling = (arrivalAt) => {
  if (arrivalAt > 0) safeLS.setJSON(COLO_SETTLING_KEY, arrivalAt);
  else safeLS.remove(COLO_SETTLING_KEY);
};
