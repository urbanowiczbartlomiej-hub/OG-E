// @ts-check

// Dashboard launch button. The panel's primary call-to-action, so it leads:
// the caller (settingsUi/index.js) drops it into a full-width cell under its
// own "Dashboard" section header, first in the tab. Owns the Dashboard-page
// URL resolver because it's the only consumer.

import { parseUniverseId } from '../../../lib/universeId.js';
import { appendLens, installButtonChrome } from '../../shared/buttonChrome.js';

/**
 * A small bar-chart glyph for the dashboard button's gold node — the OG-E
 * gold cabochon + orbit mark, retired from the command buttons (they now wear
 * the module-coloured node), reused here as the panel's primary-CTA brand mark.
 * Inner markup of a `0 0 64 64` SVG using `currentColor` (the gold lens tint).
 */
const DASHBOARD_GLYPH = [
  '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">',
  '<line x1="17" y1="45" x2="17" y2="31"/>',
  '<line x1="32" y1="45" x2="32" y2="19"/>',
  '<line x1="47" y1="45" x2="47" y2="36"/>',
  '</g>',
].join('');

/**
 * URL of the OG-E Dashboard extension page, resolved once at module eval
 * via `chrome.runtime.getURL` / `browser.runtime.getURL`. Empty string
 * when the WebExtension runtime API isn't present (test environments); the
 * click handler guards on this, so a missing URL just no-ops. The visible
 * name changed to "Dashboard" in v1.3.1; the on-disk page was renamed from
 * the legacy `histogram.html` to `dashboard.html` in v1.11.1.
 */
const DASHBOARD_URL = (() => {
  try {
    const g = /** @type {any} */ (/** @type {unknown} */ (globalThis));
    const ns = g.browser ?? g.chrome;
    const url = ns?.runtime?.getURL?.('dashboard.html');
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
})();

const BUTTON_STYLE =
  'width:100%;padding:7px 0;background:#1a2a3a;border:1px solid #2a4a5a;' +
  'color:#4a9eff;border-radius:4px;font-size:13px;cursor:pointer;font-weight:bold;';

/**
 * Build the "OG-E Dashboard" launch button (wrapped so it spans the panel
 * width). Not a `SettingsSection` — the caller drops it into a full-width
 * cell under its own "Dashboard" section header.
 *
 * @returns {HTMLElement}
 */
export const buildDashboardButton = () => {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:6px 4px 10px;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'oge-open-dashboard';
  btn.title = 'Colony stats + galaxy observations';
  btn.style.cssText =
    BUTTON_STYLE + 'display:inline-flex;align-items:center;justify-content:center;gap:9px;';

  // Lead with the OG-E gold node (cabochon + orbit mark) instead of an emoji.
  installButtonChrome();
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.cssText = 'position:relative;display:inline-flex;width:24px;height:24px;flex:none;';
  appendLens(icon, DASHBOARD_GLYPH);
  // The `.oge-lens` base is absolutely positioned for a circular FAB; here it
  // fills the inline icon box instead.
  const lens = /** @type {HTMLElement | null} */ (icon.querySelector('.oge-lens'));
  if (lens) lens.style.cssText += ';position:absolute;left:0;top:0;width:100%;height:100%;transform:none;';
  const label = document.createElement('span');
  label.textContent = 'OG-E Dashboard';
  btn.append(icon, label);
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
