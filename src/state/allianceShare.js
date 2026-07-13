// @ts-check

// Alliance-share key-owner — config + last-pulled intel for the OPT-IN
// alliance Spyglass share (IDEAS.md entry 2). Plain `read*/write*` helpers
// over `chrome.storage` — the sanctioned store-less exception (CLAUDE.md):
// nothing subscribes to these keys. Both are read on demand at their single
// consumer, the dashboard's alliance-share feature: the config when the user
// opens the Sync tab or clicks the Spyglass "Alliance" button, the cached
// intel when the panel repaints.
//
// The config is deliberately its OWN key, not a field in the shared-settings
// dict (`state/sharedSettings.js`): that dict is bridged into every game
// origin, and the alliance token has no business there — the share is
// click-driven from the dashboard (extension origin) only, so the shared
// secret stays out of the game page entirely.
//
// SECOND TRUST BOUNDARY — this token is NOT the personal sync PAT
// (`sync/gist.js` TOKEN_KEY): it points at an alliance-owned gist that other
// people write to, and is a secret shared across the alliance. Never conflate
// the two.

import { chromeStore } from '../lib/storage.js';

/**
 * chrome.storage.local key of the global (cross-universe) alliance-share
 * config dict.
 */
export const ALLIANCE_SHARE_CONFIG_KEY = 'oge_allianceShare';

/**
 * Suffix of the per-universe cached-intel key (full key:
 * `<universeId>:oge_allianceIntel`) — the last successfully pulled shared doc,
 * so the Spyglass panel can render without a network round-trip.
 */
export const ALLIANCE_INTEL_KEY_BASE = 'oge_allianceIntel';

/**
 * Compose the full cached-intel key for a universe id.
 * @param {string} universeId  e.g. `'s163-pl'`.
 * @returns {string}
 */
export const allianceIntelKeyFor = (universeId) => `${universeId}:${ALLIANCE_INTEL_KEY_BASE}`;

/**
 * @typedef {object} AllianceShareConfig
 * @property {boolean} enabled  Section master switch (the Sync tab's
 *   "Alliance share (Spyglass)" toggle-chip, mirroring the personal card's
 *   "Sync across devices"): off collapses the config body and hides the
 *   Alliance-sync button + summary on the Spyglass tab. Pre-toggle configs
 *   read as enabled when a token was already set — an installed, working
 *   share must not switch itself off on update.
 * @property {string} token     Shared alliance PAT (classic, `gist` scope).
 * @property {string} gistId    The alliance-owned gist's id.
 * @property {string} shareName How this member signs their block. Empty =
 *   fall back to the universe's own profile name at share time.
 */

/**
 * @typedef {object} AllianceIntelCache
 * @property {unknown} doc      Raw shared doc (normalised by the reader via
 *   `domain/allianceIntel.normalizeAllianceDoc`).
 * @property {number} pulledAt  Epoch-ms of the successful pull.
 */

/**
 * Read the config, normalised to the known fields.
 * @returns {Promise<AllianceShareConfig>}
 */
export const readAllianceShareConfig = async () => {
  const raw = await chromeStore.get(ALLIANCE_SHARE_CONFIG_KEY);
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const token = typeof o.token === 'string' ? o.token : '';
  return {
    // Pre-toggle migration: a config with a token was set up to be USED.
    enabled: typeof o.enabled === 'boolean' ? o.enabled : token.length > 0,
    token,
    gistId: typeof o.gistId === 'string' ? o.gistId : '',
    shareName: typeof o.shareName === 'string' ? o.shareName : '',
  };
};

/**
 * Read-modify-write a patch into the config dict.
 * @param {Partial<AllianceShareConfig>} patch
 * @returns {Promise<void>}
 */
export const writeAllianceShareConfig = async (patch) => {
  const cur = await readAllianceShareConfig();
  await chromeStore.set(ALLIANCE_SHARE_CONFIG_KEY, { ...cur, ...patch });
};

/**
 * Read one universe's cached intel, or null when none was ever pulled.
 * @param {string} universeId
 * @returns {Promise<AllianceIntelCache | null>}
 */
export const readAllianceIntel = async (universeId) => {
  const raw = await chromeStore.get(allianceIntelKeyFor(universeId));
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {any} */ (raw)
    : null;
  if (!o || o.doc == null) return null;
  const pulledAt = Number(o.pulledAt);
  return { doc: o.doc, pulledAt: Number.isFinite(pulledAt) ? pulledAt : 0 };
};

/**
 * Cache one universe's freshly pulled doc.
 * @param {string} universeId
 * @param {unknown} doc
 * @param {number} pulledAt  Epoch-ms.
 * @returns {Promise<void>}
 */
export const writeAllianceIntel = (universeId, doc, pulledAt) =>
  chromeStore.set(allianceIntelKeyFor(universeId), { doc, pulledAt });
