// @ts-check

// Impure DOM readers for the dailyRun orchestrator.
// Everything that touches `document` / `location` lives here so `pure.js`
// stays Node-testable. Selectors used by ONLY this feature live here (per
// the gameDom invariant — shared ones like COORDS_ORIGIN/COORDS_DEST come
// from `lib/gameDom.js`).
//
// # Reading the current body (planet vs moon)
//
// We read OGame's standard per-page meta tags — `ogame-planet-coordinates`
// (`"g:s:p"`) and `ogame-planet-type` (`"planet"` | `"moon"`). They are
// present on every ingame page, which is exactly what "set collect target
// while on the staging moon" needs (it can fire from any page). When the
// meta tags are missing we fall back to the highlighted planet-row coords
// (type assumed planet) so coord lookups still work.

import { GAME } from '../../lib/gameDom.js';
import { findNextPlanetInList } from '../shared/planetList.js';
import { TARGET_PLANET, TARGET_MOON } from '../../domain/rules.js';
import { parseKoords } from '../../domain/bodies.js';
import { coordKey } from './pure.js';

// ─── Feature-local selectors / ids ──────────────────────────────────────

/** Inbound (non-return) fleet rows in the event ticker, ANY mission type.
 *  Callers filter by `data-mission-type` (read per row in {@link readInboundLegs}). */
const SEL_INBOUND_ROWS =
  '#eventContent tr.eventFleet[data-return-flight="false"]';
// OGame per-page meta tags for the active body live in `lib/gameDom.js`
// (GAME.META_PLANET_COORDS / GAME.META_PLANET_TYPE) — shared with manualFsMark.

/**
 * @typedef {import('../../state/dailyRunRoutes.js').TargetCoord} TargetCoord
 */

/**
 * Read the body the user is currently on, as `{galaxy,system,position,type}`.
 * Meta tags first (work on every page); falls back to the highlighted
 * planet row's coords (type assumed planet). `null` when nothing is
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
  // Fallback: highlighted planet-row coords (no moon signal here).
  const koords = document.querySelector(
    `${GAME.ACTIVE_PLANET} ${GAME.PLANET_KOORDS}`,
  )?.textContent;
  const c2 = parseKoords(koords);
  if (c2) return { ...c2, type: TARGET_PLANET };
  return null;
};

/**
 * Resolve a body's display name from the live planet sidebar by matching
 * `g:s:p`. Each `div.smallplanet` holds ONE planet (`.planet-name` span)
 * and optionally ONE moon (`a.moonlink img.icon-moon[alt]`). For planet
 * targets we return the `.planet-name` text; for moon targets we return
 * the moon image's `alt` (the name visible in the tooltip, e.g. "K1").
 * Falls back to the planet name when the moon image is absent. Returns
 * `null` when no matching row is found or the list isn't rendered.
 *
 * @param {TargetCoord | null | undefined} coord
 * @returns {string | null}
 */
export const bodyNameByCoord = (coord) => {
  if (!coord) return null;
  for (const row of document.querySelectorAll(GAME.SMALL_PLANET)) {
    const c = parseKoords(
      row.querySelector(GAME.PLANET_KOORDS)?.textContent,
    );
    if (
      c &&
      c.galaxy === coord.galaxy &&
      c.system === coord.system &&
      c.position === coord.position
    ) {
      if (coord.type === 3) {
        // Moon name is the alt of the moon image inside a.moonlink.
        const alt = row.querySelector(`${GAME.MOON_LINK} img.icon-moon`)?.getAttribute('alt')?.trim();
        return alt || row.querySelector(GAME.PLANET_NAME)?.textContent?.trim() || null;
      }
      return row.querySelector(GAME.PLANET_NAME)?.textContent?.trim() || null;
    }
  }
  return null;
};

/**
 * Read every inbound (non-return) fleet leg from the event ticker as
 * `{ origin, dest, mission }`. `origin` is `{g,s,p}` (or `null` when
 * unreadable); `dest` is a full {@link TargetCoord} (type from the dest
 * icon — `.destFleet figure.moon` ⇒ moon); `mission` is the row's
 * `data-mission-type` as a number (0 when absent/unparseable). Callers
 * filter by `mission` so a route's "already sent" guard matches that
 * route's own mission (deployment for collect, the route's mission for
 * micro) and isn't fooled by an unrelated inbound fleet.
 *
 * @returns {Array<{
 *   origin: { galaxy: number, system: number, position: number } | null,
 *   dest: TargetCoord,
 *   mission: number,
 * }>}
 */
export const readInboundLegs = () => {
  /** @type {Array<{ origin: any, dest: TargetCoord, mission: number }>} */
  const legs = [];
  const rows = document.querySelectorAll(SEL_INBOUND_ROWS);
  for (const row of rows) {
    const dest = parseKoords(row.querySelector(GAME.COORDS_DEST)?.textContent);
    if (!dest) continue;
    const fig = row.querySelector('.destFleet figure');
    const destType =
      fig && fig.classList.contains('moon') ? TARGET_MOON : TARGET_PLANET;
    const origin = parseKoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    const mission = parseInt(row.getAttribute('data-mission-type') || '', 10) || 0;
    legs.push({ origin, dest: { ...dest, type: destType }, mission });
  }
  return legs;
};

/**
 * Find the cp (planet id) of the next planet in `#planetList` order that
 * has NOT yet sent a deployment to the collect target — i.e. still needs
 * collecting. Walks forward from the active planet, wrapping. Skips the
 * collect target's own body. `null` when nothing is left.
 *
 * @param {Set<string>} collectedOriginKeys  {@link coordKey}s of planets
 *   that already have a deployment inbound to the collect target.
 * @param {string | null} targetCoordKey  {@link coordKey} of the collect
 *   target body (skip it as a source).
 * @returns {string | null} cp id, or `null`.
 */
export const findNextCollectPlanetCp = (collectedOriginKeys, targetCoordKey) =>
  findNextPlanetInList(
    (p) => {
      const coords = parseKoords(
        p.querySelector(GAME.PLANET_KOORDS)?.textContent,
      );
      if (!coords) return false;
      const key = coordKey(coords);
      return key !== targetCoordKey && !collectedOriginKeys.has(key);
    },
    { active: 'last' },
  );
