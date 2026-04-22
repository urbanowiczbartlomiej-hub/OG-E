// Transient UI state — lives in memory only, never persisted.
//
// Holds the per-tab scratch that coordinates multi-step user flows:
//
//   - `pendingColLink`   After the user picks the next colonize target
//                        via the Send Col scan we stash the target URL
//                        here so the "Send" click knows where to navigate.
//                        Cleared after the click / after a fresh scan.
//
//   - `pendingColVerify` Set when Send Col redirects the user to
//                        fleetdispatch with specific coords. The
//                        `oge:checkTargetResult` handler uses this to
//                        recognize "this is the target WE just asked for"
//                        vs "the user typed something manually into the
//                        form", so we only flag stale targets that came
//                        from our own flow. Cleared on result (success
//                        OR stale).
//
//   - `staleRetryActive` Flipped on by the stale-target handler when a
//                        Send Col target turned out to be no longer
//                        colonizable. The next Send click swaps the
//                        fleetdispatch form to the next candidate in ONE
//                        step (strict 1:1 click-to-HTTP); the flag is
//                        cleared by that swap.
//
// Why in memory, not persisted:
//   - Every piece here is a short-lived handshake inside a single user
//     flow. Persisting it across reloads would recreate half-executed
//     states the user no longer remembers triggering.
//   - v4's `pendingColLink` et al. lived in module-scope `let`s; moving
//     them into a reactive store gives feature code one uniform way to
//     observe transient state (the same store API as everything else),
//     and lets settings / diagnostics UIs show it live without polling.
//
// This module is the one `state/*` file with no `persist` wiring. That
// is the point — persistence would be wrong for this kind of state.

import { createStore } from '../lib/createStore.js';

/**
 * @typedef {object} UIState
 * @property {string | null} pendingColLink
 *   URL to navigate to on the next Send Col click, or null. Set by the
 *   scan flow when a fresh target is found; consumed (and cleared) by
 *   the Send click handler.
 * @property {{ galaxy: number, system: number, position: number } | null} pendingColVerify
 *   Coords of the target our Send flow just redirected to. Non-null
 *   while we're waiting for the game's checkTarget XHR; cleared once
 *   the result arrives (whether Ready or Stale).
 * @property {boolean} staleRetryActive
 *   True when the most recent checkTarget came back Stale (or
 *   Reserved) and we have armed a "next Send click navigates to that
 *   system's galaxy view so the game refreshes the DB with reality"
 *   path. DESIGN.md §9.2 — navigation replaces the older 4.7.x
 *   form-swap retry. Flipped false as soon as the nav fires.
 * @property {{ galaxy: number, system: number } | null} staleTargetCoords
 *   Coords of the stale-or-reserved slot we're about to navigate the
 *   user to when `staleRetryActive` is true. Written by the stale
 *   branch of `onCheckTargetResult`, consumed by `navigateToStaleSystem`.
 */

/** @type {UIState} */
const initialState = {
  pendingColLink: null,
  pendingColVerify: null,
  staleRetryActive: false,
  staleTargetCoords: null,
};

/**
 * The UI state store. Consumers subscribe (via {@link uiState.subscribe})
 * to react to transient flow state, and call {@link uiState.update} with
 * a patch function to change one or more fields. Immutable updates only
 * — pass a NEW object, do not mutate the existing state.
 *
 * @example
 *   // Set the pending link; other fields preserved.
 *   uiState.update((s) => ({ ...s, pendingColLink: link }));
 *
 *   // Clear verify + set retry on stale.
 *   uiState.update((s) => ({
 *     ...s,
 *     pendingColVerify: null,
 *     staleRetryActive: true,
 *   }));
 *
 * @type {import('../lib/createStore.js').Store<UIState>}
 */
export const uiState = createStore(initialState);
