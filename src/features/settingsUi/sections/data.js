// @ts-check

// Dashboard launch button. Rendered at the TOP of the OG-E settings tab
// (right under the header) rather than as a labelled row at the bottom —
// it's the panel's primary call-to-action, so it leads. Owns the
// Dashboard-page URL resolver because it's the only consumer.

import { parseUniverseId } from '../../../lib/universeId.js';

/**
 * URL of the OG-E Dashboard extension page, resolved once at module eval
 * via `chrome.runtime.getURL` / `browser.runtime.getURL`. Empty string
 * when the WebExtension runtime API isn't present (test environments); the
 * click handler guards on this, so a missing URL just no-ops. The on-disk
 * filename is still `histogram.html` (kept stable across reloads); only the
 * visible name changed in v1.3.1.
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

const BUTTON_STYLE =
  'width:100%;padding:7px 0;background:#1a2a3a;border:1px solid #2a4a5a;' +
  'color:#4a9eff;border-radius:4px;font-size:13px;cursor:pointer;font-weight:bold;';

/**
 * Build the standalone "Open OG-E Dashboard" button (wrapped so it spans
 * the panel width). Not a `SettingsSection` — the caller drops it in above
 * the section tables.
 *
 * @returns {HTMLElement}
 */
export const buildDashboardButton = () => {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:6px 4px 10px;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'oge-open-dashboard';
  btn.textContent = '📊 Open OG-E Dashboard';
  btn.title = 'Colony stats + galaxy observations';
  btn.style.cssText = BUTTON_STYLE;
  btn.addEventListener('click', () => {
    if (!DASHBOARD_URL) return;
    // Pass the current tab's universe id as `?host=` so the dashboard
    // auto-selects this server in its dropdown. Encoded defensively even
    // though universe ids are restricted ASCII — costs nothing.
    const universeId = parseUniverseId(location.host);
    const url = universeId
      ? `${DASHBOARD_URL}?host=${encodeURIComponent(universeId)}`
      : DASHBOARD_URL;
    window.open(url, '_blank');
  });

  wrap.appendChild(btn);
  return wrap;
};
