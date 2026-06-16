// Shared "OGame-native" visual chrome for the three floating draggable
// buttons: sendExpedition (`#oge-send-exp`), sendColony (`#oge-send-col`) and
// dailyRun (`#oge-fs-unified`).
//
// Two things live here:
//
//   1. installButtonChrome() — injects ONE `<style id="oge-btn-chrome">`
//      (idempotent) with the rules every button shares: the rim glow + inset
//      filament, a crisp vivid edge ring on the outermost pixels (drawn via
//      `::after`), the engraved title-ring styling, the tap-ripple keyframes
//      and the per-zone press feedback.
//
//   2. decorateButton({ host, zones, title, ringId }) — appends the
//      per-button DOM the stylesheet styles: a persistent ripple layer
//      and an SVG ring carrying the title "engraved" along its top arc,
//      then wires a press + ripple tap effect onto each clickable zone.
//
// Each button still sets its OWN per-state background colour inline; none
// of that paint logic changes. The decorative children are appended to a
// STABLE host (the wrap for the split buttons; the button itself for the
// single one) so frequent label repaints never wipe them — which is why
// sendExpedition paints its label into a dedicated `.oge-exp-label` span rather
// than clobbering the button's textContent.
//
// Lives in features/shared/ because it injects into `document`; the CSS
// is a pure exported constant so the rules can be asserted in a test
// without measuring pixels. The ids/classes referenced here are OG-E's
// OWN injected surface (NOT the game's fragile DOM contract — see
// CLAUDE.md), so the design lives next to the buttons that emit it.
//
// @see ./draggableButton.js — drag/focus wiring for the same buttons.

/** @ts-check */

import { parseSvg } from '../../lib/dom.js';

/** Id of the singleton <style> element this module injects. */
export const CHROME_STYLE_ID = 'oge-btn-chrome';

/** SVG namespace for the engraved title ring. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * The HUD command-node decorative CSS shared by all three floating buttons.
 * State colour lives in `--rim` (set per button via `style.setProperty`);
 * the dark `--surface` core reads on any game background.  Exported as a
 * pure string so a test can assert it carries the right class selectors.
 */
