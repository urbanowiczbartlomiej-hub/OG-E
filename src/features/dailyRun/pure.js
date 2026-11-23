// @ts-check

// Pure core of the fleet-save micro-fleet feature — route target picking.
// (The old fleetdispatch URL builders are gone: with bare-URL entry the
// fleet courier sets ships+target in-page, so no URL is built here.) The
// coordinate shapes and key helpers live in `domain/dailyRunRoutes.js`
// (shared with the dashboard tab, which a feature may not import directly);
// this module re-exports them so the feature's own call-sites + tests keep
// one import path.
//
// Axiom (same as sibling pure cores): NO DOM, NO timers, NO listeners, NO
// `location` reads. The impure orchestrator (`./index.js`) reads the page
// and hands plain data here.
//
// @see ../../domain/dailyRunRoutes.js — coord keys + route shapes (shared).
// @see ./domHelpers.js — impure readers producing the `inFlightKeys` set.

import { coordKey, coordTypeKey } from '../../domain/dailyRunRoutes.js';
import {
  MISSION_DEPLOYMENT,
  MISSION_ESPIONAGE,
  SHIP_ESPIONAGE_PROBE,
  TARGET_MOON,
  TARGET_PLANET,
} from '../../domain/rules.js';

// Re-export the shared domain helpers so existing importers
// (`./index.js`, tests) keep importing from this module.
export {
  coordKey,
  coordTypeKey,
  findRouteForBody,
} from '../../domain/dailyRunRoutes.js';

/**
 * @typedef {import('../../domain/dailyRunRoutes.js').TargetCoord} TargetCoord
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

// ─── Micro legs: the "own moon" target and the Spy-16 trick ─────────────
//
// A route's sources and targets may overlap (e.g. sources = all moons,
// targets = all moons: the hub sends to every other moon). The target equal
// to the body you stand on can't be flown to. Instead of skipping it, the
// micro-fleet flies the fleet-save trick: Espionage to position 16 of the
// same system and straight back. While it is away the fleet-save can leave
// the hub WHOLE, and when it lands the hub holds one micro-fleet again, so
// its own Drop later happens in the same wave as every other moon's — no
// odd one out on a phalanx. Espionage needs a probe, so one rides along;
// with no probe on the body the leg is skipped.

/** The empty slot past the last planet of every system — the Spy-16 point. */
export const SPY_SAVE_POSITION = 16;

/**
 * @typedef {{ target: TargetCoord, mission: number, spy: boolean }} MicroLeg
 * @typedef {{ origin: TargetCoord | null, dest: TargetCoord, mission: number }} FleetLeg
 */

/**
 * The route's targets resolved for the body you stand on, in route order:
 * every target as-is with the route's mission, except the one equal to the
 * body itself, which becomes Espionage to `[g:s:16]` (`spy: true`) — or is
 * dropped when `canSpy` is false (no probe here).
 *
 * @param {{ targets: TargetCoord[], mission?: number }} route
 * @param {TargetCoord | null} body
 * @param {boolean} canSpy
 * @returns {MicroLeg[]}
 */
export const microLegs = (route, body, canSpy) => {
  const mission = route.mission ?? MISSION_DEPLOYMENT;
  const here = body ? coordTypeKey(body) : null;
  /** @type {MicroLeg[]} */
  const out = [];
  for (const t of route.targets || []) {
    if (here && coordTypeKey(t) === here) {
      if (!canSpy) continue;
      out.push({
        target: { galaxy: t.galaxy, system: t.system, position: SPY_SAVE_POSITION, type: TARGET_PLANET },
        mission: MISSION_ESPIONAGE,
        spy: true,
      });
    } else {
      out.push({ target: t, mission, spy: false });
    }
  }
  return out;
};

/**
 * Whether a micro leg is already in the air. A normal leg counts any inbound
 * fleet of its mission to its target (as before); a Spy-16 leg counts only an
 * Espionage leg from THIS body to that point (another body's — or the
 * fleet-save's own — trip to the same slot is not this leg).
 *
 * @param {MicroLeg} leg
 * @param {TargetCoord | null} body
 * @param {FleetLeg[]} fleetLegs  every non-return fleet in the event list.
 * @returns {boolean}
 */
export const isMicroLegSent = (leg, body, fleetLegs) => {
  const dest = coordTypeKey(leg.target);
  if (!leg.spy) {
    return fleetLegs.some((l) => l.mission === leg.mission && coordTypeKey(l.dest) === dest);
  }
  const from = body ? coordTypeKey(body) : null;
  return fleetLegs.some(
    (l) =>
      l.mission === MISSION_ESPIONAGE &&
      coordTypeKey(l.dest) === dest &&
      !!l.origin &&
      coordTypeKey(l.origin) === from,
  );
};

/**
 * The next micro leg still to send on this body (route order) and how many
 * remain including it.
 *
 * @param {{ targets: TargetCoord[], mission?: number }} route
 * @param {TargetCoord | null} body
 * @param {FleetLeg[]} fleetLegs
 * @param {boolean} canSpy
 * @returns {{ next: MicroLeg | null, left: number }}
 */
export const planMicro = (route, body, fleetLegs, canSpy) => {
  const pending = microLegs(route, body, canSpy).filter((l) => !isMicroLegSent(l, body, fleetLegs));
  return { next: pending[0] ?? null, left: pending.length };
};

/**
 * The fleet a Spy-16 leg flies: the route's micro-fleet plus one espionage
 * probe (the mission needs one), unless the route already carries probes.
 *
 * @param {Array<{ shipId: number, count: number }>} fleet
 * @returns {Array<{ shipId: number, count: number }>}
 */
export const spyFleet = (fleet) =>
  fleet.some((f) => Number(f.shipId) === SHIP_ESPIONAGE_PROBE)
    ? fleet
    : [...fleet, { shipId: SHIP_ESPIONAGE_PROBE, count: 1 }];

// ─── Drop / Up: own moon ↔ own planet ───────────────────────────────────

/**
 * The other body at the same slot: a moon's own planet (Drop) or a planet's
 * own moon (Up).
 *
 * @param {TargetCoord} body
 * @returns {TargetCoord}
 */
export const pairTarget = (body) => ({
  galaxy: body.galaxy,
  system: body.system,
  position: body.position,
  type: body.type === TARGET_MOON ? TARGET_PLANET : TARGET_MOON,
});

/**
 * {@link coordTypeKey}s of bodies whose Drop / Up is already in the air: a
 * deployment from a body to the other body at the SAME slot.
 *
 * @param {FleetLeg[]} fleetLegs
 * @returns {Set<string>}
 */
export const pairedOriginKeys = (fleetLegs) => {
  const set = new Set();
  for (const l of fleetLegs) {
    if (
      l.mission === MISSION_DEPLOYMENT &&
      l.origin &&
      l.origin.type !== l.dest.type &&
      coordKey(l.origin) === coordKey(l.dest)
    ) {
      set.add(coordTypeKey(l.origin));
    }
  }
  return set;
};
