// @ts-check

// Impure DOM helpers for the Lifeforms feature — coord readers, the
// in-page galaxy-form navigation, and the game discover-button click.
// Every export here touches the live page; the pure compute core
// (`derive`, `render`, target pickers) lives in `./pure.js`.
//
// These coord readers are deliberately LOCAL copies of the equivalents in
// `sendColony/domHelpers.js` rather than a shared import: CLAUDE.md's layering
// forbids one feature importing another. The fragile bit — the GAME
// SELECTORS — is centralized in `lib/gameDom.js` (so a game rename is a
// one-line fix); only the thin wrapper functions are duplicated, which the
// rule explicitly tolerates ("functions aren't the contract, selectors are").
//
// @see ./pure.js  — pure core that consumes `home` / `view`.
// @see ./index.js — orchestrator; `captureEnv()` is the bridge.

import { safeClick } from '../../lib/dom.js';
import { GAME } from '../../lib/gameDom.js';
import { parseArtifactCounter } from './pure.js';

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
 * reasoning as `sendColony/domHelpers.js parseCurrentGalaxyView`.
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
 * Is the game's discover-system control present but DISABLED? The game
 * marks the unavailable state (all fleet slots used, or any other blocker)
 * with a `disabled="disabled"` attribute on the control plus an inner
 * `<div class="disabled">` veil — we accept either signal. AGR hides the
 * native control behind its own clone (`#ago_discovery`), but the native
 * node stays in the DOM with its state, so this read works under AGR too.
 *
 * Absent control ⇒ `false` ("not disabled" — presence is a separate
 * question answered by {@link hasDiscoverButton}).
 *
 * @returns {boolean}
 */
export const isDiscoverButtonDisabled = () => {
  const btn = document.getElementById(DISCOVER_BTN_ID);
  if (!btn) return false;
  return btn.hasAttribute('disabled') || btn.querySelector('.disabled') !== null;
};

/**
 * Click the game's discover-system control (the game then fires
 * `sendSystemDiscoveryFleet`). Returns `true` if the control existed and
 * was clicked. A DISABLED control is never clicked — the game would
 * ignore it and the caller would burn its post-click cooldown waiting
 * for a result that cannot come.
 *
 * @returns {boolean}
 */
export const clickDiscover = () => {
  const btn = document.getElementById(DISCOVER_BTN_ID);
  if (!btn || isDiscoverButtonDisabled()) return false;
  safeClick(btn);
  return true;
};

/**
 * Where the artifact counter lives on the lfresearch page: the header
 * slot div (`<div id="slot01" class="slot">Zebrane artefakty: N / M</div>`).
 * We anchor on the structural `header .slot` rather than the `slot01` id so
 * a second slot appearing some day doesn't silently break the read — the
 * number-pair parser ignores slots without an `N / M` counter anyway.
 * Single-feature selector → stays local (per gameDom's scope rules).
 */
const LF_ARTIFACT_SLOT_SELECTOR = '#lfresearch header .slot';

/**
 * Read the artifact counter (`current / max`) from the live lfresearch
 * page DOM. Scans every header slot and returns the first that parses;
 * `null` when the page has no counter (e.g. lifeforms disabled on the
 * account) or when called outside a browser context (node tests).
 *
 * @returns {{ current: number, max: number } | null}
 */
export const readArtifactCounter = () => {
  if (typeof document === 'undefined') return null;
  const slots = document.querySelectorAll(LF_ARTIFACT_SLOT_SELECTOR);
  for (const slot of slots) {
    const parsed = parseArtifactCounter(slot.textContent);
    if (parsed) return parsed;
  }
  return null;
};
