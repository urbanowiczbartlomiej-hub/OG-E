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
 * One source moon's route: its target list + the micro-fleet size.
 *
 * @typedef {object} Route
 * @property {TargetCoord[]} targets
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

// ─── Routes DSL ─────────────────────────────────────────────────────────
//
// One route per line:
//   <srcMoon> = <ship>x<count> -> <target>, <target>, ...
//   e.g.  4:472:15 = DT x15000 -> 4:475:14, 4:480:8m, 5:120:6
//
// ship  : alias MT/DT/PIO (case-insensitive) or raw id 202/203/219.
// count : integer; a trailing `k` means ×1000.
// target: g:s:p with optional trailing `m` ⇒ moon (type 3), else planet.
// Blank lines and `#` comments are ignored. Malformed lines are reported
// in `errors` (1-based line number) and skipped — the rest still parse.

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
 * Parse the routes DSL text into a `routes` map (keyed by source-moon
 * {@link coordKey}) plus per-line `errors`. Never throws.
 *
 * @param {string} text
 * @returns {{
 *   routes: Record<string, Route>,
 *   errors: Array<{ line: number, message: string }>,
 * }}
 */
export const parseRoutesDsl = (text) => {
  /** @type {Record<string, Route>} */
  const routes = {};
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
      errors.push({ line: lineNo, message: 'expected "<src> = <ship>x<count> -> <targets>"' });
      continue;
    }

    const src = parseTargetToken(line.slice(0, eq));
    if (!src) {
      errors.push({ line: lineNo, message: 'bad source coords (expected g:s:p)' });
      continue;
    }
    const microFleet = parseShipToken(line.slice(eq + 1, arrow));
    if (!microFleet) {
      errors.push({ line: lineNo, message: 'bad micro-fleet (expected e.g. DT x15000 or 203x15000)' });
      continue;
    }
    const targetTokens = line
      .slice(arrow + 2)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    /** @type {TargetCoord[]} */
    const targets = [];
    let badTarget = false;
    for (const tok of targetTokens) {
      const t = parseTargetToken(tok);
      if (!t) {
        errors.push({ line: lineNo, message: `bad target "${tok}"` });
        badTarget = true;
        break;
      }
      targets.push(t);
    }
    if (badTarget) continue;
    if (targets.length === 0) {
      errors.push({ line: lineNo, message: 'no targets' });
      continue;
    }

    routes[coordKey(src)] = { targets, microFleet };
  }

  return { routes, errors };
};

/**
 * Render a `routes` map back to canonical DSL text (one route per line).
 * `parseRoutesDsl(formatRoutesDsl(r)).routes` deep-equals `r`. Known ship
 * ids render as aliases (DT/MT/PIO).
 *
 * @param {Record<string, Route>} routes
 * @returns {string}
 */
export const formatRoutesDsl = (routes) => {
  if (!routes || typeof routes !== 'object') return '';
  /** @param {TargetCoord} t */
  const fmtTarget = (t) =>
    `${t.galaxy}:${t.system}:${t.position}${t.type === TARGET_MOON ? 'm' : ''}`;
  const lines = [];
  for (const key of Object.keys(routes)) {
    const route = routes[key];
    if (!route || !route.microFleet || !Array.isArray(route.targets)) continue;
    const ship = ID_TO_ALIAS[route.microFleet.shipId] || String(route.microFleet.shipId);
    const targets = route.targets.map(fmtTarget).join(', ');
    lines.push(`${key} = ${ship}x${route.microFleet.count} -> ${targets}`);
  }
  return lines.join('\n');
};
