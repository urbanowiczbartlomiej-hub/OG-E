// @ts-check

// Floating "Send Exp" button — orchestrator + DOM I/O. Pure helpers
// (constants, stripBrackets, URL builder, cap checks, initial-label
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
//      the label flips to "Send!" so the user's NEXT tap sends.
//   3. On fleetdispatch, fleet panel hydrated (`#dispatchFleet` present)
//      → we click the native dispatch button. Exactly one send.
//
// The "one click → one action" contract is the same TOS-safe boundary
// every OG-E feature respects: we never chain server-visible actions,
// and we lean on AGR (which every player runs) rather than driving the
// native form ourselves — AGR overwrites the fleet2 target anyway.
//
// # Max-expedition guard
//
// If `#eventContent` already shows `maxExpPerPlanet` expedition fleets
// we paint a transient "All maxed!" label on the button for 2 seconds
// and abort the dispatch. We do NOT auto-advance to a different
// planet — that is what `bridges/expeditionRedirect.js` does on
// successful sends, orthogonally.
//
// # Settings-driven lifecycle
//
//   - `mobileMode`  toggles visibility. Flipping it off at runtime
//                   removes the DOM node entirely (we aren't a CSS-hide
//                   feature like the badges cluster; the button would
//                   grab tap area even while invisible, so actual
//                   removal is correct).
//   - `enterBtnSize` resizes the circle and scales the font to ~23%.
//                   Updates apply live.
//   - `maxExpPerPlanet` gates the click handler. Read per click, so
//                   panel edits take effect on the very next tap.
//
// # Draggability + focus persistence
//
// The button can be dragged with mouse or touch. We use an 8px movement
// threshold to distinguish drag from tap — anything under that is still
// a click. The final position is written to `oge_enterBtnPos` as JSON
// and restored on install.
//
// Focus persists across reloads via `oge_focusedBtn`. When the button
// is the focused element on reload, we restore focus 50 ms after
// insert. This matters for keyboard users and — importantly — for the
// mobile keyboard-Enter flow where the user's Enter key naturally
// triggers `click` on the focused button.
//
// @see ./pure.js — pure constants + helpers consumed here.
// @see ../../bridges/expeditionRedirect.js — orthogonal: rewrites the
//   post-send `redirectUrl` so successive dispatches hop planets.

import { settingsStore } from '../../state/settings.js';
import { safeClick, waitFor } from '../../lib/dom.js';
import { GAME, ACTIVE_PLANET_CLASS } from '../../lib/gameDom.js';
import { createButton as makeButton, LABEL_CLASS } from '../shared/button.js';
import {
  BUTTON_ID,
  FOCUS_KEY,
  FOCUS_VALUE,
  POS_KEY,
  DRAG_THRESHOLD,
  MAX_LABEL_MS,
  POLL_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  DEFAULT_EDGE_OFFSET_PX,
  FOCUS_RESTORE_DELAY_MS,
  EVENTBOX_SAFETY_TIMEOUT_MS,
  EVENTBOX_LOADING_LABEL_MS,
  BUTTON_TEXT,
  ALL_MAXED_LABEL,
  BG_IDLE,
  BG_MAX,
  stripBrackets,
  buildFleetdispatchUrl,
  isGlobalExpeditionCapReached,
  isGlobalExpeditionCapReachedAfterNextSend,
  computeInitialLabel,
} from './pure.js';

/**
 * @typedef {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 */

// ── Module-level snapshot of `window.fleetDispatcher` ────────────────

/**
 * Cached snapshot of `window.fleetDispatcher` published by the MAIN-world
 * bridge `bridges/fleetDispatcherSnapshot.js`. `null` until the first
 * `oge:fleetDispatcher` event arrives (initial publish deferred to
 * DOMContentLoaded + microtask). On fleetdispatch, the click handler
 * consults this to short-circuit the per-planet DOM walk when the game
 * already reports the GLOBAL expedition cap is reached (14/14), and to
 * skip the post-send auto-redirect when the send we're about to issue
 * tips us over the cap.
 *
 * @type {FleetDispatcherSnapshot | null}
 */
let fleetDispatcherSnapshot = null;

