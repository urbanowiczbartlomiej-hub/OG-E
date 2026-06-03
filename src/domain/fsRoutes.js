// @ts-check

// Pure domain logic for the fleet-save micro-fleet route config: the
// coordinate shapes, the key helpers, and the dashboard text DSL parser /
// formatter. No DOM, no storage, no timers — plain functions over plain
// data, fully Node-testable.
//
// Lives in `domain/` (not `features/fsCollect/pure.js`) because BOTH the
// fsCollect feature AND the dashboard route-editor tab need the DSL, and
// a feature must not import another feature (see CLAUDE.md). The feature's
// `pure.js` re-exports these so its own call-sites keep one import path.
//
// @see ../features/fsCollect/pure.js — re-exporter + URL builders.
// @see ../state/fsRoutes.js — the persisted store using these shapes.

import {
  TARGET_PLANET,
  TARGET_MOON,
  SHIP_SMALL_CARGO,
  SHIP_LARGE_CARGO,
  SHIP_PATHFINDER,
} from './rules.js';

/**
 * A target (or source) coordinate. `type` follows the game's
 * fleetdispatch `type=` param: 1 = planet, 3 = moon (see `rules.js`).
 *
 * @typedef {object} TargetCoord
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 * @property {number} type
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
 * and/or moons) sharing ONE ordered target list and ONE micro-fleet.
 * Standing on ANY of the sources fires the route. Source matching uses
 * {@link coordTypeKey}, so a planet and the moon at the same slot are
 * distinct sources — which is why each source carries its own `type`
 * (older configs, where a source was always a moon, are lifted to
 * `type === 3` by {@link migrateFsRoutes}).
 *
 * No synthetic `id`: a route's identity IS its source set (a body belongs
 * to at most one route), and dropping the field keeps the DSL round-trip
 * (`parse(format(r)) === r`) free of an unencoded field.
 *
 * @typedef {object} Route
 * @property {TargetCoord[]} sources  Source bodies (planets and/or moons).
 * @property {TargetCoord[]} targets  Destinations, tried in order.
 * @property {MicroFleet} microFleet
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
 * Build a {@link TargetCoord} from a type-less coord key (`"g:s:p"`) and a
 * `type`. Returns `null` when the key isn't a bare `g:s:p` triple. Used by
 * {@link migrateFsRoutes} to lift legacy moon-keyed routes into the
 * source-array shape.
 *
 * @param {string} key
 * @param {number} type
 * @returns {TargetCoord | null}
 */
