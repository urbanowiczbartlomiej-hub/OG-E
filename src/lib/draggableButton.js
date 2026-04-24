// Shared drag + focus-persistence helper for the floating mobile
// buttons (sendExp, sendCol). Both features previously open-coded the
// same touch/mouse drag wiring with an 8-px threshold and the same
// `oge_focusedBtn`-based focus persistence. This module factors that
// out so changes (e.g. adjusting the drag threshold, tweaking restore
// timing) land in one place instead of two near-identical copies.
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
// # Why a single helper for two features
//
// sendCol's container wraps two halves; the drag/focus logic still
// lives on the OUTER `wrap`, and the focus persistence wires on each
// half independently — which we model by calling `installFocusPersist`
// twice (once per half) with different `focusValue`s. sendExp uses a
// single button so calls both helpers once.
//
// @see ../features/sendCol.js        — caller for the colonize button.
// @see ../features/sendExp.js       — caller for the expedition button.

/** @ts-check */

import { safeLS } from './storage.js';

/**
 * Wire mouse + touch drag onto a draggable element. The caller's click
 * listener should consult `wasDrag()` and short-circuit when it returns
 * true (and call `resetDrag()` so the next genuine click fires).
 *
 * Movement under `dragThreshold` px is ignored (counts as a tap). Once
 * the threshold trips, the element switches from `right`/`bottom`
 * anchoring to absolute `left`/`top` and the position is clamped to
 * `[0, viewport - size]`. On release the final coords are written to
 * `safeLS.setJSON(posKey, { x, y })`.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.element  The draggable element (the wrap div for split buttons).
 * @param {string} opts.posKey  localStorage key for `{ x, y }`.
 * @param {number} opts.size  Current diameter; used for the viewport clamp.
 * @param {number} [opts.dragThreshold=8]  px before a gesture counts as drag.
 * @returns {{ wasDrag: () => boolean, resetDrag: () => void }}
 */
export const installDrag = ({ element, posKey, size, dragThreshold = 8 }) => {
  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  /** @param {number} cx @param {number} cy */
  const onStart = (cx, cy) => {
    isDragging = true;
    hasMoved = false;
    startX = cx;
    startY = cy;
    const r = element.getBoundingClientRect();
    startLeft = r.left;
    startTop = r.top;
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
      Math.min(startLeft + dx, window.innerWidth - size),
    );
    const newY = Math.max(
      0,
      Math.min(startTop + dy, window.innerHeight - size),
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
  if (safeLS.get(focusKey) === focusValue) {
    setTimeout(() => button.focus(), focusRestoreDelay);
  }
};
