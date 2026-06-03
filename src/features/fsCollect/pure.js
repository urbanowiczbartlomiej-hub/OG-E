// @ts-check

// Pure core of the fleet-save micro-fleet feature — the fleetdispatch URL
// builders and target picking. The coordinate shapes, key helpers, and
// the dashboard routes DSL live in `domain/fsRoutes.js` (shared with the
// dashboard tab, which a feature may not import directly); this module
// re-exports them so the feature's own call-sites + tests keep one import
// path.
//
// Axiom (same as sibling pure cores): NO DOM, NO timers, NO listeners, NO
// `location` reads. The impure orchestrator (`./index.js`) reads the page
// and hands plain data here.
//
// @see ../../domain/fsRoutes.js — coord keys + routes DSL (shared).
// @see ./domHelpers.js — impure readers producing the `inFlightKeys` set.

import { MISSION_DEPLOYMENT } from '../../domain/rules.js';
import { coordKey, coordTypeKey } from '../../domain/fsRoutes.js';

// Re-export the shared domain helpers so existing importers
// (`./index.js`, tests) keep importing from this module.
export {
  coordKey,
  coordTypeKey,
  parseRoutesDsl,
  formatRoutesDsl,
} from '../../domain/fsRoutes.js';

/**
 * @typedef {import('../../domain/fsRoutes.js').TargetCoord} TargetCoord
 * @typedef {import('../../domain/fsRoutes.js').MicroFleet} MicroFleet
 */

/** The fixed fleetdispatch query prefix appended to the game origin. */
export const FLEETDISPATCH_QUERY = '?page=ingame&component=fleetdispatch';

/**
 * Build the fleetdispatch URL for a DEPLOY (micro-fleet) send: target
 * coords + `type` + `mission=4`, and — when a micro-fleet is given — the
 * `am<shipId>=count` param that preloads the ships.
 *
 * `base` is the game origin+path (e.g. `location.href.split('?')[0]`),
 * passed in (not read from `location`) so this stays pure.
 *
 * @param {string} base
 * @param {TargetCoord} target
 * @param {MicroFleet | null | undefined} microFleet
 * @returns {string}
 */
export const buildDeployUrl = (base, target, microFleet) => {
  const { galaxy, system, position, type } = target;
  let url =
    base +
    FLEETDISPATCH_QUERY +
    `&galaxy=${galaxy}&system=${system}&position=${position}` +
    `&type=${type}&mission=${MISSION_DEPLOYMENT}`;
  if (
    microFleet &&
    Number(microFleet.shipId) > 0 &&
    Number(microFleet.count) > 0
  ) {
    url += `&am${microFleet.shipId}=${microFleet.count}`;
  }
  return url;
};

/**
 * Build the fleetdispatch URL for a COLLECT send: target coords + `type` +
 * `mission=4`, with NO ship preload — the orchestrator selects all ships
 * + all resources via the page controls after load.
 *
 * @param {string} base
 * @param {TargetCoord} target
 * @returns {string}
 */
export const buildCollectUrl = (base, target) => {
  const { galaxy, system, position, type } = target;
  return (
    base +
    FLEETDISPATCH_QUERY +
    `&galaxy=${galaxy}&system=${system}&position=${position}` +
    `&type=${type}&mission=${MISSION_DEPLOYMENT}`
  );
};

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
