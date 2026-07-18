// @ts-check

// Floating "Send Exp" button — orchestrator + DOM I/O. Pure helpers
// (constants, URL builder, cap checks, initial-label
// decision) live in `./pure.js`; this file owns the install/dispose
// lifecycle, the click-handler state machine, the DOM readers, and
// the bridge listener that keeps the fleetDispatcher snapshot fresh.
//
// # Why this feature exists
//
// On mobile, OGame scales the page to roughly half size, so the game's
// own "Send fleet" button becomes a 40×40 px target that users miss
// constantly. Our button is settings-driven in pixel diameter (default
// 560) and draggable to the user's preferred spot on the screen, so it
// is always comfortably reachable with the thumb.
//
// # What one click does (each tap = exactly ONE game action)
//
//   1. User is NOT on fleetdispatch → we navigate to fleetdispatch with
//      `cp=<a planet that still has an expedition slot>`. The game's own
//      page load happens next; we originate no request ourselves.
//   2. On fleetdispatch, fleet panel NOT yet hydrated → we click AGR's
//      expedition routine `#ago_routine_7` (once it reports ready). AGR
//      assigns the mission + fleet and renders the native dispatch button;
//      the label flips to "Send" so the user's NEXT tap sends.
//   3. On fleetdispatch, fleet panel hydrated (`#dispatchFleet` present)
//      → we click the native dispatch button. Exactly one send.
//
// The "one click → one action" contract is the same TOS-safe boundary
// every OG-E feature respects: we never chain server-visible actions,
// and we lean on AGR (which every player runs) rather than driving the
// native form ourselves — AGR overwrites the fleet2 target anyway.
//
// # Long-press = skip this planet
//
// A long-press ({@link HOLD_SKIP_MS} ms, with the shared button's radial
// charge arc as feedback) navigates to the next planet still UNDER
// `maxExpeditionsPerPlanet` WITHOUT sending — the manual counterpart to the
// auto-redirect's round-robin hop (`bridges/expeditionRedirect.js`). It lets
// the player deliberately pass over the planet they're on; the walk just
// continues from the destination. Paints "All sent" when no OTHER planet
// has a free slot. This is navigation only — still zero server actions.
//
// # Max-expedition guard
//
// If `#eventContent` already shows `maxExpeditionsPerPlanet` expedition fleets
// we paint a transient "All sent" label on the button for 2 seconds
// and abort the dispatch. We do NOT auto-advance to a different
// planet — that is what `bridges/expeditionRedirect.js` does on
// successful sends, orthogonally.
//
// # Settings-driven lifecycle
//
//   - `showExpeditionButton` toggles visibility (the settings module bar;
//                   each unified-FAB module has its own flag). Flipping it
//                   off at runtime removes the DOM node entirely (we aren't
//                   a CSS-hide feature like the badges cluster; the button
//                   would grab tap area even while invisible, so actual
//                   removal is correct).
//   - `fabBtnSize`  resizes the circle and scales the font to ~23%.
//                   Updates apply live.
//   - `maxExpeditionsPerPlanet` gates the click handler. Read per click, so
//                   panel edits take effect on the very next tap.
//
// # Unified FAB + focus persistence
//
// The button is one module of the unified FAB (`shared/unifiedFab.js`):
// the shell owns the shared dragged position (`oge_fabPos`) and shows the
// button only while it is the active module.
//
// @see ./pure.js — pure constants + helpers consumed here.
// @see ../../bridges/expeditionRedirect.js — orthogonal: rewrites the
//   post-send `redirectUrl` so successive dispatches hop planets.

