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
// Two independent overlays fire whenever event items are present:
//
//   1. Animated menu entries — any `.menubutton.premiumHighligt` that is
//      NOT one of the three permanent items gets a persistent orange-pulse
//      animation on the menu button itself.
//
//   2. Alert banner in `#middle` — a prominent, blinking red-orange strip
//      prepended to `#middle` with a clickable link for each event item.
//      Hard to miss even if the left sidebar is collapsed or ignored.
//      Link text is the game's own locale-aware label from `.textlabel`.
//
// Both overlays are gated on `settings.eventMenuHighlight` (default `true`).
// Toggling off immediately strips highlights and removes the banner; the
// left-toolbar animation restores the moment it is toggled back on.
//
// The banner has an ✕ close button; clicking it suppresses the banner
// for the rest of the calendar day (stored in localStorage). The menu
// animation is never suppressed by dismiss — it is the lightweight
// reminder after the banner has been acknowledged.
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
//   1. `installEventMenuHighlight()` injects both stylesheets once
//      (idempotent: guarded by stable style-element ids).
//   2. `applyHighlights()` + `renderBanner()` run immediately, then on
//      every debounced MutationObserver tick in case OGame AJAX-rebuilds
//      the toolbar or content area.
//   3. A 3-second safety-poll re-applies both, guarding against observer
//      gaps (same safety-net pattern as `badges.js`).
//   4. A `settingsStore` subscription reacts immediately when the feature
//      is toggled: off → strip everything; on → re-inject and re-apply.
//   5. Dispose removes both style elements, strips the animation class,
//      removes the banner element, disconnects the observer, clears poll,
//      and unsubscribes from settingsStore. Dispose does NOT clear the
//      daily-dismiss localStorage flag — that is a user preference.
//
// Idempotent install: a second call returns the same dispose fn without
// touching the DOM.

/** @ts-check */

import { injectStyle, safeClick } from '../lib/dom.js';
import { debounce } from '../lib/debounce.js';
import { settingsStore } from '../state/settings.js';

const STYLE_ID = 'oge-event-highlight-style';
const BANNER_STYLE_ID = 'oge-event-banner-style';

/** CSS class added to event menu entries. */
const HIGHLIGHT_CLASS = 'oge-event-highlight';

/** Id of the alert banner injected into `#middle`. */
const BANNER_ID = 'oge-event-banner';

/**
 * localStorage key that stores the ISO date (`YYYY-MM-DD`) on which the
 * user last dismissed the banner. Cleared automatically on a new calendar
 * day.
 */
export const BANNER_DISMISS_KEY = 'oge-event-banner-dismissed';

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

const BANNER_CSS = `
@keyframes oge-banner-flash {
  0%, 100% {
    background: rgba(200, 30, 0, 0.85);
    box-shadow: 0 0 18px rgba(255, 80, 0, 0.6),
                inset 0 0 10px rgba(255, 60, 0, 0.3);
  }
  50% {
    background: rgba(255, 80, 0, 0.95);
    box-shadow: 0 0 40px rgba(255, 100, 0, 0.95),
                inset 0 0 20px rgba(255, 80, 0, 0.5);
  }
}
@keyframes oge-banner-text-flash {
  0%, 100% { color: #ffe04b; text-shadow: 0 0 6px rgba(255, 200, 0, 0.6); }
  50%       { color: #fff;    text-shadow: 0 0 16px rgba(255, 220, 0, 0.95); }
}
#${BANNER_ID} {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 12px 48px;
  margin-bottom: 10px;
  border-radius: 5px;
  border: 2px solid rgba(255, 120, 0, 0.8);
  animation: oge-banner-flash 0.9s ease-in-out infinite;
  cursor: default;
}
#${BANNER_ID} .oge-banner-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
#${BANNER_ID} .oge-banner-link {
  display: inline-block;
  padding: 8px 24px;
  border-radius: 4px;
  border: 1px solid rgba(255, 200, 0, 0.7);
  background: rgba(0, 0, 0, 0.35);
  color: #ffe04b !important;
  font-weight: bold;
  font-size: 17px;
  text-decoration: none !important;
  animation: oge-banner-text-flash 0.9s ease-in-out infinite;
  transition: background 0.15s;
}
#${BANNER_ID} .oge-banner-link:hover {
  background: rgba(255, 100, 0, 0.5);
}
#${BANNER_ID} .oge-banner-close {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: 1px solid rgba(255, 200, 0, 0.45);
  border-radius: 3px;
  color: #ffe04b;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 3px 8px;
  opacity: 0.75;
  transition: opacity 0.15s, background 0.15s;
}
#${BANNER_ID} .oge-banner-close:hover {
  opacity: 1;
  background: rgba(255, 50, 0, 0.4);
}
`;

