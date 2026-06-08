// @ts-check

// Config-driven floating button — the single structural home for the look
// and gestures shared by the dashboard's command buttons (sendExp,
// sendCol, fsCollect/Daily Run). It owns ONLY the view + input gestures:
//
//   • structure: one circular button (1 zone) or a vertically split
//     circle (2+ stacked zones), with the shared geometry/shadow/position;
//   • placement: restore a dragged position from `posKey` (clamped to the
//     viewport) or anchor bottom-right at `edgeOffset`;
//   • a per-zone label container painted via {@link Button#paintLines}
//     (1–3 stacked lines) WITHOUT clobbering the engraved ring / ripple
//     decoration — which is exactly why the single-zone button paints into
//     a dedicated `.oge-btn-label` span rather than its own textContent;
//   • per-zone background + a `dim` (greyed-out) flag;
//   • wiring: the engraved title ring + tap ripple (`decorateButton`),
//     drag (`installDrag`) with a tap/drag discriminator, an optional
//     long-press gesture with a radial sweep indicator, and focus
//     persistence (`installFocusPersist`).
//
// What it deliberately does NOT do (per CLAUDE.md's layering): it never
// reads the game DOM, never touches XHR, and knows nothing about fleets,
// missions or stores. The caller passes `onTap` / `onHold` callbacks and
// drives `paintLines` / `setBg` / `setDim` from its own derive→render
// pipeline. The ids/classes here are OG-E's OWN injected surface, not the
// game's fragile contract.
//
// @see ./buttonChrome.js     — the engraved ring + ripple decoration.
// @see ./draggableButton.js  — the drag + focus-persistence primitives.

import { decorateButton } from './buttonChrome.js';
import { installDrag, installFocusPersist } from './draggableButton.js';
import { safeLS } from '../../lib/storage.js';

/**
 * Shared drop-shadow every floating button pins. Deeper than the original,
 * and the `0 0 18px 5px` layer (no offset, positive spread) makes the
 * shadow begin already AT the button's outer rim rather than only past it.
 */
const SHADOW =
  '0 10px 30px rgba(0,0,0,0.70),0 4px 12px rgba(0,0,0,0.60),' +
  '0 0 18px 5px rgba(0,0,0,0.55),0 0 0 1px rgba(0,0,0,0.45)';

/** Class on the per-zone label container the paint methods write into. */
export const LABEL_CLASS = 'oge-btn-label';

/**
 * One stacked line in a zone label.
 *
 * @typedef {object} LabelLine
 * @property {string} text
 * @property {string} [em]            font-size in em of the zone base (default '1em').
 * @property {number} [opacity]       0..1 (default 1).
 * @property {number} [marginTop]     px gap above this line (default 0).
 * @property {number} [letterSpacing] px letter-spacing (default 0).
 */

/**
 * One clickable zone of the button.
 *
 * @typedef {object} ZoneConfig
 * @property {string} key                  stable handle used by paint/setBg/setDim.
 * @property {string} id                   element id (OG-E's own surface).
 * @property {string} [ariaLabel]
 * @property {string} bg                   initial background.
 * @property {(ev: MouseEvent) => void} onTap
 * @property {() => void} [onHold]         present ⇒ enables long-press on this zone.
 * @property {string} [focusValue]         present ⇒ persist focus under `focusKey`.
 * @property {number} [focusRestoreDelay]
 * @property {number} [labelShiftY]        px to nudge this zone's label toward
 *                                         the button centre (split buttons:
 *                                         +down on the top zone, -up on the
 *                                         bottom one). Applied to the label span.
 */

/**
 * @typedef {object} ButtonConfig
 * @property {string} id                   outer element id.
 * @property {string} title                engraved on the ring + hover title.
 * @property {string} ringId               unique id for the ring's arc path.
 * @property {number} size                 diameter in px.
 * @property {number} fontScale            zone base font-size = round(size * fontScale).
 * @property {string} posKey               localStorage key for the dragged position.
 * @property {ZoneConfig[]} zones          1 zone ⇒ single circle; 2+ ⇒ split.
 * @property {number} [edgeOffset]         bottom-right anchor inset (default 20).
 * @property {number} [dragThreshold]      px before a gesture is a drag (default 8).
 * @property {string} [focusKey]           shared focus key (default 'oge_focusedBtn').
 * @property {number} [holdMs]             long-press duration (default 300).
 */

