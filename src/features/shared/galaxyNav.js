// @ts-check

// In-page galaxy navigation — fill the galaxy-view form inputs and click the
// game's own submit, so stepping to a system re-uses OGame's AJAX loader
// instead of a full page reload. Shared by sendLifeform (the discovery walk)
// and sendSpy (the galaxy-look proposal); the selectors live in lib/gameDom
// (they're a game contract read by 2+ features). One call = one navigation —
// callers keep the 1-tap-1-action contract.

import { GAME } from '../../lib/gameDom.js';

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
