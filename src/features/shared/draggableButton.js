// Shared drag + focus-persistence helpers used by the floating mobile
// buttons (sendExp, sendCol) and the fresh-planet banner
// (freshPlanetDetector). The two button features previously open-coded
// the same touch/mouse drag wiring with an 8-px threshold and the same
// `oge_focusedBtn`-based focus persistence; freshPlanetDetector grew
// the same drag wiring independently. This module factors that out so
// changes (e.g. adjusting the drag threshold, tweaking restore timing)
// land in one place instead of three near-identical copies.
//
// Lives in `features/shared/` rather than `lib/` because it touches
// `window`, `document`, and `safeLS` — `lib/` is the pure-helpers
// boundary (see `CONTRIBUTING.md` §2). `shared/` is the conventional
// home for cross-feature helpers that legitimately need DOM/storage.
//
// # What this helper does
//
//   1. Drag (touch + mouse): once movement exceeds `dragThreshold` px,
//      switch the element to absolute `left` / `top` positioning and
//      persist the position to `safeLS` under `posKey` on release.
//   2. Focus persistence: writes `focusValue` to `focusKey` on focus;
//      clears it on blur iff we're still the current owner; restores
//      focus `focusRestoreDelay` ms after install when the saved key
//      matches `focusValue`.
//   3. Click suppression: when a drag has actually moved (`hasMoved`),
//      the next click on the element is swallowed so a drag terminating
//      on the button doesn't double-fire as a tap.
//
// # What this helper does NOT do
//
//   - Render the button — the caller creates the DOM.
//   - Choose default position — caller sets `right` / `bottom` (or
//     restores from `posKey`) before calling `installDraggableButton`.
//   - Click behaviour — caller wires its own `'click'` listener; this
//     helper exposes a `wasDrag()` predicate the listener checks first.
//
// # Why a single helper for three features
//
// sendCol's container wraps two halves; the drag/focus logic still
// lives on the OUTER `wrap`, and the focus persistence wires on each
// half independently — which we model by calling `installFocusPersist`
// twice (once per half) with different `focusValue`s. sendExp uses a
// single button so calls both helpers once. freshPlanetDetector calls
// only `installDrag` — the banner has no focus state to persist.
//
// @see ../sendCol/index.js          — caller for the colonize button.
// @see ../sendExp/index.js          — caller for the expedition button.
// @see ../freshPlanetDetector.js    — drag-only caller for the banner.

/** @ts-check */

import { safeLS } from '../../lib/storage.js';

// ─── Shared stacking order (last-touched on top) ────────────────────────
//
// As the number of floating buttons grows (sendExp, sendCol, and the two
// dailyRun buttons) they increasingly overlap. To keep the one the user
// is reaching for usable, every drag/tap START raises that element above
// the others: a single module-wide monotonic counter hands out
// ever-larger z-index values, so the most-recently-touched button always
// paints on top and covers the ones beneath it.
//
// All OG-E floating buttons historically pin `z-index:99999` in their
// inline cssText, so the counter starts just above that — the first touch
// of any button already lifts it over the static crowd, and subsequent
// touches keep promoting whichever was touched last. Runtime-only by
// design: there's nothing to persist, the order simply reflects recency
// within the current page.

/** Base z-index the floating buttons pin in their cssText. */
const Z_BASE = 99999;

/**
 * Restore a saved `{x,y}` position onto `el` (clamped to the viewport so a
 * resize since the last drag can't strand it off-screen), else anchor it
 * bottom-right at `edgeOffset`. The natural companion of {@link installDrag}
 * (which persists the position this restores) — shared by the standalone
 * button path in `./button.js` and the unified-FAB wrapper.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.element
 * @param {string} opts.posKey     localStorage key holding `{ x, y }`.
 * @param {number} opts.size       element diameter in px (for clamping).
 * @param {number} opts.edgeOffset bottom-right inset when no saved position.
 * @returns {void}
 */
export const restorePosition = ({ element, posKey, size, edgeOffset }) => {
  const saved = safeLS.json(posKey);
  if (
    saved &&
    typeof saved === 'object' &&
    typeof (/** @type {any} */ (saved).x) === 'number' &&
    typeof (/** @type {any} */ (saved).y) === 'number'
  ) {
    const p = /** @type {{ x: number, y: number }} */ (saved);
    element.style.left = Math.min(p.x, window.innerWidth - size) + 'px';
    element.style.top = Math.min(p.y, window.innerHeight - size) + 'px';
  } else {
    element.style.right = edgeOffset + 'px';
    element.style.bottom = edgeOffset + 'px';
  }
};

/**
 * Monotonic z-index dispenser. Bumped on every {@link bringToFront} call.
 * Module scope so it is shared across every `installDrag` consumer — that
 * sharing is the whole point (a global ordering across all buttons).
 */
