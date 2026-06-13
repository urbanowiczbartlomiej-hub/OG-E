// @ts-check

// Pure compute core of `features/sendLifeform/index.js` — the lifeform
// "discover system" button. Mirrors the `sendCol/pure.js` split: this file
// owns the pure pipeline (`derive` → `render`), the target-picking helpers,
// and every constant / typedef they touch. NO DOM, NO timers, NO storage,
// NO event listeners, NO module-local mutable state.
//
// # Role
//
// One single-zone button that walks the universe firing lifeform system
// discoveries (one user tap = one game action):
//
//   1. Off galaxy view            → "Discover" (caller full-navigates).
//   2. On galaxy, current system
//      still needs discovery       → "Discover [g:s]" (caller clicks the
//                                    game's `#discoverSystemBtn`).
//   3. On galaxy, current system
//      already covered (<7d)        → "Next [g:s]" (caller in-page hops to
//                                    the NEAREST system that still needs it).
//   4. Everything covered          → "All discovered!".
//
// # Why per-system retention
//
// One discovery send covers the WHOLE system at once (the response's
// `sentToCoordinates` lists every position). So the 7-day retention gate
// and the "next free system" search key off a per-system timestamp
// (`SystemScan.lfScannedAt`); the per-position `lfPositions` map the
// feature also records is fidelity only and not read here.
//
// @see ./index.js      — impure orchestrator that consumes this.
// @see ./domHelpers.js — DOM readers + the discover-button click.
// @see ../sendCol/pure.js — the parallel colonization pure core.

import { buildGalaxyOrder } from '../../domain/positions.js';
import { COL_MAX_SYSTEM, COL_MAX_GALAXY } from '../../domain/rules.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../state/scans.js').SystemScan} SystemScan
 * @typedef {{ galaxy: number, system: number }} SystemCoords
 */

// ─── Retention ──────────────────────────────────────────────────────────

/**
 * A system is re-discoverable 7 days after its last successful discovery.
 * The game enforces the same cooldown server-side; we mirror it so the
 * button skips systems still inside the window instead of wasting a tap
 * on a `shipsSent:0` response.
 */
export const LF_RESCAN_MS = 7 * 24 * 3600 * 1000;

// ─── Colours (violet / purple family) ─────────────────────────────────────
// Seeded from the planted TODO in `sendCol/pure.js`. Distinct hue from the
// cyan Send-Col / amber-wait palette so the three buttons read apart.

/** Rim colour — idle / "Discover" (violet). */
export const BG_LF_IDLE = '#a78bfa';
/** Rim colour — ready to discover / navigate (brighter violet). */
export const BG_LF_ACTIVE = '#bb9dff';
/** Rim colour — mid-discovery cooldown "Wait…" (deep violet). */
export const BG_LF_WAIT = '#8b5cf6';
/** Rim colour — "All discovered!" (muted violet). */
export const BG_LF_DONE = '#7c6aa8';
/** Rim colour — fleet-cap / cannot-send (rose, matches Send-Col error). */
export const BG_LF_ERROR = '#fb7185';

// ─── Cooldown ─────────────────────────────────────────────────────────────

/**
 * Safety cap for the post-click cooldown. Normally the lock lifts
 * event-driven (on `oge:systemDiscoveryResult`); this covers a silently
 * dropped response. Matches `sendCol`'s `SCAN_COOLDOWN_MS`.
 */
export const DISCOVERY_COOLDOWN_MS = 8000;

// ─── Artifact cap ──────────────────────────────────────────────────────────

/**
 * Extract the artifact counter from the lfresearch header slot text, e.g.
 * `"Zebrane artefakty: 3609 / 3600"`. Locale-independent: the label text
 * varies per language, so we only look for the first `N / M` number pair
 * and tolerate thousands separators (`.`, `,`, NBSP, space, apostrophe).
 * Returns `null` when no counter is present or `max` is not positive.
 *
 * `current > max` is a legitimate reading (simultaneous wave landings
 * overshoot the cap) and is preserved verbatim.
 *
 * @param {string | null | undefined} text
 * @returns {{ current: number, max: number } | null}
 */
export const parseArtifactCounter = (text) => {
  if (typeof text !== 'string') return null;
  const m = text.match(/(\d[\d.,'\u00a0 ]*)\/\s*(\d[\d.,'\u00a0 ]*)/);
  if (!m) return null;
  const toInt = (/** @type {string} */ s) => parseInt(s.replace(/[^\d]/g, ''), 10);
  const current = toInt(m[1]);
  const max = toInt(m[2]);
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return null;
  return { current, max };
};

// ─── Retention predicate ───────────────────────────────────────────────────