export const BUTTON_CHROME_CSS = [
  // ── Host: dark core, state rim colour, shared transitions ──────────────
  '.oge-host{',
  '--surface:#0b1220;--rim:#38bdf8;--glow:1;--label:#f8fafc;--art-opacity:.1;',
  'position:relative;border-radius:50%;isolation:isolate;',
  'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Verdana,sans-serif;',
  'font-weight:700;color:var(--label);cursor:pointer;',
  '-webkit-user-select:none;user-select:none;touch-action:manipulation;',
  'transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .2s ease,filter .12s ease;}',

  // ── Elevation + state rim border + glow ─────────────────────────────────
  // The 1.5px rim-coloured thread that rides just inside the chrome edge is
  // the button's one spot of pure state colour — kept BRIGHT (82%) with a soft
  // same-colour inner glow so it reads as a glowing filament, not a dim line.
  '.oge-host{',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.07),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 82%,transparent),',
  'inset 0 0 8px -1px color-mix(in oklab,var(--rim) 50%,transparent),',
  '0 0 calc(26px * var(--glow)) -6px var(--rim),',
  '0 18px 36px -12px rgba(0,0,0,.72),',
  '0 4px 12px -2px rgba(0,0,0,.5);}',

  // ── Crisp bright edge (the outermost pixels) ────────────────────────────
  // The zone/surface gradient reaches the rounded rim, so the inset chrome
  // filament never quite paints the LAST pixels of the edge — that band stays
  // the dim gradient colour. This pseudo-ring lays a vivid, SHARP state-coloured
  // line right on the perimeter (like the FAB menu orbs' edge), single and split
  // alike. border-box keeps it inside the split wrap's overflow:hidden; z-index 6
  // sits it above the fill(0) + seam(4), and it's the perimeter so it never
  // crowds the central node(5).
  '.oge-host::after{content:"";position:absolute;inset:0;border-radius:50%;',
  'pointer-events:none;z-index:6;box-sizing:border-box;',
  'border:1.5px solid color-mix(in oklab,var(--rim) 88%,#fff 12%);}',

  // ── Single-zone: rim-tinted fill on a dedicated layer ───────────────────
  // The host keeps only the chrome (rim shadow + ring + lens); the painted
  // fill lives in .oge-surface so the busy/disabled dim can grey the fill
  // (and the label nested in it) without touching the chrome. z-index:auto
  // keeps the surface below the ring(2)/lens(5) and avoids forming its own
  // stacking context, so the label's z-index:3 still resolves above the ring.
  '.oge-host.single{background:var(--surface);}',
  '.oge-host.single .oge-surface{position:absolute;inset:0;border-radius:50%;',
  'pointer-events:none;background:radial-gradient(125% 125% at 50% 16%,',
  'color-mix(in oklab,var(--rim) 26%,var(--surface)) 0%,',
  'var(--surface) 62%);}',

  // ── Split-zone layout ───────────────────────────────────────────────────
  '.oge-host.split{overflow:hidden;display:flex;flex-direction:column;background:var(--surface);}',

  // ── Per-zone: rim-tinted gradient + zone divider ────────────────────────
  '.oge-host .zone{',
  'flex:1;border:none;cursor:pointer;color:var(--label);font-weight:700;',
  'display:flex;align-items:center;justify-content:center;text-align:center;',
  'position:relative;',
  'background:radial-gradient(150% 150% at 50% 0%,',
  'color-mix(in oklab,var(--rim) 30%,var(--surface)),',
  'color-mix(in oklab,var(--rim) 12%,var(--surface)));',
  'transition:filter .12s ease;}',
  // Seam runs INVERTED: brightest at the two outer ends, fading to nothing
  // in the centre — so it threads into the central glass lens (see .oge-lens)
  // from both halves instead of cutting across it. (The old build was the
  // mirror: bright centre, fading to the sides.)
  '.oge-host .zone+.zone::before{',
  'content:"";position:absolute;left:14%;right:14%;top:-.5px;height:1.5px;z-index:4;',
  'background:linear-gradient(90deg,',
  'color-mix(in oklab,var(--rim) 60%,#fff),transparent,',
  'color-mix(in oklab,var(--rim) 60%,#fff));',
  'opacity:.55;}',
  '.oge-host .zone:hover{filter:brightness(1.12) saturate(1.05);}',

  // ── Split: stronger rim + dark inset backing to restore thread contrast
  //    Zone gradients colour the area just inside the circular edge, reducing
  //    contrast between the thread and its inner background. A dark inset at
  //    3px sits behind the 1.5px thread, creating a ~1.5px dark strip that
  //    decouples the thread from the zone gradient — matching the contrast
  //    a single-zone button gets naturally from its near-black edge fill.
  '.oge-host.split{',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.12),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 88%,transparent),',
  'inset 0 0 0 3px rgba(0,0,0,.45),',
  'inset 0 0 9px -1px color-mix(in oklab,var(--rim) 48%,transparent),',
  '0 0 calc(26px * var(--glow)) -6px var(--rim),',
  '0 18px 36px -12px rgba(0,0,0,.72),',
  '0 4px 12px -2px rgba(0,0,0,.5);}',
  '.oge-host.split:hover{',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.14),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 95%,transparent),',
  'inset 0 0 0 3px rgba(0,0,0,.40),',
  'inset 0 0 11px -1px color-mix(in oklab,var(--rim) 55%,transparent),',
  '0 0 calc(30px * var(--glow)) -4px var(--rim),',
  '0 22px 40px -12px rgba(0,0,0,.74),',
  '0 4px 12px -2px rgba(0,0,0,.5);}',

  // ── Label container ─────────────────────────────────────────────────────
  '.oge-btn-label{display:flex;align-items:center;justify-content:center;',
  'width:100%;pointer-events:none;z-index:3;text-shadow:0 1px 2px rgba(0,0,6,.45);}',
  // Nudged down so the label clears the upper glass lens (see .oge-lens).
  // Now nested in .oge-surface (not a direct host child) — match on descendant.
  '.oge-host.single .oge-btn-label{position:absolute;inset:0;padding-top:14%;}',

  // ── Ring: band, charge arc, progress arc, title, brand ──────────────────
  '.oge-ring{position:absolute;inset:0;width:100%;height:100%;',
  'pointer-events:none;overflow:visible;z-index:2;}',
  '.oge-ring-band{fill:none;stroke:rgba(148,163,184,.22);stroke-width:6;}',
  // Both arcs start hidden: with stroke-linecap:round, Chrome paints the
  // rounded cap as a stray dot even when the dash is fully offset (empty),
  // so an "empty" arc would show a permanent ~1% mark. visibility:hidden
  // kills it; JS flips to visible only while the arc is actually filling.
  '.oge-ring-progress{fill:none;stroke:var(--rim);stroke-width:6;stroke-linecap:round;',
  'visibility:hidden;filter:drop-shadow(0 0 2.5px var(--rim));transition:stroke-dashoffset .4s ease;}',
  '.oge-ring-charge{fill:none;stroke:var(--rim);stroke-width:6.5;stroke-linecap:round;',
  'visibility:hidden;filter:drop-shadow(0 0 5px var(--rim));}',
  '.oge-ring-title{fill:var(--label);font-weight:700;',
  'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Verdana,sans-serif;',
  'text-transform:uppercase;',
  // paint-order:stroke puts the stroke under the fill so halos don't eat glyph details.
  'paint-order:stroke;stroke:rgba(2,6,16,.6);stroke-width:.7px;stroke-linejoin:round;}',
  '.oge-ring-brand{fill:color-mix(in oklab,var(--rim) 62%,#94a3b8);font-weight:700;',
  'text-transform:uppercase;letter-spacing:.4px;',
  'paint-order:stroke;stroke:rgba(2,6,16,.55);stroke-width:.6px;}',

  // ── Glyph layer (the brand node's identity glyph) ───────────────────────
  // The flat tinted glyph layer, z-index 0 (above the gradient fill, below
  // ripple(1), ring(2), label(3)); tints via currentColor, fades with
  // --art-opacity. Shared by the FAB's satellite orbs AND the in-button node
  // oczko — both `.oge-node`, which cranks --art-opacity up and recolours the
  // glyph light so it reads on the module-coloured dome (see .oge-node below).
  '.oge-art{position:absolute;inset:0;z-index:0;pointer-events:none;',
  'display:flex;align-items:center;justify-content:center;',
  'color:var(--rim);opacity:var(--art-opacity,.1);}',
  '.oge-art svg{width:60%;height:60%;overflow:visible;}',
  '@media (prefers-reduced-motion:reduce){.oge-art{transition:none;}}',

  // ── The "oczko" (node lens) + its gold-lens ancestor ────────────────────
  // The small node parked inside every command button. It used to be a gold
  // cabochon framed by the OG-E orbit mark; it is now the SAME module-coloured
  // dome the FAB's satellite orbs wear (`.oge-node`, below), so the active
  // module's oczko and its orb are one and the same — tapping an orb reads as
  // that node flying into the button. Deliberately SMALL: the action label is
  // the priority, the node is a glanceability + brand cue, not the centrepiece.
  // z-index 5 keeps it above the seam(4), label(3), ring(2). Placement per
  // shape below: SINGLE parks it in the upper section (label cleared below);
  // SPLIT centres it on the seam, which the inverted divider threads into.
  // Gold glass cabochon + orbit mark — the placement (left/top/size) is shared
  // with the node oczko below; the gold VISUAL here is only the base. The
  // command buttons override it with `.oge-node` (declared last, so it wins on
  // the `.oge-lens.oge-node` oczko); the gold look survives for OG-E's own UI
  // (appendLens → the settings dashboard button). `--surface` falls back so it
  // renders outside a command button too.
  '.oge-lens{position:absolute;left:50%;border-radius:50%;z-index:5;',
  'pointer-events:none;display:flex;align-items:center;justify-content:center;',
  'color:#e8b870;',
  'background:',
  'radial-gradient(130% 110% at 50% 16%,rgba(255,255,255,.14),transparent 44%),',
  'radial-gradient(120% 120% at 50% 34%,',
  'color-mix(in oklab,var(--rim,#e8b870) 16%,var(--surface,#0b1220)),var(--surface,#0b1220) 80%);',
  'box-shadow:',
  'inset 0 1.5px 2px rgba(255,255,255,.22),',
  'inset 0 -4px 7px rgba(0,0,6,.5),',
  'inset 0 -2px 5px color-mix(in oklab,var(--rim,#e8b870) 20%,transparent),',
  'inset 0 0 0 1px color-mix(in oklab,var(--rim,#e8b870) 38%,transparent),',
  '0 2px 4px rgba(0,0,0,.5);}',
  '.oge-lens-glyph{width:46%;height:46%;overflow:visible;opacity:.95;',
  'filter:drop-shadow(0 1px 1px rgba(0,0,6,.5));}',
  // Orbit mark: sits slightly proud of the dome so its beads land on the rim.
  '.oge-lens-orbit{position:absolute;left:-26%;top:-26%;width:152%;height:152%;',
  'overflow:visible;z-index:6;}',
  // SINGLE: small node parked up top (label cleared below). SPLIT: centred on
  // the seam. ~20% larger than the original gold lens; SINGLE is nudged up so
  // the larger node grows upward (its bottom edge stays put) and never crowds
  // the label below.
  '.oge-host.single .oge-lens{top:24%;width:25%;height:25%;transform:translate(-50%,-50%);}',
  '.oge-host.split .oge-lens{top:50%;width:23%;height:23%;transform:translate(-50%,-50%);}',

  // ── Brand node: FAB satellite orb + the in-button "oczko" (one shared look) ─
  // Declared AFTER .oge-lens so it wins on the `.oge-lens.oge-node` oczko. The
  // SAME dome the FAB's satellite orbs wear, so tapping an orb reads as that
  // node flying into the button. Module colour rides `--mod`; the glyph is the
  // faint `.oge-art` layer tinted light so it reads on the coloured dome. No
  // position here — the oczko gets it from `.oge-lens`, the orbs from
  // `.oge-fab-orb` (unifiedFab.js).
  '.oge-node{border-radius:50%;display:flex;align-items:center;justify-content:center;',
  'color:#eaf0f8;--art-opacity:.92;',
  'background:radial-gradient(circle at 35% 28%,',
  'color-mix(in oklab,var(--mod) 34%,#0b1220) 0%,#0b1220 76%);',
  'box-shadow:',
  'inset 0 1px 1px rgba(255,255,255,.18),',
  '0 0 0 1.5px color-mix(in oklab,var(--mod) 62%,transparent),',
  '0 0 15px color-mix(in oklab,var(--mod) 34%,transparent),',
  '0 4px 12px rgba(0,0,0,.55);}',
  // Light glyph (overrides .oge-art's --rim tint) so it reads on the dome.
  '.oge-node .oge-art{color:inherit;}',

  // ── Tap ripple (rim-coloured wave from the touch point) ─────────────────
  '.oge-deco-layer{position:absolute;inset:0;border-radius:50%;',
  'overflow:hidden;pointer-events:none;z-index:1;}',
  '.oge-ripple{position:absolute;border-radius:50%;',
  'background:radial-gradient(circle,',
  'color-mix(in oklab,var(--rim) 55%,#fff) 0%,',
  'color-mix(in oklab,var(--rim) 30%,transparent) 55%,transparent 70%);',
  'transform:translate(-50%,-50%) scale(0);',
  'animation:oge-ripple-kf .5s ease-out forwards;}',
  '@keyframes oge-ripple-kf{',
  'from{transform:translate(-50%,-50%) scale(0);opacity:.85;}',
  'to{transform:translate(-50%,-50%) scale(1);opacity:0;}}',

  // ── Hover / active states ────────────────────────────────────────────────
  '.oge-host:hover{transform:translateY(-1px);',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.09),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 92%,transparent),',
  'inset 0 0 10px -1px color-mix(in oklab,var(--rim) 55%,transparent),',
  '0 0 calc(30px * var(--glow)) -4px var(--rim),',
  '0 22px 40px -12px rgba(0,0,0,.74),',
  '0 4px 12px -2px rgba(0,0,0,.5);}',
  '.oge-host:active{transform:scale(.975);}',
  '.oge-tap-active{filter:brightness(1.08);}',

  // ── Hold-to-confirm ring charge animation ────────────────────────────────
  // --charge (0→1) is set by JS; drives scale, glow intensity and arc fill.
  '.oge-host.oge-charging{',
  'transform:scale(calc(1 + .045*var(--charge,0)));',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.1),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) calc(82% + 13%*var(--charge,0)),transparent),',
  'inset 0 0 calc(8px + 6px*var(--charge,0)) -1px color-mix(in oklab,var(--rim) 52%,transparent),',
  '0 0 calc(22px + 30px*var(--charge,0)) -6px var(--rim),',
  '0 18px 36px -12px rgba(0,0,0,.72),0 4px 12px -2px rgba(0,0,0,.5);}',
  '.oge-host.oge-fired{animation:oge-fire .45s ease-out;}',
  '@keyframes oge-fire{',
  '0%{filter:brightness(1.6);transform:scale(1.07);}',
  '100%{filter:none;transform:scale(1);}}',

  // ── Focus ring (keyboard a11y) ───────────────────────────────────────────
  '.oge-host:focus-visible,.oge-host .zone:focus-visible{',
  'outline:3px solid color-mix(in oklab,var(--rim) 85%,#fff);outline-offset:3px;}',
  '.oge-host:focus:not(:focus-visible),.oge-host .zone:focus:not(:focus-visible){outline:none;}',

  // ── State flag animations (error pulsates faster, wait slower) ───────────
  '.oge-host[data-flag~="error"]{animation:oge-alert 1.6s ease-in-out infinite;}',
  '.oge-host[data-flag~="wait"]{animation:oge-alert 2.4s ease-in-out infinite;}',
  '@keyframes oge-alert{',
  '0%,100%{box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.07),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 78%,transparent),',
  'inset 0 0 8px -1px color-mix(in oklab,var(--rim) 48%,transparent),',
  '0 0 22px -8px var(--rim),0 18px 36px -12px rgba(0,0,0,.72),0 4px 12px -2px rgba(0,0,0,.5);}',
  '50%{box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.1),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 95%,transparent),',
  'inset 0 0 11px -1px color-mix(in oklab,var(--rim) 58%,transparent),',
  '0 0 34px -2px var(--rim),0 18px 36px -12px rgba(0,0,0,.72),0 4px 12px -2px rgba(0,0,0,.5);}}',

  // ── Disabled ─────────────────────────────────────────────────────────────
  // Greys ONLY the fill + label (the .zone / .oge-surface layer), leaving the
  // rim, ring and brand lens at full strength — same treatment the busy dim
  // uses, so a disabled button reads consistently for 1- and 2-zone. Taps are
  // also swallowed in JS (the click handler checks the disabled flag); the
  // pointer-events guard is the belt-and-braces for split halves in a real
  // browser.
  '.oge-host[aria-disabled="true"]{cursor:not-allowed;animation:none;}',
  '.oge-host[aria-disabled="true"] .zone,',
  '.oge-host[aria-disabled="true"] .oge-surface{opacity:.5;}',
  '.oge-host[aria-disabled="true"] .zone{pointer-events:none;}',

  // ── Reduced motion ────────────────────────────────────────────────────────
  '@media (prefers-reduced-motion:reduce){',
  '.oge-host,.oge-host .zone,.oge-ring-progress{transition:none;}',
  '.oge-ripple{display:none;}',
  '.oge-host[data-flag]{animation:none;}',
  '.oge-host.oge-charging{transform:none;}',
  '.oge-host.oge-fired{animation:none;}}',
].join('');

