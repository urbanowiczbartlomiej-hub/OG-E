// Planet-bar capture — passive snapshot of the player's owned bodies.
//
// # What it does
//
// On each in-game page-load it reads the left planet bar (`#planetList`),
// extracts every planet and moon as a {@link Body}, and writes the whole
// list to {@link bodiesStore}. The dashboard route editor (extension
// origin) reads that snapshot to render a clickable planet/moon picker, and
// `domain/fsRoutes.reconcileRoutes` uses it to prune routes whose endpoints
// no longer exist (wired in a later step).
//
// # Why a full overwrite (not an incremental merge)
//
// The planet bar lists ALL owned bodies on every in-game page, regardless
// of which page you're on. So a single read is the complete, current truth
// — there is nothing to merge. We replace the stored snapshot wholesale.
// Bodies change over time (coords freed by abandonment, new colonies, moons
// destroyed); a wholesale replace is exactly what lets reconciliation later
// notice what disappeared.
//
// # Why we never persist an EMPTY capture
//
// If `#planetList` hasn't hydrated yet (or we mis-read it) the extraction
// could yield zero bodies. Writing that would wipe a previously-good
// inventory — and reconciliation against an empty inventory would prune
// every route. So `tryCapture` only writes when it found ≥1 body; an empty
// read is treated as "not ready" and the `waitFor` retry covers the
// still-hydrating case.
//
// # Why the hydrate gate ({@link whenBodiesHydrated})
//
// Same race documented in `state/history.js` / `features/colonyRecorder.js`:
// our fresh `store.set` could be clobbered by a late async hydrate. Gating
// the first capture on {@link whenBodiesHydrated} makes the fresh snapshot
// win. The capture is also self-healing — even if a write were lost, the
// next page-load captures again.
//
// # Top-frame only
//
// OGame embeds iframes; the planet bar lives in the top frame and the
// snapshot is identical everywhere, so running this in sub-frames would
// just multiply storage writes. The caller (`content.js`) gates the
// install on `window.top === window.self`.
//
// @ts-check

import { waitFor } from '../lib/dom.js';
import { GAME } from '../lib/gameDom.js';
import { TARGET_PLANET, TARGET_MOON } from '../domain/rules.js';
import { parseKoords, dedupeBodies, isCompleteBody } from '../domain/bodies.js';
import { bodiesStore, whenBodiesHydrated } from '../state/bodies.js';

/**
 * @typedef {import('../domain/bodies.js').Body} Body
 */

// ─── Feature-local selectors ────────────────────────────────────────────
// Moon nodes are read by ONLY this feature, so per the gameDom invariant
// (selectors used by exactly one feature stay local) they live here, not in
// lib/gameDom.js. The planet-row / name / koords selectors ARE shared and
// come from GAME.

/** The moon anchor inside a `.smallplanet` row (absent when no moon). */
const SEL_MOON_LINK = 'a.moonlink';
/** The moon icon `<img>` whose `alt` carries the moon's display name. */
const SEL_MOON_IMG = 'img';

/** Prefix of a planet row's `id` (`planet-<cp>`). */
const PLANET_ID_PREFIX = 'planet-';

/**
 * Pull the numeric `cp` out of a fleetdispatch URL (`…&cp=34693626…`),
 * or `null` when absent / non-numeric.
 *
 * @param {string | null | undefined} url
 * @returns {number | null}
 */
const cpFromUrl = (url) => {
  if (!url) return null;
  const m = String(url).match(/[?&]cp=(\d+)/);
  if (!m) return null;
  const cp = parseInt(m[1], 10);
  return Number.isFinite(cp) && cp > 0 ? cp : null;
};

/**
 * Extract the 0–2 bodies (a planet, optionally its moon) from one
 * `.smallplanet` row. Exported for the behavioural test; not part of the
 * feature's public surface.
 *
 * The planet's `cp` comes from the row id (`planet-<cp>`), its name/coords
 * from the shared `.planet-name` / `.planet-koords` spans. The moon, when
 * present, shares the planet's coordinates (the game renders both at the
 * same `g:s:p`); its `cp` comes from the moonlink href and its name from
 * the moon icon's `alt`. Malformed entries are dropped via
 * {@link isCompleteBody}.
 *
 * @param {Element} row
 * @returns {Body[]}
 */
