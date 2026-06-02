// @ts-check

// Cloud sync section. Co-locates the `formatSyncStatus` helper because
// the syncStatus row's `getText` is the only consumer; keeping the
// `oge_lastSyncAt` / `oge_lastDownAt` / `oge_lastSyncErr` localStorage
// keys near the field that displays them is easier to audit than
// scattering them across the orchestrator.

import { safeLS } from '../../../lib/storage.js';
import { SYNC_STATUS_EVENT } from '../../../sync/gist.js';

// DOM id of the Sync status row's span (INPUT_ID_PREFIX + 'syncStatus').
// Inlined rather than imported from controls.js to avoid a sections↔controls
// import cycle; the prefix is a stable contract.
const SYNC_STATUS_SPAN_ID = 'oge-setting-syncStatus';

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
 * Format (compact — the status row is one column wide):
 *   `↑ <upload time>   ↓ <download time>`     (up + down share ONE line)
 *   `⚠ <error message>`                        (only when `oge_lastSyncErr` is set)
 *
 * Timestamps render as time-of-day for the common same-day case (so the
 * line stays short) and fall back to full date+time only when the sync was
 * on a different day. A missing / unparseable timestamp renders as an
 * em-dash. Unknown localStorage failures (quota, private-mode) silently
 * collapse to the em-dash path since `safeLS.get` swallows them.
 *
 * @returns {string}
 */
const formatSyncStatus = () => {
  const now = new Date();
  /**
   * @param {string | null} iso
   * @returns {string}
   */
  const fmt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    // Same calendar day ⇒ time only; otherwise the full date+time so a
    // day-old sync is unambiguous.
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
  };
  const up = safeLS.get(LS_LAST_SYNC_AT);
  const down = safeLS.get(LS_LAST_DOWN_AT);
  const err = safeLS.get(LS_LAST_SYNC_ERR);
  const lines = [`↑ ${fmt(up)}   ↓ ${fmt(down)}`];
  if (err) lines.push('⚠ ' + err);
  return lines.join('\n');
};

/** @type {SettingsSection} */
export const syncSection = {
  section: 'Multi-device sync',
  options: [
    {
      // Master switch for the whole section + the manual "Sync now" trigger
      // on its right. When off, the token + status rows grey out (like the
      // Reminders master). The button greys too (syncing is a no-op while
      // off) but the master checkbox itself always stays live.
      id: 'cloudSync',
      label: 'Sync across devices',
      type: 'checkbox',
      buttonText: 'Sync now',
      onclick: () => {
        // Immediate feedback: paint "Syncing…" before the async round-trip,
        // mirroring the ntfy "Check now" UX. The sync layer's setStatus
        // fires SYNC_STATUS_EVENT when it settles, which repaints the row
        // with the real result (times or a one-line error).
        const span = document.getElementById(SYNC_STATUS_SPAN_ID);
        if (span) span.textContent = 'Syncing…';
        document.dispatchEvent(new CustomEvent('oge:syncForce'));
      },
      buttonDisabledWhen: (s) => !s.cloudSync,
    },
    {
      id: 'gistToken',
      label: 'GitHub Personal Access Token (gist scope)',
      type: 'password',
      disabledWhen: (s) => !s.cloudSync,
    },
    {
      // Status line on its own full-width row (the trigger moved up to the
      // master row, freeing the horizontal space). Read-only + synchronous
      // (reads localStorage), but `refreshEvent` re-runs getText on every
      // SYNC_STATUS_EVENT the sync layer emits — so a manual "Sync now"
      // (or any background sync) repaints the line the moment it settles.
      id: 'syncStatus',
      label: 'Sync status',
      type: 'static',
      getText: () => formatSyncStatus(),
      refreshEvent: SYNC_STATUS_EVENT,
    },
  ],
};
