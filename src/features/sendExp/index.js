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
// # What one click does (three cases, each = exactly ONE game action)
//
//   1. User is NOT on fleetdispatch → we navigate to fleetdispatch with
//      `mission=15` and `cp=<current planet>`. The game's own page load
//      happens next; we originate no request ourselves.
//   2. User IS on fleetdispatch with `mission=15` → we synthesize an
//      `Enter` keyboard event on `document.activeElement`. OGame's own
//      keydown handler reads that and calls `sendFleet`. We never call
//      the game's internals directly.
//   3. User IS on fleetdispatch with a different mission → we navigate
//      to the same fleetdispatch page with `mission=15` substituted in.
//      Exactly one navigation, no cascade.
//
// The "one click → one action" contract is the same TOS-safe boundary
// every OG-E feature respects: we never chain server-visible actions,
// and we never originate our own requests.
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
import { safeLS } from '../../lib/storage.js';
import { safeClick, waitFor } from '../../lib/dom.js';
import {
  installDrag,
  installFocusPersist as installButtonFocusPersist,
} from '../shared/draggableButton.js';
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
  const planet = document.querySelector('#planetList .hightlightPlanet');
  if (!planet) return null;
  const coordsEl = planet.querySelector('.planet-koords');
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
    const c = stripBrackets(row.querySelector('.coordsOrigin')?.textContent);
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
    document.querySelectorAll('#planetList .smallplanet'),
  );
  if (planets.length === 0) return null;
  const activeIdx = planets.findIndex((p) =>
    p.classList.contains('hightlightPlanet'),
  );
  const start = activeIdx < 0 ? 0 : activeIdx;
  const startOffset = skipCurrent ? 1 : 0;
  for (let i = startOffset; i < planets.length; i++) {
    const idx = (start + i) % planets.length;
    const p = planets[idx];
    const coords = stripBrackets(p.querySelector('.planet-koords')?.textContent);
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
   * Repaint the button text. Idempotent; no-op when the button was
   * torn down between schedule and fire.
   *
   * @param {HTMLButtonElement} btn
   * @param {string} text
   */
  const setLabel = (btn, text) => {
    btn.textContent = text;
  };

  /**
   * Lock the button for the duration of a Phase 2 run — greys it out
   * and sets the re-entry flag so a second click is ignored.
   *
   * @param {HTMLButtonElement} btn
   */
  const lock = (btn) => {
    busy = true;
    btn.style.opacity = '0.5';
  };

  /**
   * Release the Phase 2 lock and restore the opacity.
   *
   * @param {HTMLButtonElement} btn
   */
  const unlock = (btn) => {
    busy = false;
    btn.style.opacity = '1';
  };

  /**
   * Transient "All maxed!" painted when every planet has hit the
   * expedition cap. Duration is {@link MAX_LABEL_MS} so users learn
   * the cadence once.
   *
   * @param {HTMLButtonElement} btn
   */
  const paintAllMaxed = (btn) => {
    const original = btn.textContent;
    btn.textContent = ALL_MAXED_LABEL;
    btn.style.background = BG_MAX;
    setTimeout(() => {
      btn.textContent = original;
      btn.style.background = BG_IDLE;
    }, MAX_LABEL_MS);
  };

  /**
   * Phase 2 (fleetdispatch + mission=15, fleet panel NOT yet loaded):
   * wait for AGR's `#ago_routine_7` to exist and inspect its
   * `.ago_routine_check` child. Three outcomes:
   *
   *   - `ago_routine_check_3` (ready): click the routine element —
   *     AGR renders `#ago_fleet2_main` + the native `#dispatchFleet`
   *     button. Then wait for both and flip the label to "Send!"
   *     so the user's next tap issues the real send.
   *   - `ago_routine_check_1` / `_check_2` (no ships): no expedition
   *     is possible from here. Navigate to the next planet that still
   *     has slots, else paint "All maxed!".
   *   - Routine never appears within {@link POLL_TIMEOUT_MS}: give up
   *     quietly and restore the idle label. The user can retry.
   *
   * Returns a promise so the click handler can await completion (only
   * to then exit — the Phase 2 outcomes already repaint + unlock).
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

      if (ready) {
        setLabel(btn, 'Send!');
      } else {
        setLabel(btn, BUTTON_TEXT);
      }
      unlock(btn);
      return;
    }

    // `_check_1` or `_check_2` → no ships here. Look for a planet
    // that CAN still send; navigate there. If none, paint "All maxed!"
    // and let the user deal with it.
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
   * Handle the idle-state click. Not called when a drag just finished
   * (the click listener short-circuits on `hasMoved`).
   *
   * Flow:
   *   Phase 0 — current planet maxed → navigate to next free planet
   *             (or paint "All maxed!" when nothing has room).
   *   Phase 1 — fleetdispatch + mission=15 + fleet panel loaded →
   *             click the native `#dispatchFleet` button (sends).
   *   Phase 2 — fleetdispatch + mission=15 + fleet panel NOT loaded →
   *             see {@link runPhase2}: poll the AGR routine element,
   *             click it, wait for the fleet panel, flip the label.
   *   Else  → navigate to fleetdispatch for the active planet.
   *
   * @param {HTMLButtonElement} btn
   * @returns {void}
   */
  const handleClick = (btn) => {
    if (busy) return;

    // Eventbox-readiness gate. On fleetdispatch the click handler reads
    // DOM state (`#eventContent` rows, AGR's `#ago_routine_7` check
    // class) that is only authoritative after OGame's eventbox refresh
    // XHR lands. Clicking before that puts the button into a Phase 2
    // poll against stale state. Paint a brief "Loading..." cue and bail
    // — no lock, so the user can tap again as soon as the page settles.
    if (!eventBoxReady) {
      const original = btn.textContent;
      setLabel(btn, 'Loading...');
      setTimeout(() => {
        // The eventbox may have arrived during the cue window; restore
        // whatever label was there before rather than the idle default.
        if (btn.textContent === 'Loading...') setLabel(btn, original ?? BUTTON_TEXT);
      }, EVENTBOX_LOADING_LABEL_MS);
      return;
    }

    // Global-cap gate (snapshot is authoritative when populated): if
    // the game reports every expedition slot in use (e.g. 14/14), there
    // is nowhere to send from — paint "All maxed!" and bail before any
    // DOM walk. Only applies when the snapshot is populated (non-null
    // on fleetdispatch AFTER the MAIN-world bridge publishes).
    if (isGlobalExpeditionCapReached(fleetDispatcherSnapshot)) {
      paintAllMaxed(btn);
      return;
    }

    const isFleet = location.search.includes('component=fleetdispatch');

    if (!isFleet) {
      // Not on fleetdispatch yet — hop to the first planet that has
      // room (possibly the active one). `findPlanetWithExpSlot(false)`
      // — skipCurrent=false. No separate "current cap" check here; if
      // the active planet is maxed the iteration just moves past it.
      const cp = findPlanetWithExpSlot(false);
      if (cp === null) {
        paintAllMaxed(btn);
        return;
      }
      location.href = buildFleetdispatchUrl(cp);
      return;
    }

    // Already on fleetdispatch. Phase 0 — current planet cap check.
    // When the active planet is full, jump to the next free one so
    // the user doesn't have to re-pick manually.
    const max = settingsStore.get().maxExpPerPlanet;
    const count = countActiveExpeditions(getActivePlanetCoords());
    if (count >= max) {
      // Pre-redirect guard: if the snapshot reports we're one send
      // away from the global cap (e.g. 13/14), the pending send is
      // about to tip us to 14/14. No point walking to another planet
      // — every planet will then report full once the send lands and
      // the game refreshes its counts. Paint "All maxed!" and stop so
      // the user sees why no nav happened.
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
    // Phase 2 — panel not loaded → click AGR routine, wait for it.
    // Gate on `component=fleetdispatch` only: AGR assigns the mission
    // itself when the user taps its expedition routine, so `mission=15`
    // is not a reliable precondition for Phase 1/2 here.
    const dispatch = document.getElementById('dispatchFleet');
    const fleetPanel = document.getElementById('ago_fleet2_main');
    if (dispatch && fleetPanel) {
      safeClick(dispatch);
      setLabel(btn, 'Sent!');
      // Lock the button while the game processes the dispatch XHR + its
      // own post-send navigation. In the happy path OGame reloads the
      // page within ~1 s and the whole content-script reinitialises, so
      // the lock is moot. The safety timeout covers the rare case where
      // the dispatch XHR fails (validation error, network blip) and the
      // game stays put — without it the button would sit on "Sent!"
      // forever, taking clicks that would do nothing visible.
      lock(btn);
      setTimeout(() => unlock(btn), 3000);
      return;
    }
    lock(btn);
    void runPhase2(btn);
  };

  /**
   * Wire drag (mouse + touch) and the click handler onto `btn`. Drag
   * + storage persistence live in {@link installDrag}; we just hook
   * the click listener and consult `wasDrag()` so a drag terminating
   * inside the button doesn't double-fire as a click.
   *
   * @param {HTMLButtonElement} btn
   * @param {number} size  Current button diameter — passed through to
   *   {@link installDrag} for the viewport clamp.
   * @returns {void}
   */
  const installDragAndClick = (btn, size) => {
    const drag = installDrag({
      element: btn,
      posKey: POS_KEY,
      size,
      dragThreshold: DRAG_THRESHOLD,
    });

    btn.addEventListener('click', (e) => {
      if (drag.wasDrag()) {
        drag.resetDrag();
        return;
      }
      e.stopPropagation();
      handleClick(btn);
    });
  };

  /**
   * Wire focus-persist via {@link installButtonFocusPersist} (shared
   * helper used by sendCol too — same `oge_focusedBtn` key).
   *
   * @param {HTMLButtonElement} btn
   * @returns {void}
   */
  const installFocusPersist = (btn) => {
    installButtonFocusPersist({
      button: btn,
      focusKey: FOCUS_KEY,
      focusValue: FOCUS_VALUE,
      focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
    });
  };

  /**
   * Create and mount the button. Idempotent: bails early if the
   * button id already exists in the document.
   *
   * @returns {void}
   */
  const createButton = () => {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BUTTON_ID;
    // Context-aware initial label: on fleetdispatch the user's next
    // tap meaning is different depending on AGR/OGame hydration state,
    // so the button label tells them what's about to happen.
    btn.textContent = computeInitialLabel({
      search: location.search,
      hasDispatchFleet: document.getElementById('dispatchFleet') !== null,
      hasAgoRoutine7: document.getElementById('ago_routine_7') !== null,
    });
    btn.tabIndex = 0;
    btn.setAttribute('aria-label', 'Send expedition');

    const size = settingsStore.get().enterBtnSize;
    btn.style.cssText = [
      'position:fixed',
      'border-radius:50%',
      'border:none',
      `background:${BG_IDLE}`,
      'color:#fff',
      'font-weight:bold',
      'z-index:99999',
      'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
      'touch-action:none',
      'user-select:none',
      'cursor:pointer',
      `width:${size}px`,
      `height:${size}px`,
      `font-size:${Math.round(size * 0.23)}px`,
    ].join(';');

    // Restore saved position if present, otherwise anchor bottom-right.
    // The saved position is clamped to the current viewport so resizing
    // the window since the last drag doesn't stash the button off-screen.
    const savedPos = safeLS.json(POS_KEY);
    if (
      savedPos &&
      typeof savedPos === 'object' &&
      savedPos !== null &&
      typeof /** @type {any} */ (savedPos).x === 'number' &&
      typeof /** @type {any} */ (savedPos).y === 'number'
    ) {
      const p = /** @type {{ x: number, y: number }} */ (savedPos);
      btn.style.left = Math.min(p.x, window.innerWidth - size) + 'px';
      btn.style.top = Math.min(p.y, window.innerHeight - size) + 'px';
    } else {
      btn.style.right = DEFAULT_EDGE_OFFSET_PX + 'px';
      btn.style.bottom = DEFAULT_EDGE_OFFSET_PX + 'px';
    }

    document.body.appendChild(btn);
    // Brief lock on first appearance so in-flight XHRs can settle before
    // the user can trigger Phase 2 prematurely.
    if (btn.textContent === 'Prepare') {
      lock(btn);
      setTimeout(() => unlock(btn), 200);
    }
    installDragAndClick(btn, size);
    installFocusPersist(btn);
  };

  /**
   * Remove the button (if present). Safe to call when not rendered.
   */
  const removeButton = () => {
    const el = document.getElementById(BUTTON_ID);
    if (el) el.remove();
  };

  /**
   * Live-update the mounted button's diameter + font size. No-op when
   * the button isn't currently rendered.
   *
   * @param {number} size
   * @returns {void}
   */
  const updateButtonSize = (size) => {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById(BUTTON_ID));
    if (!btn) return;
    btn.style.width = size + 'px';
    btn.style.height = size + 'px';
    btn.style.fontSize = Math.round(size * 0.23) + 'px';
  };

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