export const bodiesFromRow = (row) => {
  /** @type {Body[]} */
  const out = [];

  const coords = parseKoords(
    row.querySelector(GAME.PLANET_KOORDS)?.textContent,
  );
  if (!coords) return out; // No coords ⇒ not a usable row.

  // Planet.
  const id = row.id || '';
  const planetCp = id.startsWith(PLANET_ID_PREFIX)
    ? parseInt(id.slice(PLANET_ID_PREFIX.length), 10)
    : NaN;
  const planetName =
    row.querySelector(GAME.PLANET_NAME)?.textContent?.trim() || '';
  /** @type {Body} */
  const planet = { cp: planetCp, name: planetName, ...coords, type: TARGET_PLANET };
  if (isCompleteBody(planet)) out.push(planet);

  // Moon (optional). Shares the planet's coordinates.
  const moonLink = row.querySelector(SEL_MOON_LINK);
  if (moonLink) {
    const moonCp = cpFromUrl(
      moonLink.getAttribute('href') || moonLink.getAttribute('data-link'),
    );
    const moonName =
      moonLink.querySelector(SEL_MOON_IMG)?.getAttribute('alt')?.trim() || '';
    /** @type {Body} */
    const moon = {
      cp: /** @type {number} */ (moonCp ?? NaN),
      name: moonName,
      ...coords,
      type: TARGET_MOON,
    };
    if (isCompleteBody(moon)) out.push(moon);
  }

  return out;
};

/**
 * Read every `.smallplanet` row in `#planetList` into a de-duplicated
 * {@link Body} list. Returns `[]` when the bar is absent or empty (caller
 * treats that as "not ready", never persists it).
 *
 * @returns {Body[]}
 */
export const readPlanetBar = () => {
  const rows = document.querySelectorAll(GAME.SMALL_PLANET);
  /** @type {Body[]} */
  const bodies = [];
  for (const row of rows) bodies.push(...bodiesFromRow(row));
  return dedupeBodies(bodies);
};

/**
 * Single capture attempt. Reads the bar and, ONLY when it found ≥1 body,
 * replaces the stored snapshot. Returns `true` iff it persisted.
 *
 * @returns {boolean}
 */
const tryCapture = () => {
  const bodies = readPlanetBar();
  if (bodies.length === 0) return false; // Not ready / nothing to store.
  bodiesStore.set({ bodies, capturedAt: Date.now() });
  return true;
};

/**
 * The installed-dispose handle, or `null` when not installed. Module scope
 * so repeat installs collapse to a no-op (return the same handle) rather
 * than queuing redundant capture attempts for the same page-load.
 *
 * @type {(() => void) | null}
 */
let installed = null;

/**
 * Install the planet-bar capture for the current page-load.
 *
 * Behaviour mirrors `features/colonyRecorder`:
 *   1. Both attempts are gated on {@link whenBodiesHydrated} so a fresh
 *      snapshot can't be clobbered by a late hydrate.
 *   2. First attempt — succeeds immediately when the bar is already
 *      painted (the common case once OGame's scripts have run).
 *   3. Otherwise poll for `#planetList` and retry once when it appears
 *      (or give up on timeout). The poll aborts if the page navigates.
 *   4. Idempotent per page-load.
 *
 * @returns {() => void} Dispose handle that flips the module sentinel back.
 */
export const installPlanetBarCapture = () => {
  if (installed) return installed;
  installed = () => {
    installed = null;
  };

  void whenBodiesHydrated().then(() => {
    if (tryCapture()) return;
    waitFor(
      () => document.querySelector(GAME.PLANET_LIST) !== null,
      { timeoutMs: 5000, intervalMs: 200 },
    ).then(() => {
      tryCapture();
    });
  });

  return installed;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. `_`-prefixed:
 * do not import from production code.
 *
 * @returns {void}
 */
export const _resetPlanetBarCaptureForTest = () => {
  installed = null;
};
