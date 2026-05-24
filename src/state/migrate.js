// @ts-check

// One-shot migration: legacy un-namespaced `chrome.storage.local` keys
// → per-universe namespaced keys (introduced in v1.1.0).
//
// # What this fixes
//
// Before v1.1.0 the colony-history array and galaxy-scan map were
// persisted under literal keys `oge_colonyHistory` and `oge_galaxyScans`.
// `chrome.storage.local` is extension-wide (not per-origin), so a player
// running OG-E on two OGame servers saw the data of one bleed into the
// other. v1.1.0 namespaces these keys with the universe id parsed from
// `location.host`. Old installs already have data sitting at the legacy
// un-namespaced location and need it lifted into the namespaced slot —
// otherwise the post-upgrade histogram looks empty on every server.
//
// # Strategy: first-server-wins, no UI
//
// Migration runs in the game-origin content script bootstrap, so the
// universe id is `parseUniverseId(location.host)` of whichever server
// the player happens to load first after upgrading. That universe
// inherits the legacy data; subsequent servers find the legacy keys
// already gone and start with empty datasets. This matches the player's
// stated intent — separate stats per server, even on the same account
// — and avoids prompting them for a manual claim.
//
// The trade-off: if the player opens "wrong" server B first by accident,
// the data goes to B instead of A. We accept this because (a) the
// player explicitly asked for per-server isolation, (b) the data on A
// is regenerated on natural play (each scan / colonize re-populates the
// store), and (c) adding an explicit-claim UI would be overkill for a
// solo-user extension.
//
// # Invariant guaranteed by this module
//
// After {@link migrateLegacyStorageKeys} resolves, the legacy keys
// `oge_colonyHistory` and `oge_galaxyScans` are absent from
// `chrome.storage.local`. Either their values were lifted into the
// universe-namespaced slots (when those slots were empty) or they were
// simply discarded (when the namespaced slots already held data). The
// migration is idempotent — a second run on the same origin is a no-op.

import { chromeStore } from '../lib/storage.js';
import { HISTORY_KEY_BASE, historyKeyFor } from './history.js';
import { SCANS_KEY_BASE, scansKeyFor } from './scans.js';

/**
 * Move one legacy key into its per-universe namespaced slot.
 *
 * Cases:
 *   - legacy undefined: no-op.
 *   - legacy defined, namespaced undefined: copy legacy → namespaced,
 *     then delete legacy.
 *   - legacy defined, namespaced defined: delete legacy only (the
 *     namespaced slot already holds the canonical value for this
 *     universe and overwriting it would lose newer data).
 *
 * @param {string} legacyKey       e.g. `'oge_colonyHistory'`.
 * @param {string} namespacedKey   e.g. `'s163-pl:oge_colonyHistory'`.
 * @returns {Promise<void>}
 */
const moveKey = async (legacyKey, namespacedKey) => {
  const legacyValue = await chromeStore.get(legacyKey);
  if (legacyValue === undefined) return;

  const namespacedValue = await chromeStore.get(namespacedKey);
  if (namespacedValue === undefined) {
    await chromeStore.set(namespacedKey, legacyValue);
  }
  // In both surviving cases (copied OR already had namespaced data) we
  // clean up the legacy key. The post-condition is the same: legacy is
  // absent after the call, so re-runs short-circuit on the first
  // `chromeStore.get` above.
  await chromeStore.remove(legacyKey);
};

/**
 * Migrate any legacy un-namespaced `chrome.storage.local` data into the
 * per-universe namespaced slots used from v1.1.0 onward. Idempotent.
 *
 * Called once from `content.js` BEFORE `initHistoryStore` /
 * `initScansStore` so the persist load reads the freshly-migrated
 * namespaced key (otherwise the stores would hydrate from an empty
 * namespaced slot and the legacy data would sit orphaned).
 *
 * When `universeId` is empty (parser fallback for non-game origins —
 * should not happen in production because the manifest restricts this
 * module to `*.ogame.gameforge.com/game/index.php*`) the function
 * resolves immediately. In that degenerate state the state modules
 * already write to the bare suffix keys, which IS the legacy location,
 * so no move is required.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from `parseUniverseId`.
 * @returns {Promise<void>}
 */
export const migrateLegacyStorageKeys = async (universeId) => {
  if (!universeId) return;
  await Promise.all([
    moveKey(HISTORY_KEY_BASE, historyKeyFor(universeId)),
    moveKey(SCANS_KEY_BASE, scansKeyFor(universeId)),
  ]);
};