/**
 * Inject the shared button chrome stylesheet exactly once. Idempotent.
 *
 * @returns {void}
 */
export const installButtonChrome = () => {
  if (document.getElementById(CHROME_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CHROME_STYLE_ID;
  style.textContent = BUTTON_CHROME_CSS;
  (document.head || document.documentElement).appendChild(style);
};

/**
 * Build the SVG ring overlay carrying `title` engraved along its top arc.
 * viewBox is a fixed 100×100 grid so it scales with the button without a
 * resize handler. The title font-size shrinks for longer titles so it
 * always fits the arc.
 *
 * @param {string} title
 * @param {string} ringId  unique id for the arc <path> this svg references.
 * @param {number | null} [progress]  0..1 initial fill of the progress arc (omit = starts empty).
 * @returns {SVGSVGElement}
 */
const buildRing = (title, ringId, progress = null) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'oge-ring');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');

  // The ring band itself (the "obwódka" the title is engraved on).
  const band = document.createElementNS(SVG_NS, 'circle');
  band.setAttribute('class', 'oge-ring-band');
  band.setAttribute('cx', '50');
  band.setAttribute('cy', '50');
  // r=46.5 with stroke 6 ⇒ band spans ~43..50: outer edge meets the rim.
  band.setAttribute('r', '46.5');
  svg.appendChild(band);

  // Hold-to-confirm charge arc: starts hidden (dashoffset=100), animated by JS.
  const charge = document.createElementNS(SVG_NS, 'circle');
  charge.setAttribute('class', 'oge-ring-charge');
  charge.setAttribute('cx', '50'); charge.setAttribute('cy', '50'); charge.setAttribute('r', '46.5');
  charge.setAttribute('pathLength', '100');
  charge.setAttribute('stroke-dasharray', '100');
  charge.setAttribute('stroke-dashoffset', '100');
  charge.setAttribute('transform', 'rotate(-90 50 50)');
  svg.appendChild(charge);

  // Countdown progress arc (e.g. "Wait Xs" min-gap state). Always present
  // so callers can drive it at any time via setProgress(); starts at
  // dashoffset=100 (invisible / empty). stroke-dashoffset encodes the fill:
  // 100 = empty, 0 = full circle.
  const prog = document.createElementNS(SVG_NS, 'circle');
  prog.setAttribute('class', 'oge-ring-progress');
  prog.setAttribute('cx', '50'); prog.setAttribute('cy', '50'); prog.setAttribute('r', '46.5');
  prog.setAttribute('pathLength', '100');
  prog.setAttribute('stroke-dasharray', '100');
  prog.setAttribute('stroke-dashoffset',
    progress != null ? String(100 - Math.max(0, Math.min(1, progress)) * 100) : '100');
  // Reveal only when there's an actual initial fill (CSS hides it by default
  // so the round cap doesn't leave a stray dot while empty — see styles).
  if (progress != null && progress > 0) prog.style.visibility = 'visible';
  prog.setAttribute('transform', 'rotate(-90 50 50)');
  svg.appendChild(prog);

  // Invisible arc the title rides on, at the band's own radius (r=46.5).
  // From the LEFT point over the TOP to the RIGHT point: with these two
  // endpoints (both at y=50) sweep-flag 1 is the upper semicircle, so the
  // title sits across the TOP of the ring (sweep-flag 0 would drop it to
  // the bottom). Combined with dominant-baseline:central below the glyphs
  // are centred ON the band, upright, reading left→right.
  // Title arc at r=46.5 — toward the band's outer half, nudged 1 unit in.
  const defs = document.createElementNS(SVG_NS, 'defs');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('id', ringId);
  path.setAttribute('fill', 'none');
  path.setAttribute('d', 'M 3.5 50 A 46.5 46.5 0 0 1 96.5 50');
  defs.appendChild(path);
  svg.appendChild(defs);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', 'oge-ring-title');
  text.setAttribute('text-anchor', 'middle');
  // Centre the glyphs on the path so they sit on the band, not beside it.
  text.setAttribute('dominant-baseline', 'central');
  const upper = title.toUpperCase();
  // Cap at 7 (then 2 smaller) so longer titles fit fully inside the rim.
  const fontSize = Math.max(3.5, Math.min(7, 92 / (upper.length * 0.72)) - 2);
  text.setAttribute('font-size', fontSize.toFixed(2));
  text.setAttribute('letter-spacing', (fontSize * 0.08).toFixed(2));

  const textPath = document.createElementNS(SVG_NS, 'textPath');
  textPath.setAttribute('href', '#' + ringId);
  // Older engines only honour xlink:href.
  textPath.setAttributeNS(XLINK_NS, 'xlink:href', '#' + ringId);
  textPath.setAttribute('startOffset', '50%');
  textPath.textContent = upper;
  text.appendChild(textPath);
  svg.appendChild(text);

  // ── Brand label "OG-E" engraved on the LOWER arc ──
  // Same styling as the title, but on the bottom of the ring. To read
  // upright AND left→right at the bottom, the arc must travel left→right
  // THROUGH 6 o'clock — that is sweep-flag 0, the opposite of the title's
  // top arc (sweep-flag 1). So technically the mirror sweep of the title,
  // yet the identical visual reading direction (left→right).
  const brandId = ringId + '-b';
  const bpath = document.createElementNS(SVG_NS, 'path');
  bpath.setAttribute('id', brandId);
  bpath.setAttribute('fill', 'none');
  bpath.setAttribute('d', 'M 3.5 50 A 46.5 46.5 0 0 0 96.5 50');
  defs.appendChild(bpath);

  const brand = document.createElementNS(SVG_NS, 'text');
  brand.setAttribute('class', 'oge-ring-brand');
  brand.setAttribute('text-anchor', 'middle');
  brand.setAttribute('dominant-baseline', 'central');
  brand.setAttribute('font-size', '4');
  brand.setAttribute('letter-spacing', '0.4');
  const brandPath = document.createElementNS(SVG_NS, 'textPath');
  brandPath.setAttribute('href', '#' + brandId);
  brandPath.setAttributeNS(XLINK_NS, 'xlink:href', '#' + brandId);
  brandPath.setAttribute('startOffset', '50%');
  brandPath.textContent = 'OG-E';
  brand.appendChild(brandPath);
  svg.appendChild(brand);

  return svg;
};

