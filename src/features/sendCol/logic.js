// @ts-check

// Pure logic helpers for sendCol. Imported by the orchestrator file
// `./index.js`. Holds target-pick algorithms, DOM coord readers, URL
// builders, and the min-gap wait helper.
//
// Purity levels:
//   - `findNextScanSystem`, `findNextColonizeTarget`, `pickCandidateInView`,
//     `buildFleetdispatchUrl`, `buildGalaxyUrl`: pure (only `location.href`
//     origin read for URL builders).
//   - `readHomePlanet`, `parseCurrentGalaxyView`: DOM readers, no mutation.
//   - `getColonizeWaitTime`: impure — reads `#durationOneWay`,
//     `settingsStore`, `registryStore`, `localStorage` (diagnostic).
//
// sendCol reads `fleetDispatcher.targetPlanet` directly rather than
// parsing coords out of the fleetdispatch URL.

import { settingsStore } from '../../state/settings.js';
import { registryStore } from '../../state/registry.js';
import { safeLS } from '../../lib/storage.js';
import {
  sysDist,
  buildGalaxyOrder,
} from '../../domain/positions.js';
import { findConflict } from '../../domain/registry.js';
import { isSystemStale } from '../../domain/scheduling.js';
import {
  COL_MAX_SYSTEM,
  COL_MAX_GALAXY,
  MISSION_COLONIZE,
} from '../../domain/rules.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../state/scans.js').SystemScan} SystemScan
 * @typedef {import('../../domain/registry.js').RegistryEntry} RegistryEntry
 */

// ─── Pure target selection ─────────────────────────────────────────────────

/**
 * Find the next galaxy/system we should scan. Pure: inputs in, next
 * coord out, no DOM / storage / clock.
 *
 * Starting point:
 *   - when we are on the galaxy view → continue from current + 1
 *   - elsewhere                       → home.galaxy, home.system + 1
 *
 * Galaxy progression rolls through `buildGalaxyOrder(home.galaxy,
 * COL_MAX_GALAXY)` — home first, then outward — and within each galaxy
 * sweeps 1..COL_MAX_SYSTEM modularly. A system counts as "needs scan"
 * when there is no entry in `scans` for it OR the entry is stale per
 * {@link isSystemStale}.
 *
 * Returns `null` when every galaxy/system combination is already
 * scanned and fresh.
 *
 * @param {GalaxyScans} scans
 * @param {{ galaxy: number, system: number }} home
 * @param {{ galaxy: number, system: number } | null} currentView
 *   Current galaxy-view coords (null when the user isn't on the galaxy
 *   page — we then start from the home planet instead).
 * @returns {{ galaxy: number, system: number } | null}
 */
export const findNextScanSystem = (scans, home, currentView) => {
  const startG = currentView ? currentView.galaxy : home.galaxy;
  const startS = currentView ? currentView.system : home.system;

  const galaxyOrder = buildGalaxyOrder(home.galaxy, COL_MAX_GALAXY);
  const startGalaxyIdx = Math.max(0, galaxyOrder.indexOf(startG));

  for (let gi = 0; gi < galaxyOrder.length; gi++) {
    const g = galaxyOrder[(startGalaxyIdx + gi) % galaxyOrder.length];
    // Current galaxy: start at startS+1 (and wrap). Others: start at 1.
    const offset = gi === 0 ? startS : 0;
    for (let i = 0; i < COL_MAX_SYSTEM; i++) {
      const s = ((offset + i) % COL_MAX_SYSTEM) + 1;
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      const scan = scans[key];
      if (!scan || isSystemStale(scan)) {
        return { galaxy: g, system: s };
      }
    }
  }
  return null;
};