let zTop = Z_BASE;

/**
 * Raise `element` above every other floating button by assigning it the
 * next z-index from the shared counter. Called on each drag/tap start.
 *
 * @param {HTMLElement} element
 * @returns {void}
 */
const bringToFront = (element) => {
  zTop += 1;
  element.style.zIndex = String(zTop);
};

/**
 * Wire mouse + touch drag onto a draggable element. The caller's click
 * listener should consult `wasDrag()` and short-circuit when it returns
 * true (and call `resetDrag()` so the next genuine click fires).
 *
 * Movement under `dragThreshold` px is ignored (counts as a tap). Once
 * the threshold trips, the element switches from `right`/`bottom`
 * anchoring to absolute `left`/`top` and the position is clamped to
 * `[0, viewport - element]` on each axis independently. The element
 * size is re-measured on every drag-start so resizes between drags
 * (e.g. a `fabBtnSize` setting change) get picked up
 * automatically, and so non-square elements (the freshPlanet banner)
 * clamp against their actual height rather than borrowing the width.
 * On release the final coords are written to `safeLS.setJSON(posKey,
 * { x, y })`.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.element  The draggable element (the wrap div for split buttons).
 * @param {string} opts.posKey  localStorage key for `{ x, y }`.
 * @param {number} [opts.dragThreshold=8]  px before a gesture counts as drag.
 * @returns {{ wasDrag: () => boolean, resetDrag: () => void }}
 */
export const installDrag = ({ element, posKey, dragThreshold = 8 }) => {
  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let width = 0;
  let height = 0;

  /** @param {number} cx @param {number} cy */
  const onStart = (cx, cy) => {
    isDragging = true;
    hasMoved = false;
    // Raise the touched element above the other floating buttons so the
    // one the user is interacting with is never hidden underneath.
    bringToFront(element);
    startX = cx;
    startY = cy;
    const r = element.getBoundingClientRect();
    startLeft = r.left;
    startTop = r.top;
    width = r.width;
    height = r.height;
  };

  /** @param {number} cx @param {number} cy */
  const onMove = (cx, cy) => {
    if (!isDragging) return;
    const dx = cx - startX;
    const dy = cy - startY;
    if (
      !hasMoved &&
      Math.abs(dx) < dragThreshold &&
      Math.abs(dy) < dragThreshold
    ) {
      return;
    }
    hasMoved = true;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    const newX = Math.max(
      0,
      Math.min(startLeft + dx, window.innerWidth - width),
    );
    const newY = Math.max(
      0,
      Math.min(startTop + dy, window.innerHeight - height),
    );
    element.style.left = newX + 'px';
    element.style.top = newY + 'px';
  };

  const onEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    if (hasMoved) {
      safeLS.setJSON(posKey, {
        x: parseInt(element.style.left, 10),
        y: parseInt(element.style.top, 10),
      });
    }
  };

  element.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      onStart(t.clientX, t.clientY);
    },
    { passive: true },
  );
  element.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      onMove(t.clientX, t.clientY);
      if (hasMoved) e.preventDefault();
    },
    { passive: false },
  );
  element.addEventListener('touchend', () => {
    onEnd();
  });
  element.addEventListener('mousedown', (e) => {
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

  return {
    wasDrag: () => hasMoved,
    resetDrag: () => {
      hasMoved = false;
    },
  };
};

/**
 * Wire focus-persistence onto a button. On focus, write `focusValue` to
 * `focusKey`; on blur, clear iff the key still points at us. If the key
 * already equals `focusValue` at install time, restore focus
 * `focusRestoreDelay` ms later (gives the DOM a tick to settle).
 *
 * @param {object} opts
 * @param {HTMLElement} opts.button
 * @param {string} opts.focusKey
 * @param {string} opts.focusValue
 * @param {number} [opts.focusRestoreDelay=50]
 * @returns {void}
 */
export const installFocusPersist = ({
  button,
  focusKey,
  focusValue,
  focusRestoreDelay = 50,
}) => {
  button.addEventListener('focus', () => safeLS.set(focusKey, focusValue));
  button.addEventListener('blur', () => {
    if (safeLS.get(focusKey) === focusValue) safeLS.remove(focusKey);
  });
  // Skip programmatic focus restoration on touch-primary devices. On mobile,
  // calling button.focus() can trigger virtual keyboard popup or focus ring
  // with no UX benefit (no keyboard navigation on touch).
  const isTouchPrimary = window.matchMedia('(pointer: coarse)').matches;
  if (!isTouchPrimary && safeLS.get(focusKey) === focusValue) {
    setTimeout(() => button.focus(), focusRestoreDelay);
  }
};