/**
 * Append the flat glyph layer to an element (idempotent per element). Shared
 * by the FAB's satellite orbs AND the in-button node oczko (both `.oge-node`
 * — see {@link appendNode}) to paint each module's identity glyph. `inner` is
 * the inner markup of a `0 0 64 64` SVG using `currentColor` so it tints to
 * the element's text colour (`.oge-node` sets a light tint; elsewhere it
 * follows `--rim`). The wrapping `.oge-art` layer parents an SVG; built via
 * innerHTML so the namespaced children parse correctly without per-node
 * createElementNS plumbing.
 *
 * @param {HTMLElement} zone
 * @param {string} inner  inner SVG markup (paths/lines/circles, currentColor).
 * @returns {void}
 */
export const appendGlyph = (zone, inner) => {
  if (!zone || !inner || zone.querySelector(':scope > .oge-art')) return;
  const art = document.createElement('span');
  art.className = 'oge-art';
  art.setAttribute('aria-hidden', 'true');
  art.appendChild(
    parseSvg(
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
        inner +
        '</svg>',
    ),
  );
  zone.appendChild(art);
};

/** Id of the hidden singleton SVG holding the orbit-mark gradients. */
export const ORBIT_DEFS_ID = 'oge-orbit-defs';

/**
 * The OG-E orbit mark (the logo's symbol): three gold arcs with gaps + three
 * beads at the gaps, on a `0 0 300 300` viewBox (ring r=100, centred). Drawn
 * via shared gradient refs (see {@link ensureOrbitDefs}). Overlaid on the
 * lens as its frame — the beads land on the dome's rim.
 */
