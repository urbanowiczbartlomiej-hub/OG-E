// Big red overlay on #planet div — prompts the user to abandon a fresh
// small colony that sits below their `colMinFields` threshold.
//
// # Role
//
// On the OGame overview page, when the currently-displayed planet is a
// freshly-colonized slot (`usedFields === 0`) AND its `maxFields` is
// below the user's keep threshold (`settings.colMinFields`), we paint
// a semi-transparent red overlay over the `#planet` graphic with an
// "ABANDON" call to action. Click on the overlay hands off to the
// existing {@link abandonPlanet} flow in `./index.js` — which owns
// the 3-click safety-gated tear-down.
//
// # Precondition
//
// Every one of these must hold for the overlay to mount:
//
//   - `location.search` contains `component=overview`
//   - `settings.colonizeMode === true` (user opted into the colonize
//     feature suite; without it `colMinFields` is not a meaningful
//     signal)
//   - {@link checkAbandonState} returns truthy (overview + fresh +
//     below threshold — same gate `sendCol` historically used, now
//     owned by this feature)
//   - `#planet` div exists in the DOM
//
// Any condition false → overlay is NOT present in DOM. No styling, no
// listeners, no cost. When conditions flip from false to true (user
// toggles setting, AJAX nav brings in the overview, etc.) the overlay
// appears; when they flip the other way it disappears.
//
// # Interaction with abandon.js
//
// We import {@link checkAbandonState} and {@link abandonPlanet} from
// `./index.js` and call them read-only — the abandon module owns
// the flow's state (re-entry guard, safety gates, coord verification,
// overlay buttons inside the native popups). Our overlay is the
// ENTRY POINT; once the user taps it, everything downstream lives in
// `abandon.js`. We do not re-implement safety checks here — the
// {@link checkAbandonState} gate and the three in-flow safety gates
// live in one place there.
//
// # No anti-misclick gate
//
// Earlier design had a 500 ms `pointer-events: none → auto` gate, but
// MutationObserver on `document.body` fires constantly (game resource
// ticks, countdown timers) and the refresh() flow re-mounted the
// overlay faster than the timer could fire — pointer-events stayed at
// `none` forever. The `abandon.js` flow has three independent safety
// gates of its own (state re-check, coord match, dialog text match) +
// a re-entry guard, so an accidental click on our overlay at worst
// opens the game popup which the user can dismiss. Simpler wins.
//
// @ts-check

import { settingsStore } from '../../state/settings.js';
import { checkAbandonState, abandonPlanet } from './index.js';

/**
 * DOM id of the overlay. Stable so repeated mount calls short-circuit,
 * and so tests / CSS overrides can target it.
 */
const OVERLAY_ID = 'oge-abandon-overlay';

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Used to make {@link installAbandonOverview}
 * idempotent and to let the settings subscriber / mutation observer
 * exit early once disposed.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Read the current planet's coords from `#positionContentField a`.
 * Returns the raw bracketed string (e.g. `"[4:30:8]"`) so it can be
 * painted directly into the overlay without further formatting.
 * When the element is absent or its text doesn't match the expected
 * `[g:s:p]` shape, returns an empty string — the overlay still
 * renders, just with coords blank.
 *
 * @returns {string}
 */
const readCoordsText = () => {
  const el = document.querySelector('#positionContentField a');
  const raw = el?.textContent?.trim() ?? '';
  const m = raw.match(/\[\d+:\d+:\d+\]/);
  return m ? m[0] : '';
};

/**
 * Install the big red abandon overlay on the overview page.
 *
 * Lifecycle:
 *   1. Runs `refresh()` once synchronously — mounts the overlay if
 *      the current page already satisfies all preconditions.
 *   2. Subscribes to `settingsStore` so `colMinFields` / `colonizeMode`
 *      edits re-evaluate the mount state live.
 *   3. Installs a `MutationObserver` on `document.body` (childList +
 *      subtree). OGame AJAX-swaps the overview content when the user
 *      switches planets via the planet list; the observer catches
 *      those swaps and refreshes so the overlay appears/disappears
 *      in lock-step with the underlying `#planet` div.
 *   4. Returns a dispose fn that unmounts, unsubs settings, and
 *      disconnects the observer.
 *
 * Idempotent: calling `installAbandonOverview()` a second time while
 * already installed returns the SAME dispose fn as the first call
 * without re-wiring anything.
 *
 * @returns {() => void} Dispose handle.
 */
