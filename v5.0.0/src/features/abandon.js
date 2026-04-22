// 3-click abandon flow — porzucanie za małych fresh kolonii (mobile-safe).
//
// # What it does
//
// On the OGame overview page, when the current planet is freshly
// colonized (usedFields === 0) and below the user's keep threshold
// (settings.colMinFields), we relay each of the user's three taps to
// exactly ONE native game action, with a DOM-level safety check between
// every step. The flow closes with a local scansStore update and a
// page reload.
//
// Strict 1:1 user-click → game-HTTP-request mapping (TOS):
//
//   Click 1 (external — feature caller invokes `abandonPlanet()`):
//     safeClick(.openPlanetRenameGiveupBox)  → GAME: GET /planetlayer
//     + pure-DOM: click #block, autofill password (no HTTP)
//     + inject our big "SUBMIT PASSWORD" button WEWNĄTRZ popup
//
//   Click 2 (user taps injected Submit):
//     safeClick(nativeSubmit)                → GAME: POST /confirmPlanetGiveup
//     + inject "CONFIRM DELETE" button WEWNĄTRZ the spawned confirm dialog
//
//   Click 3 (user taps injected Confirm):
//     safeClick(yesBtn)                       → GAME: POST /planetGiveup
//     + cleanup scansStore + reload
//
// # Why injected buttons WEWNĄTRZ popup DOM (4.7.8 fix)
//
// jQuery UI dialog's focus manager treats "click on element outside the
// dialog" as a focus-leave and hides the popup. On mobile — where a tap
// briefly fires focus events before the click — this closed the popup
// between clicks 1 and 2 of the flow (or 2 and 3), silently aborting.
// The fix: our proxy buttons are appended INSIDE the `#abandonplanet`
// content div and inside the `#errorBoxDecision`/`.errorBox` confirm
// dialog. Clicks on them count as clicks inside the dialog scope,
// focus never leaves, and the popup stays open until we safeClick()
// the native submit/yes element that dispatches the real HTTP request.
//
// # Why expandEnclosingDialog (4.8.4 fix)
//
// OGame ships the delete-confirm dialog at a hardcoded 400px width.
// On mobile viewports the big proxy "CONFIRM DELETE" button — which
// must be finger-sized — overflowed that width and rendered cramped.
// `expandEnclosingDialog` widens the surrounding `.ui-dialog` to 600px
// (or viewport-minus-20 if the viewport is narrower) and re-centers it
// when the new left-edge would run past the screen boundary. Applied
// to both the giveup popup (click 1 result) and the confirm dialog
// (click 2 result).
//
// # Why we do NOT touch historyStore (4.8.3 lesson)
//
// `historyStore` is the size-histogram dataset — every fresh
// observation of a newly-colonized planet (including ones we are
// about to abandon) is a valid data point for the planet-size
// distribution at the user's preferred positions. Abandoned planets
// are in fact the MOST important data points (they are by definition
// the small ones; without them the histogram's left tail disappears).
// `cleanupAbandonedPlanet` therefore only updates `scansStore` (so
// the galaxy view doesn't re-suggest the slot) and deliberately
// leaves the history record alone.
//
// # Safety gates
//
// Three independent checks guard against deleting a built-up planet:
//
//   1. `checkAbandonState()` must hold on entry — we're on the
//      overview page, `usedFields === 0`, and `maxFields` is below
//      the user's `colMinFields` threshold.
//   2. After click 1, `#giveupCoordinates` text must equal the
//      coordinates we captured from `#positionContentField` on entry.
//      A mismatch here would mean the popup was opened for a
//      different planet (race with manual navigation) → hard abort.
//   3. After click 2, the confirm dialog text must include the
//      captured coordinates. OGame echoes the planet's coords inside
//      the dialog body; if ours aren't there, we're looking at the
//      wrong dialog → hard abort.
//
// Plus a module-level `abandonInProgress` flag prevents re-entry
// from accidental double-invocation.
//
// @ts-check

