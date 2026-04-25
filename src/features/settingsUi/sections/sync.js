// @ts-check

// Cloud sync section. Co-locates the `formatSyncStatus` helper because
// the syncStatus row's `getText` is the only consumer; keeping the
// `oge_lastSyncAt` / `oge_lastDownAt` / `oge_lastSyncErr` localStorage
// keys near the field that displays them is easier to audit than
// scattering them across the orchestrator.

import { safeLS } from '../../../lib/storage.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** localStorage keys written by sync code, read here for the status display. */
const LS_LAST_SYNC_AT = 'oge_lastSyncAt';
const LS_LAST_DOWN_AT = 'oge_lastDownAt';
const LS_LAST_SYNC_ERR = 'oge_lastSyncErr';

/**
 * Read sync status from localStorage and compose a multi-line status
 * string. Each line is optional; the caller renders the span with
 * `white-space: pre-line` so `\n` becomes a visible break.
 *
 * Format:
 *   `↑ <upload time>`
 *   `↓ <download time>`
 *   `⚠ <error message>`   (only when `oge_lastSyncErr` is set)
 *
 * A missing / unparseable timestamp renders as an em-dash. Unknown
 * localStorage failures (quota, private-mode) silently collapse to the
 * em-dash path since `safeLS.get` swallows them.
 *
 * @returns {string}
 */
const formatSyncStatus = () => {
  /**
   * @param {string | null} iso
   * @returns {string}
   */
  const fmt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  };
  const up = safeLS.get(LS_LAST_SYNC_AT);
  const down = safeLS.get(LS_LAST_DOWN_AT);
  const err = safeLS.get(LS_LAST_SYNC_ERR);
  const lines = ['↑ ' + fmt(up), '↓ ' + fmt(down)];
  if (err) lines.push('⚠ ' + err);
  return lines.join('\n');
};

/** @type {SettingsSection} */
export const syncSection = {
  section: 'Cloud sync',
  options: [
    { id: 'cloudSync', label: 'Enable cloud sync', type: 'checkbox' },
    { id: 'gistToken', label: 'GitHub Personal Access Token (gist scope)', type: 'password' },
    {
      id: 'syncForce',
      label: 'Force sync now',
      type: 'button',
      buttonText: 'Sync',
      onclick: () => document.dispatchEvent(new CustomEvent('oge:syncForce')),
    },
    { id: 'syncStatus', label: 'Status', type: 'static', getText: () => formatSyncStatus() },
  ],
};
