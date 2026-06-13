// @ts-check

// Pure core of the fleet-save micro-fleet feature — route target picking.
// (The old fleetdispatch URL builders are gone: with bare-URL entry the
// fleet courier sets ships+target in-page, so no URL is built here.) The
// coordinate shapes, key helpers, and the dashboard routes DSL live in
// `domain/fsRoutes.js` (shared with the dashboard tab, which a feature may
// not import directly); this module re-exports them so the feature's own
// call-sites + tests keep one import path.
//
// Axiom (same as sibling pure cores): NO DOM, NO timers, NO listeners, NO
// `location` reads. The impure orchestrator (`./index.js`) reads the page
// and hands plain data here.
//
// @see ../../domain/fsRoutes.js — coord keys + routes DSL (shared).
// @see ./domHelpers.js — impure readers producing the `inFlightKeys` set.

import { coordTypeKey } from '../../domain/fsRoutes.js';

// Re-export the shared domain helpers so existing importers
// (`./index.js`, tests) keep importing from this module.
export {
  coordKey,
  coordTypeKey,
  findRouteForBody,
  parseRoutesDsl,
  formatRoutesDsl,
} from '../../domain/fsRoutes.js';

/**
 * @typedef {import('../../domain/fsRoutes.js').TargetCoord} TargetCoord
 */

/**
 * Pick the next route target without an inbound deployment fleet. Targets
 * are tried in order; matching uses {@link coordTypeKey} so a planet and
 * the moon at the same slot are distinct destinations.
 *
 * @param {TargetCoord[]} targets
 * @param {Set<string>} inFlightKeys
 * @returns {TargetCoord | null}
 */
export const findNextMicroTarget = (targets, inFlightKeys) => {
  if (!Array.isArray(targets)) return null;
  for (const t of targets) {
    if (!inFlightKeys.has(coordTypeKey(t))) return t;
  }
  return null;
};

/**
 * Count route targets that still need a micro-fleet (no inbound
 * deployment). Drives the button's "N left" label.
 *
 * @param {TargetCoord[]} targets
 * @param {Set<string>} inFlightKeys
 * @returns {number}
 */
export const countRemainingMicroTargets = (targets, inFlightKeys) => {
  if (!Array.isArray(targets)) return 0;
  let n = 0;
  for (const t of targets) {
    if (!inFlightKeys.has(coordTypeKey(t))) n += 1;
  }
  return n;
};