export const coordFromKey = (key, type) => {
  const m = String(key).match(/^(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  return {
    galaxy: parseInt(m[1], 10),
    system: parseInt(m[2], 10),
    position: parseInt(m[3], 10),
    type,
  };
};

/**
 * Find the route whose `sources` contain the body you're standing on, or
 * `null`. Matching is type-aware ({@link coordTypeKey}) so a planet and the
 * moon at the same slot select different routes. First match wins (a body
 * should belong to at most one route; the dashboard editor enforces that).
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
      Array.isArray(route.sources) &&
      route.sources.some((s) => coordTypeKey(s) === key)
    ) {
      return route;
    }
  }
  return null;
};

// ─── Routes DSL ─────────────────────────────────────────────────────────
//
// One route per line:
//   <src>, <src>, ... = <ship>x<count> -> <target>, <target>, ...
//   e.g.  4:472:15m, 4:473:15m = DT x15000 -> 4:475:14, 4:480:8m, 5:120:6
//
// src   : g:s:p with optional trailing `m` ⇒ moon (type 3), else planet.
//         One or more, comma-separated — they share the line's fleet+targets.
// ship  : alias MT/DT/PIO (case-insensitive) or raw id 202/203/219.
// count : integer; a trailing `k` means ×1000.
// target: g:s:p with optional trailing `m` ⇒ moon (type 3), else planet.
// Blank lines and `#` comments are ignored. Malformed lines are reported
// in `errors` (1-based line number) and skipped — the rest still parse.
//
// NB: sources WITHOUT a trailing `m` now parse as PLANETS. Legacy single-
// moon configs are migrated in `state/fsRoutes.js` (which sets type=3), so
// `formatRoutesDsl` renders their sources with the `m` suffix — the DSL is
// always self-describing about planet vs moon on both sides.

/** Ship-alias → id map. @type {Record<string, number>} */
const SHIP_ALIASES = {
  MT: SHIP_SMALL_CARGO,
  DT: SHIP_LARGE_CARGO,
  PIO: SHIP_PATHFINDER,
};

/** Canonical alias per known id, for {@link formatRoutesDsl}. @type {Record<number, string>} */
const ID_TO_ALIAS = {
  [SHIP_SMALL_CARGO]: 'MT',
  [SHIP_LARGE_CARGO]: 'DT',
  [SHIP_PATHFINDER]: 'PIO',
};

/**
 * Parse a `g:s:p` (optional trailing `m` ⇒ moon) token, or `null`.
 *
 * @param {string} token
 * @returns {TargetCoord | null}
 */
const parseTargetToken = (token) => {
  const m = token.trim().match(/^(\d+):(\d+):(\d+)\s*(m)?$/i);
  if (!m) return null;
  return {
    galaxy: parseInt(m[1], 10),
    system: parseInt(m[2], 10),
    position: parseInt(m[3], 10),
    type: m[4] ? TARGET_MOON : TARGET_PLANET,
  };
};

/**
 * Parse the `<ship>x<count>` token into a {@link MicroFleet}, or `null`.
 *
 * @param {string} token
 * @returns {MicroFleet | null}
 */
const parseShipToken = (token) => {
  const m = token.trim().match(/^([A-Za-z]+|\d+)\s*[x*]\s*(\d+)(k)?$/i);
  if (!m) return null;
  const shipRaw = m[1];
  let shipId;
  if (/^\d+$/.test(shipRaw)) {
    shipId = parseInt(shipRaw, 10);
  } else {
    shipId = SHIP_ALIASES[shipRaw.toUpperCase()];
    if (shipId === undefined) return null;
  }
  let count = parseInt(m[2], 10);
  if (m[3]) count *= 1000;
  if (!(count > 0)) return null;
  return { shipId, count };
};

/**
 * Parse a comma-separated coordinate list (`"a, b, c"`) into
 * {@link TargetCoord}s. Returns the parsed list plus the first bad token
 * (if any) so the caller can report it; an empty/whitespace list yields
 * `{ coords: [], bad: null }`.
 *
 * @param {string} segment
 * @returns {{ coords: TargetCoord[], bad: string | null }}
 */
const parseCoordList = (segment) => {
  /** @type {TargetCoord[]} */
  const coords = [];
  const tokens = segment
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  for (const tok of tokens) {
    const c = parseTargetToken(tok);
    if (!c) return { coords, bad: tok };
    coords.push(c);
  }
  return { coords, bad: null };
};

/**
 * Parse the routes DSL text into a `routes` array plus per-line `errors`.
 * Never throws. Each line maps a source list (left of `=`) to a micro-fleet
 * and an ordered target list (right of `->`).
 *
 * @param {string} text
 * @returns {{
 *   routes: Route[],
 *   errors: Array<{ line: number, message: string }>,
 * }}
 */
export const parseRoutesDsl = (text) => {
  /** @type {Route[]} */
  const routes = [];
  /** @type {Array<{ line: number, message: string }>} */
  const errors = [];
  if (typeof text !== 'string') return { routes, errors };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    const arrow = line.indexOf('->');
    if (eq < 0 || arrow < 0 || arrow < eq) {
      errors.push({ line: lineNo, message: 'expected "<src,...> = <ship>x<count> -> <targets>"' });
      continue;
    }

    const src = parseCoordList(line.slice(0, eq));
    if (src.bad) {
      errors.push({ line: lineNo, message: `bad source "${src.bad}"` });
      continue;
    }
    if (src.coords.length === 0) {
      errors.push({ line: lineNo, message: 'no sources (expected g:s:p before "=")' });
      continue;
    }
    const microFleet = parseShipToken(line.slice(eq + 1, arrow));
    if (!microFleet) {
      errors.push({ line: lineNo, message: 'bad micro-fleet (expected e.g. DT x15000 or 203x15000)' });
      continue;
    }
    const tgt = parseCoordList(line.slice(arrow + 2));
    if (tgt.bad) {
      errors.push({ line: lineNo, message: `bad target "${tgt.bad}"` });
      continue;
    }
    if (tgt.coords.length === 0) {
      errors.push({ line: lineNo, message: 'no targets' });
      continue;
    }

    routes.push({ sources: src.coords, targets: tgt.coords, microFleet });
  }

  return { routes, errors };
};

/**
 * Render a `routes` array back to canonical DSL text (one route per line).
 * `parseRoutesDsl(formatRoutesDsl(r)).routes` deep-equals `r`. Known ship
 * ids render as aliases (DT/MT/PIO); moons (sources OR targets) carry the
 * trailing `m`.
 *
 * @param {Route[]} routes
 * @returns {string}
 */
export const formatRoutesDsl = (routes) => {
  if (!Array.isArray(routes)) return '';
  /** @param {TargetCoord} t */
  const fmtCoord = (t) =>
    `${t.galaxy}:${t.system}:${t.position}${t.type === TARGET_MOON ? 'm' : ''}`;
  const lines = [];
  for (const route of routes) {
    if (
      !route ||
      !route.microFleet ||
      !Array.isArray(route.sources) ||
      !Array.isArray(route.targets) ||
      route.sources.length === 0
    ) {
      continue;
    }
    const ship = ID_TO_ALIAS[route.microFleet.shipId] || String(route.microFleet.shipId);
    const sources = route.sources.map(fmtCoord).join(', ');
    const targets = route.targets.map(fmtCoord).join(', ');
    lines.push(`${sources} = ${ship}x${route.microFleet.count} -> ${targets}`);
  }
  return lines.join('\n');
};

/**
 * Normalise a stored {@link import('../state/fsRoutes.js').FsRoutes} value
 * into the current shape (`routes: Route[]`), migrating the legacy
 * `routes: Record<coordKey, { targets, microFleet }>` form on the way.
 *
 * Legacy keys were source MOONS (type-less coords), so each becomes a
 * single-source route with `type === 3` ({@link TARGET_MOON}). Already-array
 * input is filtered to well-formed routes (drops anything missing a source
 * list, target list, or micro-fleet). Anything unrecognisable yields an
 * empty route list. `collectTarget` passes through (or `null`).
 *
 * Pure + idempotent — `migrate(migrate(x))` equals `migrate(x)`.
 *
 * @param {unknown} stored
 * @returns {{ routes: Route[], collectTarget: TargetCoord | null }}
 */
export const migrateFsRoutes = (stored) => {
  const obj = stored && typeof stored === 'object' ? /** @type {any} */ (stored) : {};
  /** @type {TargetCoord | null} */
  const collectTarget = obj.collectTarget ?? null;
  const raw = obj.routes;

  /** @param {any} r */
  const isWellFormed = (r) =>
    r && Array.isArray(r.sources) && r.sources.length > 0 && Array.isArray(r.targets) && r.microFleet;

  if (Array.isArray(raw)) {
    return { routes: raw.filter(isWellFormed), collectTarget };
  }

  /** @type {Route[]} */
  const routes = [];
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const r = raw[key];
      if (!r || !Array.isArray(r.targets) || !r.microFleet) continue;
      const src = coordFromKey(key, TARGET_MOON);
      if (!src) continue;
      routes.push({ sources: [src], targets: r.targets, microFleet: r.microFleet });
    }
  }
  return { routes, collectTarget };
};

/**
 * @typedef {object} RemovedEndpoint
 * @property {TargetCoord} coord  The endpoint that no longer exists.
 * @property {'source' | 'target'} role  Which side it was on.
 */

/**
 * Prune route endpoints that no longer exist among the player's captured
 * bodies. An endpoint (source or target) survives iff its
 * {@link coordTypeKey} is in `bodies`; a route is DROPPED entirely once it
 * loses all sources OR all targets (it can no longer fire / has nowhere to
 * send). Pure — returns a new routes array (unchanged routes keep their
 * original reference) plus the list of removed endpoints for reporting.
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
  /** @type {RemovedEndpoint[]} */
  const removed = [];
  /** @type {Route[]} */
  const out = [];

  for (const route of routes) {
    if (!route || !Array.isArray(route.sources) || !Array.isArray(route.targets)) {
      continue; // malformed — drop silently (migrate already filters these)
    }
    const sources = route.sources.filter((s) => valid.has(coordTypeKey(s)));
    const targets = route.targets.filter((t) => valid.has(coordTypeKey(t)));
    const droppedSources = route.sources.filter((s) => !valid.has(coordTypeKey(s)));
    const droppedTargets = route.targets.filter((t) => !valid.has(coordTypeKey(t)));

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
