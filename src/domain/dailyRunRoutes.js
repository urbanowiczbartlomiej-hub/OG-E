// @ts-check

// Pure domain logic for the "Daily Run" micro-fleet route config: the
// coordinate shapes, the key helpers, route lookup, store normalisation,
// and endpoint reconciliation. No DOM, no timers, no storage — plain
// functions over plain data, fully Node-testable.
//
// Lives in `domain/` (not `features/dailyRun/pure.js`) because BOTH the
// dailyRun feature AND the dashboard route-editor tab need these shapes,
// and a feature must not import another feature (see CLAUDE.md). The
// feature's `pure.js` re-exports them so its own call-sites keep one
// import path.
//
// @see ../features/dailyRun/pure.js — re-exporter + target picking.
// @see ../state/dailyRunRoutes.js — the persisted store using these shapes.

import { MISSION_DEPLOYMENT } from './rules.js';

/**
 * A target (or source) coordinate. `type` follows the game's
 * fleetdispatch `type=` param: 1 = planet, 3 = moon (see `rules.js`).
 *
 * @typedef {object} TargetCoord
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 * @property {number} type
 * @property {boolean} [custom]  When true, an EXTERNAL target (not one of
 *   the player's own bodies): rendered without an inventory name/stale check
 *   and never pruned by {@link reconcileRoutes}. Sources are always own
 *   bodies, so this only ever appears on targets.
 */

/**
 * Micro-fleet preloaded via the fleetdispatch `am<shipId>=count` param.
 *
 * @typedef {object} MicroFleet
 * @property {number} shipId
 * @property {number} count
 */

/**
 * A fleet-save micro-fleet route: one or more SOURCE bodies (planets
 * and/or moons) sharing ONE ordered target list and ONE fleet (one or more
 * ship types, all selected together). Standing on ANY of the sources fires
 * the route. Source matching uses {@link coordTypeKey}, so a planet and the
 * moon at the same slot are distinct sources — which is why each source
 * carries its own `type`.
 *
 * No synthetic `id`: a route's identity IS its source set (a body belongs
 * to at most one route).
 *
 * Legacy single-ship routes (a `microFleet` object instead of `fleet`) are
 * migrated to `fleet: [microFleet]` by {@link parseDailyRunRoutes} on hydrate.
 *
 * @typedef {object} Route
 * @property {boolean} [enabled]      Whether the route fires in-game; absent
 *   or `true` ⇒ enabled, `false` ⇒ paused (still shown in the editor, but
 *   {@link findRouteForBody} skips it). Normalised to an explicit boolean.
 * @property {TargetCoord[]} sources  Source bodies (planets and/or moons).
 * @property {TargetCoord[]} targets  Destinations, tried in order.
 * @property {MicroFleet[]} fleet     Ship+count entries selected together.
 * @property {number} [mission]       Fleet `mission=` id; absent ⇒ deployment
 *   ({@link MISSION_DEPLOYMENT}). Normalised to an explicit number.
 */

/**
 * Coordinate key IGNORING target type — `"galaxy:system:position"`.
 *
 * @param {{ galaxy: number, system: number, position: number }} c
 * @returns {string}
 */
export const coordKey = ({ galaxy, system, position }) =>
  `${galaxy}:${system}:${position}`;

/**
 * Coordinate key INCLUDING target type — `"galaxy:system:position:type"`.
 * Distinguishes a planet target from the moon at the same slot.
 *
 * @param {TargetCoord} c
 * @returns {string}
 */
export const coordTypeKey = ({ galaxy, system, position, type }) =>
  `${galaxy}:${system}:${position}:${type}`;

/**
 * Find the ENABLED route whose `sources` contain the body you're standing
 * on, or `null`. Disabled routes (`enabled === false`) are skipped — a
 * paused route is invisible to firing, so a body whose only route is paused
 * reads as "no route". Matching is type-aware ({@link coordTypeKey}) so a
 * planet and the moon at the same slot select different routes. First match
 * wins (a body should belong to at most one route).
 *
 * @param {Route[]} routes
 * @param {{ galaxy: number, system: number, position: number, type: number } | null | undefined} body
 * @returns {Route | null}
 */
export const findRouteForBody = (routes, body) => {
  if (!Array.isArray(routes) || !body) return null;
  const key = coordTypeKey(body);
  for (const route of routes) {
    if (
      route &&
      route.enabled !== false &&
      Array.isArray(route.sources) &&
      route.sources.some((s) => coordTypeKey(s) === key)
    ) {
      return route;
    }
  }
  return null;
};

/**
 * A single {@link MicroFleet} entry is usable iff it names a positive ship
 * count for a real ship id.
 *
 * @param {any} f
 * @returns {boolean}
 */
const isUsableFleetEntry = (f) =>
  !!f && Number.isFinite(f.shipId) && Number.isFinite(f.count) && f.count > 0;

/**
 * Normalise one stored route into the canonical {@link Route} shape, or
 * `null` when it is too malformed to keep. Migrates a legacy singular
 * `microFleet` object into a one-entry `fleet` array; an already-`fleet`
 * route keeps only its usable entries. A route needs ≥1 source, a target
 * array, and ≥1 usable fleet entry to survive.
 *
 * @param {any} r
 * @returns {Route | null}
 */
