// AGR logo rewire — hijack AntiGameReborn's otherwise-idle menu-logo
// button so clicking it opens AGR's options menu AND auto-expands our
// OG-E Settings tab, and replaces the default logo image with the OG-E
// extension icon.
//
// # Why we rewire AGR's logo rather than painting our own toolbar
//
// AGR ships `<a id="ago_menubutton_logo" class="ago_menubutton_logo_inactive">`
// which by default does almost nothing when clicked. That's a valuable
// piece of pre-existing chrome at the top of the OGame UI — rather than
// paint a second floating button we reuse it. Clicking the AGR logo
// becomes the canonical "open OG-E settings" affordance, consistent with
// the AGR-embedded settings panel owned by `features/settingsUi.js`.
//
// This module assumes AGR is installed (hard dependency — see DESIGN.md
// §5 Układ modułów and the AGR-as-dependency rationale in settingsUi.js's
// file header). If AGR never hydrates the logo button within 10 s the
// install silently no-ops, same failure mode as settingsUi.
//
// # Lifecycle
//
//   1. `waitFor(() => document.getElementById(LOGO_ID), 10s)`.
//   2. Once found: swap the `background-image` inline style to our
//      extension icon (resolved via `browser.runtime.getURL` with a
//      `chrome.runtime.getURL` fallback), and attach a `click` listener
//      that fires the AGR menu button and then schedules a click on our
//      settings tab header.
//   3. Dispose reverts the inline `style` attribute to its original
//      (captured at install time) and removes the click listener.
//
// # Why two clicks with an 80 ms gap
//
// AGR rebuilds the menu panel when it toggles — `settingsUi.js` watches
// for that via a MutationObserver and re-injects our tab. Firing our
// header click synchronously would target the stale tab node that AGR
// is about to destroy. An 80 ms `setTimeout` gives AGR time to re-render
// the panel children before we synthetically click the freshly re-injected
// `#oge5-settings-header`. The interval is empirical but generous; AGR
// typically re-renders within a few ms.
//
// @see ./settingsUi.js — owner of the `#oge5-settings-header` tab id.
// @see ../lib/dom.js — `waitFor` for the AGR hydration race.

/** @ts-check */

import { waitFor } from '../lib/dom.js';

/** DOM id of the AGR menu-logo anchor. Idle by default; we hijack it. */
const LOGO_ID = 'ago_menubutton_logo';

/** DOM id of the AGR menu toggle button. Clicking it opens the AGR options menu. */
const MENU_BUTTON_ID = 'ago_menubutton';

/**
 * DOM id of our own settings-tab header inside the AGR menu — must match
 * the constant of the same name in `features/settingsUi.js`. If that
 * changes, this one must change too.
 */
const OGE_TAB_HEADER_ID = 'oge5-settings-header';

/**
 * Maximum time we wait for AGR to hydrate its logo anchor. Mirrors the
 * 10 s settingsUi uses for `#ago_menu_content` — same failure mode, same
 * generous timeout.
 */
const AGR_TIMEOUT_MS = 10_000;

/**
 * Delay between opening the AGR menu and clicking our tab header. AGR
 * rebuilds the panel children on toggle; `settingsUi.js` re-injects on
 * that rebuild via a MutationObserver. 80 ms is a generous window for
 * that chain to settle.
 */
const TAB_EXPAND_DELAY_MS = 80;

/**
 * Resolve the URL of the extension icon via the WebExtension runtime.
 * Prefers `browser.runtime.getURL` (Firefox) and falls back to
 * `chrome.runtime.getURL` (Chromium). In test environments where neither
 * exists we return the empty string; the caller uses that as a sentinel
 * to skip the image swap (click rewire still works).
 *
 * @returns {string}
 */
const resolveIconUrl = () => {
  try {
    const g = /** @type {any} */ (/** @type {unknown} */ (globalThis));
    const b = g.browser?.runtime?.getURL?.('icons/icon.png');
    if (typeof b === 'string' && b.length > 0) return b;
    const c = g.chrome?.runtime?.getURL?.('icons/icon.png');
    if (typeof c === 'string' && c.length > 0) return c;
    return '';
  } catch {
    return '';
  }
};

