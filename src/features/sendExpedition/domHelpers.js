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
//     `settingsStore.get().maxExpeditionsPerPlanet` + `.expSkipCoords` and
//     tests each planet with `countActiveExpeditions`; the `#planetList` walk
//     itself is the shared `findNextPlanetInList`
//     (`features/shared/planetList.js`).
//   - `isCoordsExpSkipped` / `isActiveBodyExpSkipped` / `isCpExpSkipped`: read
//     the same skip list against a row's `.planet-koords` — the standing
//     "never send expeditions from here" exclusion
//     (`domain/expeditionSkip.js`).
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
import { parseSkipCoords } from '../../domain/expeditionSkip.js';

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
 * The `#planetList` row a `cp` belongs to — the row whose own `planet-<n>` id
 * matches, or (for a MOON cp) the row whose moonlink carries it. `null` when
 * the player no longer owns that body.
 *
 * Shared by {@link isCpOnPlanetList} (anchor still exists?) and
 * {@link isCpExpSkipped} (anchor still eligible?) so the two can never
 * disagree about which row a remembered `cp` refers to.
 *
 * @param {number} cp
 * @returns {HTMLElement | null}
 */
const planetRowForCp = (cp) => {
  if (!(cp > 0)) return null;
  const own = document.getElementById(`planet-${cp}`);
  if (own) return /** @type {HTMLElement} */ (own);
  const rows = document.querySelectorAll(GAME.SMALL_PLANET);
  for (const row of rows) {
    const href = row.querySelector(GAME.MOON_LINK)?.getAttribute('href');
    if (!href) continue;
    try {
      if (new URL(href, location.href).searchParams.get('cp') === String(cp))
        return /** @type {HTMLElement} */ (row);
    } catch {
      // Malformed href — keep scanning the remaining rows.
    }
  }
  return null;
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
export const isCpOnPlanetList = (cp) => planetRowForCp(cp) !== null;

/**
 * The player's standing expedition skip list, as dense `g:s:p` coords. Read
 * per call (not cached) so a change in the settings panel takes effect on the
 * very next tap, exactly like `maxExpeditionsPerPlanet`.
 *
 * @returns {Set<string>}
 */
const skipSet = () => parseSkipCoords(settingsStore.get().expSkipCoords);

/**
 * Is this position on the player's skip list — a body the expedition wave must
 * never visit? Coords-keyed, so a skipped position covers its planet AND its
 * moon (same granularity the per-planet cap counts at).
 *
 * @param {string | null} coords  Dense `g:s:p`; `null` → `false` (unknown
 *   position is never treated as excluded — see {@link getActivePlanetCoords}).
 * @returns {boolean}
 */
export const isCoordsExpSkipped = (coords) =>
  coords !== null && skipSet().has(coords);

/**
 * Is the body the current page belongs to on the skip list? The gate the
 * click handler uses to hop straight off a planet the player has excluded,
 * instead of preparing a send the planet cannot fly.
 *
 * @returns {boolean}
 */
export const isActiveBodyExpSkipped = () =>
  isCoordsExpSkipped(getActivePlanetCoords());

/**
 * Is the remembered cycle anchor pointing at a skipped body? Reached when the
 * player excludes the planet a cycle used to start from (or manually sent a
 * cycle's first expedition from one) — the anchor then has to yield to the
 * ordinary free-slot walk rather than parking every cycle on a dead body.
 *
 * @param {number} cp
 * @returns {boolean}
 */
export const isCpExpSkipped = (cp) => {
  const row = planetRowForCp(cp);
  if (!row) return false;
  return isCoordsExpSkipped(
    denseCoords(row.querySelector(GAME.PLANET_KOORDS)?.textContent) || null,
  );
};

/**
 * Walk `#planetList .smallplanet` starting from the active planet and
 * return the `cp` of the first planet that has room for another
 * expedition (`count < settings.maxExpeditionsPerPlanet`) and is NOT on the
 * skip list.
 *
 * Wraps around the planet list, so a player whose active planet is the
 * last in the list still finds room on earlier entries. `null` when
 * every planet (save the active one, if `skipCurrent`) is maxed or skipped.
 *
 * Why the skip list is checked HERE and not only at the send: a planet kept
 * for something else (mining colony, deut farm) is under the cap all day, so
 * the walk parks the wave on it, the server refuses the send, and the second
 * pass over the planets that DO fly never happens. Excluding it from the walk
 * is what keeps the round-robin going. Same predicate as
 * `bridges/expeditionRedirect.js`'s hop, so the button and the post-send
 * redirect can never pick different bodies.
 *
 * @param {boolean} skipCurrent
 *   When `true`, skip the active planet itself — used from the click
 *   handler after the active planet is already known to be full.
 * @returns {number | null} `cp` of the first planet with room, or `null`.
 */
export const findPlanetWithExpSlot = (skipCurrent) => {
  const max = settingsStore.get().maxExpeditionsPerPlanet;
  const skipped = skipSet();
  const cp = findNextPlanetInList(
    (p) => {
      const coords = denseCoords(
        p.querySelector(GAME.PLANET_KOORDS)?.textContent,
      );
      if (!coords || skipped.has(coords)) return false;
      return countActiveExpeditions(coords) < max;
    },
    { active: skipCurrent ? 'skip' : 'first' },
  );
  if (cp === null) return null;
  const n = parseInt(cp, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