/**
 * Count how many systems across every galaxy still need a (re)scan —
 * i.e. have no entry in `scans` OR their entry is stale per
 * {@link isSystemStale}. Used by the Scan button label so the user can
 * see at a glance how far the scan-fresh frontier is from covering the
 * whole universe.
 *
 * Scope is 1..COL_MAX_SYSTEM × every galaxy (COL_MAX_GALAXY total = 7 ×
 * 499 = 3493 checks). Each check is a hash lookup + a couple of
 * integer comparisons, so the whole pass is well under a millisecond
 * on modern hardware — cheap enough to run from the 1 Hz refresh
 * ticker without caching.
 *
 * Pure: no DOM, no storage, no clock reads beyond what
 * {@link isSystemStale} does via its default `now` parameter.
 *
 * @param {GalaxyScans} scans
 * @returns {number} number of systems that would return a hit from
 *   {@link findNextScanSystem}. Zero means "everything fresh".
 */
export const countScansRemaining = (scans) => {
  let remaining = 0;
  for (let g = 1; g <= COL_MAX_GALAXY; g++) {
    for (let s = 1; s <= COL_MAX_SYSTEM; s++) {
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      const scan = scans[key];
      if (!scan || isSystemStale(scan)) remaining++;
    }
  }
  return remaining;
};

/**
 * Find the next colonization target in the local scan DB, respecting
 * the user's `colPositions` priority, the in-flight registry, and the
 * "prefer other galaxies first" toggle.
 *
 * Two-stage guard:
 *   1. `scan.positions[pos].status === 'empty'` — the game observed
 *      the slot empty (so `empty_sent` from prior fleets is filtered).
 *   2. `inFlight.has("g:s:pos")` — any entry in `registry` with
 *      `arrivalAt > now` blocks the same coord key. This is the
 *      second line of defence after `mergeScanResult`'s empty_sent
 *      preservation.
 *
 * Galaxy-order policy:
 *   - `preferOther=false` (default): [home, home+1, home-1, …]
 *   - `preferOther=true`: move home to the end — trades fast home
 *     sends for predictable min-gap timing across galaxies.
 *
 * Within a galaxy, the home galaxy is searched farthest-first (better
 * arrival spread), other galaxies are linear 1..499.
 *
 * @param {GalaxyScans} scans
 * @param {RegistryEntry[]} registry
 * @param {{ galaxy: number, system: number }} home
 * @param {number[]} targets  user's parsed `colPositions` list
 * @param {boolean} preferOther  move home galaxy to end of order
 * @returns {{ galaxy: number, system: number, position: number, link: string } | null}
 */
export const findNextColonizeTarget = (
  scans,
  registry,
  home,
  targets,
  preferOther,
) => {
  if (targets.length === 0) return null;

  const now = Date.now();
  const inFlight = new Set(
    registry.filter((r) => (r.arrivalAt || 0) > now).map((r) => r.coords),
  );

  let order = buildGalaxyOrder(home.galaxy, COL_MAX_GALAXY);
  if (preferOther && order.length > 1) {
    order = [...order.slice(1), order[0]];
  }

  for (const g of order) {
    // Home galaxy — farthest first; others — sequential 1..N.
    const systems =
      g === home.galaxy
        ? Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1).sort(
            (a, b) => sysDist(b, home.system) - sysDist(a, home.system),
          )
        : Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1);

    for (const s of systems) {
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      const scan = scans[key];
      if (!scan || !scan.positions) continue;
      for (const pos of targets) {
        const p = scan.positions[pos];
        if (!p || p.status !== 'empty') continue;
        const coordKey =
          /** @type {`${number}:${number}:${number}`} */ (`${g}:${s}:${pos}`);
        if (inFlight.has(coordKey)) continue;
        const base = location.href.split('?')[0];
        const link =
          base +
          `?page=ingame&component=fleetdispatch` +
          `&galaxy=${g}&system=${s}&position=${pos}` +
          `&type=1&mission=${MISSION_COLONIZE}&am208=1`;
        return { galaxy: g, system: s, position: pos, link };
      }
    }
  }
  return null;
};

