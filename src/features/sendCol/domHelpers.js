// @ts-check

// Impure helpers for sendCol — DOM readers + the min-gap wait
// computation. Every export here touches the live page (DOM, settings
// store, registry store, or `localStorage`); the pure compute core
// (`derive`, `render`, target pickers, URL builders) lives in
// `./pure.js` instead.
//
// Why a sibling file instead of inlining into `./index.js`:
//   - `index.js` is the orchestrator (mount, dispose, subscriptions,
//     1 Hz ticker). Mixing in DOM/store readers blurs the boundary
//     between "wire-up" and "data extraction".
//   - Each helper here has a single, easily-testable concern and a
//     small surface — they fit naturally as standalone exports.
//   - `index.js`'s `captureEnv()` calls `readHomePlanet` and
//     `parseCurrentGalaxyView` to assemble the `DeriveEnv` that feeds
//     `pure.derive`. The wait helper is called from the Send click
//     handler, not from `derive`.
//
// Purity classification (mirrors `./pure.js`'s "what we don't do" rule):
//   - `getColonizeWaitTime`: reads `#durationOneWay` from the DOM,
//     `settingsStore`, `registryStore`, and `safeLS` (for the opt-in
//     debug flag). Returns whole seconds to wait.
//   - `readHomePlanet`: reads `#planetList .hightlightPlanet` (the
//     game's CSS-class typo is intentional — that's the actual class).
//   - `parseCurrentGalaxyView`: reads `#galaxy_input` / `#system_input`
//     when present, falls back to `location.search`.
//
// @see ./pure.js  — pure compute core that consumes the env these
//                    readers help build.
// @see ./index.js — orchestrator; `captureEnv()` is the bridge.

import { settingsStore } from '../../state/settings.js';
import { registryStore } from '../../state/registry.js';
import { safeLS } from '../../lib/storage.js';
import { findConflict } from '../../domain/registry.js';

// ─── Min-gap wait helper ──────────────────────────────────────────────────

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
