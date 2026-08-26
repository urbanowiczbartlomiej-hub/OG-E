// @ts-check

// Muted probers for the "Who's spying on you" surfaces.
//
// Plain `read*/write*` key-owner over `chrome.storage.local` — the sanctioned
// exception documented in CLAUDE.md (cf. `state/apiCache.js`,
// `state/historyCpIndex.js`): the two readers pull it on demand once per
// render, and nothing needs to react to a change beyond the re-render the
// clicking surface triggers for itself.
//
// # What this is NOT
//
// It is not a "this player is friendly" mark. `domain/dangerScore.js` already
// has that concept and it short-circuits the whole threat model to zero for
// your alliance and your in-game buddy list. Muting a prober here deliberately
// does NOT touch their danger score, their patrol classification or their
// badge: the case this exists for is a strong neighbour whose scan you already
// know about and have accounted for, and who is exactly as capable of killing
// your fleet afterwards as they were before you muted them. Suppressing the
// alert is a statement about the ALERT, not about the player.
//
// # Why per-universe, keyed by player id
//
// Player ids are assigned per server, so an id muted on one universe means
// somebody else entirely on another — the key is namespaced
// (`<universeId>:oge_spyIgnored`) for the same reason the reports themselves
// are. Keyed by id rather than by report because that is the request: a prober
// stays muted when they scan again, instead of resurfacing on the next alert
// and needing to be dismissed once per scan.
//
// # Why localStorage was not an option
//
// Both surfaces have to agree: the in-game panel (`features/whosSpyingPanel`)
// runs on the game origin, the Spyglass strip runs on the extension origin.
// `safeLS` would give them two separate, silently diverging mute lists, so
// this lives in `chrome.storage.local`, which both can see.
//
// # LOCAL ONLY, for now
//
// This does not enter the gist, so a mute applies to the device that made it.
// The reports it filters DO sync (`proximityReportsPerUniverse`), so the same
// prober still needs muting once per device. Making it travel means a payload
// key plus a merge rule that can express an UNMUTE — a bare union would make
// unmuting impossible, since the remote copy would keep re-adding the id — so
// it needs the `on: false` tombstone shape `state/fleetReminders.js` already
// uses. Deliberately left out of this pass; the stored value is a plain id
// array, which that shape can adopt by treating a legacy array as all-muted.

import { chromeStore } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * Suffix portion of the chrome.storage.local key. The key actually written is
 * `<universeId>:<SPY_IGNORED_KEY_BASE>` — see {@link spyIgnoredKeyFor}.
 */
export const SPY_IGNORED_KEY_BASE = 'oge_spyIgnored';

/**
 * Compose the full chrome.storage.local key for a given universe id.
 * Exported because the dashboard has no `location.host` to derive it from —
 * it knows the universe from its own dropdown.
 *
 * @param {string} universeId  e.g. `'s163-pl'`.
 * @returns {string} e.g. `'s163-pl:oge_spyIgnored'`.
 */
export const spyIgnoredKeyFor = (universeId) => `${universeId}:${SPY_IGNORED_KEY_BASE}`;

/**
 * Narrow a stored payload to a set of player ids.
 *
 * Anything unusable degrades to "nothing is muted" rather than throwing: a
 * corrupt value here must fail towards SHOWING alerts, never towards hiding
 * them. A mute that silently disappears is a visible annoyance the user can
 * fix with one click; an alert silently swallowed by a bad payload is the kind
 * of miss this panel exists to prevent.
 *
 * @param {unknown} raw
 * @returns {Set<number>}
 */
const toIdSet = (raw) => {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((n) => typeof n === 'number' && Number.isFinite(n)));
};

/**
 * Read the muted-prober set for the current tab's universe.
 * @returns {Promise<Set<number>>} Empty set when nothing is stored.
 */
export const readSpyIgnored = async () => {
  const key = currentUniverseKey(SPY_IGNORED_KEY_BASE, spyIgnoredKeyFor);
  return toIdSet(await chromeStore.get(key));
};

/**
 * Read the muted-prober set for an explicit universe — the dashboard variant.
 * @param {string} universeId
 * @returns {Promise<Set<number>>}
 */
export const readSpyIgnoredFor = async (universeId) =>
  toIdSet(await chromeStore.get(spyIgnoredKeyFor(universeId)));

/**
 * Persist the muted-prober set for the current tab's universe.
 * Stored sorted so a diff of the raw key stays readable and two devices that
 * muted the same ids produce byte-identical payloads.
 *
 * @param {Iterable<number>} ids
 * @returns {Promise<void>}
 */
export const writeSpyIgnored = (ids) => {
  const key = currentUniverseKey(SPY_IGNORED_KEY_BASE, spyIgnoredKeyFor);
  return chromeStore.set(key, [...new Set(ids)].sort((a, b) => a - b));
};

/**
 * Persist the muted-prober set for an explicit universe — the dashboard
 * variant.
 *
 * @param {string} universeId
 * @param {Iterable<number>} ids
 * @returns {Promise<void>}
 */
export const writeSpyIgnoredFor = (universeId, ids) =>
  chromeStore.set(spyIgnoredKeyFor(universeId), [...new Set(ids)].sort((a, b) => a - b));