const normalizeRoute = (r) => {
  if (!r || !Array.isArray(r.sources) || r.sources.length === 0 || !Array.isArray(r.targets)) {
    return null;
  }
  const fleet = Array.isArray(r.fleet)
    ? r.fleet.filter(isUsableFleetEntry).map((/** @type {any} */ f) => ({ shipId: f.shipId, count: f.count }))
    : isUsableFleetEntry(r.microFleet)
      ? [{ shipId: r.microFleet.shipId, count: r.microFleet.count }]
      : [];
  if (fleet.length === 0) return null;
  const mission = Number.isFinite(r.mission) ? r.mission : MISSION_DEPLOYMENT;
  return { enabled: r.enabled !== false, sources: r.sources, targets: r.targets, fleet, mission };
};

/**
 * Normalise a stored {@link import('../state/dailyRunRoutes.js').DailyRunRoutes}
 * value into the canonical shape: a well-formed `routes: Route[]` plus the
 * `collectTarget`. Array input is mapped through {@link normalizeRoute}
 * (migrating legacy single-ship routes, dropping anything missing a source
 * list, target list, or usable fleet); any non-array / junk input yields an
 * empty route list. `collectTarget` passes through (or `null`).
 *
 * @param {unknown} stored
 * @returns {{ routes: Route[], collectTarget: TargetCoord | null }}
 */
export const parseDailyRunRoutes = (stored) => {
  const obj = stored && typeof stored === 'object' ? /** @type {any} */ (stored) : {};
  /** @type {TargetCoord | null} */
  const collectTarget = obj.collectTarget ?? null;
  const raw = obj.routes;
  const routes = Array.isArray(raw)
    ? /** @type {Route[]} */ (raw.map(normalizeRoute).filter(Boolean))
    : [];
  return { routes, collectTarget };
};

/**
 * @typedef {object} RemovedEndpoint
 * @property {TargetCoord} coord  The endpoint that no longer exists.
 * @property {'source' | 'target'} role  Which side it was on.
 */

/**
 * Prune route endpoints that no longer exist among the player's captured
 * bodies. An endpoint (source or target) survives iff it is `custom` (an
 * intentional external target — never pruned) OR its {@link coordTypeKey} is
 * in `bodies`; a route is DROPPED entirely once it loses all sources OR all
 * targets (it can no longer fire / has nowhere to send). Pure — returns a
 * new routes array (unchanged routes keep their original reference) plus the
 * list of removed endpoints for reporting.
 *
 * # Caller contract (IMPORTANT)
 *
 * Reconcile ONLY against a NON-EMPTY `bodies` snapshot. An empty inventory
 * (capture not yet run, or a mis-read) would mark every endpoint invalid
 * and wipe all routes. `features/planetBarCapture` already refuses to
 * persist an empty capture, so the snapshot handed here is real; this
 * function additionally short-circuits to a no-op (identity, no removals)
 * when `bodies` is empty, as a second line of defence.
 *
 * `changed` is implied by `removed.length > 0` — equivalently, the returned
 * `routes` is reference-equal to the input's surviving routes only when
 * nothing was pruned, so the caller can skip the store write when
 * `removed` is empty (anti-loop).
 *
 * @param {Route[]} routes
 * @param {Array<{ galaxy: number, system: number, position: number, type: number }>} bodies
 * @returns {{ routes: Route[], removed: RemovedEndpoint[] }}
 */
export const reconcileRoutes = (routes, bodies) => {
  if (!Array.isArray(routes)) return { routes: [], removed: [] };
  // Empty inventory ⇒ no-op (see caller contract): never prune against it.
  if (!Array.isArray(bodies) || bodies.length === 0) {
    return { routes, removed: [] };
  }
  const valid = new Set(bodies.map(coordTypeKey));
  /** A custom (external) endpoint is intentional and always survives; an
   * own-body endpoint survives only while it's still in the inventory.
   * @param {TargetCoord} c */
  const survives = (c) => c.custom === true || valid.has(coordTypeKey(c));
  /** @type {RemovedEndpoint[]} */
  const removed = [];
  /** @type {Route[]} */
  const out = [];

  for (const route of routes) {
    if (!route || !Array.isArray(route.sources) || !Array.isArray(route.targets)) {
      continue; // malformed — drop silently (migrate already filters these)
    }
    const sources = route.sources.filter(survives);
    const targets = route.targets.filter(survives);
    const droppedSources = route.sources.filter((s) => !survives(s));
    const droppedTargets = route.targets.filter((t) => !survives(t));

    for (const s of droppedSources) removed.push({ coord: s, role: 'source' });
    for (const t of droppedTargets) removed.push({ coord: t, role: 'target' });

    if (sources.length === 0 || targets.length === 0) {
      continue; // route can no longer fire / has nowhere to send → drop it
    }
    // Keep the original object reference when nothing changed (anti-loop).
    out.push(
      droppedSources.length || droppedTargets.length
        ? { ...route, sources, targets }
        : route,
    );
  }

  return { routes: out, removed };
};