import { settingsStore } from '../../state/settings.js';
import { prepareViaRoutine, dispatchPrepared, dispatchWhenReady } from '../shared/agrRoutine.js';
import { GAME } from '../../lib/gameDom.js';
import { createButton as makeButton } from '../shared/button.js';
import { COMET_GLYPH } from '../shared/buttonGlyphs.js';
import { FAB_MODULES } from '../shared/fabModules.js';
import { OWNER_EXP } from '../../domain/fleetOwnership.js';
import { isFleetCapReached } from '../../domain/fleetPlan.js';
import { installFleetOwnership } from '../shared/fleetOwnership.js';
import { bareFleetdispatchUrl } from '../shared/fleetCourier.js';
import { installFabSettingsLifecycle } from '../shared/fabSettingsLifecycle.js';
import { createFleetDispatcherCache } from '../shared/fleetDispatcherCache.js';
import {
  BUTTON_ID,
  MAX_LABEL_MS,
  HOLD_SKIP_MS,
  BUTTON_TEXT,
  ALL_MAXED_LABEL,
  ALL_FLEETS_LABEL,
  BG_IDLE,
  BG_MAX,
  BG_ERROR,
  EXP_ROUTINE_OFF_LABEL,
  EXP_ROUTINE_OFF_HINT,
  ROUTINE_OFF_LABEL_MS,
  buildFleetdispatchUrl,
  isGlobalExpeditionCapReached,
  isGlobalExpeditionCapReachedAfterNextSend,
  isPlanetShipless,
  computeInitialLabel,
} from './pure.js';
import {
  getActivePlanetCoords,
  countActiveExpeditions,
  findPlanetWithExpSlot,
} from './domHelpers.js';

// ── Module-level snapshot of `window.fleetDispatcher` ────────────────

/**
 * Cached snapshot of `window.fleetDispatcher`, published by the MAIN-world
 * bridge `bridges/fleetDispatcherSnapshot.js` (Chrome MV3 isolated scripts
 * can't read it directly). On fleetdispatch, the click handler consults
 * `fdCache.get()` to short-circuit the per-planet DOM walk when the game
 * already reports the GLOBAL expedition cap is reached (14/14), and to skip
 * the post-send auto-redirect when the send we're about to issue tips us
 * over the cap. Bootstrap + bridge wiring live in the shared cache.
 */
const fdCache = createFleetDispatcherCache();

// ── Install / dispose ────────────────────────────────────────────────

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Used to make `installSendExpedition`
 * idempotent (second call returns the same dispose without touching
 * DOM) and to let the settings subscriber exit early once disposed.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Module-scope handle to the live install's `handleSkip` (the long-press
 * action), so {@link _onSkipForTest} can invoke it directly. Reset to a no-op
 * on dispose. Default no-op covers the "not installed" case.
 *
 * @type {() => void}
 */
let skipForTest = () => {};

