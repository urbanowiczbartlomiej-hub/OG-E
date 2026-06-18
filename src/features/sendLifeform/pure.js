// @ts-check

// Pure compute core of `features/sendLifeform/index.js` — the lifeform
// "discover system" button. Mirrors the `sendColony/pure.js` split: this file
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
// @see ../sendColony/pure.js — the parallel colonization pure core.

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
// Seeded from the planted TODO in `sendColony/pure.js`. Distinct hue from the
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
 * dropped response. Matches `sendColony`'s `SCAN_COOLDOWN_MS`.
 */
export const DISCOVERY_COOLDOWN_MS = 8000;

// ─── Artifact cap ──────────────────────────────────────────────────────────

/**
 * How many discoveries we let fire AFTER the last counter reading before the
 * off-galaxy tap detours through lfresearch to refresh it. The counter is in
 * no request — the only way to read it is to land on the lfresearch page — so
 * we re-read it periodically rather than after every single send (which forced
 * a research-page visit on every wave) or never (which let it drift stale).
 * The cap is NEVER a hard block: discoveries keep going past `max`; this only
 * governs how often we bother refreshing the number we display.
 */
export const ARTIFACT_REFRESH_EVERY = 10;

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
 * Count systems discovered (their `lfScannedAt` stamped) strictly AFTER the
 * given epoch-ms — a proxy for "how many discoveries since the last artifact
 * reading", which drives the {@link ARTIFACT_REFRESH_EVERY} refresh detour.
 * `since === null` (never read) ⇒ 0, so a fresh install never force-detours.
 *
 * @param {GalaxyScans} scans
 * @param {number | null} since  epoch-ms of the last counter reading.
 * @returns {number}
 */
export const countLfSentSince = (scans, since) => {
  if (since === null) return 0;
  let n = 0;
  for (const scan of Object.values(scans)) {
    if (scan.lfScannedAt && scan.lfScannedAt > since) n++;
  }
  return n;
};

/**
 * Count systems across every galaxy that still need a discovery. Cheap
 * full-universe pass (7 × 499 hash lookups), run from the 1 Hz refresh for
 * the button's progress label — same pattern as
 * `sendColony/pure.js countScansRemaining`.
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
 * in its header. Used by the `checkArtifacts` tap (the periodic counter
 * refresh detour).
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
 *   - `checkArtifacts` — we have a prior lfresearch reading AND at least
 *                    {@link ARTIFACT_REFRESH_EVERY} discoveries were sent
 *                    AFTER it (the displayed count has drifted). One tap
 *                    navigates to lfresearch to refresh the counter. Only
 *                    raised OFF galaxy so an in-progress run is never
 *                    interrupted. Reaching the cap NEVER blocks sending —
 *                    `cap` (below) just rides along as a badge.
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
 * `cap` rides on EVERY phase: `{ current, max }` when the last reading is at
 * or over the artifact cap, else `null`. It is a non-blocking SIGNAL only —
 * the phase still drives a real send; render paints a badge over it.
 *
 * @typedef {{ current: number, max: number } | null} ArtifactCap
 *
 * @typedef {(
 *   | { kind: 'checkArtifacts', scansRemaining: number, cap: ArtifactCap }
 *   | { kind: 'offGalaxy', scansRemaining: number, cap: ArtifactCap }
 *   | { kind: 'discover', target: SystemCoords, cooldown: boolean, scansRemaining: number, cap: ArtifactCap }
 *   | { kind: 'blocked', target: SystemCoords, scansRemaining: number, cap: ArtifactCap }
 *   | { kind: 'navigate', target: SystemCoords, cooldown: boolean, scansRemaining: number, cap: ArtifactCap }
 *   | { kind: 'allDone', cooldown: boolean, scansRemaining: number, cap: ArtifactCap }
 * )} LfContext
 */

/**
 * Single-zone paint instruction (same shape sendColony uses).
 *
 * @typedef {{ text: string, bg: string, subtext?: string, hint?: string, dim?: boolean, capDot?: boolean }} Paint
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
 *   (absent ⇒ no cap badge and no refresh detour — the counter is unknown).
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

  // Non-blocking cap signal. Reaching `max` no longer gates anything — the
  // user keeps discovering past the cap on purpose (the game just overshoots,
  // e.g. 3609/3600); we only carry the numbers so render can badge them.
  const a = env.artifacts ?? null;
  /** @type {ArtifactCap} */
  const cap = a && a.current >= a.max ? { current: a.current, max: a.max } : null;

  // Off galaxy: detour through lfresearch to refresh the counter only once
  // enough discoveries have piled up since the last reading (the counter is
  // in no request — landing on that page is the only way to read it). A fresh
  // install (no reading) never force-detours. Otherwise go to the galaxy.
  if (!env.search.includes('component=galaxy')) {
    const readAt = a?.readAt ?? null;
    if (a && countLfSentSince(env.scans, readAt) >= ARTIFACT_REFRESH_EVERY) {
      return { kind: 'checkArtifacts', scansRemaining, cap };
    }
    return { kind: 'offGalaxy', scansRemaining, cap };
  }

  // On galaxy: prefer discovering the system the user is already looking at.
  if (env.view && isSystemLfStale(systemScan(env.scans, env.view), env.now)) {
    if (env.hasDiscoverBtn) {
      // The game disabled its discover control (T11) — sends are refused
      // (all fleet slots used / other game-side blocker). Surface it
      // instead of arming a click that cannot go anywhere.
      if (env.discoverBtnDisabled === true) {
        return { kind: 'blocked', target: env.view, scansRemaining, cap };
      }
      return { kind: 'discover', target: env.view, cooldown: env.cooldown, scansRemaining, cap };
    }
    // Stale but the game's discover control isn't in the DOM yet — treat as
    // a navigate to the same system so the button stays actionable (the
    // in-page submit re-renders the view + its discover button).
    return { kind: 'navigate', target: env.view, cooldown: env.cooldown, scansRemaining, cap };
  }

  // Viewed system is fresh (or unknown view) — find the nearest stale one.
  const anchor = env.view ?? env.home;
  const target = anchor ? findNextLfSystem(env.scans, anchor, env.now) : null;
  if (target) {
    return { kind: 'navigate', target, cooldown: env.cooldown, scansRemaining, cap };
  }
  return { kind: 'allDone', cooldown: env.cooldown, scansRemaining, cap };
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
  const base = renderPhase(ctx);
  // Non-blocking cap badge laid over whatever the phase shows: a dot (capDot)
  // plus the cap number, so the user KNOWS they're maxed while the button
  // still fires real sends. The "N+" reads "max reached, possibly over".
  // The number rides the bottom hint line when the phase already owns the
  // subtext (e.g. a `[g:s]` target); otherwise it takes the subtext itself.
  if (ctx.cap) {
    const label = `${ctx.cap.max}+`;
    base.capDot = true;
    if (base.subtext) base.hint = label;
    else base.subtext = label;
  }
  return base;
};

/**
 * The phase's base paint, before the cap badge overlay. Split out so {@link
 * render} can layer the non-blocking cap signal on top uniformly.
 *
 * No "N left" hint: for lifeforms there are always thousands of stale
 * systems, so the count carries no signal — it's just noise on the button.
 *
 * @param {LfContext} ctx
 * @returns {Paint}
 */
const renderPhase = (ctx) => {
  switch (ctx.kind) {
    case 'checkArtifacts':
      // Enough discoveries have fired since the last reading that the shown
      // count has drifted — tap detours to lfresearch to refresh it.
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