/**
 * Does this system need a (re)discovery? True when we have never
 * discovered it, or the last discovery is older than {@link LF_RESCAN_MS}.
 *
 * @param {SystemScan | undefined} scan  the stored record (or undefined).
 * @param {number} now  epoch-ms.
 * @returns {boolean}
 */
export const isSystemLfStale = (scan, now) => {
  const at = scan?.lfScannedAt;
  if (!at) return true;
  return now - at > LF_RESCAN_MS;
};

// ─── Target selection ──────────────────────────────────────────────────────

/**
 * Find the NEAREST system that still needs a lifeform discovery, starting
 * from `from` (the galaxy-view system when on galaxy, else home). "Nearest"
 * is the wrap-aware ring distance ({@link sysDist}, so dist(499, 1) === 1):
 * within the starting galaxy we walk outward by ring distance (1, 2, 3, …,
 * trying both directions at each step); only once that galaxy is fully
 * covered do we move to the next galaxy via {@link buildGalaxyOrder}
 * (home-first, near-first), sweeping those linearly 1..N.
 *
 * Returns `null` when every system in every galaxy is fresh (<7d).
 *
 * @param {GalaxyScans} scans
 * @param {SystemCoords} from   starting point (current view or home).
 * @param {number} now          epoch-ms.
 * @returns {SystemCoords | null}
 */
export const findNextLfSystem = (scans, from, now) => {
  const galaxyOrder = buildGalaxyOrder(from.galaxy, COL_MAX_GALAXY);

  for (let gi = 0; gi < galaxyOrder.length; gi++) {
    const g = galaxyOrder[gi];
    if (gi === 0) {
      // Starting galaxy: nearest-first by wrap-aware ring distance.
      // distance 0 (the current system itself) is intentionally checked
      // first so the caller discovers where it already stands before
      // hopping away.
      for (let d = 0; d <= Math.floor(COL_MAX_SYSTEM / 2); d++) {
        for (const s of systemsAtDistance(from.system, d)) {
          const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
          if (isSystemLfStale(scans[key], now)) return { galaxy: g, system: s };
        }
      }
    } else {
      // Other galaxies: no meaningful "current" anchor — sweep 1..N.
      for (let s = 1; s <= COL_MAX_SYSTEM; s++) {
        const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
        if (isSystemLfStale(scans[key], now)) return { galaxy: g, system: s };
      }
    }
  }
  return null;
};

/**
 * The 1 or 2 systems exactly `d` ring-steps from `center` on the
 * 1..COL_MAX_SYSTEM wrap ring. `d === 0` → `[center]`; the antipodal case
 * on an odd-sized ring yields two distinct systems; we de-dupe defensively.
 *
 * @param {number} center  1..COL_MAX_SYSTEM
 * @param {number} d        ring distance (0..floor(N/2))
 * @returns {number[]}
 */
const systemsAtDistance = (center, d) => {
  if (d === 0) return [center];
  const up = ((center - 1 + d) % COL_MAX_SYSTEM) + 1;
  const down = ((center - 1 - d + COL_MAX_SYSTEM) % COL_MAX_SYSTEM) + 1;
  return up === down ? [up] : [up, down];
};

/**
 * Most recent `lfScannedAt` across all scanned systems — the epoch-ms
 * timestamp of the last discovery send. Returns `null` when nothing has
 * ever been sent (no system has `lfScannedAt` set).
 *
 * Used by `derive` to detect sessions where a wave was sent after the last
 * artifact-counter reading (so the counter may have grown since then).
 *
 * @param {GalaxyScans} scans
 * @returns {number | null}
 */
export const maxLfScannedAt = (scans) => {
  let max = 0;
  for (const scan of Object.values(scans)) {
    if (scan.lfScannedAt && scan.lfScannedAt > max) max = scan.lfScannedAt;
  }
  return max > 0 ? max : null;
};

/**
 * Count systems across every galaxy that still need a discovery. Cheap
 * full-universe pass (7 × 499 hash lookups), run from the 1 Hz refresh for
 * the button's progress label — same pattern as
 * `sendCol/pure.js countScansRemaining`.
 *
 * @param {GalaxyScans} scans
 * @param {number} now
 * @returns {number}
 */
export const countLfRemaining = (scans, now) => {
  let remaining = 0;
  for (let g = 1; g <= COL_MAX_GALAXY; g++) {
    for (let s = 1; s <= COL_MAX_SYSTEM; s++) {
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      if (isSystemLfStale(scans[key], now)) remaining++;
    }
  }
  return remaining;
};

// ─── URL builder ────────────────────────────────────────────────────────────

/**
 * Bare galaxy-view URL (current origin) — used by the off-galaxy first tap.
 *
 * @param {string} href  `location.href`.
 * @returns {string}
 */
export const buildGalaxyUrl = (href) =>
  href.split('?')[0] + '?page=ingame&component=galaxy';