const ORBIT_MARK =
  '<svg class="oge-lens-orbit" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">' +
  '<g fill="none" stroke="url(#oge-orbit-arc)" stroke-width="9" stroke-linecap="round">' +
  '<path d="M 170.79 52.19 A 100 100 0 0 1 245.11 180.90"/>' +
  '<path d="M 224.31 216.91 A 100 100 0 0 1 75.69 216.91"/>' +
  '<path d="M 54.89 180.90 A 100 100 0 0 1 129.21 52.19"/>' +
  '</g>' +
  '<g fill="url(#oge-orbit-ball)" stroke="rgba(60,30,8,.5)" stroke-width="1.5">' +
  '<circle cx="150" cy="50" r="15"/>' +
  '<circle cx="236.60" cy="200" r="15"/>' +
  '<circle cx="63.40" cy="200" r="15"/>' +
  '</g></svg>';

/**
 * Inject the singleton SVG carrying the orbit-mark gradients (idempotent).
 * The mark references them by id (`url(#oge-orbit-*)`), so they must exist
 * once in the document. Built via innerHTML on a hidden holder (the same
 * inline-SVG-through-HTML-parser path the glyph layers use).
 *
 * @returns {void}
 */
export const ensureOrbitDefs = () => {
  if (typeof document === 'undefined' || document.getElementById(ORBIT_DEFS_ID)) return;
  const holder = document.createElement('div');
  holder.id = ORBIT_DEFS_ID;
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
  holder.appendChild(
    parseSvg(
      '<svg width="0" height="0" xmlns="http://www.w3.org/2000/svg" focusable="false"><defs>' +
        '<linearGradient id="oge-orbit-arc" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#E8A23D"/>' +
        '<stop offset="50%" stop-color="#C77B2B"/>' +
        '<stop offset="100%" stop-color="#9C5A1E"/>' +
        '</linearGradient>' +
        '<radialGradient id="oge-orbit-ball" cx="35%" cy="30%" r="75%">' +
        '<stop offset="0%" stop-color="#F4C66B"/>' +
        '<stop offset="55%" stop-color="#D08A33"/>' +
        '<stop offset="100%" stop-color="#8F4F1B"/>' +
        '</radialGradient>' +
        '</defs></svg>',
    ),
  );
  document.body.appendChild(holder);
};

