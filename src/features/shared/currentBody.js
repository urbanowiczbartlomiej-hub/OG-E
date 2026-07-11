// @ts-check

// Shared "which body am I standing on?" reader — coords AND planet-vs-moon
// type. Used by features that must not act on the wrong body (dailyRun's
// collect walk, the alarmClock guardian's fleet-save gate).
//
// # Reading the current body (planet vs moon)
//
// We read OGame's standard per-page meta tags — `ogame-planet-coordinates`
// (`"g:s:p"`) and `ogame-planet-type` (`"planet"` | `"moon"`). They are
// present on every ingame page, which is exactly what "set collect target
// while on the staging moon" needs (it can fire from any page). When the
// meta tags are missing we fall back to the highlighted planet-list row:
// `.hightlightPlanet` (planet pages) or `.hightlightMoon` (moon pages —
// the game swaps the class, see `lib/gameDom.js`), the row's own class
// supplying the type.

import { GAME } from '../../lib/gameDom.js';
import { TARGET_PLANET, TARGET_MOON } from '../../domain/rules.js';
import { parseKoords } from '../../domain/bodies.js';

/**
 * @typedef {import('../../state/dailyRunRoutes.js').TargetCoord} TargetCoord
 */

/**
 * Read the body the user is currently on, as `{galaxy,system,position,type}`.
 * Meta tags first (work on every page); falls back to the highlighted
 * planet-list row (planet or moon variant). `null` when nothing is
 * readable.
 *
 * @returns {TargetCoord | null}
 */
export const readCurrentBody = () => {
  const coordsMeta = document
    .querySelector(GAME.META_PLANET_COORDS)
    ?.getAttribute('content');
  const c = parseKoords(coordsMeta);
  if (c) {
    const typeMeta = document
      .querySelector(GAME.META_PLANET_TYPE)
      ?.getAttribute('content');
    const type = typeMeta === 'moon' ? TARGET_MOON : TARGET_PLANET;
    return { ...c, type };
  }
  // Fallback: the highlighted row. `.hightlightPlanet` ⇒ on the planet;
  // `.hightlightMoon` ⇒ on its moon (same row, different class).
  const planetRow = document.querySelector(GAME.ACTIVE_PLANET);
  const row = planetRow ?? document.querySelector(GAME.ACTIVE_MOON_ROW);
  const c2 = parseKoords(row?.querySelector(GAME.PLANET_KOORDS)?.textContent);
  if (c2) return { ...c2, type: planetRow ? TARGET_PLANET : TARGET_MOON };
  return null;
};