/**
 * @typedef {object} Button
 * @property {HTMLElement} el                              outer element.
 * @property {(key: string) => HTMLElement | null} zoneEl  a zone's element.
 * @property {(key: string, lines: LabelLine[]) => void} paintLines
 * @property {(key: string, text: string) => void} setText  single-line shortcut.
 * @property {(key: string, bg: string) => void} setBg
 * @property {(key: string, dim: boolean) => void} setDim
 * @property {(size: number) => void} resize                live diameter + font.
 * @property {() => boolean} wasDrag
 * @property {() => void} resetDrag
 * @property {() => void} dispose
 */

const DEFAULTS = {
  edgeOffset: 20,
  dragThreshold: 8,
  focusKey: 'oge_focusedBtn',
  holdMs: 300,
};

/**
 * Restore a saved `{x,y}` onto `el` (clamped to the viewport so a resize
 * since the last drag can't strand it off-screen), else anchor
 * bottom-right at `edgeOffset`.
 *
 * @param {HTMLElement} el
 * @param {string} posKey
 * @param {number} size
 * @param {number} edgeOffset
 * @returns {void}
 */
const place = (el, posKey, size, edgeOffset) => {
  const saved = safeLS.json(posKey);
  if (
    saved &&
    typeof saved === 'object' &&
    typeof (/** @type {any} */ (saved).x) === 'number' &&
    typeof (/** @type {any} */ (saved).y) === 'number'
  ) {
    const p = /** @type {{ x: number, y: number }} */ (saved);
    el.style.left = Math.min(p.x, window.innerWidth - size) + 'px';
    el.style.top = Math.min(p.y, window.innerHeight - size) + 'px';
  } else {
    el.style.right = edgeOffset + 'px';
    el.style.bottom = edgeOffset + 'px';
  }
};

/**
 * Paint up to N stacked lines into a zone's `.oge-btn-label` span. Only
 * the label span is cleared, so the sibling ring/ripple decoration (on a
 * single-zone button, that decoration shares the same host) survives.
 *
 * @param {HTMLElement} span
 * @param {LabelLine[]} lines
 * @returns {void}
 */
export const renderLines = (span, lines) => {
  span.textContent = '';
  const col = document.createElement('div');
  col.style.cssText =
    'display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;line-height:1.1;width:100%;';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line.text;
    let css = `font-size:${line.em || '1em'};`;
    if (line.opacity != null && line.opacity !== 1) css += `opacity:${line.opacity};`;
    if (line.marginTop) css += `margin-top:${line.marginTop}px;`;
    if (line.letterSpacing) css += `letter-spacing:${line.letterSpacing}px;`;
    div.style.cssText = css;
    col.appendChild(div);
  }
  span.appendChild(col);
};

/**
 * Canonical stacked-label spec shared by every button so all three read
 * identically: a 1em primary on top, an optional 0.5em caption below, and
 * an optional 0.34em low-weight hint at the bottom. An omitted/empty
 * `sub`/`hint` drops that line. This is the single source of truth for the
 * label font sizes / opacities / spacing — pass the result to
 * {@link renderLines} (or `Button.paintLines`).
 *
 * @param {{ main: string, sub?: string, hint?: string }} parts
 * @returns {LabelLine[]}
 */
export const labelLines = ({ main, sub, hint }) => {
  /** @type {LabelLine[]} */
  const lines = [{ text: main, em: '1em' }];
  if (sub != null && sub !== '') {
    lines.push({ text: sub, em: '0.5em', opacity: 0.85, marginTop: 2, letterSpacing: 0.5 });
  }
  if (hint != null && hint !== '') {
    lines.push({ text: hint, em: '0.34em', opacity: 0.55, marginTop: 2, letterSpacing: 0.5 });
  }
  return lines;
};