import { settingsStore } from '../state/settings.js';
import { scansStore } from '../state/scans.js';
import { safeClick, waitFor } from '../lib/dom.js';

/**
 * @typedef {import('../state/settings.js').Settings} Settings
 */

/**
 * Expand the jQuery-UI `.ui-dialog` that encloses `el` to at least
 * `desiredWidthPx`, capping at `window.innerWidth - 20` to leave a
 * breathing margin on narrow mobile viewports. If the dialog's current
 * `left` would place the right edge past the screen, re-positions it
 * so the full width fits.
 *
 * No-op when `el` is not inside a `.ui-dialog` (e.g. tests mounting
 * our target div at the document root without the jQuery UI wrapper).
 *
 * @param {Element} el   Any element inside the dialog we want widened.
 * @param {number} [desiredWidthPx]  Preferred width in px. Defaults 600.
 * @returns {void}
 */
const expandEnclosingDialog = (el, desiredWidthPx = 600) => {
  const dialog = /** @type {HTMLElement | null} */ (
    el.closest?.('.ui-dialog') ?? null
  );
  if (!dialog) return;
  const target = Math.min(desiredWidthPx, window.innerWidth - 20);
  dialog.style.width = target + 'px';
  const left = parseFloat(dialog.style.left) || 0;
  const maxLeft = window.innerWidth - target - 10;
  if (left > maxLeft) dialog.style.left = Math.max(10, maxLeft) + 'px';
};

/**
 * Create one of our big proxy action buttons. Styled for thumb-tap
 * friendliness: 66px vertical padding, bold 20px label, 2px white
 * border, `touch-action: manipulation` (disables double-tap zoom).
 * The caller is responsible for appending it WEWNĄTRZ the game's
 * popup DOM — the styling does not include `position:absolute`; the
 * button sits as a block element below the native content.
 *
 * @param {string} text    Button label.
 * @param {string} bgColor CSS background colour.
 * @param {string} id      DOM id (used by the click watchdogs to
 *                         detect popup-close between steps).
 * @returns {HTMLButtonElement}  Unattached `<button type="button">`.
 */
const makeInjectedButton = (text, bgColor, id) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = id;
  btn.textContent = text;
  btn.style.cssText = [
    'display:block', 'width:100%', 'box-sizing:border-box',
    'margin:14px 0', 'padding:66px 16px',
    'background:' + bgColor, 'color:#fff',
    'font-size:20px', 'font-weight:bold', 'text-align:center',
    'border:2px solid #fff', 'border-radius:10px',
    'cursor:pointer', 'touch-action:manipulation',
  ].join(';');
  return btn;
};

/**
 * Mark a galaxy slot as abandoned in {@link scansStore} so the galaxy
 * overlay does not suggest it as a colonize target in future picks.
 *
 * Deliberately does NOT touch `historyStore` — see module header for
 * the rationale (histogram preservation; 4.8.3 lesson).
 *
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @returns {void}
 */
const cleanupAbandonedPlanet = (galaxy, system, position) => {
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  scansStore.update((prev) => {
    const existing = prev[key] ?? { scannedAt: Date.now(), positions: {} };
    /** @type {import('../state/scans.js').SystemScan['positions']} */
    const newPositions = {
      ...existing.positions,
      [position]: {
        status: 'abandoned',
        flags: { hasAbandonedPlanet: true },
      },
    };
    return {
      ...prev,
      [key]: { scannedAt: Date.now(), positions: newPositions },
    };
  });
};

/**
 * Re-entry guard. Flipped to `true` when a flow enters Click-1 work
 * and back to `false` in the `finally` of {@link abandonPlanet}. A
 * second concurrent call returns `false` immediately.
 */
let abandonInProgress = false;

