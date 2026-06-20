// @ts-check

// AGR-missing guard — OG-E hard-depends on AntiGameReborn (AGR). When AGR
// is absent the settings panel never injects (features/settingsUi), the
// menu logo never rewires (features/agrLogo), and fleet aiming through
// AGR's fleet1 controls silently breaks. Today all of that fails quietly,
// so a user without AGR just sees a half-working extension and no reason
// why. This module makes the missing dependency visible: it waits for
// AGR's top-bar menu button to hydrate and, if it never does, drops a
// dismissible banner at the top of the page telling the user to install
// AntiGameReborn.
//
// # Why a self-contained banner (not the settings panel / dashboard)
//
// The obvious home for a warning would be OG-E's own settings — but that
// panel lives INSIDE AGR's menu (features/settingsUi), which is exactly
// what's missing here. So the banner must be standalone: its own injected
// DOM + stylesheet, depending on nothing but `document.body`. For the same
// reason there is no opt-out toggle — a toggle would live in the absent
// panel (circular). The banner is dismissible per page view (× button) and
// reappears on the next load: a hard dependency keeps reminding.
//
// # No install link by design
//
// AGR's install URL differs between Chromium and Firefox stores and is not
// stable over time, so the banner names the extension to search for rather
// than linking to a store page that may rot.
//
// # Detection
//
// `waitFor(GAME.AGO_MENU_BUTTON, 10s)` — the SAME anchor + timeout agrLogo
// and settingsUi use, so "AGR present" means the same thing everywhere
// (selector centralized in lib/gameDom.js). A truthy resolve means AGR
// hydrated → no banner. A null resolve (timeout) means AGR is absent →
// show the banner. To avoid a false positive when AGR is merely slow
// (> 10 s), once the banner is up a MutationObserver on <body> tears it
// down the moment the AGR button finally appears.
//
// # Lifecycle (mirrors agrLogo's install/dispose sentinel)
//
//   1. installAgrGuard() — idempotent; starts the AGR-probe wait.
//   2. timeout with no AGR → injectStyle + append banner to <body>; arm
//      the late-AGR observer.
//   3. dispose / × click → remove banner + stylesheet, disconnect the
//      observer, and flip the disposed flag so an in-flight wait no-ops.
//
// @see ./agrLogo.js — also probes GAME.AGO_MENU_BUTTON (to open AGR's menu).
// @see ./settingsUi/index.js — the AGR-as-dependency rationale (file header).
// @see ../lib/gameDom.js — GAME.AGO_MENU_BUTTON, the shared AGR-present probe.

import { waitFor, injectStyle } from '../lib/dom.js';
import { GAME } from '../lib/gameDom.js';

/** Stable id for the banner container — lets dispose find it and collapses a double-install. */
const BANNER_ID = 'oge-agr-missing';

/** Stable id for the banner stylesheet (`:hover` can't be expressed inline). */
const BANNER_STYLE_ID = 'oge-agr-missing-style';

/**
 * Maximum time we wait for AGR to hydrate its menu button before declaring
 * it absent. Mirrors the 10 s agrLogo + settingsUi use, so all three agree
 * on what "AGR is present" means.
 */
const AGR_TIMEOUT_MS = 10_000;

/** Banner copy — names the extension to install; no store link (URLs differ per browser / rot). */
const BANNER_TEXT =
  'OG-E requires the AntiGameReborn (AGR) extension. ' +
  'Install AntiGameReborn for all features to work properly.';

const BANNER_CSS = `
#${BANNER_ID}{
  position:fixed;
  top:8px;
  left:50%;
  transform:translateX(-50%);
  z-index:2147483000;
  display:flex;
  align-items:center;
  gap:10px;
  max-width:90vw;
  padding:8px 12px;
  border:1px solid #c0392b;
  border-left:4px solid #e74c3c;
  border-radius:4px;
  background:#1b1b1b;
  color:#f5f5f5;
  font:13px/1.4 Verdana,Arial,sans-serif;
  box-shadow:0 2px 10px rgba(0,0,0,.6);
}
#${BANNER_ID} .oge-agr-missing-icon{ flex:0 0 auto; font-size:15px; }
#${BANNER_ID} .oge-agr-missing-text{ flex:1 1 auto; }
#${BANNER_ID} .oge-agr-missing-close{
  flex:0 0 auto;
  cursor:pointer;
  border:0;
  background:transparent;
  color:#bbb;
  font-size:16px;
  line-height:1;
  padding:0 2px;
}
#${BANNER_ID} .oge-agr-missing-close:hover{ color:#fff; }
`;

