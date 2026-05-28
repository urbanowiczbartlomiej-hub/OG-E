// @ts-check

// Data section. Owns the Dashboard-page URL resolver because the Open
// OG-E Dashboard button is its only consumer.

import { parseUniverseId } from '../../../lib/universeId.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * URL of the OG-E Dashboard extension page, resolved once at module
 * eval via `chrome.runtime.getURL` / `browser.runtime.getURL`. Empty
 * string when the WebExtension runtime API isn't present (test
 * environments); the onclick handler guards on this, so a missing URL
 * just no-ops. The on-disk filename is still `histogram.html` (kept
 * stable for backward-compat across reloads); only the visible name
 * changed in v1.3.1.
 */
const DASHBOARD_URL = (() => {
  try {
    const g = /** @type {any} */ (/** @type {unknown} */ (globalThis));
    const ns = g.browser ?? g.chrome;
    const url = ns?.runtime?.getURL?.('histogram.html');
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
})();

/** @type {SettingsSection} */
export const dataSection = {
  section: 'Data',
  options: [
    {
      id: 'openDashboard',
      label: 'OG-E Dashboard (colony stats + galaxy observations)',
      type: 'button',
      buttonText: 'Open OG-E Dashboard',
      onclick: () => {
        if (!DASHBOARD_URL) return;
        // Pass the current tab's universe id as `?host=` so the dashboard
        // auto-selects this server in its dropdown. Encodes defensively
        // even though universe ids are restricted ASCII — costs nothing
        // and matches general "URL-safe parameter" practice.
        const universeId = parseUniverseId(location.host);
        const url = universeId
          ? `${DASHBOARD_URL}?host=${encodeURIComponent(universeId)}`
          : DASHBOARD_URL;
        window.open(url, '_blank');
      },
    },
  ],
};
