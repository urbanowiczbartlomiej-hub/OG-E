// @ts-check

// Pure geometry + selection logic for the unified floating button's
// always-visible satellite menu. No DOM, no timers, no storage —
// everything here is plain math over plain data so the layout can be unit
// tested without happy-dom (the pure-core rule from CLAUDE.md). The DOM
// shell that consumes these lives in ./unifiedFab.js.

/**
 * Position of one orbit item (orb centre), in viewport px.
 *
 * @typedef {object} OrbitItemPos
 * @property {number} x  orb centre x.
 * @property {number} y  orb centre y.
 */

// Angular STEP between adjacent orbit items (~37°) — the gap the original
// fixed ~112° arc gave a 4-orb menu, kept as the aesthetic baseline. The arc
// WIDTH is now count-driven (step × gaps) instead of constant: a constant arc
// flung 2 orbs to its extremes (unnaturally far apart, hugging nothing) and
// crammed 5+ into the same 112°. See orbitLayout.
const ORBIT_STEP_RAD = (Math.PI * 0.62) / 3;

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Angle (radians) pointing from the FAB centre `(cx, cy)` toward the
 * viewport centre — the ray the satellite orbs fan symmetrically about, so
 * wherever the user drags the FAB the menu opens into free screen space.
 * Degenerate when the FAB sits exactly at the viewport centre (both deltas
 * zero); there we pick the down-right diagonal for a stable home instead of
 * snapping to `atan2(0,0)`'s 0 rad.
 *
 * @param {object} o
 * @param {number} o.cx  FAB centre x (viewport px).
 * @param {number} o.cy  FAB centre y.
 * @param {number} o.vw  viewport width.
 * @param {number} o.vh  viewport height.
 * @returns {number}
 */
export const aimAngle = ({ cx, cy, vw, vh }) => {
  const dx = vw / 2 - cx;
  const dy = vh / 2 - cy;
  return dx === 0 && dy === 0 ? Math.PI / 4 : Math.atan2(dy, dx);
};

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
 * Diameter of one satellite orb for a FAB of diameter `fabSize` — a fixed
 * proportion of the FAB so the orbs grow and shrink WITH it across the whole
 * `fabBtnSize` range (40–560). The only clamp is a 36 px floor that keeps the
 * orb tappable on a tiny FAB (0.42 × fabSize is always smaller than the FAB,
 * so no upper rail is needed). A previous hard 150 px ceiling froze the orbs
 * once the FAB passed ~357 px — the default is 320 — so enlarging the FAB
 * appeared to leave the menu untouched.
 *
 * @param {number} fabSize
 * @returns {number}
 */
export const orbDiameter = (fabSize) => Math.max(36, Math.round(fabSize * 0.42));

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
 * Number of samples the feasible-window scan takes around the full circle.
 * 256 ⇒ ~1.4° resolution — far below what the eye can see at orbit radii,
 * and cheap enough for every drag-move frame (a few hundred multiplies).
 */
const FEASIBLE_SCAN_N = 256;

/**
 * Rotate the arc `[.. spread ..]` so it fits INSIDE the screen, keeping its
 * centre as close to the aim angle `base` as possible.
 *
 * Why: `base` alone points at the viewport centre, which from a corner of a
 * tall phone screen is nearly vertical — half the arc then runs off the near
 * edge, and the per-orb XY clamp used to drag those orbs along the edge into
 * each other and under the FAB, while the other side of the screen sat empty.
 * Instead we compute the set of FEASIBLE angles (those where an orb of
 * diameter `orbSize` fully fits on-screen at `radius` from the FAB), take
 * the contiguous window nearest `base`, and slide the arc minimally into it —
 * so from a corner the whole fan rotates into the free space.
 *
 * Numeric scan over {@link FEASIBLE_SCAN_N} samples (robust against the
 * corner cases an analytic circle/edge-band intersection breeds). Returns the
 * arc's CENTRE angle plus the (possibly compressed) spread: a window narrower
 * than the requested spread squeezes the arc down to the window — but never
 * below `minSpread`, the collision floor under which neighbouring orbs would
 * touch (below it a sub-px overhang into the XY clamp beats overlapping
 * orbs). Nothing feasible at all (radius larger than the viewport) → plain
 * `base` with the spread unchanged.
 *
 * @param {object} o
 * @param {number} o.cx      FAB centre x (viewport px).
 * @param {number} o.cy      FAB centre y.
 * @param {number} o.radius  orbit radius.
 * @param {number} o.margin  orb half-diameter + gap — the same margin the
 *   XY clamp uses, so "feasible" and "not clamped" agree.
 * @param {number} o.vw      viewport width.
 * @param {number} o.vh      viewport height.
 * @param {number} o.base    aim angle (radians) — see {@link aimAngle}.
 * @param {number} o.spread  requested total arc width (radians).
 * @param {number} [o.minSpread]  collision floor for the compressed spread
 *   (defaults to 0 — no floor).
 * @returns {{ centre: number, spread: number }}
 */
