// Event menu highlight — draw attention to temporary event entries that
// share the `premiumHighligt` class with the three permanent premium items.
//
// # Problem
//
// OGame occasionally inserts ephemeral event entries (reward periods,
// contests, seasonal items …) into the left toolbar under the same
// `premiumHighligt` class that styles the always-present Trader, Officers,
// and Shop items. Because these entries look identical to the permanent
// ones, players routinely skip them during daily routines and miss the
// associated event window.
//
// # Solution
//
// Animated menu entries — any `.menubutton.premiumHighligt` that is NOT
// one of the three permanent items gets a persistent orange-pulse
// animation on the menu button itself. Subtle enough to live with all
// day, distinct enough that the eye lands on it during the routine
// left-sidebar scan.
//
// Gated on `settings.eventMenuHighlight` (default `true`). Toggling off
// immediately strips the animation; the animation restores the moment it
// is toggled back on.
//
// Permanent items are identified by their English `data-ipi-hint` values
// (locale-independent game-engine identifiers):
//
//   ipiToolbarTrader    → Trader / Handlarz
//   ipiToolbarOfficers  → Officers / Kantyna
//   ipiToolbarShop      → Shop / Sklep
//
// Every other `premiumHighligt` entry is treated as ephemeral. If OGame
// ever adds a fourth permanent premium item, add its hint to PERMANENT_HINTS.
//
// # Lifecycle
//
//   1. `installEventMenuHighlight()` injects the stylesheet once
//      (idempotent: guarded by stable style-element id).
//   2. `applyHighlights()` runs immediately, then on every debounced
//      MutationObserver tick in case OGame AJAX-rebuilds the toolbar.
//   3. A 3-second safety-poll re-applies, guarding against observer
//      gaps (same safety-net pattern as `badges.js`).
//   4. A `settingsStore` subscription reacts immediately when the feature
//      is toggled: off → strip everything; on → re-inject and re-apply.
//   5. Dispose strips the animation class, removes the style element,
//      disconnects the observer, clears the poll, and unsubscribes from
//      settingsStore.
//
// Idempotent install: a second call returns the same dispose fn without
// touching the DOM.
//
// # History
//
// Earlier versions of this feature also painted a large red-orange
// blinking banner at the top of `#middle` with a clickable link for each
// event item. The banner was removed in v1.3.6 — the menu pulse alone
// proved sufficient, and the banner was loud enough that players found
// it disruptive during normal play. See git history for the prior
// banner implementation if a revival is ever considered.

/** @ts-check */

import { injectStyle } from '../lib/dom.js';
import { debounce } from '../lib/debounce.js';
import { settingsStore } from '../state/settings.js';

const STYLE_ID = 'oge-event-highlight-style';

/** CSS class added to event menu entries. */
const HIGHLIGHT_CLASS = 'oge-event-highlight';

/**
 * English `data-ipi-hint` values for the three permanent premium items.
 * Locale-independent — safe to hardcode.
 *
 * @type {ReadonlySet<string>}
 */
const PERMANENT_HINTS = new Set([
  'ipiToolbarTrader',
  'ipiToolbarOfficers',
  'ipiToolbarShop',
]);

const CSS = `
@keyframes oge-event-bg {
  0%, 70%, 100% {
    box-shadow: inset 0 0 6px rgba(255, 115, 0, 0.30),
                0 0 3px rgba(255, 90, 0, 0.15);
  }
  85% {
    box-shadow: inset 0 0 18px rgba(255, 150, 0, 0.80),
                0 0 14px rgba(255, 100, 0, 0.55),
                0 0 28px rgba(255, 80, 0, 0.25);
  }
}
@keyframes oge-event-text {
  0%, 70%, 100% {
    color: #ffd700;
    text-shadow: 0 0 4px rgba(255, 200, 0, 0.30);
  }
  85% {
    color: #ffd700;
    text-shadow: 0 0 7px rgba(255, 190, 0, 0.60);
  }
}
.${HIGHLIGHT_CLASS} {
  animation: oge-event-bg 4s linear infinite;
  border-radius: 3px;
}
.${HIGHLIGHT_CLASS} span {
  animation: oge-event-text 4s linear infinite;
  font-weight: bold;
}
.${HIGHLIGHT_CLASS}:hover,
.${HIGHLIGHT_CLASS}:active {
  animation-name: none;
  box-shadow: inset 0 0 12px rgba(255, 140, 0, 0.55),
              0 0 7px rgba(255, 90, 0, 0.30);
}
.${HIGHLIGHT_CLASS}:hover span,
.${HIGHLIGHT_CLASS}:active span {
  animation-name: none;
  color: #ffd700;
  text-shadow: 0 0 7px rgba(255, 190, 0, 0.60);
}
.${HIGHLIGHT_CLASS}.on {
  animation-name: none;
  box-shadow: inset 0 0 20px rgba(255, 160, 0, 0.85),
              0 0 16px rgba(255, 110, 0, 0.60),
              0 0 32px rgba(255, 80, 0, 0.28);
}
.${HIGHLIGHT_CLASS}.on span {
  animation-name: none;
  color: #ffd700;
  text-shadow: 0 0 9px rgba(255, 200, 0, 0.70);
}
`;

const REFRESH_DEBOUNCE_MS = 150;

/**
 * Return all ephemeral event menu entries: `.menubutton.premiumHighligt`
 * items inside `#menuTable` that are not one of the three permanent items.
 *
 * @returns {Element[]}
 */
const findEventItems = () =>
  [...document.querySelectorAll('#menuTable .menubutton.premiumHighligt')].filter(
    (el) => !PERMANENT_HINTS.has(/** @type {HTMLElement} */ (el).dataset.ipiHint ?? ''),
  );

/**
 * Strip the highlight class from any previously tagged element, then
 * re-apply to the current set of event items. No-op when the feature
 * is disabled in settings.
 *
 * @returns {void}
 */
const applyHighlights = () => {
  if (!settingsStore.get().eventMenuHighlight) return;
  document
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
  findEventItems().forEach((el) => el.classList.add(HIGHLIGHT_CLASS));
};

/** Strip all highlights and remove styles — used when toggled off. */
const teardownDom = () => {
  document
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
  document.getElementById(STYLE_ID)?.remove();
};

/**
 * Module-scope install handle. Non-null between install and dispose.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the event-menu highlight feature.
 *
 * Idempotent: a second call while already installed returns the same
 * dispose fn without touching the DOM.
 *
 * @returns {() => void} Dispose handle.
 */
export const installEventMenuHighlight = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);
  applyHighlights();

  const scheduleRefresh = debounce(() => {
    if (installed) applyHighlights();
  }, REFRESH_DEBOUNCE_MS);

  const observer = new MutationObserver(scheduleRefresh);
  const target = document.getElementById('menuTable') ?? document.body;
  observer.observe(target, { childList: true, subtree: true });

  const safetyPoll = setInterval(() => {
    if (installed) applyHighlights();
  }, 3000);

  // React to settings changes — same diff-guarded pattern as readabilityBoost.
  let prevEnabled = settingsStore.get().eventMenuHighlight;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.eventMenuHighlight === prevEnabled) return;
    prevEnabled = next.eventMenuHighlight;
    if (prevEnabled) {
      injectStyle(STYLE_ID, CSS);
      applyHighlights();
    } else {
      teardownDom();
    }
  });

  installed = {
    dispose: () => {
      observer.disconnect();
      clearInterval(safetyPoll);
      unsubSettings();
      teardownDom();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset. Runs the current dispose (if any) so DOM is clean
 * between test cases.
 *
 * @returns {void}
 */
export const _resetEventMenuHighlightForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