/**
 * Pick the first free target position inside the galaxy view the user
 * is currently staring at. Pure: inputs in, coord out, no DOM / clock.
 *
 * Implements the "current-view priority" rule: when the user has just
 * scanned a system and is still on its galaxy
 * view, a matching free slot in THAT system takes precedence over the
 * global best candidate from `findNextColonizeTarget`. Gives immediate
 * visual feedback ("you see it, Send goes there") instead of bouncing
 * to some other galaxy.
 *
 * A position is a hit when both:
 *   - `scans[view.galaxy:view.system].positions[pos].status === 'empty'`
 *   - no registry entry with `arrivalAt > now` exists for the same
 *     `g:s:pos` coord key (same in-flight guard as findNextColonizeTarget).
 *
 * Priority is `targets[]` order — the caller passes the user's
 * `colPositions` preference list and we return the first index that
 * matches. Returns `null` when the view system is not in `scans`, has
 * no `positions` record, or every target slot is already inFlight.
 *
 * @param {GalaxyScans} scans
 * @param {RegistryEntry[]} registry
 * @param {number[]} targets  user's parsed `colPositions` list
 * @param {{ galaxy: number, system: number }} view  current galaxy-view coords
 * @param {number} now  epoch-ms "now" for inFlight filtering
 * @returns {{ galaxy: number, system: number, position: number } | null}
 */
export const pickCandidateInView = (scans, registry, targets, view, now) => {
  if (targets.length === 0) return null;
  const key = /** @type {`${number}:${number}`} */ (
    `${view.galaxy}:${view.system}`
  );
  const scan = scans[key];
  if (!scan || !scan.positions) return null;

  const inFlight = new Set(
    registry.filter((r) => (r.arrivalAt || 0) > now).map((r) => r.coords),
  );

  for (const pos of targets) {
    const p = scan.positions[pos];
    if (!p || p.status !== 'empty') continue;
    const coordKey =
      /** @type {`${number}:${number}:${number}`} */ (
        `${view.galaxy}:${view.system}:${pos}`
      );
    if (inFlight.has(coordKey)) continue;
    return { galaxy: view.galaxy, system: view.system, position: pos };
  }
  return null;
};

// ─── Min-gap wait helper (impure — reads DOM + stores) ────────────────────

/**
 * Compute the number of seconds we must wait before firing the current
 * fleetdispatch to keep min-gap with all pending colonize arrivals in
 * the registry. Zero = safe to send. Synchronous: reads
 * `#durationOneWay` from the DOM and the registry from
 * {@link registryStore}.
 *
 * Consolidated around the pure {@link findConflict} helper. The strict
 * "< minGap" semantics are what findConflict already enforces — so
 * this wrapper only has to handle the DOM parsing and the final
 * seconds-to-wait math.
 *
 * @returns {number} whole seconds to wait (`Math.ceil`), 0 when safe.
 */
export const getColonizeWaitTime = () => {
  const durEl = document.getElementById('durationOneWay');
  if (!durEl) return 0;
  const parts = (durEl.textContent ?? '').trim().split(':').map(Number);
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0;
  let durSec = 0;
  if (parts.length === 3) {
    durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 4) {
    durSec = parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  }
  if (!durSec) return 0;

  const now = Date.now();
  const ourArrival = now + durSec * 1000;
  const minGapMs = settingsStore.get().colMinGap * 1000;
  const registry = registryStore.get();
  const conflict = findConflict(registry, ourArrival, minGapMs);

  // Opt-in diagnostic. Flip `localStorage.oge_debugMinGap = 'true'`
  // in DevTools and the next Send click logs every input the
  // calculation used. Useful when the user reports "min-gap didn't
  // block even though arrivals coincided" — usually turns out to be a
  // registry entry with a malformed arrivalAt, a stale entry that
  // should have been pruned, or a durationOneWay that parsed to 0.
  if (safeLS.bool('oge_debugMinGap', false)) {
    const pending = registry
      .filter((r) => (Number(r.arrivalAt) || 0) > now)
      .map((r) => ({ coords: r.coords, arrivalAt: r.arrivalAt }));
    // eslint-disable-next-line no-console
    console.debug('[OG-E min-gap]', {
      durationSec: durSec,
      ourArrival,
      minGapMs,
      pending,
      conflict,
      resultWaitSec: conflict
        ? Math.max(
          0,
          Math.ceil((minGapMs - Math.abs(Number(conflict.arrivalAt) - ourArrival)) / 1000),
        )
        : 0,
    });
  }

  if (!conflict) return 0;
  const gap = Math.abs((Number(conflict.arrivalAt) || 0) - ourArrival);
  const waitMs = minGapMs - gap;
  if (waitMs <= 0) return 0;
  return Math.ceil(waitMs / 1000);
};