/**
 * Sync DOM read: is the current overview page a fresh colony that is
 * below the user's keep threshold?
 *
 * Conditions (all must hold):
 *   - `location.search` includes `component=overview`
 *   - `#diameterContentField` exists and matches `(used/max)`
 *   - `used === 0` (no buildings yet — definitely fresh)
 *   - `max < settings.colMinFields` (below the user's threshold)
 *
 * @param {Settings} [settings]  Optional settings snapshot; defaults
 *   to the current `settingsStore.get()` value. Passing it in makes
 *   the function pure w.r.t. the store, which simplifies testing.
 * @returns {{ used: number, max: number, minFields: number } | null}
 *   Triple of parsed values when abandon is warranted, else `null`.
 */
export const checkAbandonState = (settings) => {
  const s = settings ?? settingsStore.get();
  if (!location.search.includes('component=overview')) return null;
  const diameterEl = document.getElementById('diameterContentField');
  if (!diameterEl) return null;
  const m = diameterEl.textContent?.match(/\((\d+)\/(\d+)\)/);
  if (!m) return null;
  const used = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (used !== 0) return null;
  if (max >= s.colMinFields) return null;
  return { used, max, minFields: s.colMinFields };
};

/**
 * Run the 3-click abandon flow end-to-end. Returns `true` on
 * successful completion (local cleanup done, reload scheduled),
 * `false` on any abort — missing safety gate, coords mismatch,
 * timeout waiting for a game response, or user closing a popup
 * mid-flow. Uses the module-level {@link abandonInProgress} flag
 * to block re-entry.
 *
 * See file header for the 1:1 click-to-HTTP mapping.
 *
 * @returns {Promise<boolean>}
 */