export const feasibleArcCenter = ({ cx, cy, radius, margin, vw, vh, base, spread, minSpread = 0 }) => {
  const stepA = (Math.PI * 2) / FEASIBLE_SCAN_N;
  /** Sample i covers the relative angle (i − N/2) · stepA, i.e. index N/2 = `base`. */
  const ok = new Array(FEASIBLE_SCAN_N);
  for (let i = 0; i < FEASIBLE_SCAN_N; i++) {
    const a = base + (i - FEASIBLE_SCAN_N / 2) * stepA;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    ok[i] = x >= margin && x <= vw - margin && y >= margin && y <= vh - margin;
  }
  /** @type {{ centre: number, spread: number }} */
  const unmoved = { centre: base, spread };
  // Collect contiguous feasible runs on the CIRCLE (the scan array wraps:
  // index 0 and N−1 are angular neighbours, so a run crossing the seam is one
  // window, not two).
  /** @type {Array<{ from: number, len: number }>} */
  const runs = [];
  let i = 0;
  while (i < FEASIBLE_SCAN_N) {
    if (!ok[i]) { i++; continue; }
    const from = i;
    while (i < FEASIBLE_SCAN_N && ok[i]) i++;
    runs.push({ from, len: i - from });
  }
  if (runs.length === 0) return unmoved;
  if (runs.length === 1 && runs[0].len === FEASIBLE_SCAN_N) {
    return unmoved; // everything feasible — keep the aim ray untouched
  }
  // Merge a run touching the seam (…N−1 + 0…) into one circular window.
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (runs.length > 1 && first.from === 0 && last.from + last.len === FEASIBLE_SCAN_N) {
    runs.pop();
    first.from = last.from - FEASIBLE_SCAN_N; // negative index = wrapped start
    first.len += last.len;
  }
  // Pick the window whose angular span lies closest to `base` (relative 0):
  // prefer one containing 0; else minimal distance from 0 to the span.
  const mid = FEASIBLE_SCAN_N / 2;
  let best = runs[0];
  let bestDist = Infinity;
  for (const r of runs) {
    const lo = r.from - mid;
    const hi = r.from + r.len - 1 - mid;
    const dist = lo <= 0 && 0 <= hi ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
    if (dist < bestDist) { bestDist = dist; best = r; }
  }
  // Erode the window by one scan step per side: a boundary sample is feasible
  // only to within the scan resolution, and an arc endpoint placed exactly on
  // it can land a fraction of a px outside (then the XY clamp shaves it off
  // the orbit circle). One conservative step guarantees strict feasibility.
  // A window too narrow to erode collapses to its midpoint.
  let winLo = (best.from - mid + 1) * stepA;
  let winHi = (best.from + best.len - 2 - mid) * stepA;
  if (winHi < winLo) winLo = winHi = (winLo + winHi) / 2;
  // Slide the arc centre minimally so [centre−spread/2, centre+spread/2]
  // fits in [winLo, winHi]. A narrower window compresses the spread down to
  // it (never below the collision floor — see the doc above); whatever still
  // overhangs, the XY clamp catches.
  const width = winHi - winLo;
  const fitSpread = width >= spread ? spread : Math.max(minSpread, width);
  const half = fitSpread / 2;
  const centre = width >= fitSpread
    ? clamp(0, winLo + half, winHi - half)
    : (winLo + winHi) / 2;
  return { centre: base + centre, spread: fitSpread };
};

/**
 * Lay `count` satellite orbs on an arc around the FAB centre `(cx, cy)`. The
 * arc aims TOWARD the viewport centre and is then rotated just enough to fit
 * on-screen (see {@link feasibleArcCenter}), so wherever the user has dragged
 * the FAB — including hard into a corner of a tall phone screen — the menu
 * fans into free screen space instead of piling up against the near edge.
 * Each position is additionally clamped to the viewport as a belt-and-braces
 * guard for the too-narrow-window fallback.
 *
 * The arc's WIDTH grows with the item count: adjacent orbs sit a constant
 * ~37° apart (2 orbs hug the aim ray instead of flying to a fixed arc's
 * extremes; 5+ get the wider arc they need to fit). The step is raised to
 * the collision minimum when the orbs are large relative to the orbit
 * radius (small FABs), and the total spread is capped at a full even circle
 * so the arc's two ends can never overlap each other.
 *
 * @param {object} opts
 * @param {number} opts.cx       FAB centre x (viewport px).
 * @param {number} opts.cy       FAB centre y.
 * @param {number} opts.count    number of items (0 ⇒ empty result).
 * @param {number} opts.radius   orbit radius — see {@link orbitRadius}.
 * @param {number} opts.orbSize  orb diameter — see {@link orbDiameter}.
 * @param {number} opts.vw       viewport width.
 * @param {number} opts.vh       viewport height.
 * @returns {OrbitItemPos[]}
 */
export const orbitLayout = ({ cx, cy, count, radius, orbSize, vw, vh }) => {
  /** @type {OrbitItemPos[]} */
  const items = [];
  if (count <= 0) return items;
  const base = aimAngle({ cx, cy, vw, vh });
  // Collision floor: the angular step whose chord equals one orb diameter
  // plus a small gap, so neighbouring orbs never touch even on a tiny FAB
  // (where the orbit radius shrinks faster than the 36px orb floor).
  const collisionStep = 2 * Math.asin(Math.min(1, (orbSize + 8) / (2 * radius)));
  const step = Math.max(ORBIT_STEP_RAD, collisionStep);
  const wantSpread = Math.min(step * (count - 1), (Math.PI * 2 * (count - 1)) / count);
  const orbMargin = orbSize / 2 + 8;
  const { centre, spread } = feasibleArcCenter({
    cx, cy, radius, margin: orbMargin, vw, vh, base,
    spread: wantSpread, minSpread: collisionStep * (count - 1),
  });
  const start = centre - spread / 2;
  for (let i = 0; i < count; i++) {
    const a = count === 1 ? centre : start + spread * (i / (count - 1));
    items.push({
      x: clamp(cx + Math.cos(a) * radius, orbMargin, vw - orbMargin),
      y: clamp(cy + Math.sin(a) * radius, orbMargin, vh - orbMargin),
    });
  }
  return items;
};
