// features/shared/planetList.js
//
// The "walk the planet list from the active planet, wrapping around"
// skeleton shared by sendExpedition's free-slot search and dailyRun's
// collect-source walk. Both iterate `#planetList` rows relative to the
// active planet and return the `cp` (planet id) of the first row matching
// a feature-specific predicate — only the predicate and where the active
// planet falls in the order differ. The fragile game-DOM contract (the
// planet-row selector, the active-planet class, the `planet-<n>` id shape)
// lives in `lib/gameDom.js`; this owns the traversal so neither feature
// re-implements the modulo walk.

import { GAME, ACTIVE_PLANET_CLASS } from '../../lib/gameDom.js';

/**
 * Walk the planet rows starting from the active planet and return the
 * `cp` of the first row for which `predicate` is truthy.
 *
 * `active` controls where the active planet itself sits in the walk:
 *   - `'first'` — checked first, then the rest forward with wrap (used
 *     when the active planet is a valid candidate to prefer);
 *   - `'skip'`  — never checked (caller already ruled it out);
 *   - `'last'`  — checked last, after a full wrap (prefer others, fall
 *     back to the active planet).
 * Every reachable row is visited exactly once in all three modes.
 *
 * The predicate runs BEFORE the `cp` is parsed (matching both original
 * call sites), so a feature can read coords / classes off the element
 * without worrying about id shape. Non-`planet-<n>` rows are skipped.
 *
 * @param {(planet: HTMLElement) => boolean} predicate  per-row test.
 * @param {{ active?: 'first' | 'skip' | 'last' }} [opts]
 * @returns {string | null} the numeric `cp` as a string, or `null` when
 *   no row matches (or the list is empty).
 */
export const findNextPlanetInList = (predicate, opts = {}) => {
  const active = opts.active ?? 'first';
  const planets = /** @type {HTMLElement[]} */ (
    [...document.querySelectorAll(GAME.SMALL_PLANET)]
  );
  if (planets.length === 0) return null;

  const activeIdx = planets.findIndex((p) =>
    p.classList.contains(ACTIVE_PLANET_CLASS),
  );
  const start = activeIdx < 0 ? 0 : activeIdx;
  // No row carries the active-planet class (e.g. the current page is a
  // moon) — there is no active row to skip or defer around, so every mode
  // degrades to a plain full walk over every planet.
  const lo = activeIdx < 0 ? 0 : active === 'first' ? 0 : 1;
  const hi =
    activeIdx < 0
      ? planets.length - 1
      : active === 'last'
        ? planets.length
        : planets.length - 1;

  for (let i = lo; i <= hi; i++) {
    const p = planets[(start + i) % planets.length];
    if (!predicate(p)) continue;
    const id = p.id || '';
    if (!id.startsWith('planet-')) continue;
    const cp = id.slice('planet-'.length);
    if (cp) return cp;
  }
  return null;
};
