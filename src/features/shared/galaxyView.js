// @ts-check

// Shared galaxy-view DOM reader, used by more than one feature (sendColony,
// sendLifeform). Lives in `features/shared/` — the sanctioned home for
// cross-feature game-DOM helpers (cf. `planetList.js`, `fleetOwnership.js`) —
// so neither feature has to keep a byte-identical copy (and no feature imports
// another). The fragile bit, the GAME SELECTORS, stays in `lib/gameDom.js`.
//
// NB: `readHomePlanet` is deliberately NOT hoisted here — sendColony and
// sendLifeform read the active body differently on MOON pages (sendColony falls
// back to `.hightlightMoon` and returns the moon's coords; sendLifeform returns
// null), so a shared version would silently change one feature's behaviour.
// Those stay as local copies until that divergence is reconciled on purpose.

import { GAME } from '../../lib/gameDom.js';

/**
 * Read the galaxy view's current `(galaxy, system)` from the DOM when the user
 * is on it, otherwise `null`.
 *
 * Prefer the live form inputs (`#galaxy_input`, `#system_input`) over
 * `location.search`. After AGR's in-page submit (`navigateGalaxyInPage`) the
 * URL stays at the initial-load coords, but the input values track every
 * subsequent scan target. Reading the URL here meant the second + later scan
 * clicks all picked up the same stale starting point and looped.
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
  // Fallback to URL — covers the very first scan, before AGR has had a chance
  // to render the form inputs.
  const params = new URLSearchParams(location.search);
  const g = parseInt(params.get('galaxy') ?? '', 10);
  const s = parseInt(params.get('system') ?? '', 10);
  if (!Number.isFinite(g) || !Number.isFinite(s)) return null;
  return { galaxy: g, system: s };
};