/**
 * Install the floating Send Exp button.
 *
 * Lifecycle:
 *   1. Snapshots current settings. If `showExpeditionButton === false` we
 *      skip DOM work entirely — but still wire the settings subscriber so
 *      a later flip to `true` creates the button live.
 *   2. Renders (if enabled): creates the `<button id="oge-send-exp">`,
 *      registers it as the 'exp' module of the unified FAB, and wires
 *      click / focus handlers. When body is not yet present we defer
 *      insertion to `DOMContentLoaded` (once).
 *   3. Subscribes to `settingsStore` for live updates:
 *        - `showExpeditionButton true → false`: remove button,
 *        - `showExpeditionButton false → true`: create button,
 *        - `fabBtnSize` change: resize width/height/font-size in place.
 *   4. Returns a dispose fn that removes the button (if present) and
 *      unsubscribes from settings.
 *
 * Idempotent: calling `installSendExpedition()` a second time while already
 * installed returns the SAME dispose fn as the first call without
 * re-rendering.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSendExpedition = () => {
  if (installed) return installed.dispose;

  // Fleet2 ownership (T5): the Phase-1 dispatch gate below reads the
  // ownership session + the last checkTarget observation; make sure the
  // shared listener is attached (idempotent — the courier installs it too).
  installFleetOwnership();

  // Re-entry guard: a user tapping twice during Phase 2 polling must
  // NOT start a second poll loop (or double-click the routine element,
  // which at best is wasted and at worst confuses AGR's state machine).
  // Dimmed opacity gives a visible cue that the button is working.
  let busy = false;

  // The shared Button controller (view + gestures). Created on mount,
  // nulled on dispose. The label/lock/colour helpers below delegate to it
  // so the phase logic stays untouched.
  /** @type {import('../shared/button.js').Button | null} */
  let controller = null;

  // Tracks the pending cap-label restore timer so overlapping cap
  // transients coalesce onto one timer (the last always restores
  // BUTTON_TEXT) instead of leaving a stale label behind.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let capLabelTimer = null;

  // The eventbox-readiness gate (hold the button visibly disabled on
  // fleetdispatch until OGame's post-load eventbox XHR lands) now lives in
  // the shared Button — see `gateUntilEventBox` in the config below and
  // `features/shared/eventBoxGate.js`. Every fleet-send button shares it.

  /**
   * Repaint the button text into the dedicated label span (auto-creating
   * it on first use). Idempotent; no-op when the button was torn down
   * between schedule and fire.
   *
   * @param {HTMLElement} _btn  vestigial — the controller owns the element.
   * @param {string} text
   */
  const setLabel = (_btn, text) => controller?.setText('main', text);

  /**
   * Lock the button for the duration of a Phase 2 run — greys it out
   * and sets the re-entry flag so a second click is ignored.
   *
   * @param {HTMLElement} [_btn]  vestigial — the controller owns the element.
   */
  const lock = (_btn) => {
    busy = true;
    controller?.setDim('main', true);
  };

  /**
   * Release the Phase 2 lock and restore the opacity.
   *
   * @param {HTMLElement} [_btn]  vestigial — the controller owns the element.
   */
  const unlock = (_btn) => {
    busy = false;
    controller?.setDim('main', false);
  };

  /**
   * Transient cap label (amber) — restores the previous label and idle
   * colour after {@link MAX_LABEL_MS} so users learn the cadence once.
   *
   * @param {HTMLButtonElement} btn
   * @param {string} label
   * @param {string} [bg]  rim colour; defaults to the amber wait tone. The
   *   general fleet-cap ("Max fleets") passes the error tone so it matches
   *   every other send button's fleet-cap paint.
   */
  const paintCapLabel = (btn, label, bg = BG_MAX) => {
    if (capLabelTimer !== null) clearTimeout(capLabelTimer);
    setLabel(btn, label);
    controller?.setBg('main', bg);
    controller?.setError(bg === BG_ERROR);
    capLabelTimer = setTimeout(() => {
      capLabelTimer = null;
      setLabel(btn, BUTTON_TEXT);
      controller?.setBg('main', BG_IDLE);
      controller?.setError(false);
    }, MAX_LABEL_MS);
  };

  /**
   * Transient "All sent" painted when every planet has hit the
   * expedition cap.
   *
   * @param {HTMLButtonElement} btn
   */
  const paintAllMaxed = (btn) => paintCapLabel(btn, ALL_MAXED_LABEL);

  /**
   * Error label (rose) painted when a Phase 2 dispatch can't proceed because
   * AGR's Expeditions routine is disabled (routine 7 absent). Mirrors
   * {@link paintCapLabel} but uses the error rim, a longer dwell, and a native
   * tooltip with the fix. Restores the idle label + colour + tooltip after
   * {@link ROUTINE_OFF_LABEL_MS}.
   *
   * @param {HTMLButtonElement} btn
   */
  const paintRoutineOff = (btn) => {
    const prevTitle = btn.title;
    setLabel(btn, EXP_ROUTINE_OFF_LABEL);
    btn.title = EXP_ROUTINE_OFF_HINT;
    controller?.setBg('main', BG_ERROR);
    controller?.setError(true);
    setTimeout(() => {
      setLabel(btn, BUTTON_TEXT);
      btn.title = prevTitle;
      controller?.setBg('main', BG_IDLE);
      controller?.setError(false);
    }, ROUTINE_OFF_LABEL_MS);
  };

  /**
   * Phase 2 (fleetdispatch, fleet panel NOT yet loaded): drive AGR's
   * expeditions routine (`#ago_routine_7`) via the shared
   * {@link prepareViaRoutine}, then map its outcome to the expedition labels:
   *   - `'prepared'`   → flip to "Send" so the next tap issues the real send.
   *   - `'noShips'`    → hop to the next planet with a slot, else "All sent".
   *   - `'routineOff'` → paint the "enable Expeditions in AGR" error.
   *   - `'timeout'`    → restore the idle label quietly; the user can retry.
   *
   * @param {HTMLButtonElement} btn
   * @returns {Promise<void>}
   */
  const runPhase2 = async (btn) => {
    setLabel(btn, 'Wait...');
    const state = await prepareViaRoutine({ routineId: 7, owner: OWNER_EXP });

    if (state === 'prepared') {
      setLabel(btn, 'Send');
      unlock(btn);
      return;
    }
    if (state === 'routineOff') {
      // A shipless planet ALSO yields routine 7 absent (AGR omits it with no
      // fleet), which is indistinguishable from a genuinely disabled routine at
      // the DOM level. If the snapshot confirms there are no ships here, hop like
      // a maxed planet instead of crying "AGR off"; only a ship-bearing planet
      // with the routine truly disabled reaches the error paint. (The click-time
      // fast path usually catches this first; this covers a snapshot that only
      // populated after the tap.)
      if (isPlanetShipless(fdCache.get())) {
        setLabel(btn, 'No ships');
        if (hopToNextExpPlanet()) return;
        paintAllMaxed(btn);
        unlock(btn);
        return;
      }
      paintRoutineOff(btn);
      unlock(btn);
      return;
    }
    if (state === 'timeout') {
      setLabel(btn, BUTTON_TEXT);
      unlock(btn);
      return;
    }

    // 'noShips' — no expedition possible here. Hop to the next planet that
    // still has a slot; if none, paint "All sent".
    setLabel(btn, 'No ships');
    if (hopToNextExpPlanet()) return;
    paintAllMaxed(btn);
    unlock(btn);
  };

  /**
   * Phase 1, patient variant — fleet2 panel is up but the native dispatch is
   * still `.off` (AGR mid-fill). Paint a working cue, then {@link
   * dispatchWhenReady} polls until the game clears `.off` and fires. One tap
   * launches even when tapped mid-fill — the high-volume case where an eager
   * tap used to hit a disabled button and silently do nothing.
   *
   * @param {HTMLButtonElement} btn
   * @returns {Promise<void>}
   */
  const runPhase1 = async (btn) => {
    setLabel(btn, 'Wait...');
    const r = await dispatchWhenReady({ owner: OWNER_EXP });

    if (r === 'foreign') {
      // Not our fleet2 — restart from a bare fleetdispatch (page nav; the
      // button stays locked through the reload).
      location.href = bareFleetdispatchUrl();
      return;
    }
    if (r === 'sent') {
      setLabel(btn, 'Sent');
      // Lock held; release after the post-send nav window in case the page
      // doesn't reload (rare dispatch failure) — mirrors the fast path.
      setTimeout(() => unlock(btn), 3000);
      return;
    }
    // 'timeout' — never became sendable; restore idle and release for a retry.
    setLabel(btn, BUTTON_TEXT);
    unlock(btn);
  };

  /**
   * Hop to the next planet that still has a free expedition slot (skipping the
   * active one). The shared "walk to another planet" move — used by the
   * current-planet-cap gate, the no-ships gate, the routine-off fallback, and
   * the AGR `'noShips'` outcome. Caller paints "All sent" when it returns false.
   *
   * @returns {boolean} `true` when a navigation was issued (caller must return);
   *   `false` when no other planet has room.
   */
  const hopToNextExpPlanet = () => {
    const nextCp = findPlanetWithExpSlot(true);
    if (nextCp === null) return false;
    location.href = buildFleetdispatchUrl(nextCp);
    return true;
  };

  /**
   * Send-button TAP — drive AGR's expedition routine (no fleet memory).
   *
   * Flow:
   *   - Eventbox gate: on fleetdispatch the cap counts + routine state are
   *     stale until OGame's eventbox XHR lands; paint a brief cue and bail.
   *   - Global-cap gate → "All sent".
   *   - Off fleetdispatch → hop to the first planet with a free slot.
   *   - On fleetdispatch, current-planet cap full → jump to the next free
   *     planet (unless the next send would hit the global cap anyway).
   *   - Phase 1 (fleet panel already loaded) → click `#dispatchFleet`.
   *   - Phase 2 (panel not loaded) → {@link runPhase2}: click AGR's routine.
   *
   * @param {HTMLButtonElement} btn
   * @returns {void}
   */
  const handleClick = (btn) => {
    if (busy) return;

    // The eventbox-readiness gate is enforced upstream by the shared Button
    // (the button is disabled until the eventbox XHR lands), so by the time a
    // click reaches here the cap counts + AGR's `#ago_routine_7` check class
    // are authoritative.

    // General fleet-slot gate (T11) — every fleet slot in use ⇒ NO fleet
    // of any kind can launch. Broader than the expedition cap below, so it
    // is checked first and gets its own label.
    if (isFleetCapReached(fdCache.get())) {
      paintCapLabel(btn, ALL_FLEETS_LABEL, BG_ERROR);
      return;
    }

    // Global-cap gate — every expedition slot in use ⇒ nowhere to send.
    if (isGlobalExpeditionCapReached(fdCache.get())) {
      paintAllMaxed(btn);
      return;
    }

    const isFleet = location.search.includes('component=fleetdispatch');

    // Off fleetdispatch → hop to the first planet with a free slot.
    if (!isFleet) {
      const cp = findPlanetWithExpSlot(false);
      if (cp === null) {
        paintAllMaxed(btn);
        return;
      }
      location.href = buildFleetdispatchUrl(cp);
      return;
    }

    // On fleetdispatch — current-planet cap: full ⇒ jump to the next free
    // planet (unless the next send would hit the global cap anyway).
    const max = settingsStore.get().maxExpeditionsPerPlanet;
    if (countActiveExpeditions(getActivePlanetCoords()) >= max) {
      if (isGlobalExpeditionCapReachedAfterNextSend(fdCache.get())) {
        paintAllMaxed(btn);
        return;
      }
      if (hopToNextExpPlanet()) return;
      paintAllMaxed(btn);
      return;
    }

    // No ships on this planet ⇒ nothing to prepare here (in 1.13 AGR omits its
    // Expeditions routine entirely when there's no fleet, so Phase 2 would wait
    // out its timeout and paint a spurious "AGR exp off"). Treat it like a maxed
    // planet: hop onward. This restores the pre-1.13 "empty planet → next
    // planet" behaviour without the stall.
    if (isPlanetShipless(fdCache.get())) {
      if (hopToNextExpPlanet()) return;
      paintAllMaxed(btn);
      return;
    }

    // Phase 1 — fleet panel already loaded → just fire dispatch.
    // Phase 2 — panel not loaded → click AGR routine, wait for it. Gate on
    // `component=fleetdispatch` only: AGR assigns the mission itself when
    // the user taps its routine, so `mission=15` is not a precondition.
    const dispatch = document.querySelector(GAME.FD_DISPATCH);
    const fleetPanel = document.getElementById(GAME.AGO_FLEET2_MAIN);
    if (dispatch && fleetPanel) {
      // Ownership gate (T5): a loaded fleet panel is NOT proof this is our
      // expedition — the player may have armed a manual send, or another
      // OG-E button's tap-1 prepared its own fleet2. dispatchPrepared sends
      // only when the session is ours (we clicked the routine on this page) or,
      // with no session, the last checkTarget matches the expedition profile
      // (position 16 + Pathfinder). Anything foreign: leave it untouched and
      // restart from a bare fleetdispatch.

      // Dispatch present but still `.off` (AGR is mid-fill): a synchronous send
      // here would click a disabled control and launch nothing while reporting
      // success. Hand off to the patient path so this single tap waits out the
      // fill and then fires — the high-volume "first tap does nothing" fix.
      if (dispatch.classList.contains(GAME.FD_DISABLED_CLASS)) {
        lock(btn);
        void runPhase1(btn);
        return;
      }

      const r = dispatchPrepared({ owner: OWNER_EXP });
      if (r === 'foreign') {
        location.href = bareFleetdispatchUrl();
        return;
      }
      if (r === 'sent') {
        setLabel(btn, 'Sent');
        // Lock while the game processes the dispatch + its post-send nav. In
        // the happy path OGame reloads within ~1 s; the safety timeout covers
        // the rare case where the dispatch fails and the page stays put.
        lock(btn);
        setTimeout(() => unlock(btn), 3000);
      }
      return;
    }
    lock(btn);
    void runPhase2(btn);
  };

  /**
   * Long-press (hold) the button → SKIP the current planet: navigate to the
   * next planet still under the per-planet cap WITHOUT sending, so the
   * round-robin walk continues from there. The manual counterpart to the
   * auto-redirect's hop — for deliberately passing over the planet you're on.
   * Paints "All sent" when no OTHER planet has a free slot.
   *
   * Navigation only: it issues no server action, so unlike {@link handleClick}
   * it skips the fleet-cap / global-cap gates (those guard sends, not hops).
   *
   * @returns {void}
   */
  const handleSkip = () => {
    if (busy) return;
    if (hopToNextExpPlanet()) return;
    paintAllMaxed(/** @type {HTMLButtonElement} */ (controller?.el));
  };

  // Exposed to the test-only handle below; reset on dispose. Lets tests drive
  // the skip outcome directly (mirrors sendColony's `_onSendHoldForTest`)
  // without synthesising the pointer-hold gesture — same rationale as this
  // file's "drag testing is NOT covered" note.
  skipForTest = handleSkip;

  /**
   * Create and mount the button via the shared {@link makeButton}
   * controller (geometry, placement, engraved ring, drag, click + focus
   * persistence). Idempotent: {@link makeButton} returns `null` when the
   * id is already mounted, so a second call is a no-op.
   *
   * @returns {void}
   */
  const createButton = () => {
    // Already mounted → keep the live controller; a redundant call must
    // NOT overwrite it with makeButton's null (idempotency-guard return).
    if (document.getElementById(BUTTON_ID)) return;

    const size = settingsStore.get().fabBtnSize;
    controller = makeButton({
      id: BUTTON_ID,
      title: 'Expeditions',
      ringId: 'oge-ring-exp',
      size,
      // Matches sendLifeform's scale so short labels ("Send" / "Prepare" /
      // "Discover") read at the same size across the 1-zone command buttons.
      fontScale: 0.18,
      module: FAB_MODULES.exp,
      gateUntilEventBox: true,
      holdMs: HOLD_SKIP_MS,
      zones: [
        {
          key: 'main',
          id: BUTTON_ID,
          ariaLabel: 'Send expedition',
          bg: BG_IDLE,
          glyph: COMET_GLYPH,
          onTap: () => void handleClick(/** @type {HTMLButtonElement} */ (controller?.el)),
          onHold: handleSkip,
        },
      ],
    });
    if (!controller) return;
    controller.el.style.setProperty('--glow', '1.3');

    // Initial label reflects the page state at mount: "Send" when the
    // native dispatch button is already up, "Prepare" when only AGR's
    // routine is present, else the idle default.
    setLabel(
      controller.el,
      computeInitialLabel({
        search: location.search,
        hasDispatchFleet: document.querySelector(GAME.FD_DISPATCH) !== null,
        hasAgoRoutine7: document.getElementById('ago_routine_7') !== null,
      }),
    );
  };

  /**
   * Remove the button (if present). Safe to call when not rendered.
   */
  const removeButton = () => {
    controller?.dispose();
    controller = null;
  };

  /**
   * Live-update the mounted button's diameter + font size. No-op when
   * the button isn't currently rendered.
   *
   * @param {number} size
   * @returns {void}
   */
  const updateButtonSize = (size) => controller?.resize(size);

  // Bootstrap snapshot BEFORE first mount — so the initial click can see
  // the right phase (seeds from a live `window.fleetDispatcher` when one is
  // readable; otherwise the bridge event populates it asynchronously).
  fdCache.bootstrap();

  // Settings-driven mount/teardown + live resize — the wiring shared by
  // every send* FAB feature, gated on the per-module `showExpeditionButton`
  // toggle (the settings module bar).
  const unsubSettings = installFabSettingsLifecycle({
    settingsStore,
    enabled: (s) => s.showExpeditionButton,
    mount: () => createButton(),
    removeButton,
    updateButtonSize,
    isInstalled: () => installed !== null,
  });

  // Keep the snapshot fresh across checkTarget XHRs and subsequent
  // publishes from the MAIN-world bridge.
  fdCache.attach();

  installed = {
    dispose: () => {
      removeButton();
      unsubSettings();
      fdCache.detach();
      skipForTest = () => {};
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
export const _resetSendExpeditionForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};

/**
 * Test-only reset for the module-scope `fleetDispatcherSnapshot` cache.
 * Lets cases that rely on a pristine snapshot state (e.g. "no snapshot
 * dispatched yet") run independently of earlier tests that may have
 * published one. Exported with a `_` prefix to signal "do not import
 * from production code".
 *
 * @returns {void}
 */
export const _resetFleetDispatcherSnapshotForSendExpeditionTest = () => {
  fdCache.reset();
};

/**
 * Test-only: invoke the live install's long-press "skip" action directly.
 * Mirrors sendColony's `_onSendHoldForTest` — drives the skip OUTCOME without
 * synthesising the pointer-hold gesture (the shared button owns the gesture
 * mechanics + charge arc). No-op when not installed.
 *
 * @returns {void}
 */
export const _onSkipForTest = () => skipForTest();
