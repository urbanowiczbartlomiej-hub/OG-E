// Floating "Send Exp" button — large round tap target that collapses the
// multi-step expedition dispatch flow into a single click.
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
// every feature in v5 respects: we never chain server-visible actions,
// and we never originate our own requests.
//
// # Max-expedition guard (semantic carry-over from 4.x)
//
// 4.x had an elaborate per-planet slot check that counted expedition
// dots, walked to the next planet with room, etc. V5 keeps the
// semantics simpler: if `#eventContent` already shows `maxExpPerPlanet`
// expedition fleets we paint a transient "Max!" label on the button
// for 2 seconds and abort the dispatch. We do NOT auto-advance to a
// different planet — that is what `bridges/expeditionRedirect.js`
// does on successful sends, orthogonally.
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
// a click. The final position is written to `oge5_enterBtnPos` as JSON
// and restored on install.
//
// Focus persists across reloads via `oge5_focusedBtn`. When the button
// is the focused element on reload, we restore focus 50 ms after insert
// (same as the 4.x `setupBtnFocusPersist`). This matters for keyboard
// users and — importantly — for the mobile keyboard-Enter flow where the
// user's Enter key naturally triggers `click` on the focused button.
//
// @see ../bridges/expeditionRedirect.js — orthogonal: rewrites the
//   post-send `redirectUrl` so successive dispatches hop planets.

/** @ts-check */

import { settingsStore } from '../state/settings.js';
import { safeLS } from '../lib/storage.js';
import { safeClick, waitFor } from '../lib/dom.js';
import { MISSION_EXPEDITION } from '../domain/rules.js';

/**
 * DOM id of the floating button. Stable so repeated `createButton`
 * calls short-circuit, and so tests / CSS overrides can target it.
 */
const BUTTON_ID = 'oge5-send-exp';

/**
 * localStorage key — holds the id of whichever of our buttons was last
 * focused. Currently only {@link FOCUS_VALUE} ever lands here, but the
 * shape matches 4.x (`oge_focusedBtn` took `'enter'` or `'col-send'`
 * etc.) so when the Send Col button lands in v5 they will share the
 * key seamlessly.
 */
const FOCUS_KEY = 'oge5_focusedBtn';

/** Focus-persist value written/read by this feature. */
const FOCUS_VALUE = 'send-exp';

/** localStorage key — holds `{ x: number, y: number }` dragged position. */
const POS_KEY = 'oge5_enterBtnPos';

/**
 * Movement threshold in pixels before a pointer gesture counts as a
 * drag. Anything below this (jitter from thumb contact, touch-start
 * micro-moves) still fires as a click. Matches the 4.x value.
 */
const DRAG_THRESHOLD = 8;

/**
 * How long the "Max!" warning label stays on the button when the
 * click handler bails due to `maxExpPerPlanet`. 2 s is long enough to
 * read, short enough that a user retrying immediately after adding
 * a slot is not interrupted.
 */
const MAX_LABEL_MS = 2000;

/** Default button copy — what the user sees in the "idle" state. */
const BUTTON_TEXT = 'Send Exp';

/** Transient copy painted when the max-exp guard trips on this planet. */
const MAX_LABEL = 'Max!';

/** Transient copy when every planet has hit `maxExpPerPlanet`. */
const ALL_MAXED_LABEL = 'All maxed!';

/**
 * Timeout for waiting on AGR's routine element / fleet panel hydration.
 * 15 s mirrors v4's `pollDOM` budget — long enough for a slow phone on
 * a cold cache to receive the async fleet-panel assets, short enough
 * that an obviously-broken page doesn't lock the button forever.
 */
const POLL_TIMEOUT_MS = 15_000;

/** Poll interval for AGR-readiness checks. Matches v4 `pollDOM`. */
const POLL_INTERVAL_MS = 300;

/** Background color for the idle button (blue, translucent). */
const BG_IDLE = 'rgba(0,150,255,0.7)';

/** Background color for the "Max!" state (amber, more opaque). */
const BG_MAX = 'rgba(200,150,0,0.85)';

/** Default offset from the bottom-right corner when no saved pos. */
const DEFAULT_EDGE_OFFSET_PX = 20;