/**
 * Module-scope install handle (same pattern as agrLogo). Holds the dispose
 * fn between install and dispose; `null` otherwise. Makes
 * {@link installAgrGuard} idempotent and lets an in-flight AGR-wait exit
 * early when disposed before the timeout fires.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Build the banner element WITHOUT `innerHTML` (AMO's linter flags every
 * `innerHTML` write). All children are real nodes with `textContent`.
 *
 * @param {() => void} onClose Invoked when the × button is clicked.
 * @returns {HTMLElement}
 */
const buildBanner = (onClose) => {
  const root = document.createElement('div');
  root.id = BANNER_ID;
  root.setAttribute('role', 'alert');

  const icon = document.createElement('span');
  icon.className = 'oge-agr-missing-icon';
  icon.textContent = '⚠';

  const text = document.createElement('span');
  text.className = 'oge-agr-missing-text';
  text.textContent = BANNER_TEXT;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'oge-agr-missing-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', onClose);

  root.appendChild(icon);
  root.appendChild(text);
  root.appendChild(close);
  return root;
};

/**
 * Install the AGR-missing guard. Waits up to 10 s for AGR's menu button;
 * if it never appears, shows a dismissible top-of-page banner prompting
 * the user to install AntiGameReborn.
 *
 * Idempotent: a second call while already installed returns the first
 * dispose. Dispose-before-ready is supported via a closure `disposed`
 * flag (an in-flight wait that resolves after dispose no-ops).
 *
 * @returns {() => void} Dispose handle.
 */
export const installAgrGuard = () => {
  if (installed) return installed.dispose;

  let disposed = false;
  /** @type {HTMLElement | null} */
  let bannerEl = null;
  /** @type {MutationObserver | null} */
  let lateAgrObserver = null;

  /** Remove the banner + its stylesheet (idempotent). Leaves `disposed` alone. */
  const removeBanner = () => {
    if (lateAgrObserver) {
      lateAgrObserver.disconnect();
      lateAgrObserver = null;
    }
    if (bannerEl && bannerEl.parentNode) {
      bannerEl.parentNode.removeChild(bannerEl);
    }
    bannerEl = null;
    const styleEl = document.getElementById(BANNER_STYLE_ID);
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
  };

  const showBanner = () => {
    // Collapse a double-install / dev-reload leftover.
    if (document.getElementById(BANNER_ID)) return;
    injectStyle(BANNER_STYLE_ID, BANNER_CSS);
    bannerEl = buildBanner(removeBanner);
    (document.body || document.documentElement).appendChild(bannerEl);

    // False-positive guard: if AGR was merely slow (hydrates after our
    // 10 s timeout), tear the banner down the moment its button appears.
    lateAgrObserver = new MutationObserver(() => {
      if (document.querySelector(GAME.AGO_MENU_BUTTON)) removeBanner();
    });
    lateAgrObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  waitFor(() => document.querySelector(GAME.AGO_MENU_BUTTON), {
    timeoutMs: AGR_TIMEOUT_MS,
    intervalMs: 200,
  }).then((el) => {
    if (disposed) return;
    // Truthy → AGR present, nothing to warn about. Null → timed out → warn.
    if (!el) showBanner();
  });

  const dispose = () => {
    disposed = true;
    removeBanner();
    installed = null;
  };

  installed = { dispose };
  return dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs the
 * current dispose (if any) so each test case starts with a clean DOM and
 * no leaked observer. `_` prefix = do not import from production code.
 *
 * @returns {void}
 */
export const _resetAgrGuardForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
