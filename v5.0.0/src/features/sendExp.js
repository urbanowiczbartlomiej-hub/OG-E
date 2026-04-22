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

/** Transient copy painted when the max-exp guard trips. */
const MAX_LABEL = 'Max!';

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
 * Count currently in-flight expedition fleets visible in
 * `#eventContent`. Used to enforce `settings.maxExpPerPlanet`.
 *
 * TODO(v5): filter by origin coords matching the active planet so the
 * count reflects "how many expeditions this planet has out" rather
 * than "how many the whole account has out". For MVP the looser check
 * is close enough — the badges feature already surfaces the per-planet
 * count visually and the user can override by tapping through the
 * "Max!" warning (it clears after 2 s).
 *
 * @returns {number}
 */
const countActiveExpeditions = () => {
  const rows = document.querySelectorAll(
    '#eventContent tr.eventFleet[data-mission-type="15"]',
  );
  return rows.length;
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
 * Build a fleetdispatch URL pointing at the given `cp` with
 * `mission=15`. The base is derived from the current `location.href`
 * so we stay on the same origin / path the game served, and we drop
 * any existing query tail so stale params (old `position=`, stale
 * `mission=`) don't leak into the navigation.
 *
 * @param {number} cp
 * @returns {string}
 */
const buildExpeditionUrl = (cp) => {
  const base = location.href.split('?')[0];
  return `${base}?page=ingame&component=fleetdispatch&cp=${cp}&mission=${MISSION_EXPEDITION}`;
};

/**
 * Synthesize `Enter` keydown + keyup on `document.activeElement` (or
 * `document` as a fallback). OGame's fleetdispatch form listens for
 * Enter and calls its own `sendFleet` — so "press Enter for the user"
 * is how we dispatch without ever touching the game's internals.
 *
 * @returns {void}
 */
const dispatchEnter = () => {
  const target = document.activeElement || document;
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  );
  target.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  );
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

  /**
   * Handle the idle-state click. Not called when a drag just finished
   * (the click listener short-circuits on `hasMoved`).
   *
   * @param {HTMLButtonElement} btn
   * @returns {void}
   */
  const handleClick = (btn) => {
    const max = settingsStore.get().maxExpPerPlanet;
    const count = countActiveExpeditions();
    if (count >= max) {
      const original = btn.textContent;
      btn.textContent = MAX_LABEL;
      btn.style.background = BG_MAX;
      setTimeout(() => {
        btn.textContent = original;
        btn.style.background = BG_IDLE;
      }, MAX_LABEL_MS);
      return;
    }

    const isFleet = location.search.includes('component=fleetdispatch');
    const isExp = location.search.includes(`mission=${MISSION_EXPEDITION}`);

    if (isFleet && isExp) {
      dispatchEnter();
      return;
    }

    const cp = getActiveCp();
    if (cp === null) return;
    location.href = buildExpeditionUrl(cp);
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
    btn.textContent = BUTTON_TEXT;
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