/**
 * Append the brand NODE (the "oczko") to a command button host (idempotent
 * per host): the SAME module-coloured dome the FAB's satellite orbs wear (see
 * the `.oge-node` rules — both render `appendGlyph`'s `.oge-art` layer on a
 * `--mod`-tinted dome). The `.oge-lens` class parks it in the upper section on
 * a single-zone host and centred on the seam on a split host; the module
 * colour rides `--mod`, set on the host by `createButton`. `inner` is the inner
 * markup of a `0 0 64 64` SVG using `currentColor` (the light node glyph tint).
 *
 * @param {HTMLElement} host  Stable outer element (the button or split wrap).
 * @param {string} inner      Inner SVG markup (paths/lines/circles, currentColor).
 * @returns {void}
 */
export const appendNode = (host, inner) => {
  if (!host || !inner || host.querySelector('.oge-lens')) return;
  const node = document.createElement('span');
  node.className = 'oge-lens oge-node';
  node.setAttribute('aria-hidden', 'true');
  appendGlyph(node, inner);
  host.appendChild(node);
};

/**
 * Append the GOLD glass lens to a host (idempotent per host): a gold glass
 * cabochon carrying `inner`'s glyph, framed by the OG-E orbit mark (three gold
 * arcs + three beads). No longer used by the command buttons (they wear
 * `.oge-node` via {@link appendNode}); kept for OG-E's own UI accents — e.g.
 * the settings "Open Dashboard" button. The `.oge-lens` rules size it inside a
 * command button; standalone callers set size/position inline. `inner` is the
 * inner markup of a `0 0 64 64` SVG using `currentColor` (the gold glyph tint).
 *
 * @param {HTMLElement} host  Stable outer element (the button or split wrap).
 * @param {string} inner      Inner SVG markup (paths/lines/circles, currentColor).
 * @returns {void}
 */
