// @ts-check

// Config-driven floating button — the single structural home for the look
// and gestures shared by the dashboard's command buttons (sendExpedition,
// sendColony, dailyRun/Daily Run). It owns ONLY the view + input gestures:
//
//   • structure: one circular button (1 zone) or a vertically split
//     circle (2+ stacked zones), with the shared geometry/shadow/position;
//   • placement: a `module` config joins the unified FAB (the shell in
//     ./unifiedFab.js owns position/drag/visibility); a standalone button
//     restores a dragged position from `posKey` (clamped to the viewport)
//     or anchors bottom-right at `edgeOffset`;
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

import { decorateButton, appendLens } from './buttonChrome.js';
import {
  installDrag,
  installFocusPersist,
  restorePosition,
} from './draggableButton.js';
import { registerFabModule } from './unifiedFab.js';
import { whenEventBoxReady, isFleetdispatchPage } from './eventBoxGate.js';

// box-shadow and background are now driven by the .oge-host CSS class via
// the --rim custom property — no inline SHADOW constant needed here.

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
 * @property {string} bg                   initial rim/state colour (used as CSS --rim).
 * @property {(ev: MouseEvent) => void} onTap
 * @property {() => void} [onHold]         present ⇒ enables long-press on this zone.
 * @property {string} [glyph]              inner SVG markup of the glass node
 *                                         lens glyph (see buttonGlyphs.js);
 *                                         omitted ⇒ no lens.
 * @property {string} [focusValue]         present ⇒ persist focus under `focusKey`.
 * @property {number} [focusRestoreDelay]
 * @property {number} [labelShiftY]        px to nudge this zone's label
 *                                         vertically (translateY; +down).
 *                                         Split buttons push labels AWAY from
 *                                         centre (-up on the top zone, +down on
 *                                         the bottom one) to clear the central
 *                                         glass lens. Applied to the label span.
 */

/**
 * @typedef {object} ButtonConfig
 * @property {string} id                   outer element id.
 * @property {string} title                engraved on the ring + hover title.
 * @property {string} ringId               unique id for the ring's arc path.
 * @property {number} size                 diameter in px.
 * @property {number} fontScale            zone base font-size = round(size * fontScale).
 * @property {import('./unifiedFab.js').FabModuleMeta} [module]
 *   present ⇒ the button joins the unified FAB: the shell owns position,
 *   drag and visibility (only the active module shows), and `posKey` /
 *   `edgeOffset` are ignored. The four command buttons all pass this.
 * @property {string} [posKey]             localStorage key for the dragged
 *                                         position (standalone buttons only).
 * @property {ZoneConfig[]} zones          1 zone ⇒ single circle; 2+ ⇒ split.
 * @property {number} [edgeOffset]         bottom-right anchor inset (default 20).
 * @property {number} [dragThreshold]      px before a gesture is a drag (default 8).
 * @property {string} [focusKey]           shared focus key (default 'oge_focusedBtn').
 * @property {number} [holdMs]             long-press duration (default 300).
 * @property {boolean} [gateUntilEventBox] present ⇒ the button starts VISIBLY
 *   disabled on `component=fleetdispatch` and enables once OGame's post-load
 *   eventbox XHR has landed (taps are swallowed until then). No-op off
 *   fleetdispatch. See {@link whenEventBoxReady}. The four command buttons
 *   pass this — they all read DOM that's stale until the eventbox is fresh.
 */