/**
 * React to `oge:fleetDispatcher` — MAIN-world bridge publishing a fresh
 * snapshot of `window.fleetDispatcher`. Stash it so subsequent clicks
 * consult the GLOBAL expeditionCount / maxExpeditionCount numbers rather
 * than the per-planet DOM scan alone.
 *
 * @param {Event} e
 * @returns {void}
 */
const onFleetDispatcherSnapshot = (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail;
  if (!detail || typeof detail !== 'object') return;
  fleetDispatcherSnapshot = /** @type {FleetDispatcherSnapshot} */ (detail);
};

// ── DOM readers ──────────────────────────────────────────────────────

/**
 * Read the currently-active planet's coords from `#planetList`. Returns
 * `null` when the highlight marker or its coords span is missing — the
 * caller treats that as "can't filter, fall back to global count".
 *
 * @returns {string | null}  `"g:s:p"` without brackets, or `null`.
 */
const getActivePlanetCoords = () => {
  const planet = document.querySelector(GAME.ACTIVE_PLANET);
  if (!planet) return null;
  const coordsEl = planet.querySelector(GAME.PLANET_KOORDS);
  const coords = stripBrackets(coordsEl?.textContent);
  return coords || null;
};

/**
 * Count currently in-flight expeditions, filtered to those whose origin
 * matches the active planet. The per-planet limit is enforced via the
 * dots painted by the badges feature on each planet row.
 *
 * When the active planet's coords can't be read (`originCoords === null`)
 * we fall back to counting every expedition in `#eventContent` — safer
 * to over-report and show "All maxed!" than under-report and let the
 * user blow past their configured cap.
 *
 * @param {string | null} originCoords
 *   Active-planet coords in `g:s:p` form. Pass `null` to count globally.
 * @returns {number}
 */
