// @ts-check

// Dashboard launch button. The panel's primary call-to-action, so it leads:
// it rides as the TOP SEGMENT of the FAB module block (floatingButton.js
// passes it as the moduleTiles `topSlot`), flush above the module tiles.
// Look lives in controls.js' TILES_CSS under `.oge-dash-launch` (class-driven
// so hover/focus work); this file owns structure + the Dashboard-page URL
// resolver because it's the only consumer.

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

/**
 * Build the "OG-E Dashboard" launch button. Not a `SettingsSection` — the
 * floatingButton section passes this as the moduleTiles `topSlot`, so it
 * renders flush above the module tiles as the block's top segment (styled by
 * `.oge-dash-launch` in controls.js' TILES_CSS).
 *
 * @returns {HTMLElement}
 */
export const buildDashboardButton = () => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'oge-open-dashboard';
  btn.className = 'oge-dash-launch';
  btn.title = 'Colony stats + galaxy observations';

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

  return btn;
};
