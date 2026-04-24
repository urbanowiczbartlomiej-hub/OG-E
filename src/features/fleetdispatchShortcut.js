// @ts-check

// Keyboard shortcut: ArrowRight on the fleetdispatch page advances to
// the next visible action panel.
//
// Two-step navigation, gated to whichever panel is currently rendered:
//
//   • `#allresources` visible → click it (advances from "ships chosen"
//     to "resources chosen", revealing the dispatch panel).
//   • else `.send_all a` / `#sendall` visible → click it (advances from
//     "fleet view" to "send all ships", populating the resources step).
//
// One key press → exactly one click on the native AGR/OGame button
// (TOS clean — no automated chains).
//
// Pre-conditions:
//   - URL is `component=fleetdispatch`. Listener short-circuits otherwise
//     so the shortcut doesn't hijack ArrowRight on every other page.
//   - Active element is NOT an INPUT / TEXTAREA / SELECT — the user
//     might be typing fleet quantities and ArrowRight should still
//     move the caret then.
//   - Target element has `offsetParent !== null` (i.e. visible); jQuery
//     UI dialogs sometimes leave the buttons present but
//     `display:none`, and clicking a hidden button no-ops with a
//     confusing UX.
//
// Idempotent install: a second call returns the existing dispose fn.

import { safeClick } from '../lib/dom.js';

/** Substring used to gate the listener to the fleetdispatch page. */
const FLEETDISPATCH_PATH = 'component=fleetdispatch';

/**
 * Active install handle, or `null` when not installed. Held at module
 * scope so a second call to {@link installFleetdispatchShortcut}
 * collapses to a no-op returning the same dispose.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the ArrowRight shortcut. Returns a dispose fn that removes
 * the listener and clears the install handle. Idempotent.
 *
 * @returns {() => void}
 */
export const installFleetdispatchShortcut = () => {
  if (installed) return installed.dispose;

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight') return;
    if (!location.search.includes(FLEETDISPATCH_PATH)) return;

    // Don't intercept caret movement when the user is typing.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Panel 2: `#allresources` — advances from ships → resources →
    // dispatch ready. Higher priority than the ships button so a
    // re-press of ArrowRight after the first step does the right thing.
    const allRes = document.getElementById('allresources');
    if (allRes && /** @type {HTMLElement} */ (allRes).offsetParent !== null) {
      e.preventDefault();
      safeClick(allRes);
      return;
    }

    // Panel 1: `.send_all a` (preferred) or `#sendall` (fallback).
    // Either selector picks up the "send all ships" trigger that AGR
    // exposes on the fleet selection step.
    const sendAll = document.querySelector('.send_all a')
      ?? document.getElementById('sendall');
    if (sendAll && /** @type {HTMLElement} */ (sendAll).offsetParent !== null) {
      e.preventDefault();
      safeClick(sendAll);
    }
  };

  document.addEventListener('keydown', onKeyDown);

  installed = {
    dispose: () => {
      document.removeEventListener('keydown', onKeyDown);
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope install sentinel. Production
 * code never needs this — the leading underscore is a hard signal.
 *
 * @returns {void}
 */
export const _resetFleetdispatchShortcutForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
