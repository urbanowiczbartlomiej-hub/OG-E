// @ts-check

// Impure DOM readers for the dailyRun orchestrator.
// Everything that touches `document` / `location` lives here so `pure.js`
// stays Node-testable. Selectors used by ONLY this feature live here (per
// the gameDom invariant — shared ones like COORDS_ORIGIN/COORDS_DEST come
// from `lib/gameDom.js`).
//
// The current-body reader (meta tags → highlighted-row fallback) lives in
// `../shared/currentBody.js` (shared with the alarmClock guardian) and is
// re-exported here so this feature's call-sites keep one import path.

import { GAME } from '../../lib/gameDom.js';
import { findNextPlanetInList } from '../shared/planetList.js';
import { TARGET_PLANET, TARGET_MOON } from '../../domain/rules.js';
import { parseKoords } from '../../domain/bodies.js';
import { coordTypeKey } from './pure.js';

export { readCurrentBody } from '../shared/currentBody.js';

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
        // Moon name = the moon icon's `alt` inside a.moonlink (the game puts
        // no class on that <img> — same reader as planetBarCapture).
        const alt = row.querySelector(`${GAME.MOON_LINK} img`)?.getAttribute('alt')?.trim();
        return alt || row.querySelector(GAME.PLANET_NAME)?.textContent?.trim() || null;
      }
      return row.querySelector(GAME.PLANET_NAME)?.textContent?.trim() || null;
    }
  }
  return null;
};

/**
 * Read every inbound (non-return) fleet leg from the event ticker as
 * `{ origin, dest, mission }`. `origin` and `dest` are full
 * {@link TargetCoord}s (type from each side's body icon — a
 * `figure.moon` inside `.originFleet` / `.destFleet` ⇒ moon), `origin`
 * `null` when unreadable; `mission` is the row's `data-mission-type` as a
 * number (0 when absent/unparseable). Callers filter by `mission` so a
 * route's "already sent" guard matches that route's own mission
 * (deployment for collect, the route's mission for micro) and isn't
 * fooled by an unrelated inbound fleet.
 *
 * @returns {Array<{
 *   origin: TargetCoord | null,
 *   dest: TargetCoord,
 *   mission: number,
 * }>}
 */
export const readInboundLegs = () => {
  /** @type {Array<{ origin: TargetCoord | null, dest: TargetCoord, mission: number }>} */
  const legs = [];
  const rows = document.querySelectorAll(SEL_INBOUND_ROWS);
  for (const row of rows) {
    const dest = parseKoords(row.querySelector(GAME.COORDS_DEST)?.textContent);
    if (!dest) continue;
    const destFig = row.querySelector('.destFleet figure');
    const destType =
      destFig && destFig.classList.contains('moon') ? TARGET_MOON : TARGET_PLANET;
    const o = parseKoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    const originFig = row.querySelector(`${GAME.ORIGIN_FLEET} figure`);
    const originType =
      originFig && originFig.classList.contains('moon') ? TARGET_MOON : TARGET_PLANET;
    const origin = o ? { ...o, type: originType } : null;
    const mission = parseInt(row.getAttribute('data-mission-type') || '', 10) || 0;
    legs.push({ origin, dest: { ...dest, type: destType }, mission });
  }
  return legs;
};

/** `cp` param of a planet-list link's href, or `null`.
 * @param {string | null | undefined} href */
const cpFromHref = (href) => {
  if (!href) return null;
  try {
    return new URL(href, location.href).searchParams.get('cp');
  } catch {
    return null;
  }
};

/**
 * Find the cp of the next body in `#planetList` order that has NOT yet
 * sent a deployment to the collect target — i.e. still needs collecting.
 * Walks forward from the active row, wrapping. Skips the collect target's
 * own body — TYPE-aware, so with the target on moon A the PLANET at A is
 * still a valid source (it sends "up" to its own moon). `null` when
 * nothing is left.
 *
 * The walk stays on the SAME kind of body the run is on: collecting from a
 * planet advances planet→planet (row cp), collecting from a moon advances
 * moon→moon (rows without a moon are skipped; cp from the moonlink href).
 *
 * @param {Set<string>} collectedOriginKeys  {@link coordTypeKey}s of bodies
 *   that already have a deployment inbound to the collect target.
 * @param {string | null} targetKey  {@link coordTypeKey} of the collect
 *   target body (skip it as a source).
 * @param {number} sourceType  The kind of body being collected from —
 *   `TARGET_MOON` walks moons, anything else walks planets.
 * @returns {string | null} cp id, or `null`.
 */
export const findNextCollectSourceCp = (collectedOriginKeys, targetKey, sourceType) => {
  const wantMoon = sourceType === TARGET_MOON;
  return findNextPlanetInList(
    (p) => {
      const coords = parseKoords(
        p.querySelector(GAME.PLANET_KOORDS)?.textContent,
      );
      if (!coords) return false;
      if (wantMoon && !p.querySelector(GAME.MOON_LINK)) return false;
      const key = coordTypeKey({
        ...coords,
        type: wantMoon ? TARGET_MOON : TARGET_PLANET,
      });
      return key !== targetKey && !collectedOriginKeys.has(key);
    },
    {
      active: 'last',
      // Moon walk: the row's own id is the PLANET's cp — the moon's comes
      // from its moonlink href.
      cpOf: wantMoon
        ? (p) => cpFromHref(p.querySelector(GAME.MOON_LINK)?.getAttribute('href'))
        : undefined,
    },
  );
};
