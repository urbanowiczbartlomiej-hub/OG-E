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
//   - `getActivePlanetCoords`: reads the active `#planetList` row —
//     `.hightlightPlanet` on planet pages, `.hightlightMoon` on moon pages
//     (the game's CSS-class typos are intentional — those are the live
//     classes, centralized as `GAME.ACTIVE_PLANET` / `GAME.ACTIVE_MOON_ROW`)
//     — and its `.planet-koords` child.
//   - `countActiveExpeditions`: reads the RETURN rows of in-flight expeditions
//     in `#eventContent` (mission-type 15) and their `.coordsOrigin` cell (one
//     such row per expedition, for its whole round trip — see there).
//   - `getActiveBodyCp` / `isCpOnPlanetList`: read the `#planetList` rows
//     (their `planet-<n>` ids and moonlink `cp`s) for the cycle-anchor
//     memory — recording / validating the remembered expedition start body.
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
 * Read the currently-active body's coords from `#planetList`. Returns
 * `null` when the highlight marker or its coords span is missing — the
 * caller treats that as "can't filter, fall back to global count".
 *
 * BOTH highlight classes count. The game marks the active row
 * `hightlightPlanet` on planet pages and swaps it for `hightlightMoon` on moon
 * pages (its own misspellings — see `lib/gameDom.js`). Matching only the
 * planet class left every MOON page with no coords at all, and the caller's
 * `null` fallback then compared the ACCOUNT-WIDE expedition count against the
 * per-planet cap: with the cap at 2, any two expeditions in flight anywhere
 * made every moon look full, so a moon-launched cycle bounced from body to
 * body and landed on "All sent" without sending. A moon shares its planet's
 * `g:s:p`, so one `.planet-koords` read serves both.
 *
 * @returns {string | null}  `"g:s:p"` without brackets, or `null`.
 */
export const getActivePlanetCoords = () => {
  const planet =
    document.querySelector(GAME.ACTIVE_PLANET) ||
    document.querySelector(GAME.ACTIVE_MOON_ROW);
  if (!planet) return null;
  const coordsEl = planet.querySelector(GAME.PLANET_KOORDS);
  const coords = denseCoords(coordsEl?.textContent);
  return coords || null;
};

/**
 * Count currently in-flight expeditions launched from the given body — every
 * phase counts (outbound, holding at the expedition point, on the way home),
 * because the expedition holds its planet's slot until it lands. That is how the
 * game bills it in its own `Expeditions: n/max`.
 *
 * # One expedition = one RETURN row (the rule this hinges on)
 *
 * An expedition is a two-way mission, so the game writes BOTH of its rows the
 * moment it is dispatched: an outbound (`data-return-flight="false"`) and a
 * return (`"true"`). The outbound row disappears when the fleet reaches the
 * expedition point, while the return row lives from dispatch until the fleet is
 * home — so the return row, and only it, is present exactly once per in-flight
 * expedition through every phase. Coords are direction-STABLE: both rows read
 * `origin = the launcher`, `dest = [g:s:16]`, and a return leg does NOT swap
 * them. See `docs/ogame-fleet-mechanics.md` § "Event list" for the mechanics
 * this follows from.
 *
 * Two wrong models this replaced, both plausible, both measured against a live
 * ticker and both wrong:
 *
 *   1. *"One expedition = one row, identified by its origin cell."* Counting
 *      rows double-counts every expedition that is still outbound (2 rows), so
 *      with the per-planet cap at 2 a single expedition per planet already read
 *      as "full": the button painted "All sent" after one round-robin pass with
 *      half the account's expedition slots free. This is the bug users hit.
 *   2. *"Attribute each leg to the body at its home end (origin going out, dest
 *      coming back)."* It happens to be right while every expedition is still
 *      flying out, which is why it looked correct — but the coords never swap,
 *      so a fleet holding at the point (outbound row gone, return row's dest is
 *      `[g:s:16]`) counts as ZERO and the planet silently frees its slot.
 *
 * When the active planet's coords can't be read (`originCoords === null`)
 * we fall back to counting every expedition in `#eventContent` — safer
 * to over-report and show "All sent" than under-report and let the
 * user blow past their configured cap.
 *
 * @param {string | null} originCoords
 *   Launching body's coords in `g:s:p` form. Pass `null` to count globally.
 * @returns {number}
 */
export const countActiveExpeditions = (originCoords) => {
  const rows = document.querySelectorAll(
    '#eventContent tr.eventFleet[data-mission-type="15"][data-return-flight="true"]',
  );
  if (originCoords === null) return rows.length;
  let count = 0;
  for (const row of rows) {
    const from = denseCoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    if (from === originCoords) count += 1;
  }
  return count;
};

/**
 * Read the `cp` id of the body the current page belongs to — the planet row's
 * own `planet-<n>` id, or, on a MOON page, the `cp` off that row's moonlink.
 *
 * Why not just read `cp` off `location.search`: a bare fleetdispatch URL
 * carries no `cp` at all (the game falls back to the session's current body),
 * so the URL is not a reliable source. The highlighted `#planetList` row is —
 * the game marks exactly one, with its own misspelled classes (see
 * `lib/gameDom.js`), and swaps `hightlightPlanet` for `hightlightMoon` when the
 * page is a moon. Recording the MOON's cp when the expedition left from a moon
 * keeps the anchor honest: the next cycle resumes on the same moon, matching
 * what `bridges/expeditionRedirect.js` does for its mid-cycle hops.
 *
 * @returns {number} `cp` of the active body, or `0` when it can't be read.
 */
export const getActiveBodyCp = () => {
  const moonRow = document.querySelector(GAME.ACTIVE_MOON_ROW);
  if (moonRow) {
    const href = moonRow.querySelector(GAME.MOON_LINK)?.getAttribute('href');
    if (!href) return 0;
    try {
      const cp = parseInt(
        new URL(href, location.href).searchParams.get('cp') || '',
        10,
      );
      return Number.isFinite(cp) && cp > 0 ? cp : 0;
    } catch {
      return 0;
    }
  }
  const planetRow = document.querySelector(GAME.ACTIVE_PLANET);
  const cp = parseInt((planetRow?.id || '').replace('planet-', ''), 10);
  return Number.isFinite(cp) && cp > 0 ? cp : 0;
};

/**
 * Is `cp` still a body the player owns — i.e. a planet row on `#planetList`
 * or one of its moonlinks? Guards the remembered expedition anchor against a
 * planet that has since been abandoned, sold or lost: a stale id would send
 * the tap to a fleetdispatch page for a body that no longer exists.
 *
 * @param {number} cp
 * @returns {boolean}
 */
export const isCpOnPlanetList = (cp) => {
  if (!(cp > 0)) return false;
  if (document.getElementById(`planet-${cp}`)) return true;
  const moons = document.querySelectorAll(
    `${GAME.SMALL_PLANET} ${GAME.MOON_LINK}`,
  );
  for (const moon of moons) {
    const href = moon.getAttribute('href');
    if (!href) continue;
    try {
      if (new URL(href, location.href).searchParams.get('cp') === String(cp))
        return true;
    } catch {
      // Malformed href — keep scanning the remaining rows.
    }
  }
  return false;
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