const REFRESH_DEBOUNCE_MS = 150;

/** @returns {string} Today's date as `YYYY-MM-DD` in local time. */
const todayIso = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** @returns {boolean} True if the user already dismissed the banner today. */
const isBannerDismissedToday = () => {
  try {
    return localStorage.getItem(BANNER_DISMISS_KEY) === todayIso();
  } catch {
    return false;
  }
};

/** Record today's date as the dismiss date and remove the banner from DOM. */
const dismissBanner = () => {
  try {
    localStorage.setItem(BANNER_DISMISS_KEY, todayIso());
  } catch {
    // localStorage unavailable — suppress for this page load only.
  }
  document.getElementById(BANNER_ID)?.remove();
};

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

/**
 * Build or remove the alert banner in `#middle` based on the current set of
 * event items. Skips rendering when the feature is disabled in settings or
 * when the user dismissed the banner today.
 *
 * @returns {void}
 */
const renderBanner = () => {
  const items = findEventItems();
  const existing = document.getElementById(BANNER_ID);

  if (!settingsStore.get().eventMenuHighlight || items.length === 0 || isBannerDismissedToday()) {
    existing?.remove();
    return;
  }

  const middle = document.getElementById('middle');
  if (!middle) return;

  // Reuse existing element to avoid animation restart on each safety-poll.
  const banner = existing ?? document.createElement('div');
  banner.id = BANNER_ID;
  banner.innerHTML = '';

  const linksWrap = document.createElement('div');
  linksWrap.className = 'oge-banner-links';

  for (const el of items) {
    const anchor = /** @type {HTMLAnchorElement} */ (el);
    const text =
      anchor.querySelector('.textlabel')?.textContent?.trim() ||
      anchor.dataset.ipiHint ||
      'Event';

    const link = document.createElement('a');
    link.className = 'oge-banner-link';
    link.textContent = text;

    // CSP guard: OGame ships some premium-menu items as
    // `<a href="javascript:...">`. Copying that href onto our banner
    // link causes a CSP `script-src` violation when the user clicks
    // (the page's policy does not allow javascript: navigations). For
    // such anchors we delegate the click to the original element via
    // safeClick — which strips the javascript: href and fires the
    // click event, so any OGame-attached onclick listener still runs.
    // Plain http(s) hrefs are passed through unchanged so middle-click
    // and right-click "open in new tab" keep working.
    const rawHref = anchor.getAttribute('href') ?? '';
    if (rawHref && !rawHref.startsWith('javascript:')) {
      link.href = rawHref;
    } else {
      link.href = '#';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        safeClick(anchor);
      });
    }

    linksWrap.appendChild(link);
  }
  banner.appendChild(linksWrap);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'oge-banner-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', dismissBanner);
  banner.appendChild(closeBtn);

  if (!existing) {
    middle.prepend(banner);
  }
};

/** Strip all highlights and remove banner+styles — used when toggled off. */
const teardownDom = () => {
  document
    .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
  document.getElementById(BANNER_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(BANNER_STYLE_ID)?.remove();
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
  injectStyle(BANNER_STYLE_ID, BANNER_CSS);
  applyHighlights();
  renderBanner();

  const scheduleRefresh = debounce(() => {
    if (installed) {
      applyHighlights();
      renderBanner();
    }
  }, REFRESH_DEBOUNCE_MS);

  const observer = new MutationObserver(scheduleRefresh);
  const target = document.getElementById('menuTable') ?? document.body;
  observer.observe(target, { childList: true, subtree: true });

  const safetyPoll = setInterval(() => {
    if (installed) {
      applyHighlights();
      renderBanner();
    }
  }, 3000);

  // React to settings changes — same diff-guarded pattern as readabilityBoost.
  let prevEnabled = settingsStore.get().eventMenuHighlight;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.eventMenuHighlight === prevEnabled) return;
    prevEnabled = next.eventMenuHighlight;
    if (prevEnabled) {
      injectStyle(STYLE_ID, CSS);
      injectStyle(BANNER_STYLE_ID, BANNER_CSS);
      applyHighlights();
      renderBanner();
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
 * between test cases. Does NOT clear the localStorage dismiss flag —
 * tests that need a clean dismiss state must clear it via BANNER_DISMISS_KEY.
 *
 * @returns {void}
 */
export const _resetEventMenuHighlightForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
