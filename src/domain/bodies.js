// @ts-check

// Pure domain logic for the player's BODY INVENTORY — the list of planets
// and moons captured from the in-game left planet bar (`#planetList`). No
// DOM, no storage, no timers: plain functions over plain data, Node-testable.
//
// # Why this exists
//
// The dashboard runs in an extension page, NOT in the game, so it cannot
// read `#planetList` directly. The `features/planetBarCapture` feature reads
// the bar in-game and persists a snapshot (see `state/bodies.js`); the
// dashboard route editor then renders a clickable picker from that snapshot,
// and `domain/dailyRunRoutes.reconcileRoutes` prunes routes whose endpoints no
// longer exist among the captured bodies.
//
// A {@link Body} shares the `{ galaxy, system, position, type }` shape with
// `domain/dailyRunRoutes.TargetCoord`, so `coordTypeKey` from there keys a Body
// just as it keys a route endpoint — that shared key is exactly what makes
// reconciliation a plain Set lookup.
//
// @see ../state/bodies.js — the per-universe store persisting a snapshot.
// @see ./dailyRunRoutes.js — `coordTypeKey` (the shared identity) + reconcile.

import { TARGET_PLANET } from './rules.js';
import {
  axisDelta,
  flightDistance,
  SAME_SYSTEM_D,
  SYSTEM_BASE,
  SYSTEM_STEP,
} from './geometry.js';

/**
 * One owned body (planet or moon) as captured from the planet bar.
 *
 * `type` follows the game's fleetdispatch `type=` param: 1 = planet,
 * 3 = moon (see `rules.js`). A planet and its moon share the same
 * `galaxy:system:position`; `type` is what tells them apart — which is
 * why a Body's identity is {@link import('./dailyRunRoutes.js').coordTypeKey},
 * not the type-less `coordKey`.
 *
 * `cp` is the game-assigned body id (stable while the body exists, but it
 * changes if the slot is abandoned and re-colonized). It is carried for
 * display / navigation only; the canonical identity for routes is the
 * coordinate+type key, because deploy URLs are built from coordinates.
 *
 * @typedef {object} Body
 * @property {number} cp        Game body id (from `planet-<cp>` / `cp=` href).
 * @property {string} name      Display name, e.g. "P1" / "K1".
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 * @property {number} type      1 = planet, 3 = moon.
 */

/**
 * Parse a coord string in either the game's bracketed DOM form
 * (`"[4:467:15]"`) or a bare `"4:467:15"` into its three numbers, or
 * `null` when nothing coordinate-shaped is present.
 *
 * The single home for coord-string parsing: features import it from here
 * (`features/dailyRun/domHelpers`, `features/planetBarCapture`) rather than
 * re-declaring it — a feature must not import another feature, and domain is
 * the shared floor.
 *
 * @param {string | null | undefined} text
 * @returns {{ galaxy: number, system: number, position: number } | null}
 */
export const parseKoords = (text) => {
  if (!text) return null;
  const m = String(text).match(/(\d+):(\d+):(\d+)/);
  if (!m) return null;
  return {
    galaxy: parseInt(m[1], 10),
    system: parseInt(m[2], 10),
    position: parseInt(m[3], 10),
  };
};

/**
 * Build a `"g:s:p|m|p"` → body-name index from owned bodies. A planet and its
 * moon share coords (`type` 3 = moon), so the key carries the body type. Powers
 * the "show our planet/moon names instead of coordinates" toggles (in-game
 * Who's-spying panel + the dashboard proximity strip).
 *
 * @param {ReadonlyArray<Body>} bodies
 * @returns {Map<string, string>}
 */
export const bodyNameIndex = (bodies) => {
  const m = new Map();
  for (const b of bodies || []) {
    if (b && b.name) m.set(`${b.galaxy}:${b.system}:${b.position}|${b.type === 3 ? 'm' : 'p'}`, b.name);
  }
  return m;
};

