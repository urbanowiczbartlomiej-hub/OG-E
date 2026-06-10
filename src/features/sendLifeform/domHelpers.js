// @ts-check

// Impure DOM helpers for the Lifeforms feature — coord readers, the
// in-page galaxy-form navigation, and the game discover-button click.
// Every export here touches the live page; the pure compute core
// (`derive`, `render`, target pickers) lives in `./pure.js`.
//
// These coord readers are deliberately LOCAL copies of the equivalents in
// `sendCol/domHelpers.js` rather than a shared import: CLAUDE.md's layering
// forbids one feature importing another. The fragile bit — the GAME
// SELECTORS — is centralized in `lib/gameDom.js` (so a game rename is a
// one-line fix); only the thin wrapper functions are duplicated, which the
// rule explicitly tolerates ("functions aren't the contract, selectors are").
//
// @see ./pure.js  — pure core that consumes `home` / `view`.
// @see ./index.js — orchestrator; `captureEnv()` is the bridge.

import { safeClick } from '../../lib/dom.js';
import { GAME } from '../../lib/gameDom.js';

/**
 * Id of the game's "Discover system" control on the galaxy view. Clicking
 * it makes the GAME issue the `sendSystemDiscoveryFleet` request — we never
 * originate it. Single-feature selector, so it stays local (per gameDom's
 * scope rules) rather than in `lib/gameDom.js`.
 */
export const DISCOVER_BTN_ID = 'discoverSystemBtn';

/**
 * Read the active planet's `(galaxy, system)` from
 * `#planetList .hightlightPlanet` (the game's CSS-class typo is intentional).
 * Returns `null` on a page without the planet list.
 *
 * @returns {{ galaxy: number, system: number } | null}
 */
export const readHomePlanet = () => {
  const active = document.querySelector(GAME.ACTIVE_PLANET);
  if (!active) return null;
  // On moon pages the highlight class sits on the moonlink <a>; climb to the
  // `.smallplanet` row first so `.planet-koords` resolves reliably.
  const row = active.closest('.smallplanet') ?? active;
  const coords = row.querySelector(GAME.PLANET_KOORDS)?.textContent?.trim();
  const m = (coords || '').match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return { galaxy: parseInt(m[1], 10), system: parseInt(m[2], 10) };
};

/**
 * Read the galaxy view's current `(galaxy, system)` when the user is on it,
 * else `null`. Prefers the live form inputs (which track in-page submits)
 * over `location.search` (which stays at the initial-load coords) — same
 * reasoning as `sendCol/domHelpers.js parseCurrentGalaxyView`.
 *
 * @returns {{ galaxy: number, system: number } | null}
 */
export const parseCurrentGalaxyView = () => {
  if (!location.search.includes('component=galaxy')) return null;
  const galInput = /** @type {HTMLInputElement | null} */ (
    document.querySelector(GAME.GALAXY_INPUT)
  );
  const sysInput = /** @type {HTMLInputElement | null} */ (
    document.querySelector(GAME.SYSTEM_INPUT)
  );
  const inputG = galInput ? parseInt(galInput.value, 10) : NaN;
  const inputS = sysInput ? parseInt(sysInput.value, 10) : NaN;
  if (Number.isFinite(inputG) && Number.isFinite(inputS)) {
    return { galaxy: inputG, system: inputS };
  }
  const params = new URLSearchParams(location.search);
  const g = parseInt(params.get('galaxy') ?? '', 10);
  const s = parseInt(params.get('system') ?? '', 10);
  if (!Number.isFinite(g) || !Number.isFinite(s)) return null;
  return { galaxy: g, system: s };
};

/**
 * Update the galaxy-view form inputs and submit for a fast in-page nav to
 * `(galaxy, system)`. Returns `true` when the submit control was found +
 * clicked; `false` so the caller can fall back to a full-page navigation.
 *
 * @param {number} galaxy
 * @param {number} system
 * @returns {boolean}
 */
export const navigateGalaxyInPage = (galaxy, system) => {
  const galInput = /** @type {HTMLInputElement | null} */ (
    document.querySelector(GAME.GALAXY_INPUT)
  );
  const sysInput = /** @type {HTMLInputElement | null} */ (
    document.querySelector(GAME.SYSTEM_INPUT)
  );
  if (!sysInput) return false;
  if (galInput) galInput.value = String(galaxy);
  sysInput.value = String(system);
  const submitBtn = /** @type {HTMLElement | null} */ (
    document.querySelector(GAME.GALAXY_SUBMIT) ??
      document.querySelector(GAME.GALAXY_SUBMIT_FALLBACK)
  );
  if (submitBtn) {
    submitBtn.click();
    return true;
  }
  return false;
};

/**
 * Is the game's discover-system control present in the DOM right now?
 *
 * @returns {boolean}
 */
export const hasDiscoverButton = () =>
  document.getElementById(DISCOVER_BTN_ID) !== null;

/**
 * Click the game's discover-system control (the game then fires
 * `sendSystemDiscoveryFleet`). Returns `true` if the control existed.
 *
 * @returns {boolean}
 */
export const clickDiscover = () => {
  const btn = document.getElementById(DISCOVER_BTN_ID);
  if (!btn) return false;
  safeClick(btn);
  return true;
};