/**
 * @typedef {object} Button
 * @property {HTMLElement} el                              outer element.
 * @property {(key: string) => HTMLElement | null} zoneEl  a zone's element.
 * @property {(key: string, lines: LabelLine[]) => void} paintLines
 * @property {(key: string, text: string) => void} setText  single-line shortcut.
 * @property {(key: string, bg: string) => void} setBg
 * @property {(key: string, dim: boolean) => void} setDim
 * @property {(disabled: boolean) => void} setDisabled  greys the fill +
 *   swallows taps (the readiness gate drives this; also callable directly).
 * @property {(pct: number) => void} setProgress  0 = empty, 1 = full circle on the progress arc.
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
  // Unified-FAB members fill the shell's wrapper (which owns the fixed
  // position, the z-index and the drag); standalone buttons position and
  // stack themselves as before.
  const positionCss = cfg.module
    ? ['position:absolute', 'left:0', 'top:0']
    : ['position:fixed', 'z-index:99999'];

  /** @type {Map<string, HTMLElement>} zone key → zone element (click target). */
  const zoneEls = new Map();
  /** @type {Map<string, HTMLElement>} zone key → label span. */
  const labelEls = new Map();
  /**
   * Zone key → the greyable FILL element: the busy/disabled dim (and the
   * label that rides it) target THIS, never the host — so the rim, ring SVG
   * and brand-node lens stay vivid while a zone is dimmed. Split zones ARE
   * their own fill (`.zone`); a single button gets a dedicated `.oge-surface`
   * layer so dimming it doesn't drag the chrome down with it. Keeping the
   * label inside the fill means one element greys both, identically for 1-
   * and 2-zone buttons.
   *
   * @type {Map<string, HTMLElement>}
   */
  const fillEls = new Map();

  // ── structure ──────────────────────────────────────────────────────────
  /** @type {HTMLElement} */
  let outer;
  if (single) {
    const z = cfg.zones[0];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = cfg.id;
    btn.className = 'oge-host single';
    btn.tabIndex = -1;
    if (z.ariaLabel) btn.setAttribute('aria-label', z.ariaLabel);
    btn.title = cfg.title;
    // background and box-shadow are driven by .oge-host CSS via --rim.
    btn.style.cssText = [
      ...positionCss,
      'border-radius:50%',
      'border:none',
      'touch-action:none',
      'user-select:none',
      'cursor:pointer',
      `width:${cfg.size}px`,
      `height:${cfg.size}px`,
      `font-size:${base}`,
    ].join(';');
    btn.style.setProperty('--rim', z.bg);
    // Dedicated fill layer so the busy/disabled dim greys only the painted
    // surface + label, never the rim/ring/lens chrome (z-index:auto keeps it
    // below the ring and out of its own stacking context, so the label's
    // z-index still resolves above the ring). The host now carries only chrome.
    const surface = document.createElement('span');
    surface.className = 'oge-surface';
    btn.appendChild(surface);
    outer = btn;
    zoneEls.set(z.key, btn);
    fillEls.set(z.key, surface);
  } else {
    const wrap = document.createElement('div');
    wrap.id = cfg.id;
    wrap.className = 'oge-host split';
    wrap.title = cfg.title;
    // box-shadow is driven by .oge-host CSS via --rim (set to primary zone colour).
    wrap.style.cssText = [
      ...positionCss,
      'border-radius:50%',
      'overflow:hidden',
      'display:flex',
      'flex-direction:column',
      'touch-action:none',
      'user-select:none',
      'cursor:pointer',
      `width:${cfg.size}px`,
      `height:${cfg.size}px`,
    ].join(';');
    wrap.style.setProperty('--rim', cfg.zones[0].bg);
    for (const z of cfg.zones) {
      const half = document.createElement('button');
      half.type = 'button';
      half.id = z.id;
      half.className = 'zone';
      half.tabIndex = -1;
      if (z.ariaLabel) half.setAttribute('aria-label', z.ariaLabel);
      // background is driven by .oge-host .zone CSS via --rim.
      half.style.cssText = [
        'flex:1',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'text-align:center',
        'border:none',
        'cursor:pointer',
        `font-size:${base}`,
      ].join(';');
      half.style.setProperty('--rim', z.bg);
      wrap.appendChild(half);
      zoneEls.set(z.key, half);
      // A split half IS its own fill — it sits below the host's ring/lens.
      fillEls.set(z.key, half);
    }
    outer = wrap;
  }

  // Label container per zone (a span the paint methods rewrite, leaving the
  // ring/ripple decoration — appended to the host below — untouched). An
  // optional per-zone `labelShiftY` nudges the whole label toward centre;
  // it rides on the span so it survives every repaint.
  for (const z of cfg.zones) {
    const el = /** @type {HTMLElement} */ (fillEls.get(z.key));
    const span = document.createElement('span');
    span.className = LABEL_CLASS;
    if (z.labelShiftY) span.style.transform = `translateY(${z.labelShiftY}px)`;
    el.appendChild(span);
    labelEls.set(z.key, span);
  }
  // One shared glass node lens carries the command glyph. CSS parks it in
  // the upper section on a single-zone button and centred on the seam on a
  // split one; it mounts on the stable host so label repaints never wipe it.
  // A single button uses its only zone's glyph; a split one takes the first
  // zone that declares one.
  const lensGlyph = single
    ? cfg.zones[0]?.glyph
    : cfg.zones.find((z) => z.glyph)?.glyph;
  if (lensGlyph) appendLens(outer, lensGlyph);

  // ── mount + drag ────────────────────────────────────────────────────────
  // Unified-FAB members are mounted into (and dragged via) the shared shell;
  // standalone buttons place themselves and own their drag. Either way the
  // zones' click handlers consult the same wasDrag/resetDrag discriminator.
  /** @type {{ wasDrag: () => boolean, resetDrag: () => void }} */
  let drag;
  /** @type {(() => void) | null} */
  let unregisterFab = null;
  if (cfg.module) {
    const reg = registerFabModule({ meta: cfg.module, host: outer });
    drag = reg.drag;
    unregisterFab = reg.dispose;
  } else {
    restorePosition({
      element: outer,
      posKey: /** @type {string} */ (cfg.posKey),
      size: cfg.size,
      edgeOffset,
    });
    document.body.appendChild(outer);
    drag = installDrag({
      element: outer,
      posKey: /** @type {string} */ (cfg.posKey),
      dragThreshold,
    });
  }

  decorateButton({
    host: outer,
    zones: [...zoneEls.values()],
    title: cfg.title,
    ringId: cfg.ringId,
  });

  // ── long-press charge arc + hold timer — only zones that declared onHold. ─
  // The charge arc SVG element is appended by decorateButton; we animate its
  // stroke-dashoffset (100 = empty → 0 = full circle) instead of a conic-
  // gradient overlay div so the animation uses the rim colour automatically.
  const chargeArc = /** @type {SVGCircleElement | null} */ (
    outer.querySelector('.oge-ring-charge')
  );
  /** @type {number | null} */ let holdTimer = null;
  /** @type {number | null} */ let sweepRaf = null;
  let holdFired = false;
  let pressX = 0;
  let pressY = 0;

  const stopSweep = () => {
    if (sweepRaf !== null) {
      cancelAnimationFrame(sweepRaf);
      sweepRaf = null;
    }
    chargeArc?.setAttribute('stroke-dashoffset', '100');
  };
  /** @param {HTMLElement} _zone */
  const startSweep = (_zone) => {
    stopSweep();
    const t0 = performance.now();
    const tick = () => {
      const pct = Math.min((performance.now() - t0) / holdMs, 1);
      chargeArc?.setAttribute('stroke-dashoffset', String((1 - pct) * 100));
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

  // Readiness/disabled flag — set via setDisabled (the eventbox gate drives
  // it). While true the zones swallow taps and long-presses outright; the
  // greyed look comes from `aria-disabled` on the host (see buttonChrome.js).
  let disabled = false;

  // ── per-zone wiring ──────────────────────────────────────────────────────
  for (const z of cfg.zones) {
    const el = /** @type {HTMLElement} */ (zoneEls.get(z.key));

    if (z.onHold) {
      el.addEventListener('pointerdown', (e) => {
        if (disabled) return;
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
      if (disabled) return;
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

  const progressArc = /** @type {SVGCircleElement | null} */ (
    outer.querySelector('.oge-ring-progress')
  );

  // Teardown for the optional eventbox readiness gate (wired below the API).
  let stopGate = () => {};

  /** @type {Button} */
  const api = {
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
    setBg: (key, rim) => {
      const el = zoneEls.get(key);
      if (el) el.style.setProperty('--rim', rim);
      // Keep the host's outer glow in sync with the primary zone's colour.
      if (key === cfg.zones[0].key) outer.style.setProperty('--rim', rim);
    },
    setDim: (key, dim) => {
      // Dim the FILL (split half / single surface), not the host — keeps the
      // rim, ring and brand lens at full strength while the zone greys out.
      const el = fillEls.get(key);
      if (el) el.style.opacity = dim ? '0.5' : '1';
    },
    setDisabled: (d) => {
      disabled = d;
      if (d) outer.setAttribute('aria-disabled', 'true');
      else outer.removeAttribute('aria-disabled');
    },
    setProgress: (pct) => {
      progressArc?.setAttribute(
        'stroke-dashoffset',
        String((1 - Math.max(0, Math.min(1, pct))) * 100),
      );
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
      stopGate();
      if (unregisterFab) unregisterFab();
      else outer.remove();
    },
  };

  // Eventbox readiness gate: on fleetdispatch hold the button visibly
  // disabled until OGame's post-load eventbox XHR lands (or a fallback
  // fires), so a tap never acts on a half-hydrated page. No-op elsewhere.
  if (cfg.gateUntilEventBox && isFleetdispatchPage()) {
    api.setDisabled(true);
    stopGate = whenEventBoxReady(() => api.setDisabled(false));
  }

  return api;
};