/**
 * Look up our body name for a coord string + moon flag in a
 * {@link bodyNameIndex}, or `null` when we own no matching body.
 *
 * @param {Map<string, string>} index
 * @param {string} coords
 * @param {boolean} moon
 * @returns {string | null}
 */
export const bodyNameFor = (index, coords, moon) => {
  const k = parseKoords(coords);
  return k ? index.get(`${k.galaxy}:${k.system}:${k.position}|${moon ? 'm' : 'p'}`) ?? null : null;
};

/**
 * Flight distance at which a neighbour stops reading as `'near'`: fifteen
 * systems inside our own galaxy, i.e. `2700 + 95·15`.
 *
 * Expressed in DISTANCE rather than as a system count on purpose — see
 * {@link nearestBodyDistance} for the bug that a per-axis threshold caused.
 */
export const NEAR_FLIGHT_D = SYSTEM_BASE + SYSTEM_STEP * 15;

/**
 * Coarse distance from an origin coord to our NEAREST owned body, as a short
 * label + severity class (`'hot'` = same system, `'near'` = within
 * {@link NEAR_FLIGHT_D}, `''` = far).
 *
 * # Why the class comes from flight DISTANCE, not from the axis deltas
 *
 * This used to threshold each axis on its own: `≤15 systems` OR `exactly 1
 * galaxy` counted as near. The galaxy half of that was simply wrong, and
 * OGame's own numbers say so. A galaxy hop costs `GALAXY_STEP` = 20000, while
 * 200 systems inside one galaxy cost `2700 + 95·200` = 21700 — so "1 gal" is
 * very nearly as far as "200 sys" (the break-even is
 * {@link GALAXY_IN_SYSTEMS} = 183 systems). Painting "1 gal" amber while "200
 * sys" stayed grey told the player the opposite of the truth about which of
 * the two they could ignore, on the one panel whose entire job is ranking who
 * can reach them.
 *
 * Reducing both axes through {@link flightDistance} first makes that class of
 * disagreement impossible: there is one number, and the thresholds are points
 * on it. `domain/geometry.js` exists precisely so distance models don't get
 * re-derived per feature — this function was still carrying a private one.
 *
 * Donut-aware: the game always flies the WRAPPED shortest path, so 4:20 →
 * 4:450 on a 499-system donut is 69 systems, not 430 — an aggressor at the
 * seam is NEAR, and showing the naive delta hid exactly the most dangerous
 * neighbours. Bounds come from the apiContext server snapshot; without one we
 * assume the classic 9/499 donut (strictly better than no wrap).
 *
 * @param {string | null} fromCoords
 * @param {ReadonlyArray<Body>} bodies
 * @param {{ galaxies?: number, systems?: number, donutGalaxy?: boolean, donutSystem?: boolean }} [bounds]
 * @returns {{ label: string, cls: string } | null}
 */
export const nearestBodyDistance = (fromCoords, bodies, bounds = {}) => {
  const from = parseKoords(fromCoords);
  if (!from || !bodies || !bodies.length) return null;
  const gTot = Number(bounds.galaxies) > 0 ? Number(bounds.galaxies) : 9;
  const sTot = Number(bounds.systems) > 0 ? Number(bounds.systems) : 499;
  let bg = Infinity;
  let bs = Infinity;
  for (const b of bodies) {
    const dg = axisDelta(b.galaxy, from.galaxy, gTot, bounds.donutGalaxy !== false);
    const ds = axisDelta(b.system, from.system, sTot, bounds.donutSystem !== false);
    if (dg < bg || (dg === bg && ds < bs)) { bg = dg; bs = ds; }
  }
  // ONE number, then two thresholds on it. `flightDistance(0, 0)` is
  // SAME_SYSTEM_D, so the same-system case falls out of the general rule
  // instead of needing its own branch.
  const d = flightDistance(bg, bs);
  const cls = d <= SAME_SYSTEM_D ? 'hot' : d <= NEAR_FLIGHT_D ? 'near' : '';
  // The LABEL still names the axis the player thinks in ("3 sys", "1 gal") —
  // only the colour is derived from distance. A galaxy hop is always at least
  // GALAXY_STEP, well past NEAR_FLIGHT_D, so a cross-galaxy prober now always
  // reads grey, which is the point of the change.
  return { label: bg > 0 ? `${bg} gal` : `${bs} sys`, cls };
};