/** Delay before restoring focus on install (matches 4.x). */
const FOCUS_RESTORE_DELAY_MS = 50;

// ── Pure helpers ──────────────────────────────────────────────────────

/**
 * Strip the surrounding `[` and `]` from a coords string. OGame renders
 * both `.planet-koords` (planet list) and `.coordsOrigin` (event row)
 * with the brackets — stripping them once gives a consistent `g:s:p`
 * key usable for equality comparison across the two lookups.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
const stripBrackets = (raw) => (raw ?? '').trim().replace(/^\[|]$/g, '');

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
 * matches the active planet (mirrors v4 `countExpDots` semantics, where
 * the per-planet limit was enforced via the dots painted by the badges
 * feature on each planet row).
 *
 * When the active planet's coords can't be read (`originCoords === null`)
 * we fall back to counting every expedition in `#eventContent` — safer
 * to over-report and show "Max!" than under-report and let the user
 * blow past their configured cap.
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
 * Pick the right initial label for the floating button based on the
 * page state at render time. Mirrors v4 `mobile.js:446`:
 *
 *   - On fleetdispatch with `#dispatchFleet` already in the DOM →
 *     "Dispatch!" (user's next tap fires the send).
 *   - On fleetdispatch with `#ago_routine_7` but no dispatch button →
 *     "Prepare" (user's next tap kicks AGR's routine).
 *   - Otherwise → the default `BUTTON_TEXT` ("Send Exp").
 *
 * Snapshot only — the button is recreated on every page reload anyway,
 * so we don't need a live update path.
 *
 * @returns {string}
 */
const computeInitialLabel = () => {
  if (!location.search.includes('component=fleetdispatch')) return BUTTON_TEXT;
  if (document.getElementById('dispatchFleet')) return 'Dispatch!';
  if (document.getElementById('ago_routine_7')) return 'Prepare';
  return BUTTON_TEXT;
};

/**
 * Walk `#planetList .smallplanet` starting from the active planet and
 * return the `cp` of the first planet that has room for another
 * expedition (`count < settings.maxExpPerPlanet`). Mirrors v4
 * `findPlanetWithExpSlot` semantics.
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

/**
 * Extract the active planet's `cp` from
 * `#planetList .hightlightPlanet` (note the game's CSS-class spelling).
 * Returns `null` when the highlight is missing or malformed — the
 * click handler treats that as "do nothing" rather than navigating
 * to a bogus URL.
 *
 * @returns {number | null}
 */
const getActiveCp = () => {
  const el = document.querySelector('#planetList .hightlightPlanet');
  if (!el) return null;
  const id = el.id;
  if (!id || !id.startsWith('planet-')) return null;
  const cp = parseInt(id.slice('planet-'.length), 10);
  return Number.isFinite(cp) && cp > 0 ? cp : null;
};

/**
 * Build a fleetdispatch URL pointing at the given `cp`. No `mission`
 * param — AGR's own expedition routine sets the mission when the user
 * taps it on the fleetdispatch page, so baking `mission=15` into the
 * URL here would be redundant and would miss the case where the user
 * lands on fleetdispatch through our redirect and then changes AGR's
 * selection.
 *
 * Base is derived from `location.href` so we stay on the origin/path
 * the game served; the query tail is dropped to avoid leaking stale
 * params (old `position=`, `mission=`) into the navigation.
 *
 * @param {number} cp
 * @returns {string}
 */