/**
 * Galaxy-view URL for a specific `(galaxy, system)` — the full-nav fallback
 * when the in-page form submit can't be wired.
 *
 * @param {string} href
 * @param {SystemCoords} coords
 * @returns {string}
 */
export const buildGalaxySystemUrl = (href, { galaxy, system }) =>
  `${href.split('?')[0]}?page=ingame&component=galaxy&galaxy=${galaxy}&system=${system}`;

/**
 * Lifeform-research page URL (current origin) — the artifact counter lives
 * in its header. Used by the `artifactsFull` tap and the hourly background
 * counter refetch.
 *
 * @param {string} href  `location.href`.
 * @returns {string}
 */
export const buildLfResearchUrl = (href) =>
  href.split('?')[0] + '?page=ingame&component=lfresearch';

// ─── Discriminated union ──────────────────────────────────────────────────

/**
 * The button's computed state.
 *
 *   - `artifactsFull` — the artifact cap is reached (last lfresearch
 *                    reading has `current >= max`); discoveries can't yield
 *                    anything, so sending is pointless. One tap navigates
 *                    to the lfresearch page (where artifacts are spent —
 *                    and where the counter re-reads itself). Outranks every
 *                    other phase.
 *   - `checkArtifacts` — we have a prior lfresearch reading AND at least one
 *                    discovery was sent AFTER that reading (the count may have
 *                    climbed since then). One tap navigates to lfresearch to
 *                    refresh the counter before the session starts.
 *   - `offGalaxy`  — not on the galaxy component; one tap navigates there.
 *   - `discover`   — on galaxy, the viewed system needs discovery AND the
 *                    game's discover button is present (and clickable).
 *   - `blocked`    — on galaxy, the viewed system needs discovery but the
 *                    game's discover button is DISABLED (T11): the game
 *                    refuses discovery sends right now — all fleet slots
 *                    used being the canonical cause. A tap does nothing;
 *                    the 1 Hz ticker dissolves the state the moment the
 *                    game re-enables the control (a fleet returned).
 *   - `navigate`   — on galaxy, the viewed system is fresh but `target`
 *                    (the nearest stale system) still needs a discovery.
 *   - `allDone`    — on galaxy, nothing left to discover anywhere.
 *
 * `cooldown` overlays any phase (the post-click lock) and `scansRemaining`
 * rides along for the label. `target` is the nearest stale system in the
 * `navigate` phase (and the viewed system in `discover` / `blocked`).
 *
 * @typedef {(
 *   | { kind: 'artifactsFull', current: number, max: number, scansRemaining: number }
 *   | { kind: 'checkArtifacts', scansRemaining: number }
 *   | { kind: 'offGalaxy', scansRemaining: number }
 *   | { kind: 'discover', target: SystemCoords, cooldown: boolean, scansRemaining: number }
 *   | { kind: 'blocked', target: SystemCoords, scansRemaining: number }
 *   | { kind: 'navigate', target: SystemCoords, cooldown: boolean, scansRemaining: number }
 *   | { kind: 'allDone', cooldown: boolean, scansRemaining: number }
 * )} LfContext
 */

/**
 * Single-zone paint instruction (same shape sendCol uses).
 *
 * @typedef {{ text: string, bg: string, subtext?: string, hint?: string, dim?: boolean }} Paint
 */

/**
 * Input to {@link derive}. `home` / `view` arrive pre-read by the
 * orchestrator's `captureEnv` so this core stays DOM-free.
 *
 * @typedef {object} LfDeriveEnv
 * @property {string} search                `location.search` (with leading `?`).
 * @property {GalaxyScans} scans
 * @property {number} now                   epoch-ms.
 * @property {SystemCoords | null} home     active-planet coords, or null.
 * @property {SystemCoords | null} view     galaxy-view coords, or null (off galaxy).
 * @property {boolean} hasDiscoverBtn       is `#discoverSystemBtn` present in the DOM?
 * @property {boolean} [discoverBtnDisabled]
 *   Is the present `#discoverSystemBtn` DISABLED (`disabled` attribute /
 *   `.disabled` veil)? The game's signal that no discovery can be sent —
 *   all fleet slots used (T11) being the canonical cause. Absent ⇒ `false`.
 * @property {boolean} cooldown             post-click lock active?
 * @property {import('../../state/lifeformArtifacts.js').ArtifactReading | null} [artifacts]
 *   Last persisted artifact-counter reading, or null/absent when never read
 *   (absent ⇒ no cap gating — degrade to today's behaviour).
 * @property {number | null} [lastLfSentAt]
 *   Most recent `lfScannedAt` across all systems — epoch-ms of the last
 *   discovery send, or null when nothing has ever been sent.
 */

// ─── derive ─────────────────────────────────────────────────────────────────

/**
 * Pure `env → LfContext`.
 *
 * @param {LfDeriveEnv} env
 * @returns {LfContext}
 */
