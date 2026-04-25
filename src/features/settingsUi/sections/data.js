// @ts-check

// Data section. Owns the histogram-page URL resolver because the Open
// Histogram button is its only consumer.

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/**
 * URL of the histogram extension page, resolved once at module eval
 * via `chrome.runtime.getURL` / `browser.runtime.getURL`. Empty string
 * when the WebExtension runtime API isn't present (test environments);
 * the onclick handler guards on this, so a missing URL just no-ops.
 */
const HISTOGRAM_URL = (() => {
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
      id: 'openHistogram',
      label: 'Local data viewer (colony + galaxy)',
      type: 'button',
      buttonText: 'Open histogram',
      onclick: () => {
        if (HISTOGRAM_URL) window.open(HISTOGRAM_URL, '_blank');
      },
    },
  ],
};