/**
 * Strip whitespace and brackets from a coord string, yielding a dense
 * `g:s:p` key, e.g. `"[4:467:15]"` → `"4:467:15"`. `''` for nullish input.
 *
 * The event-list / planet-bar features all key persisted body state
 * (fleet-save {@link bodyKey}s, guardian coords) off this exact grammar, so
 * it lives here as the ONE normaliser they share — a drift between per-feature
 * copies would silently break cross-feature key equality.
 *
 * @param {string | null | undefined} text
 * @returns {string}
 */
export const denseCoords = (text) => (text ?? '').replace(/[\s[\]]/g, '');

/**
 * Body identity key `g:s:p:type`. A planet and its moon share `g:s:p`, so
 * `type` (1 = planet, 3 = moon) is what tells them apart. This is the ONE
 * joiner the fleet-save / badge / manual-mark features key persisted body
 * state off (`state/fleetSaveSet`), so it lives here rather than being
 * re-declared per feature; {@link dedupeBodies} inlines the same grammar.
 *
 * @param {string} coords Dense `g:s:p` (no brackets/whitespace — see {@link denseCoords}).
 * @param {number} type   1 = planet, 3 = moon.
 * @returns {string}
 */
export const bodyKey = (coords, type) => `${coords}:${type}`;

/**
 * Stable display order for a body list: by galaxy, then system, then
 * position, then type (planet before its moon). Returns a NEW sorted
 * array — the input is not mutated, so callers can sort a store value
 * without disturbing it.
 *
 * The dashboard picker renders bodies in this order so the list reads
 * top-to-bottom like the in-game bar regardless of capture order.
 *
 * @param {Body[]} bodies
 * @returns {Body[]}
 */
export const sortBodies = (bodies) =>
  [...bodies].sort(
    (a, b) =>
      a.galaxy - b.galaxy ||
      a.system - b.system ||
      a.position - b.position ||
      a.type - b.type,
  );

/**
 * Deduplicate a body list by `coordTypeKey` identity, keeping the FIRST
 * occurrence of each key. The capture walks the bar once so duplicates
 * shouldn't arise in practice, but a defensive de-dup keeps the picker
 * and reconciliation from ever seeing two entries for one slot.
 *
 * Implemented inline (not via `coordTypeKey`) to avoid a domain→domain
 * import cycle risk; the key string here is byte-identical to
 * `coordTypeKey(body)`.
 *
 * @param {Body[]} bodies
 * @returns {Body[]}
 */
export const dedupeBodies = (bodies) => {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Body[]} */
  const out = [];
  for (const b of bodies) {
    const key = `${b.galaxy}:${b.system}:${b.position}:${b.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
};

/**
 * Whether a parsed body looks complete enough to keep: positive `cp`,
 * all three finite coordinates, and a `type` we recognise. The capture
 * feature uses this to drop malformed rows rather than persist partial
 * coords that would never match a real fleetdispatch target.
 *
 * @param {Partial<Body> | null | undefined} b
 * @returns {boolean}
 */
export const isCompleteBody = (b) =>
  !!b &&
  Number.isFinite(b.cp) &&
  /** @type {number} */ (b.cp) > 0 &&
  Number.isFinite(b.galaxy) &&
  Number.isFinite(b.system) &&
  Number.isFinite(b.position) &&
  (b.type === TARGET_PLANET || b.type === 3);
