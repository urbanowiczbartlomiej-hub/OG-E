// @ts-check

// Impure DOM readers for sendExpedition — the expedition-cap walk over the
// planet list + event box. Every export here touches the live page (the
// `#planetList` rows, the `#eventContent` fleet table, and the settings
// store); the pure compute core (constants, URL builder, cap checks,
// initial-label decision) lives in `./pure.js` instead. Coord normalization
// (`denseCoords`) is shared from `domain/bodies.js`.
//
// Why a sibling file instead of inlining into `./index.js` (mirrors
// `sendColony/domHelpers.js` + `sendLifeform/domHelpers.js`):
//   - `index.js` is the orchestrator (install/dispose, the click-handler
//     state machine, the eventbox gate, the fleetDispatcher snapshot
//     listener). Mixing the DOM readers in blurs "wire-up" vs "data
//     extraction".
//   - Each reader here has a single, easily-testable concern and a small
//     surface — they fit naturally as standalone exports (and now carry
//     their own focused coverage in `test/features/sendExpeditionHelpers.test.js`).
//
// Purity classification (what these readers touch):
//   - `getActivePlanetCoords`: reads `#planetList .hightlightPlanet`
//     (the game's CSS-class typo is intentional — that's the live class,
//     centralized as `GAME.ACTIVE_PLANET`) and its `.planet-koords` child.
//   - `countActiveExpeditions`: reads the in-flight expedition rows in
//     `#eventContent` (mission-type 15) and their `.coordsOrigin` cells.
//   - `findPlanetWithExpSlot`: reads
//     `settingsStore.get().maxExpeditionsPerPlanet` and tests each planet
//     with `countActiveExpeditions`; the `#planetList` walk itself is the
//     shared `findNextPlanetInList` (`features/shared/planetList.js`).
//
// The `#eventContent tr.eventFleet[data-mission-type="15"]` selector is
// single-feature (only sendExpedition filters in-flight expeditions this way), so
// per `gameDom.js`'s scope rules it stays local here rather than hoisted.
//
// @see ./pure.js  — pure compute core (URL builder, caps).
// @see ./index.js — orchestrator; the click handler consumes these readers.

import { settingsStore } from '../../state/settings.js';
import { GAME } from '../../lib/gameDom.js';
import { findNextPlanetInList } from '../shared/planetList.js';
import { denseCoords } from '../../domain/bodies.js';

/**
 * Read the currently-active planet's coords from `#planetList`. Returns
 * `null` when the highlight marker or its coords span is missing — the
 * caller treats that as "can't filter, fall back to global count".
 *
 * @returns {string | null}  `"g:s:p"` without brackets, or `null`.
 */
export const getActivePlanetCoords = () => {
  const planet = document.querySelector(GAME.ACTIVE_PLANET);
  if (!planet) return null;
  const coordsEl = planet.querySelector(GAME.PLANET_KOORDS);
  const coords = denseCoords(coordsEl?.textContent);
  return coords || null;
};

/**
 * Count currently in-flight expeditions, filtered to those whose origin
 * matches the active planet. The per-planet limit is enforced via the
 * dots painted by the badges feature on each planet row.
 *
 * When the active planet's coords can't be read (`originCoords === null`)
 * we fall back to counting every expedition in `#eventContent` — safer
 * to over-report and show "All maxed!" than under-report and let the
 * user blow past their configured cap.
 *
 * @param {string | null} originCoords
 *   Active-planet coords in `g:s:p` form. Pass `null` to count globally.
 * @returns {number}
 */
export const countActiveExpeditions = (originCoords) => {
  const rows = document.querySelectorAll(
    '#eventContent tr.eventFleet[data-mission-type="15"]',
  );
  if (originCoords === null) return rows.length;
  let count = 0;
  for (const row of rows) {
    const c = denseCoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    if (c === originCoords) count += 1;
  }
  return count;
};

/**
 * Walk `#planetList .smallplanet` starting from the active planet and
 * return the `cp` of the first planet that has room for another
 * expedition (`count < settings.maxExpeditionsPerPlanet`).
 *
 * Wraps around the planet list, so a player whose active planet is the
 * last in the list still finds room on earlier entries. `null` when
 * every planet (save the active one, if `skipCurrent`) is maxed.
 *
 * @param {boolean} skipCurrent
 *   When `true`, skip the active planet itself — used from the click
 *   handler after the active planet is already known to be full.
 * @returns {number | null} `cp` of the first planet with room, or `null`.
 */
export const findPlanetWithExpSlot = (skipCurrent) => {
  const max = settingsStore.get().maxExpeditionsPerPlanet;
  const cp = findNextPlanetInList(
    (p) => {
      const coords = denseCoords(
        p.querySelector(GAME.PLANET_KOORDS)?.textContent,
      );
      return !!coords && countActiveExpeditions(coords) < max;
    },
    { active: skipCurrent ? 'skip' : 'first' },
  );
  if (cp === null) return null;
  const n = parseInt(cp, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
