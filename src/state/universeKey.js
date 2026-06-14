// @ts-check
//
// One implementation of the "which storage key for the universe I'm on right
// now?" fallback that every per-universe store reimplemented identically
// (scans, bodies, dailyRunRoutes, history, settings/colPositions).
//
// The rule, in one place:
//   • no `location` (a non-browser caller — a test, edge tooling) → the BASE
//     key, so data still has a home;
//   • `location` present but the host doesn't parse to a universe id (empty
//     host) → also the BASE key;
//   • otherwise → the per-universe key for the parsed id.
//
// This reads the `location` global, so it lives in state/ (not in the pure
// lib/universeId.js, whose contract is "no DOM access"). state/ → lib/ is the
// allowed direction.

import { parseUniverseId } from '../lib/universeId.js';

/**
 * Resolve the storage key for the current universe, falling back to a shared
 * base key when there is no parseable universe (no `location`, or an
 * unrecognised host).
 *
 * @param {string} baseKey            The non-namespaced fallback key.
 * @param {(id: string) => string} keyForId  Builds the per-universe key.
 * @returns {string}
 */
export const currentUniverseKey = (baseKey, keyForId) => {
  if (typeof location === 'undefined') return baseKey;
  const id = parseUniverseId(location.host);
  return id ? keyForId(id) : baseKey;
};
