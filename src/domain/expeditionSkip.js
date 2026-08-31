// @ts-check

// The expedition SKIP LIST — which bodies an expedition wave must never
// visit — as pure data transforms over one flat string.
//
// # Why this exists
//
// Both walks that pick "the next body with a free expedition slot" (the
// button's hop in `features/sendExpedition/domHelpers.js` and the post-send
// redirect in `bridges/expeditionRedirect.js`) test a body ONLY by its
// in-flight count against the per-planet cap. A planet kept for something
// else — a mining colony with no fleet, a deut farm with no tank — therefore
// looks exactly like a planet with room, so the wave walks onto it, the send
// is refused ("no fuel" / no ships), and the round-robin stalls there instead
// of coming back around for the second pass. The user's answer is a standing
// exclusion list, and this module is the format both walks agree on.
//
// # Why COORDS and not a list position
//
// A body is identified by its dense `g:s:p` coords, never by its index in
// `#planetList`. A position is not a stable name for a body: colonising or
// abandoning a planet shifts every index after it, so an index-keyed list
// would silently start excluding the wrong bodies the next time the player's
// holdings change. (OGame also offers a planet-list sort order, which would
// renumber the whole list at once — not re-verified here, but it only makes
// the case stronger.) Coords also match how the per-planet cap already counts
// (`countActiveExpeditions` buckets the event ticker by origin coords), so a
// skipped position is skipped for its planet AND its moon, which is the same
// granularity the cap works at.
//
// # Why the stored value is EXCLUSIONS, not inclusions
//
// So the empty string means "nothing skipped" — the pre-existing behaviour —
// and a freshly colonised planet joins the wave on its own. An inclusion list
// would quietly leave every new colony out until the player noticed.
//
// Pure: no DOM, no storage, no timers. The raw string lives in the settings
// store (`state/settings.js`, field `expSkipCoords`); the MAIN-world bridge
// reads the same localStorage key by hand.

import { denseCoords } from './bodies.js';

/**
 * Order two dense `g:s:p` coords the way a player reads their planet list:
 * galaxy, then system, then position — numerically, so `1:9:4` sorts before
 * `1:10:4`. Malformed parts collapse to 0 rather than `NaN`-poisoning the
 * comparison.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const byCoords = (a, b) => {
  const pa = a.split(':').map((n) => parseInt(n, 10) || 0);
  const pb = b.split(':').map((n) => parseInt(n, 10) || 0);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};

/**
 * Parse the stored value into a lookup set of dense `g:s:p` coords.
 *
 * Tolerant on purpose — the value is a plain localStorage string that survives
 * across versions and can be hand-edited: entries are trimmed, run through
 * {@link denseCoords} (so a pasted `[1:234:5]` still matches), and anything
 * that isn't a `g:s:p` triple is dropped rather than kept as a key that can
 * never match a real row.
 *
 * @param {string | null | undefined} raw  Comma-separated coords.
 * @returns {Set<string>}
 */
export const parseSkipCoords = (raw) => {
  /** @type {Set<string>} */
  const out = new Set();
  for (const part of String(raw ?? '').split(',')) {
    const coords = denseCoords(part);
    if (/^\d+:\d+:\d+$/.test(coords)) out.add(coords);
  }
  return out;
};

/**
 * Serialise a coords collection back to the stored form: deduped, sorted in
 * planet-list reading order, comma-separated, no spaces. Sorting is what makes
 * the value stable — the same selection always produces the same string, so a
 * settings write only happens when the selection actually changed.
 *
 * @param {Iterable<string>} coords
 * @returns {string}
 */
export const formatSkipCoords = (coords) =>
  [...new Set(coords)].sort(byCoords).join(',');

/**
 * Flip one body's membership and return the new stored value. The single
 * write path the settings picker uses, so add and remove can never disagree
 * about normalisation.
 *
 * @param {string | null | undefined} raw  Current stored value.
 * @param {string} coords                  Dense `g:s:p` to toggle.
 * @returns {string}  New stored value.
 */
export const toggleSkipCoords = (raw, coords) => {
  const set = parseSkipCoords(raw);
  const key = denseCoords(coords);
  if (!set.delete(key)) set.add(key);
  return formatSkipCoords(set);
};