const buildFleetdispatchUrl = (cp) => {
  const base = location.href.split('?')[0];
  return `${base}?page=ingame&component=fleetdispatch&cp=${cp}`;
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
 *   2. Renders (if enabled): creates the `<button id="oge5-send-exp">`,
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
  // Mirrors v4's module-scope `expBusy`. Dimmed opacity gives a visible
  // cue that the button is working.
  let busy = false;

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
   * expedition cap. 2 s matches the original `MAX_LABEL` timing so
   * users learn the cadence once.
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
   *     button. Then wait for both and flip the label to "Dispatch!"
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
      // Routine is ready — AGR prep+fire. Second click mirrors v4's
      // `setTimeout(() => safeClick(routine), 50)` double-tap, which
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
        setLabel(btn, 'Dispatch!');
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
   * Flow mirrors v4 `tryExpedition`:
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

    const isFleet = location.search.includes('component=fleetdispatch');

    if (!isFleet) {
      // Not on fleetdispatch yet — hop to the first planet that has
      // room (possibly the active one). v4 `onSendExpClick` matches:
      // `findPlanetWithExpSlot(false)` — skipCurrent=false. No
      // separate "current cap" check here; if the active planet is
      // maxed the iteration just moves past it.
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
      return;
    }
    lock(btn);
    void runPhase2(btn);
  };

  /**
   * Wire drag (mouse + touch) and click handlers onto `btn`. The
   * click listener consults `hasMoved` from the closing scope so a
   * drag that ended inside the button doesn't double-fire as a click.
   *
   * @param {HTMLButtonElement} btn
   * @param {number} size  Current button diameter — captured for the
   *   viewport clamp in `onMove`. Re-captured on size change via a
   *   fresh call path (`updateButtonSize` doesn't need to rewire drag
   *   because the clamp tolerates drift up to one button diameter).
   * @returns {void}
   */
  const installDragAndClick = (btn, size) => {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    /**
     * @param {number} cx
     * @param {number} cy
     */
    const onStart = (cx, cy) => {
      isDragging = true;
      hasMoved = false;
      startX = cx;
      startY = cy;
      const r = btn.getBoundingClientRect();
      startLeft = r.left;
      startTop = r.top;
    };

    /**
     * @param {number} cx
     * @param {number} cy
     */
    const onMove = (cx, cy) => {
      if (!isDragging) return;
      const dx = cx - startX;
      const dy = cy - startY;
      if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      hasMoved = true;
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
      const newX = Math.max(0, Math.min(startLeft + dx, window.innerWidth - size));
      const newY = Math.max(0, Math.min(startTop + dy, window.innerHeight - size));
      btn.style.left = newX + 'px';
      btn.style.top = newY + 'px';
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      if (hasMoved) {
        safeLS.setJSON(POS_KEY, {
          x: parseInt(btn.style.left, 10),
          y: parseInt(btn.style.top, 10),
        });
      }
    };

    btn.addEventListener(
      'touchstart',
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        onStart(t.clientX, t.clientY);
      },
      { passive: true },
    );

    btn.addEventListener(
      'touchmove',
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        onMove(t.clientX, t.clientY);
        if (hasMoved) e.preventDefault();
      },
      { passive: false },
    );

    btn.addEventListener('touchend', () => {
      onEnd();
    });

    btn.addEventListener('mousedown', (e) => {
      onStart(e.clientX, e.clientY);
      /** @param {MouseEvent} ev */
      const mv = (ev) => onMove(ev.clientX, ev.clientY);
      const up = () => {
        onEnd();
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    btn.addEventListener('click', (e) => {
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      e.stopPropagation();
      handleClick(btn);
    });
  };

  /**
   * Wire focus-persist: write `send-exp` to `FOCUS_KEY` while the
   * button is focused, clear it on blur (only if we're the current
   * owner of the key — a different button may have claimed it
   * meanwhile). If the key was `'send-exp'` at install time, restore
   * focus after a 50 ms tick so the DOM is fully painted.
   *
   * @param {HTMLButtonElement} btn
   * @returns {void}
   */
  const installFocusPersist = (btn) => {
    btn.addEventListener('focus', () => safeLS.set(FOCUS_KEY, FOCUS_VALUE));
    btn.addEventListener('blur', () => {
      if (safeLS.get(FOCUS_KEY) === FOCUS_VALUE) safeLS.remove(FOCUS_KEY);
    });
    if (safeLS.get(FOCUS_KEY) === FOCUS_VALUE) {
      setTimeout(() => btn.focus(), FOCUS_RESTORE_DELAY_MS);
    }
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
    // Context-aware initial label (v4 parity): on fleetdispatch the
    // user's next tap meaning is different depending on AGR/OGame
    // hydration state, so the button label tells them what's about
    // to happen.
    btn.textContent = computeInitialLabel();
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

  installed = {
    dispose: () => {
      removeButton();
      unsubSettings();
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