export const appendLens = (host, inner) => {
  if (!host || !inner || host.querySelector('.oge-lens')) return;
  ensureOrbitDefs();
  const lens = document.createElement('span');
  lens.className = 'oge-lens';
  lens.setAttribute('aria-hidden', 'true');
  lens.appendChild(
    parseSvg(
      '<svg class="oge-lens-glyph" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
        inner +
        '</svg>',
    ),
  );
  lens.appendChild(parseSvg(ORBIT_MARK));
  host.appendChild(lens);
};

/**
 * Spawn a single ripple at the pointer location inside `layer` (which is
 * clipped to the circle). Removed on animation end, with a timed fallback
 * for environments where `animationend` never fires.
 *
 * @param {HTMLElement} layer
 * @param {HTMLElement} host
 * @param {number} clientX
 * @param {number} clientY
 * @returns {void}
 */
const spawnRipple = (layer, host, clientX, clientY) => {
  const r = host.getBoundingClientRect();
  const diameter = Math.max(r.width, r.height) * 1.5 || 80;
  const ripple = document.createElement('span');
  ripple.className = 'oge-ripple';
  ripple.style.width = diameter + 'px';
  ripple.style.height = diameter + 'px';
  ripple.style.left = clientX - r.left + 'px';
  ripple.style.top = clientY - r.top + 'px';
  layer.appendChild(ripple);
  const done = () => ripple.remove();
  ripple.addEventListener('animationend', done);
  setTimeout(done, 800);
};

