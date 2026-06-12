// @ts-check

// Pure geometry + selection logic for the unified floating button's
// orbital module picker. No DOM, no timers, no storage — everything here
// is plain math over plain data so the layout can be unit tested without
// happy-dom (the pure-core rule from CLAUDE.md). The DOM shell that
// consumes these lives in ./unifiedFab.js.

/**
 * Position of one orbit item (orb centre) and its caption, in viewport px.
 *
 * @typedef {object} OrbitItemPos
 * @property {number} x       orb centre x.
 * @property {number} y       orb centre y.
 * @property {number} labelX  caption centre x (further out along the same ray).
 * @property {number} labelY  caption centre y.
 */

/** Arc the orbit items fan across, in radians (~112°). */
const ORBIT_SPREAD_RAD = Math.PI * 0.62;

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Pick the module the FAB should currently show: the stored id when it is
 * actually registered, else the first registered module (covers a missing
 * key, a stale id from an older version, and test runs that mount a single
 * module). `null` only when nothing is registered.
 *
 * @param {string | null} storedId
 * @param {string[]} registeredIds  in registration order.
 * @returns {string | null}
 */
export const resolveActiveId = (storedId, registeredIds) => {
  if (storedId !== null && registeredIds.includes(storedId)) return storedId;
  return registeredIds.length > 0 ? registeredIds[0] : null;
};

/**
 * Diameter of one orbit orb for a FAB of diameter `fabSize` — proportional
 * but clamped so tiny FABs stay tappable and huge ones don't fill the
 * screen with the picker.
 *
 * @param {number} fabSize
 * @returns {number}
 */
export const orbDiameter = (fabSize) => clamp(Math.round(fabSize * 0.42), 56, 150);

/**
 * Distance from the FAB centre to each orb centre: just past the FAB's own
 * edge plus the orb's radius, with a small visual gap.
 *
 * @param {number} fabSize
 * @param {number} orbSize
 * @returns {number}
 */
export const orbitRadius = (fabSize, orbSize) => fabSize / 2 + orbSize / 2 + 14;

/**
 * Diameter of the small picker handle riding the FAB's edge.
 *
 * @param {number} fabSize
 * @returns {number}
 */
export const handleDiameter = (fabSize) => clamp(Math.round(fabSize * 0.18), 24, 48);

/**
 * Lay `count` orbit items on an arc around the FAB centre `(cx, cy)`. The
 * arc always opens TOWARD the viewport centre, so wherever the user has
 * dragged the FAB the picker fans into free screen space instead of off
 * the edge; each position is additionally clamped to the viewport as a
 * belt-and-braces guard. Captions sit further out along the same ray.
 *
 * @param {object} opts
 * @param {number} opts.cx        FAB centre x (viewport px).
 * @param {number} opts.cy        FAB centre y.
 * @param {number} opts.count     number of items (0 ⇒ empty result).
 * @param {number} opts.radius    orbit radius — see {@link orbitRadius}.
 * @param {number} opts.orbSize   orb diameter — see {@link orbDiameter}.
 * @param {number} opts.labelGap  px between an orb's edge and its caption.
 * @param {number} opts.vw        viewport width.
 * @param {number} opts.vh        viewport height.
 * @returns {OrbitItemPos[]}
 */
export const orbitLayout = ({ cx, cy, count, radius, orbSize, labelGap, vw, vh }) => {
  /** @type {OrbitItemPos[]} */
  const items = [];
  if (count <= 0) return items;
  const base = Math.atan2(vh / 2 - cy, vw / 2 - cx);
  const start = base - ORBIT_SPREAD_RAD / 2;
  const orbMargin = orbSize / 2 + 8;
  const labelRadius = radius + orbSize / 2 + labelGap;
  for (let i = 0; i < count; i++) {
    const a = count === 1 ? base : start + ORBIT_SPREAD_RAD * (i / (count - 1));
    items.push({
      x: clamp(cx + Math.cos(a) * radius, orbMargin, vw - orbMargin),
      y: clamp(cy + Math.sin(a) * radius, orbMargin, vh - orbMargin),
      labelX: clamp(cx + Math.cos(a) * labelRadius, 30, vw - 30),
      labelY: clamp(cy + Math.sin(a) * labelRadius, 12, vh - 12),
    });
  }
  return items;
};