// ─── DOM coord readers ────────────────────────────────────────────────────

/**
 * Read the active planet's coords from `#planetList .hightlightPlanet`
 * (note the game's CSS-class typo). Returns `null` on a page that
 * doesn't carry the planet list (unexpected — we gracefully bail).
 *
 * @returns {{ galaxy: number, system: number } | null}
 */
export const readHomePlanet = () => {
  const active = document.querySelector('#planetList .hightlightPlanet');
  if (!active) return null;
  const coords = active.querySelector('.planet-koords')?.textContent?.trim();
  const m = (coords || '').match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return { galaxy: parseInt(m[1], 10), system: parseInt(m[2], 10) };
};

/**
 * Read the galaxy view's current `(galaxy, system)` from the DOM when
 * the user is on it, otherwise `null`.
 *
 * Prefer the live form inputs (`#galaxy_input`, `#system_input`) over
 * `location.search`. After AGR's in-page submit (`navigateGalaxyInPage`)
 * the URL stays at the initial-load coords, but the input values track
 * every subsequent scan target. Reading the URL here meant the second +
 * later scan clicks all picked up the same stale starting point and
 * looped.
 *
 * @returns {{ galaxy: number, system: number } | null}
 */
export const parseCurrentGalaxyView = () => {
  if (!location.search.includes('component=galaxy')) return null;
  const galInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('galaxy_input')
  );
  const sysInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('system_input')
  );
  const inputG = galInput ? parseInt(galInput.value, 10) : NaN;
  const inputS = sysInput ? parseInt(sysInput.value, 10) : NaN;
  if (Number.isFinite(inputG) && Number.isFinite(inputS)) {
    return { galaxy: inputG, system: inputS };
  }
  // Fallback to URL — covers the very first scan, before AGR has had
  // a chance to render the form inputs.
  const params = new URLSearchParams(location.search);
  const g = parseInt(params.get('galaxy') ?? '', 10);
  const s = parseInt(params.get('system') ?? '', 10);
  if (!Number.isFinite(g) || !Number.isFinite(s)) return null;
  return { galaxy: g, system: s };
};

// ─── URL builders ─────────────────────────────────────────────────────────

/**
 * Build the full fleetdispatch URL for a colonize mission: game origin
 * + `?page=ingame&component=fleetdispatch&galaxy=X&system=Y&position=Z
 * &type=1&mission=7&am208=1`. `type=1` preselects planet, `mission=7` is
 * colonize, `am208=1` auto-loads one colony ship.
 *
 * Origin comes from `location.href.split('?')[0]` so the built URL stays
 * on whatever host the user is playing on (pl/org/de/…) without the
 * caller having to know.
 *
 * Pure with respect to its arguments: the only external read is
 * `location.href`, which every page share a value for within a single
 * navigation.
 *
 * @param {{ galaxy: number, system: number, position: number }} coords
 * @returns {string}
 */
export const buildFleetdispatchUrl = ({ galaxy, system, position }) => {
  const base = location.href.split('?')[0];
  return (
    base +
    `?page=ingame&component=fleetdispatch` +
    `&galaxy=${galaxy}&system=${system}&position=${position}` +
    `&type=1&mission=${MISSION_COLONIZE}&am208=1`
  );
};

/**
 * Build the galaxy-view URL for a given `(galaxy, system)`: game origin
 * + `?page=ingame&component=galaxy&galaxy=X&system=Y`. Used by the Scan
 * handler for full-navigation fallback and by the stale-retry path.
 *
 * @param {{ galaxy: number, system: number }} coords
 * @returns {string}
 */
export const buildGalaxyUrl = ({ galaxy, system }) => {
  const base = location.href.split('?')[0];
  return (
    base +
    `?page=ingame&component=galaxy` +
    `&galaxy=${galaxy}&system=${system}`
  );
};