export const installAbandonOverview = () => {
  if (installed) return installed.dispose;

  /**
   * Remove the overlay if present, and clear the `#planet` position
   * style we set on mount. Safe to call when not mounted (no-op).
   *
   * @returns {void}
   */
  const unmount = () => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
  };

  /**
   * Mount the overlay inside `#planet`. Idempotent — re-enters as a
   * no-op when the overlay already exists.
   *
   * @param {{ used: number, max: number, minFields: number }} info
   *   Values from `checkAbandonState`; `max` is the one we paint.
   * @returns {void}
   */
  const mount = (info) => {
    if (document.getElementById(OVERLAY_ID)) return;
    const planet = /** @type {HTMLElement | null} */ (
      document.getElementById('planet')
    );
    if (!planet) return;

    // Position overlay as an ABSOLUTE body-level child aligned to
    // `#planet`'s page-space bounding rect. Earlier design mutated
    // `#planet.style.position = 'relative'` so that `inset: 0` on a
    // child worked — that turned out to break the game's jQuery UI
    // dialog init for the abandon popup (`openPlanetRenameGiveupBox`
    // triggers a `.dialog('option', ...)` that expects specific layout
    // state). Keeping `#planet` untouched and floating a body-level
    // overlay avoids any interaction with game's own DOM assumptions.
    const rect = planet.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position:absolute',
      `top:${rect.top + window.scrollY}px`,
      `left:${rect.left + window.scrollX}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'background:rgba(160, 0, 0, 0.85)',
      'color:#fff',
      'font-weight:bold',
      'text-align:center',
      'border:3px solid #fff',
      'border-radius:12px',
      'z-index:9999',
      'cursor:pointer',
    ].join(';');

    const titleLine = document.createElement('div');
    titleLine.textContent = '\u26A0 ABANDON \u26A0';
    titleLine.style.cssText = 'font-size:24px;margin-bottom:6px;opacity:0.9';

    const coordsLine = document.createElement('div');
    coordsLine.textContent = readCoordsText();
    coordsLine.style.cssText = 'font-size:18px;opacity:0.85';

    // The decisive metric for "abandon yes/no" — maxFields. Paint it
    // biggest so it dominates the overlay at a glance. User eyeballs
    // this number against their `colMinFields` threshold and either
    // confirms or closes.
    const sizeLine = document.createElement('div');
    sizeLine.textContent = `${info.max} fields`;
    sizeLine.style.cssText = 'font-size:56px;margin:8px 0;line-height:1;letter-spacing:1px';

    const hintLine = document.createElement('div');
    hintLine.textContent = 'click to start';
    hintLine.style.cssText = 'font-size:12px;opacity:0.7;margin-top:6px';

    overlay.appendChild(titleLine);
    overlay.appendChild(coordsLine);
    overlay.appendChild(sizeLine);
    overlay.appendChild(hintLine);

    // Click handler with visible feedback + password pre-check.
    //
    // CRITICAL: once the user commits to abandon, we FULLY dispose
    // ourselves — overlay removed, MutationObserver disconnected,
    // settings unsubscribed. The game's giveup popup opens jQuery UI
    // dialogs that seem sensitive to concurrent DOM mutations from
    // observers; our observer firing on every body mutation during
    // popup creation caused "cannot call methods on dialog prior to
    // initialization" errors in the game's `openOverlay`. Clean exit
    // gives the game exclusive ownership of the DOM for the flow.
    //
    // After dispose, if the user navigates back to overview (e.g. the
    // flow aborts, or they come back later), `installAbandonOverview()`
    // is re-invoked at the next DOMContentLoaded / content-script boot,
    // re-mounting the overlay if conditions still hold. So this is a
    // session-level hand-off, not a permanent disable.
    overlay.addEventListener('click', async () => {
      const s = settingsStore.get();
      if (!s.colPassword) {
        hintLine.textContent = '\u26A0 Set password in OG-E settings first';
        hintLine.style.opacity = '1';
        return;
      }
      // Dispose ourselves completely — game takes over. Captured from
      // the outer `installed` ref so it survives even though `installed`
      // will be set to null inside dispose.
      const disposeSelf = installed?.dispose;
      if (disposeSelf) disposeSelf();
      try {
        const ok = await abandonPlanet();
        if (!ok) {
          // eslint-disable-next-line no-console
          console.debug('[OG-E abandonOverview] abandonPlanet returned false — safety gate aborted');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.debug('[OG-E abandonOverview] abandonPlanet threw:', err);
      }
    });

    document.body.appendChild(overlay);
  };

  /**
   * Re-evaluate whether the overlay should be mounted. Called on
   * install, on every settings change, and on every body mutation.
   *
   * @returns {void}
   */
  const refresh = () => {
    const settings = settingsStore.get();
    if (!settings.colonizeMode) {
      unmount();
      return;
    }
    if (!location.search.includes('component=overview')) {
      unmount();
      return;
    }
    if (!document.getElementById('planet')) {
      unmount();
      return;
    }
    const info = checkAbandonState(settings);
    if (!info) {
      unmount();
      return;
    }
    mount(info);
  };

  // Initial mount (sync) — users arriving on the overview via direct
  // navigation see the overlay immediately rather than on the next
  // settings change.
  refresh();

  // React to settings edits — `colMinFields` bump or `colonizeMode`
  // toggle should flip the overlay in-place.
  const unsubSettings = settingsStore.subscribe(refresh);

  // OGame AJAX-swaps overview content when the user switches planets
  // via `#planetList`. childList + subtree catches both the `#planet`
  // div replacement and the `#diameterContentField` update that feeds
  // `checkAbandonState`.
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true });

  installed = {
    dispose: () => {
      unmount();
      unsubSettings();
      observer.disconnect();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs the
 * current dispose (if any) so each test case starts with a clean DOM
 * and fresh subscription count. Exported with a `_` prefix to signal
 * "do not import from production code".
 *
 * @returns {void}
 */
export const _resetAbandonOverviewForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
