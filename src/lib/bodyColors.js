// @ts-check

// Body-type colour tokens — the ONE place OG-E decides what colour a planet
// coordinate and a moon coordinate are painted.
//
// # Why these two values
//
// They are AGR's own planet/moon colours. OG-E's injected panels sit directly
// alongside AGR's UI, and a player reads "green = planet, orange = moon" as a
// single visual language across both — a second, OG-E-specific pairing (the old
// blue/violet) made the same distinction twice in two dialects and cost a beat
// of re-reading on every glance. Matching AGR is the whole point of the values;
// do not "refresh" them independently of AGR.
//
// # Why lib/
//
// Both worlds need them: the in-game panels (`features/whosSpyingPanel`) and
// the extension-origin dashboard (`features/dashboard/*`). A feature may not
// import another feature, and `features/dashboard/palette.js` is dashboard-only
// — so the shared home is the dependency-free foundation. Nothing here imports
// anything.
//
// These are OG-E's OWN presentation choices, not a game-DOM contract, so they
// deliberately do NOT live in `lib/gameDom.js`.

/**
 * Planet coordinate / label colour (AGR green).
 */
export const PLANET_COLOR = '#87CC00';

/**
 * Moon coordinate / label colour (AGR orange).
 */
export const MOON_COLOR = '#FF9600';

/**
 * Pick the colour for a body by type — the form most call sites want, so the
 * `isMoon ? MOON : PLANET` ternary isn't spelled out ten times.
 *
 * @param {boolean | undefined} isMoon
 * @returns {string}
 */
export const bodyColor = (isMoon) => (isMoon ? MOON_COLOR : PLANET_COLOR);