/**
 * Module-scope install handle. Holds the dispose fn between install and
 * dispose; `null` otherwise. Used to make {@link installAgrLogoRewire}
 * idempotent (second call returns the same dispose without touching
 * DOM) and to allow in-flight AGR-wait resolutions to exit early when
 * the install was disposed before the logo appeared.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the AGR logo rewire. Waits up to 10 s for the AGR logo anchor
 * to appear, then swaps its background image and attaches a click
 * handler that opens AGR's menu and auto-expands our settings tab.
 *
 * Idempotent: a second call while already installed returns the same
 * dispose fn as the first. Dispose-before-ready is supported: calling
 * the returned dispose while the AGR wait is still pending aborts the
 * rewire via a closure `disposed` flag.
 *
 * @returns {() => void} Dispose handle.
 */
export const installAgrLogoRewire = () => {
  if (installed) return installed.dispose;

  let disposed = false;

  /** @type {HTMLElement | null} */
  let logoEl = null;
  /** Original value of the inline `style` attribute — `null` means no attribute was set. */
  /** @type {string | null} */
  let originalStyleAttr = null;
  /** @type {((e: Event) => void) | null} */
  let clickListener = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingTabClick = null;

  waitFor(() => document.getElementById(LOGO_ID), {
    timeoutMs: AGR_TIMEOUT_MS,
    intervalMs: 200,
  }).then((el) => {
    if (disposed) return;
    if (!el) return;
    logoEl = /** @type {HTMLElement} */ (el);

    // Capture the pre-rewire style attribute so dispose can restore it
    // verbatim. `getAttribute` returns `null` when the attribute is
    // absent — we preserve that shape so dispose can call `removeAttribute`
    // rather than setting an empty string.
    originalStyleAttr = logoEl.getAttribute('style');

    // Image swap — only when the runtime gave us a URL. Empty string
    // means we're in a test environment with no WebExtension runtime;
    // skip the image (click rewire still works).
    const iconUrl = resolveIconUrl();
    if (iconUrl) {
      const styleText =
        `background-image: url(${iconUrl}) !important;` +
        ' background-size: contain;' +
        ' background-repeat: no-repeat;' +
        ' background-position: center;';
      // Preserve any existing inline style attributes by appending —
      // AGR's own rules are in a stylesheet, so the inline attr is
      // typically empty, but a user stylesheet or future AGR version
      // might put something here.
      const prefix = originalStyleAttr ? originalStyleAttr + ';' : '';
      logoEl.setAttribute('style', prefix + ' ' + styleText);
    }

    // Click rewire. `capture: true` so we run before any bubbling
    // handler AGR may have registered; `stopImmediatePropagation`
    // prevents any sibling capture listener from running after us.
    clickListener = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const menuBtn = document.getElementById(MENU_BUTTON_ID);
      if (menuBtn) /** @type {HTMLElement} */ (menuBtn).click();
      pendingTabClick = setTimeout(() => {
        pendingTabClick = null;
        const tabHeader = document.getElementById(OGE_TAB_HEADER_ID);
        if (tabHeader) /** @type {HTMLElement} */ (tabHeader).click();
      }, TAB_EXPAND_DELAY_MS);
    };
    logoEl.addEventListener('click', clickListener, true);
  });

  const dispose = () => {
    disposed = true;
    if (pendingTabClick !== null) {
      clearTimeout(pendingTabClick);
      pendingTabClick = null;
    }
    if (logoEl && clickListener) {
      logoEl.removeEventListener('click', clickListener, true);
    }
    if (logoEl) {
      // Restore the pre-rewire style attribute verbatim. `null` means
      // there was no attribute originally — `removeAttribute` returns
      // the node to its pristine shape.
      if (originalStyleAttr === null) {
        logoEl.removeAttribute('style');
      } else {
        logoEl.setAttribute('style', originalStyleAttr);
      }
    }
    clickListener = null;
    logoEl = null;
    originalStyleAttr = null;
    installed = null;
  };

  installed = { dispose };
  return dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs the
 * current dispose (if any) so each test case starts with a clean DOM
 * and no leaked listeners. Exported with a `_` prefix to signal
 * "do not import from production code".
 *
 * @returns {void}
 */
export const _resetAgrLogoRewireForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