export const abandonPlanet = async () => {
  if (abandonInProgress) return false;

  const settings = settingsStore.get();

  // ── Safety 1: abandon state still valid on entry ───────────────
  if (!checkAbandonState(settings)) return false;

  // ── Safety 2: capture planet coords for mid-flow verification ──
  const posEl = document.querySelector('#positionContentField a');
  const coordsMatch = posEl?.textContent?.trim()?.match(/\[(\d+):(\d+):(\d+)\]/);
  if (!coordsMatch) return false;
  const galaxy = parseInt(coordsMatch[1], 10);
  const system = parseInt(coordsMatch[2], 10);
  const position = parseInt(coordsMatch[3], 10);
  const expectedCoords = `[${galaxy}:${system}:${position}]`;

  // ── Safety 3: password configured ──────────────────────────────
  if (!settings.colPassword) return false;

  abandonInProgress = true;
  try {
    // ═══ Click 1: open giveup popup ═════════════════════════════
    const giveupLink = document.querySelector('.openPlanetRenameGiveupBox');
    if (!giveupLink) return false;
    safeClick(giveupLink); // HTTP: GET /planetlayer

    // Wait for the popup and verify it opened for OUR planet.
    const giveupCoordsEl = await waitFor(() => {
      const el = document.getElementById('giveupCoordinates');
      return el?.textContent?.trim() ? el : null;
    }, { timeoutMs: 5000 });
    if (!giveupCoordsEl) return false;
    if (giveupCoordsEl.textContent?.trim() !== expectedCoords) {
      // Coords mismatch — hard abort; never delete the wrong planet.
      return false;
    }

    // Pure-DOM: click #block to reveal password form (no HTTP).
    const blockBtn = document.getElementById('block');
    if (!blockBtn) return false;
    safeClick(blockBtn);

    const validateDiv = await waitFor(() => {
      const el = document.getElementById('validate');
      return el && el.offsetParent !== null ? el : null;
    }, { timeoutMs: 3000 });
    if (!validateDiv) return false;

    const pwField = /** @type {HTMLInputElement | null} */ (
      validateDiv.querySelector('input[type="password"]')
    );
    const nativeSubmit = /** @type {HTMLInputElement | null} */ (
      validateDiv.querySelector('input[type="submit"]')
    );
    if (!pwField || !nativeSubmit) return false;

    // Autofill password (no HTTP); fire input + change events so any
    // framework listeners bound to the field see the update.
    pwField.value = settings.colPassword;
    pwField.dispatchEvent(new Event('input', { bubbles: true }));
    pwField.dispatchEvent(new Event('change', { bubbles: true }));

    // Inject the big "SUBMIT PASSWORD" button WEWNĄTRZ the popup so
    // jQuery UI's focus manager doesn't close the dialog on tap.
    const abandonContent = document.getElementById('abandonplanet');
    if (!abandonContent) return false;
    const proxySubmit = makeInjectedButton(
      'SUBMIT PASSWORD',
      '#c07020',
      'oge5-abandon-proxy-submit',
    );
    abandonContent.appendChild(proxySubmit);
    expandEnclosingDialog(abandonContent);

    // ═══ Click 2: user taps our Submit proxy ════════════════════
    const submitOk = await new Promise(
      /** @param {(value: boolean) => void} resolve */
      (resolve) => {
        proxySubmit.addEventListener('click', () => {
          clearInterval(watchdog);
          proxySubmit.disabled = true;
          proxySubmit.textContent = 'Submitting…';
          safeClick(nativeSubmit); // HTTP: POST /confirmPlanetGiveup
          resolve(true);
        }, { once: true });
        // Auto-abort if the popup closes under us (user tapped X).
        const watchdog = setInterval(() => {
          if (!document.getElementById('oge5-abandon-proxy-submit')) {
            clearInterval(watchdog);
            resolve(false);
          }
        }, 500);
      },
    );
    if (!submitOk) return false;

    // Wait for confirm dialog; verify it references our planet.
    const yesBtn = await waitFor(() => {
      const btn = document.querySelector('#errorBoxDecision .yes')
        ?? document.querySelector('.errorBox .yes');
      if (!btn) return null;
      const dialog = document.querySelector('#errorBoxDecision')
        ?? document.querySelector('.errorBox');
      const text = dialog?.textContent ?? '';
      if (!text.includes(expectedCoords)) return null;
      return btn;
    }, { timeoutMs: 5000 });
    if (!yesBtn) return false;

    const confirmDialog = /** @type {HTMLElement | null} */ (
      document.getElementById('errorBoxDecision')
      ?? document.querySelector('.errorBox')
    );
    if (!confirmDialog) return false;

    const proxyConfirm = makeInjectedButton(
      '⚠ CONFIRM DELETE ⚠',
      '#a02020',
      'oge5-abandon-proxy-confirm',
    );
    confirmDialog.appendChild(proxyConfirm);
    expandEnclosingDialog(confirmDialog);

    // ═══ Click 3: user taps our Confirm proxy ═══════════════════
    const confirmOk = await new Promise(
      /** @param {(value: boolean) => void} resolve */
      (resolve) => {
        proxyConfirm.addEventListener('click', () => {
          clearInterval(watchdog);
          proxyConfirm.disabled = true;
          proxyConfirm.textContent = 'Deleting…';
          safeClick(yesBtn); // HTTP: POST /planetGiveup
          resolve(true);
        }, { once: true });
        const watchdog = setInterval(() => {
          if (!document.getElementById('oge5-abandon-proxy-confirm')) {
            clearInterval(watchdog);
            resolve(false);
          }
        }, 500);
      },
    );
    if (!confirmOk) return false;

    // Post-abandon: brief settle, then scansStore cleanup + reload.
    await new Promise((r) => setTimeout(r, 800));
    cleanupAbandonedPlanet(galaxy, system, position);
    setTimeout(() => location.reload(), 800);
    return true;
  } finally {
    abandonInProgress = false;
  }
};

/**
 * Test-only hook: reset the module-level {@link abandonInProgress}
 * re-entry guard. Production code never needs to call this — the
 * `finally` block in {@link abandonPlanet} always clears the flag.
 *
 * @returns {void}
 */
export const _resetAbandonForTest = () => {
  abandonInProgress = false;
};