const countActiveExpeditions = (originCoords) => {
  const rows = document.querySelectorAll(
    '#eventContent tr.eventFleet[data-mission-type="15"]',
  );
  if (originCoords === null) return rows.length;
  let count = 0;
  for (const row of rows) {
    const c = stripBrackets(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    if (c === originCoords) count += 1;
  }
  return count;
};

/**
 * Walk `#planetList .smallplanet` starting from the active planet and
 * return the `cp` of the first planet that has room for another
 * expedition (`count < settings.maxExpPerPlanet`).
 *
 * Wraps around the planet list, so a player whose active planet is the
 * last in the list still finds room on earlier entries. `null` when
 * every planet (save the active one, if `skipCurrent`) is maxed.
 *
 * @param {boolean} skipCurrent
 *   When `true`, skip the active planet itself — used from the click
 *   handler after the active planet is already known to be full.
 * @returns {number | null} `cp` of the first planet with room, or `null`.
 */
const findPlanetWithExpSlot = (skipCurrent) => {
  const max = settingsStore.get().maxExpPerPlanet;
  const planets = Array.from(
    document.querySelectorAll(GAME.SMALL_PLANET),
  );
  if (planets.length === 0) return null;
  const activeIdx = planets.findIndex((p) =>
    p.classList.contains(ACTIVE_PLANET_CLASS),
  );
  const start = activeIdx < 0 ? 0 : activeIdx;
  const startOffset = skipCurrent ? 1 : 0;
  for (let i = startOffset; i < planets.length; i++) {
    const idx = (start + i) % planets.length;
    const p = planets[idx];
    const coords = stripBrackets(p.querySelector(GAME.PLANET_KOORDS)?.textContent);
    if (!coords) continue;
    if (countActiveExpeditions(coords) >= max) continue;
    const id = p.id;
    if (!id || !id.startsWith('planet-')) continue;
    const cp = parseInt(id.slice('planet-'.length), 10);
    if (Number.isFinite(cp) && cp > 0) return cp;
  }
  return null;
};

// ── Install / dispose ────────────────────────────────────────────────

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Used to make `installSendExp`
 * idempotent (second call returns the same dispose without touching
 * DOM) and to let the settings subscriber exit early once disposed.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the floating Send Exp button.
 *
 * Lifecycle:
 *   1. Snapshots current settings. If `mobileMode === false` we skip
 *      DOM work entirely — but still wire the settings subscriber so
 *      a later flip to `true` creates the button live.
 *   2. Renders (if enabled): creates the `<button id="oge-send-exp">`,
 *      applies size + position, wires drag / click / focus handlers,
 *      and appends to `document.body`. When body is not yet present
 *      we defer insertion to `DOMContentLoaded` (once).
 *   3. Subscribes to `settingsStore` for live updates:
 *        - `mobileMode true → false`: remove button,
 *        - `mobileMode false → true`: create button,
 *        - `enterBtnSize` change: resize width/height/font-size in place.
 *   4. Returns a dispose fn that removes the button (if present) and
 *      unsubscribes from settings.
 *
 * Idempotent: calling `installSendExp()` a second time while already
 * installed returns the SAME dispose fn as the first call without
 * re-rendering.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSendExp = () => {
  if (installed) return installed.dispose;

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

  // Eventbox readiness gate (fleetdispatch only). On `component=fleetdispatch`
  // OGame fires an async XHR for the fleet-event list shortly after page
  // load; until that lands, `#eventContent` rows and AGR's routine state
  // are stale, and a click handed to runPhase2 polls a half-hydrated DOM
  // for the full 15 s POLL_TIMEOUT_MS window before recovering. We gate
  // clicks on the bridge's `oge:eventBoxLoaded` signal (see
  // `bridges/eventBoxHook.js`) and fall back to a safety timeout so a
  // missed XHR (run_at race, future URL change, …) doesn't lock the
  // button forever — 8 s is well past the typical eventbox load (~1 s)
  // but a fraction of the 15 s Phase 2 timeout we'd otherwise hit. Pages
  // other than fleetdispatch start ready immediately.
  const isFleetdispatchPage = location.search.includes('component=fleetdispatch');
  let eventBoxReady = !isFleetdispatchPage;

  /** @type {((e: Event) => void) | null} */
  let onEventBoxLoaded = null;
  /** @type {(() => void) | null} */
  let onWindowLoad = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let eventBoxSafetyTimer = null;
  if (isFleetdispatchPage) {
    onEventBoxLoaded = () => {
      eventBoxReady = true;
    };
    document.addEventListener('oge:eventBoxLoaded', onEventBoxLoaded);

    // Secondary trigger: window 'load' event. The eventbox refresh XHR
    // typically fires DURING page load and lands shortly after `load`
    // does, but some installs (cached responses, future OGame URL
    // shape) won't go through our XHR observer. The load event is a
    // hard guarantee that the page itself is no longer hydrating, so
    // it's a safe moment to open the gate. We hook it unconditionally
    // — if the page is already 'complete' the listener is harmlessly
    // dead, and the safety timer still fires.
    onWindowLoad = () => {
      eventBoxReady = true;
    };
    window.addEventListener('load', onWindowLoad, { once: true });

    eventBoxSafetyTimer = setTimeout(() => {
      eventBoxReady = true;
    }, EVENTBOX_SAFETY_TIMEOUT_MS);
  }

  /**
   * Read the current label. The label lives in the shared Button's
   * `.oge-btn-label` span (not the button's textContent) so the engraved
   * title-ring SVG sharing the host doesn't pollute it.
   *
   * @param {HTMLButtonElement} btn
   * @returns {string}
   */
  const getLabel = (btn) =>
    /** @type {HTMLElement | null} */ (
      btn.querySelector('.' + LABEL_CLASS)
    )?.textContent ?? '';

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
   * Transient "All maxed!" painted when every planet has hit the
   * expedition cap. Duration is {@link MAX_LABEL_MS} so users learn
   * the cadence once.
   *
   * @param {HTMLButtonElement} btn
   */
  const paintAllMaxed = (btn) => {
    const original = getLabel(btn);
    setLabel(btn, ALL_MAXED_LABEL);
    controller?.setBg('main', BG_MAX);
    setTimeout(() => {
      setLabel(btn, original);
      controller?.setBg('main', BG_IDLE);
    }, MAX_LABEL_MS);
  };

  /**
   * Phase 2 (fleetdispatch, fleet panel NOT yet loaded): wait for AGR's
   * `#ago_routine_7` to exist and inspect its `.ago_routine_check` child.
   * Three outcomes:
   *
   *   - `ago_routine_check_3` (ready): click the routine element — AGR
   *     renders `#ago_fleet2_main` + the native `#dispatchFleet` button.
   *     Then wait for both and flip the label to "Send!" so the user's
   *     next tap issues the real send.
   *   - `ago_routine_check_1` / `_check_2` (no ships): no expedition is
   *     possible from here. Navigate to the next planet that still has
   *     slots, else paint "All maxed!".
   *   - Routine never appears within {@link POLL_TIMEOUT_MS}: give up
   *     quietly and restore the idle label. The user can retry.
   *
   * @param {HTMLButtonElement} btn
   * @returns {Promise<void>}
   */
  const runPhase2 = async (btn) => {
    setLabel(btn, 'Loading...');

    const routine = await waitFor(() => {
      const el = document.getElementById('ago_routine_7');
      return el?.querySelector('.ago_routine_check') ? el : null;
    }, { timeoutMs: POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS });

    if (!routine) {
      setLabel(btn, BUTTON_TEXT);
      unlock(btn);
      return;
    }

    const check = routine.querySelector('.ago_routine_check');
    if (check?.classList.contains('ago_routine_check_3')) {
      // Routine is ready — AGR prep+fire. The 50 ms delayed second click
      // shakes loose cases where one click left AGR half-idled.
      safeClick(routine);
      setTimeout(() => safeClick(routine), 50);
      setLabel(btn, 'Preparing...');

      const ready = await waitFor(
        () =>
          document.getElementById('dispatchFleet')
            && document.getElementById('ago_fleet2_main')
            ? true
            : null,
        { timeoutMs: POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      );

      setLabel(btn, ready ? 'Send!' : BUTTON_TEXT);
      unlock(btn);
      return;
    }

    // `_check_1` or `_check_2` → no ships here. Look for a planet that CAN
    // still send; navigate there. If none, paint "All maxed!".
    setLabel(btn, 'No ships');
    const nextCp = findPlanetWithExpSlot(true);
    if (nextCp !== null) {
      location.href = buildFleetdispatchUrl(nextCp);
      return;
    }
    paintAllMaxed(btn);
    unlock(btn);
  };

  /**
   * Send-button TAP — drive AGR's expedition routine (no fleet memory).
   *
   * Flow:
   *   - Eventbox gate: on fleetdispatch the cap counts + routine state are
   *     stale until OGame's eventbox XHR lands; paint a brief cue and bail.
   *   - Global-cap gate → "All maxed!".
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

    // Eventbox-readiness gate (fleetdispatch only). The cap counts + AGR's
    // `#ago_routine_7` check class are authoritative only after OGame's
    // eventbox XHR lands. Clicking before that polls a half-hydrated DOM.
    if (!eventBoxReady) {
      const original = getLabel(btn);
      setLabel(btn, 'Loading...');
      setTimeout(() => {
        if (getLabel(btn) === 'Loading...') setLabel(btn, original || BUTTON_TEXT);
      }, EVENTBOX_LOADING_LABEL_MS);
      return;
    }

    // Global-cap gate — every expedition slot in use ⇒ nowhere to send.
    if (isGlobalExpeditionCapReached(fleetDispatcherSnapshot)) {
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
    const max = settingsStore.get().maxExpPerPlanet;
    if (countActiveExpeditions(getActivePlanetCoords()) >= max) {
      if (isGlobalExpeditionCapReachedAfterNextSend(fleetDispatcherSnapshot)) {
        paintAllMaxed(btn);
        return;
      }
      const nextCp = findPlanetWithExpSlot(true);
      if (nextCp !== null) {
        location.href = buildFleetdispatchUrl(nextCp);
        return;
      }
      paintAllMaxed(btn);
      return;
    }

    // Phase 1 — fleet panel already loaded → just fire dispatch.
    // Phase 2 — panel not loaded → click AGR routine, wait for it. Gate on
    // `component=fleetdispatch` only: AGR assigns the mission itself when
    // the user taps its routine, so `mission=15` is not a precondition.
    const dispatch = document.getElementById('dispatchFleet');
    const fleetPanel = document.getElementById('ago_fleet2_main');
    if (dispatch && fleetPanel) {
      safeClick(dispatch);
      setLabel(btn, 'Sent!');
      // Lock while the game processes the dispatch + its post-send nav. In
      // the happy path OGame reloads within ~1 s; the safety timeout covers
      // the rare case where the dispatch fails and the page stays put.
      lock(btn);
      setTimeout(() => unlock(btn), 3000);
      return;
    }
    lock(btn);
    void runPhase2(btn);
  };

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

    const size = settingsStore.get().enterBtnSize;
    controller = makeButton({
      id: BUTTON_ID,
      title: 'Expeditions',
      ringId: 'oge-ring-exp',
      size,
      fontScale: 0.23,
      posKey: POS_KEY,
      focusKey: FOCUS_KEY,
      edgeOffset: DEFAULT_EDGE_OFFSET_PX,
      dragThreshold: DRAG_THRESHOLD,
      zones: [
        {
          key: 'main',
          id: BUTTON_ID,
          ariaLabel: 'Send expedition',
          bg: BG_IDLE,
          onTap: () => void handleClick(/** @type {HTMLButtonElement} */ (controller?.el)),
          focusValue: FOCUS_VALUE,
          focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
        },
      ],
    });
    if (!controller) return;

    // Initial label reflects the page state at mount: "Send!" when the
    // native dispatch button is already up, "Prepare" when only AGR's
    // routine is present, else the idle default.
    setLabel(
      controller.el,
      computeInitialLabel({
        search: location.search,
        hasDispatchFleet: document.getElementById('dispatchFleet') !== null,
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

  // Bootstrap snapshot BEFORE first mount — so the initial click can
  // see the right phase. If `window.fleetDispatcher` happens to be
  // readable right now (Firefox Xray, tests assigning directly), seed
  // the cache. Chrome MV3 isolated scripts get undefined here; we rely
  // on the bridge event (`oge:fleetDispatcher` from
  // `bridges/fleetDispatcherSnapshot.js`) to populate it asynchronously
  // in production. Pattern mirrors `features/sendCol/index.js:installSendCol`.
  if (!fleetDispatcherSnapshot) {
    const liveFd = /** @type {any} */ (window).fleetDispatcher;
    if (liveFd && typeof liveFd === 'object') {
      fleetDispatcherSnapshot = /** @type {FleetDispatcherSnapshot} */ (liveFd);
    }
  }

  // Initial render based on current settings.
  const initial = settingsStore.get();
  if (initial.mobileMode) {
    if (document.body) {
      createButton();
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          // Re-check in case dispose ran before DOMContentLoaded fired.
          if (installed && settingsStore.get().mobileMode) createButton();
        },
        { once: true },
      );
    }
  }

  // Subscribe for live changes. We react ONLY to the two fields we
  // care about (mobileMode, enterBtnSize) — the settings store carries
  // the whole panel so unrelated edits (colMinGap, colPassword, ...)
  // would otherwise spam this callback.
  let prevMobileMode = initial.mobileMode;
  let prevEnterBtnSize = initial.enterBtnSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.mobileMode !== prevMobileMode) {
      if (next.mobileMode) {
        if (document.body) createButton();
      } else {
        removeButton();
      }
      prevMobileMode = next.mobileMode;
    }
    if (next.enterBtnSize !== prevEnterBtnSize) {
      updateButtonSize(next.enterBtnSize);
      prevEnterBtnSize = next.enterBtnSize;
    }
  });

  // Bridge event listener: keeps `fleetDispatcherSnapshot` fresh across
  // checkTarget XHRs and subsequent publishes from the MAIN-world bridge.
  document.addEventListener('oge:fleetDispatcher', onFleetDispatcherSnapshot);

  installed = {
    dispose: () => {
      removeButton();
      unsubSettings();
      document.removeEventListener(
        'oge:fleetDispatcher',
        onFleetDispatcherSnapshot,
      );
      if (onEventBoxLoaded) {
        document.removeEventListener('oge:eventBoxLoaded', onEventBoxLoaded);
        onEventBoxLoaded = null;
      }
      if (onWindowLoad) {
        window.removeEventListener('load', onWindowLoad);
        onWindowLoad = null;
      }
      if (eventBoxSafetyTimer !== null) {
        clearTimeout(eventBoxSafetyTimer);
        eventBoxSafetyTimer = null;
      }
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
export const _resetSendExpForTest = () => {
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
export const _resetFleetDispatcherSnapshotForSendExpTest = () => {
  fleetDispatcherSnapshot = null;
};
