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
// This module assumes AGR is installed (hard dependency — see the
// AGR-as-dependency rationale in settingsUi.js's file header). If AGR
// never hydrates the logo button within 10 s the install silently
// no-ops, same failure mode as settingsUi.
//
// # Visual contract
//
// Force a fixed 27×27 square on the anchor (AGR's CSS otherwise lets the
// aspect ratio drift). Render our icon using the 48 px asset — browser
// downscale from 48→27 stays crisp; downscale from the 500×500
// `icons/icon.png` master softened the edges.
//
// Hover state (brightness pulse on pointer-over) is delivered via a
// sibling `<style id="oge-agr-logo-hover">` — inline style attributes
// cannot express pseudo-classes so the `:hover` rule has to live in a
// stylesheet.
//
// # Lifecycle
//
//   1. `waitFor(() => document.getElementById(LOGO_ID), 10s)`.
//   2. Once found: swap the `background-image` inline style to our
//      extension icon (resolved via `browser.runtime.getURL` with a
//      `chrome.runtime.getURL` fallback), force a 27×27 square, inject
//      the hover stylesheet, and attach a `click` listener that fires
//      the AGR menu button and then schedules a click on our settings
//      tab header.
//   3. Dispose reverts the inline `style` attribute to its original
//      (captured at install time), removes the hover stylesheet, and
//      removes the click listener.
//
// # Why two clicks with an 80 ms gap
//
// AGR rebuilds the menu panel when it toggles — `settingsUi.js` watches
// for that via a MutationObserver and re-injects our tab. Firing our
// header click synchronously would target the stale tab node that AGR
// is about to destroy. An 80 ms `setTimeout` gives AGR time to re-render
// the panel children before we synthetically click the freshly re-injected
// `#oge-settings-header`. The interval is empirical but generous; AGR
// typically re-renders within a few ms.
//
// @see ./settingsUi.js — owner of the `#oge-settings-header` tab id.
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
const OGE_TAB_HEADER_ID = 'oge-settings-header';

/**
 * Stable id for the hover-stylesheet we inject alongside the rewire.
 * Inline style attributes can't express pseudo-classes (`:hover`), so the
 * hover rule lives in a sibling `<style>` node. The id lets dispose find
 * and remove it and lets a double-install collapse to a single element.
 */
const HOVER_STYLE_ID = 'oge-agr-logo-hover';

/**
 * Fixed logical size of the AGR menu-logo square. AGR's own stylesheet
 * lets the anchor drift to non-square aspect ratios depending on which
 * class is active (`_inactive` vs active). We pin it to 27×27 so the
 * icon renders consistently.
 */
const LOGO_SIZE_PX = 27;

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
    // Prefer the 48 px asset — it downscales to the 27 px render box
    // with sharp edges, unlike the 500×500 master which softens.
    const b = g.browser?.runtime?.getURL?.('icons/icon48.png');
    if (typeof b === 'string' && b.length > 0) return b;
    const c = g.chrome?.runtime?.getURL?.('icons/icon48.png');
    if (typeof c === 'string' && c.length > 0) return c;
    return '';
  } catch {
    return '';
  }
};

/**
 * Module-scope install handle. Holds the dispose fn between install and
 * dispose; `null` otherwise. Used to make {@link installAgrLogo}
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
export const installAgrLogo = () => {
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
  /** @type {HTMLStyleElement | null} */
  let hoverStyleEl = null;

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

    // Pin a 27×27 square regardless of runtime icon availability — AGR's
    // own CSS lets the aspect ratio drift, and we want the click target
    // to stay consistent even when the WebExtension runtime isn't there
    // to give us a background image (test env, missing permissions).
    const squareText =
      ` width: ${LOGO_SIZE_PX}px !important;` +
      ` height: ${LOGO_SIZE_PX}px !important;` +
      ' display: block !important;';

    const iconUrl = resolveIconUrl();
    const imageText = iconUrl
      ? `background-image: url(${iconUrl}) !important;` +
        ' background-size: contain;' +
        ' background-repeat: no-repeat;' +
        ' background-position: center;'
      : '';

    // Preserve any existing inline style attributes by appending — AGR's
    // own rules are in a stylesheet, so the inline attr is typically
    // empty, but a user stylesheet or future AGR version might put
    // something here.
    const prefix = originalStyleAttr ? originalStyleAttr + ';' : '';
    logoEl.setAttribute('style', prefix + imageText + squareText);

    // Hover pulse via a sibling <style>. Inline attributes can't express
    // pseudo-classes, so the :hover rule lives in a stylesheet. Reuse
    // an existing node if a previous install left one behind (dev reload,
    // double-install race).
    const existingHover = document.getElementById(HOVER_STYLE_ID);
    if (existingHover instanceof HTMLStyleElement) {
      hoverStyleEl = existingHover;
    } else {
      hoverStyleEl = document.createElement('style');
      hoverStyleEl.id = HOVER_STYLE_ID;
      hoverStyleEl.textContent =
        `#${LOGO_ID} { opacity: 0.85; transition: opacity 120ms ease, filter 120ms ease; }\n` +
        `#${LOGO_ID}:hover { opacity: 1 !important; filter: brightness(1.2) !important; }`;
      (document.head || document.documentElement).appendChild(hoverStyleEl);
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
    if (hoverStyleEl && hoverStyleEl.parentNode) {
      hoverStyleEl.parentNode.removeChild(hoverStyleEl);
    }
    clickListener = null;
    logoEl = null;
    originalStyleAttr = null;
    hoverStyleEl = null;
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
export const _resetAgrLogoForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