/**
 * Wire press + ripple feedback onto one clickable zone. Press is a CSS
 * class toggled on pointer down/up; the ripple originates at the exact
 * touch point so a tap on one half of a split button visibly starts
 * there. Purely additive — does not interfere with the host's drag wiring
 * (which listens on the outer element) or dailyRun's long-press timer.
 *
 * @param {HTMLElement} zone
 * @param {HTMLElement} host
 * @param {HTMLElement} layer
 * @returns {void}
 */
const wireZoneTap = (zone, host, layer) => {
  const release = () => zone.classList.remove('oge-tap-active');
  // Prevent the browser from giving focus to the <button> on tap/click.
  // mousedown.preventDefault() blocks focus without suppressing the click event.
  zone.addEventListener('mousedown', (e) => e.preventDefault());
  zone.addEventListener('pointerdown', (e) => {
    zone.classList.add('oge-tap-active');
    spawnRipple(layer, host, e.clientX, e.clientY);
  });
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointerleave', release);
  zone.addEventListener('pointercancel', release);
};

/**
 * Decorate a floating button with the engraved title ring and the tap
 * ripple/press effect, and ensure the shared stylesheet is present.
 * Idempotent per host: a second call is a no-op once decorated.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host   Stable outer element (wrap, or the button itself).
 * @param {HTMLElement[]} opts.zones  Clickable zones to wire (1 or 2).
 * @param {string} opts.title  Human title, engraved uppercase on the ring.
 * @param {string} opts.ringId  Unique id for this button's arc path.
 * @param {number} [opts.progress]  0..1 initial fill of the progress arc (omit = hidden).
 * @returns {void}
 */
export const decorateButton = ({ host, zones, title, ringId, progress }) => {
  if (!host || host.querySelector('.oge-deco-layer')) return;
  installButtonChrome();

  const layer = document.createElement('span');
  layer.className = 'oge-deco-layer';
  host.appendChild(layer);

  host.appendChild(buildRing(title, ringId, progress ?? null));

  for (const zone of zones) wireZoneTap(zone, host, layer);
};