/**
 * Build, mount and wire a floating button from `cfg`. Returns a controller,
 * or `null` if a button with `cfg.id` is already mounted (idempotent
 * mount — mirrors the features' pre-existing guard).
 *
 * @param {ButtonConfig} cfg
 * @returns {Button | null}
 */
export const createButton = (cfg) => {
  if (document.getElementById(cfg.id)) return null;

  const edgeOffset = cfg.edgeOffset ?? DEFAULTS.edgeOffset;
  const dragThreshold = cfg.dragThreshold ?? DEFAULTS.dragThreshold;
  const focusKey = cfg.focusKey ?? DEFAULTS.focusKey;
  const holdMs = cfg.holdMs ?? DEFAULTS.holdMs;
  const single = cfg.zones.length === 1;
  // Single-zone labels run 1px smaller than the raw scale (the split
  // buttons keep theirs, which stay legible across two stacked halves).
  const base = Math.round(cfg.size * cfg.fontScale) - (single ? 1 : 0) + 'px';

  /** @type {Map<string, HTMLElement>} zone key → zone element. */
  const zoneEls = new Map();
  /** @type {Map<string, HTMLElement>} zone key → label span. */
  const labelEls = new Map();

  // ── structure ──────────────────────────────────────────────────────────
  /** @type {HTMLElement} */
  let outer;
  if (single) {
    const z = cfg.zones[0];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = cfg.id;
    btn.tabIndex = 0;
    if (z.ariaLabel) btn.setAttribute('aria-label', z.ariaLabel);
    btn.title = cfg.title;
    btn.style.cssText = [
      'position:fixed',
      'border-radius:50%',
      'border:none',
      `background:${z.bg}`,
      'color:#fff',
      'font-weight:bold',
      'z-index:99999',
      `box-shadow:${SHADOW}`,
      'touch-action:none',
      'user-select:none',
      'cursor:pointer',
      `width:${cfg.size}px`,
      `height:${cfg.size}px`,
      `font-size:${base}`,
    ].join(';');
    outer = btn;
    zoneEls.set(z.key, btn);
  } else {
    const wrap = document.createElement('div');
    wrap.id = cfg.id;
    wrap.title = cfg.title;
    wrap.style.cssText = [
      'position:fixed',
      'border-radius:50%',
      'overflow:hidden',
      'display:flex',
      'flex-direction:column',
      'z-index:99999',
      'touch-action:none',
      'user-select:none',
      'cursor:pointer',
      `box-shadow:${SHADOW}`,
      `width:${cfg.size}px`,
      `height:${cfg.size}px`,
    ].join(';');
    for (const z of cfg.zones) {
      const half = document.createElement('button');
      half.type = 'button';
      half.id = z.id;
      half.tabIndex = 0;
      if (z.ariaLabel) half.setAttribute('aria-label', z.ariaLabel);
      half.style.cssText = [
        'flex:1',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'text-align:center',
        'color:#fff',
        'font-weight:bold',
        'border:none',
        'cursor:pointer',
        `font-size:${base}`,
        `background:${z.bg}`,
      ].join(';');
      wrap.appendChild(half);
      zoneEls.set(z.key, half);
    }
    outer = wrap;
  }

  // Label container per zone (a span the paint methods rewrite, leaving the
  // ring/ripple decoration — appended to the host below — untouched). An
  // optional per-zone `labelShiftY` nudges the whole label toward centre;
  // it rides on the span so it survives every repaint.
  for (const z of cfg.zones) {
    const el = /** @type {HTMLElement} */ (zoneEls.get(z.key));
    const span = document.createElement('span');
    span.className = LABEL_CLASS;
    if (z.labelShiftY) span.style.transform = `translateY(${z.labelShiftY}px)`;
    el.appendChild(span);
    labelEls.set(z.key, span);
  }

  place(outer, cfg.posKey, cfg.size, edgeOffset);
  document.body.appendChild(outer);

  decorateButton({
    host: outer,
    zones: [...zoneEls.values()],
    title: cfg.title,
    ringId: cfg.ringId,
  });

  // ── drag (on the outer element, so a touch on any zone drags the whole
  // circle) + tap/drag discriminator shared by every zone's click. ────────
  const drag = installDrag({ element: outer, posKey: cfg.posKey, dragThreshold });

  // ── long-press (radial sweep) — only zones that declared onHold. ─────────
  /** @type {number | null} */ let holdTimer = null;
  /** @type {number | null} */ let sweepRaf = null;
  /** @type {HTMLElement | null} */ let sweepEl = null;
  let holdFired = false;
  let pressX = 0;
  let pressY = 0;

  const stopSweep = () => {
    if (sweepRaf !== null) {
      cancelAnimationFrame(sweepRaf);
      sweepRaf = null;
    }
    sweepEl?.remove();
    sweepEl = null;
  };
  /** @param {HTMLElement} zone */
  const startSweep = (zone) => {
    stopSweep();
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    zone.appendChild(el);
    sweepEl = el;
    const t0 = performance.now();
    const tick = () => {
      const pct = Math.min((performance.now() - t0) / holdMs, 1);
      const deg = pct * 184; // slight overshoot so the last frame is full
      el.style.background = `conic-gradient(from 90deg at 50% 0%, rgba(255,255,255,0.18) ${deg}deg, transparent ${deg}deg)`;
      if (pct < 1) sweepRaf = requestAnimationFrame(tick);
    };
    sweepRaf = requestAnimationFrame(tick);
  };
  const clearHold = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    stopSweep();
  };

  // ── per-zone wiring ──────────────────────────────────────────────────────
  for (const z of cfg.zones) {
    const el = /** @type {HTMLElement} */ (zoneEls.get(z.key));

    if (z.onHold) {
      el.addEventListener('pointerdown', (e) => {
        holdFired = false;
        pressX = e.clientX;
        pressY = e.clientY;
        clearHold();
        startSweep(el);
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          holdFired = true;
          stopSweep();
          /** @type {() => void} */ (z.onHold)();
        }, holdMs);
      });
      el.addEventListener('pointermove', (e) => {
        if (
          holdTimer !== null &&
          (Math.abs(e.clientX - pressX) > dragThreshold ||
            Math.abs(e.clientY - pressY) > dragThreshold)
        ) {
          clearHold();
        }
      });
      el.addEventListener('pointerup', clearHold);
      el.addEventListener('pointercancel', clearHold);
      el.addEventListener('pointerleave', clearHold);
      // Long-press on touch can raise the native context menu — suppress it.
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    el.addEventListener('click', (e) => {
      if (drag.wasDrag()) {
        drag.resetDrag();
        return;
      }
      if (z.onHold && holdFired) {
        holdFired = false;
        return;
      }
      e.stopPropagation();
      z.onTap(/** @type {MouseEvent} */ (e));
    });

    if (z.focusValue) {
      installFocusPersist({
        button: el,
        focusKey,
        focusValue: z.focusValue,
        ...(z.focusRestoreDelay != null
          ? { focusRestoreDelay: z.focusRestoreDelay }
          : {}),
      });
    }
  }

  return {
    el: outer,
    zoneEl: (key) => zoneEls.get(key) ?? null,
    paintLines: (key, lines) => {
      const span = labelEls.get(key);
      if (span) renderLines(span, lines);
    },
    setText: (key, text) => {
      const span = labelEls.get(key);
      if (span) renderLines(span, [{ text }]);
    },
    setBg: (key, bg) => {
      const el = zoneEls.get(key);
      if (el) el.style.background = bg;
    },
    setDim: (key, dim) => {
      const el = zoneEls.get(key);
      if (el) el.style.opacity = dim ? '0.5' : '1';
    },
    resize: (size) => {
      outer.style.width = size + 'px';
      outer.style.height = size + 'px';
      const px = Math.round(size * cfg.fontScale) - (single ? 1 : 0) + 'px';
      if (single) {
        outer.style.fontSize = px;
      } else {
        for (const el of zoneEls.values()) el.style.fontSize = px;
      }
    },
    wasDrag: () => drag.wasDrag(),
    resetDrag: () => drag.resetDrag(),
    dispose: () => {
      clearHold();
      outer.remove();
    },
  };
};