export const derive = (env) => {
  const scansRemaining = countLfRemaining(env.scans, env.now);

  // Artifact cap reached: the game can't yield more artifacts, so every
  // other phase is moot — gate the whole button until a fresh reading
  // (lfresearch visit or the hourly background refetch) drops below max.
  const a = env.artifacts;
  if (a && a.current >= a.max) {
    return { kind: 'artifactsFull', current: a.current, max: a.max, scansRemaining };
  }

  // Off galaxy: either navigate to lfresearch first (if a send happened after
  // the last counter reading — the wave may have brought artifacts), or go
  // directly to the galaxy component. The lfresearch redirect requires a
  // prior reading: without one we have no baseline, and forcing an lfresearch
  // visit on every fresh install would be annoying.
  if (!env.search.includes('component=galaxy')) {
    const lastSent = env.lastLfSentAt ?? null;
    const readAt = env.artifacts?.readAt ?? null;
    if (lastSent !== null && readAt !== null && lastSent > readAt) {
      return { kind: 'checkArtifacts', scansRemaining };
    }
    return { kind: 'offGalaxy', scansRemaining };
  }

  // On galaxy: prefer discovering the system the user is already looking at.
  if (env.view && isSystemLfStale(systemScan(env.scans, env.view), env.now)) {
    if (env.hasDiscoverBtn) {
      // The game disabled its discover control (T11) — sends are refused
      // (all fleet slots used / other game-side blocker). Surface it
      // instead of arming a click that cannot go anywhere.
      if (env.discoverBtnDisabled === true) {
        return { kind: 'blocked', target: env.view, scansRemaining };
      }
      return { kind: 'discover', target: env.view, cooldown: env.cooldown, scansRemaining };
    }
    // Stale but the game's discover control isn't in the DOM yet — treat as
    // a navigate to the same system so the button stays actionable (the
    // in-page submit re-renders the view + its discover button).
    return { kind: 'navigate', target: env.view, cooldown: env.cooldown, scansRemaining };
  }

  // Viewed system is fresh (or unknown view) — find the nearest stale one.
  const anchor = env.view ?? env.home;
  const target = anchor ? findNextLfSystem(env.scans, anchor, env.now) : null;
  if (target) {
    return { kind: 'navigate', target, cooldown: env.cooldown, scansRemaining };
  }
  return { kind: 'allDone', cooldown: env.cooldown, scansRemaining };
};

/**
 * Look up a system's scan record by coords.
 *
 * @param {GalaxyScans} scans
 * @param {SystemCoords} c
 * @returns {SystemScan | undefined}
 */
const systemScan = (scans, c) =>
  scans[/** @type {`${number}:${number}`} */ (`${c.galaxy}:${c.system}`)];

// ─── render ─────────────────────────────────────────────────────────────────

/**
 * Pure `LfContext → Paint`.
 *
 * @param {LfContext} ctx
 * @returns {Paint}
 */
export const render = (ctx) => {
  // No "N left" hint: for lifeforms there are always thousands of stale
  // systems, so the count carries no signal — it's just noise on the button.
  switch (ctx.kind) {
    case 'artifactsFull':
      // Dim + muted: a "nothing to do" state, not an error. The hint tells
      // the user the tap is still useful (jump to research to spend).
      return {
        text: 'Full',
        subtext: `${ctx.current} / ${ctx.max}`,
        hint: 'artifacts — tap: research',
        bg: BG_LF_DONE,
        dim: true,
      };
    case 'checkArtifacts':
      // A discovery was sent after the last counter reading: the wave may
      // have brought the count near or over the cap. Tap → lfresearch.
      return {
        text: 'Discover',
        subtext: 'check artifacts',
        bg: BG_LF_IDLE,
      };
    case 'offGalaxy':
      return { text: 'Discover', bg: BG_LF_IDLE };
    case 'discover':
      return {
        text: 'Discover',
        subtext: `[${ctx.target.galaxy}:${ctx.target.system}]`,
        bg: BG_LF_ACTIVE,
        dim: ctx.cooldown,
      };
    case 'blocked':
      // Same copy as the post-send fleet-cap transient ("Max fleets") so
      // the two faces of the condition read as one state. Dim — nothing
      // to do here; the ticker re-enables when the game does.
      return {
        text: 'Max fleets',
        subtext: `[${ctx.target.galaxy}:${ctx.target.system}]`,
        bg: BG_LF_ERROR,
        dim: true,
      };
    case 'navigate':
      return {
        text: 'Next',
        subtext: `[${ctx.target.galaxy}:${ctx.target.system}]`,
        bg: BG_LF_ACTIVE,
        dim: ctx.cooldown,
      };
    case 'allDone':
      return { text: 'All discovered!', bg: BG_LF_DONE };
  }
};
