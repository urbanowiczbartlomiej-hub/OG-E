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
// and `domain/fsRoutes.reconcileRoutes` prunes routes whose endpoints no
// longer exist among the captured bodies.
//
// A {@link Body} shares the `{ galaxy, system, position, type }` shape with
// `domain/fsRoutes.TargetCoord`, so `coordTypeKey` from there keys a Body
// just as it keys a route endpoint — that shared key is exactly what makes
// reconciliation a plain Set lookup.
//
// @see ../state/bodies.js — the per-universe store persisting a snapshot.
// @see ./fsRoutes.js — `coordTypeKey` (the shared identity) + reconcile.

import { TARGET_PLANET } from './rules.js';

/**
 * One owned body (planet or moon) as captured from the planet bar.
 *
 * `type` follows the game's fleetdispatch `type=` param: 1 = planet,
 * 3 = moon (see `rules.js`). A planet and its moon share the same
 * `galaxy:system:position`; `type` is what tells them apart — which is
 * why a Body's identity is {@link import('./fsRoutes.js').coordTypeKey},
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
 * Mirrors `features/fsCollect/domHelpers.parseCoordsText` but lives here
 * in `domain/` because the inventory capture needs it independently of
 * that feature (a feature must not import another feature).
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
