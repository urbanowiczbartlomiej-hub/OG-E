// @ts-check

// Impure DOM readers + fleet-step drivers for the fsCollect orchestrator.
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
//
// # Step detection
//
// OGame's fleetdispatch is a two-step form. We detect step 2 by the
// presence of the native `#dispatchFleet` button — the same signal
// `features/sendExp` keys on. On step 1 only `#continueToFleet2` is live.

import { safeClick, waitFor } from '../../lib/dom.js';
import { GAME, ACTIVE_PLANET_CLASS } from '../../lib/gameDom.js';
import { TARGET_PLANET, TARGET_MOON } from '../../domain/rules.js';
import { coordKey } from './pure.js';

// ─── Feature-local selectors / ids ──────────────────────────────────────

// "select all ships" (GAME.FD_SEND_ALL), "load all resources"
// (GAME.FD_ALL_RESOURCES), and the step-2 "dispatch fleet" button
// (GAME.FD_DISPATCH) are shared fleetdispatch controls — sourced from
// lib/gameDom.js, not re-hardcoded here.
/** Native "continue to step 2" control. */
const ID_CONTINUE = 'continueToFleet2';
/** Inbound deployment fleet rows in the event ticker. */
const SEL_DEPLOY_ROWS =
  '#eventContent tr.eventFleet[data-mission-type="4"][data-return-flight="false"]';
/** OGame per-page meta tags for the active body. */
const SEL_META_COORDS = 'meta[name="ogame-planet-coordinates"]';
const SEL_META_TYPE = 'meta[name="ogame-planet-type"]';

/** waitFor budget for the step-2 panel to render after "continue". */
const STEP2_TIMEOUT_MS = 8000;
const STEP2_INTERVAL_MS = 100;

/**
 * @typedef {import('../../state/fsRoutes.js').TargetCoord} TargetCoord
 */

/**
 * Parse a `"[g:s:p]"` or `"g:s:p"` string into coords, or `null`.
 *
 * @param {string | null | undefined} txt
 * @returns {{ galaxy: number, system: number, position: number } | null}
 */
export const parseCoordsText = (txt) => {
  if (!txt) return null;
  const m = String(txt).match(/(\d+):(\d+):(\d+)/);
  if (!m) return null;
  return {
    galaxy: parseInt(m[1], 10),
    system: parseInt(m[2], 10),
    position: parseInt(m[3], 10),
  };
};

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
    .querySelector(SEL_META_COORDS)
    ?.getAttribute('content');
  const c = parseCoordsText(coordsMeta);
  if (c) {
    const typeMeta = document
      .querySelector(SEL_META_TYPE)
      ?.getAttribute('content');
    const type = typeMeta === 'moon' ? TARGET_MOON : TARGET_PLANET;
    return { ...c, type };
  }
  // Fallback: highlighted planet-row coords (no moon signal here).
  const koords = document.querySelector(
    `${GAME.ACTIVE_PLANET} ${GAME.PLANET_KOORDS}`,
  )?.textContent;
  const c2 = parseCoordsText(koords);
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
    const c = parseCoordsText(
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
 * Read every inbound deployment leg from the event ticker as
 * `{ origin, dest }`. `origin` is `{g,s,p}` (or `null` when unreadable);
 * `dest` is a full {@link TargetCoord} (type from the dest icon —
 * `.destFleet figure.moon` ⇒ moon).
 *
 * @returns {Array<{
 *   origin: { galaxy: number, system: number, position: number } | null,
 *   dest: TargetCoord,
 * }>}
 */
export const readDeployLegs = () => {
  /** @type {Array<{ origin: any, dest: TargetCoord }>} */
  const legs = [];
  const rows = document.querySelectorAll(SEL_DEPLOY_ROWS);
  for (const row of rows) {
    const dest = parseCoordsText(row.querySelector(GAME.COORDS_DEST)?.textContent);
    if (!dest) continue;
    const fig = row.querySelector('.destFleet figure');
    const destType =
      fig && fig.classList.contains('moon') ? TARGET_MOON : TARGET_PLANET;
    const origin = parseCoordsText(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    legs.push({ origin, dest: { ...dest, type: destType } });
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
export const findNextCollectPlanetCp = (collectedOriginKeys, targetCoordKey) => {
  const planets = /** @type {HTMLElement[]} */ (
    [...document.querySelectorAll(GAME.SMALL_PLANET)]
  );
  if (planets.length === 0) return null;
  const currentIdx = planets.findIndex((p) =>
    p.classList.contains(ACTIVE_PLANET_CLASS),
  );
  const start = currentIdx < 0 ? 0 : currentIdx;
  for (let i = 1; i <= planets.length; i++) {
    const p = planets[(start + i) % planets.length];
    const coords = parseCoordsText(p.querySelector(GAME.PLANET_KOORDS)?.textContent);
    if (!coords) continue;
    const key = coordKey(coords);
    if (key === targetCoordKey) continue;
    if (collectedOriginKeys.has(key)) continue;
    const id = p.id || '';
    if (!id.startsWith('planet-')) continue;
    const cp = id.slice('planet-'.length);
    if (cp) return cp;
  }
  return null;
};

// ─── Fleet-step drivers ─────────────────────────────────────────────────

/**
 * Whether the fleetdispatch form is on step 2 (the native dispatch button
 * is present). Mirrors `features/sendExp`'s step-2 signal.
 *
 * @returns {boolean}
 */
export const isStep2 = () => document.querySelector(GAME.FD_DISPATCH) !== null;

/** Click "select all ships" (step 1). No-op when absent. @returns {void} */
export const selectAllShips = () => safeClick(document.querySelector(GAME.FD_SEND_ALL));

/** Click "continue to step 2". No-op when absent. @returns {void} */
export const clickContinue = () => safeClick(document.getElementById(ID_CONTINUE));

/** Click "load all resources" (step 2). No-op when absent. @returns {void} */
export const loadAllResources = () => safeClick(document.querySelector(GAME.FD_ALL_RESOURCES));

/** Click the native dispatch button (step 2). No-op when absent. @returns {void} */
export const clickDispatch = () => safeClick(document.querySelector(GAME.FD_DISPATCH));

/**
 * Wait until the step-2 dispatch button appears (after a "continue"
 * click). Resolves `true` when it shows, `null` on timeout.
 *
 * @returns {Promise<true | null>}
 */
export const waitForStep2 = () =>
  waitFor(() => (document.querySelector(GAME.FD_DISPATCH) ? true : null), {
    timeoutMs: STEP2_TIMEOUT_MS,
    intervalMs: STEP2_INTERVAL_MS,
  });
