// Shared "OGame-native" visual chrome for the three floating draggable
// buttons: sendExp (`#oge-send-exp`), sendCol (`#oge-send-col`) and
// fsCollect (`#oge-fs-unified`).
//
// Two things live here:
//
//   1. installButtonChrome() — injects ONE `<style id="oge-btn-chrome">`
//      (idempotent) with the rules every button shares: an inset edge
//      vignette + top sheen drawn via `::after`, the engraved title-ring
//      styling, the tap-ripple keyframes and the per-zone press feedback.
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
// sendExp paints its label into a dedicated `.oge-exp-label` span rather
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

/** Id of the singleton <style> element this module injects. */
export const CHROME_STYLE_ID = 'oge-btn-chrome';

/** SVG namespace for the engraved title ring. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * The OGame-style decorative CSS shared by all three floating buttons.
 * Exported as a pure string so a test can assert it targets the three
 * button ids and carries the overlay / ring / ripple / press rules.
 */
export const BUTTON_CHROME_CSS = [
  // ── Edge vignette + glassy top sheen (drawn on top of the colours) ──
  // pointer-events:none so taps fall through; clipped to the circle by
  // the host's own border-radius (+ overflow on the split buttons).
  '#oge-send-exp::after,#oge-send-col::after,#oge-fs-unified::after{',
  'content:"";position:absolute;inset:0;border-radius:50%;',
  'pointer-events:none;z-index:2;',
  'box-shadow:',
  'inset 0 0 18px 4px rgba(0,0,0,0.55),', // edge vignette ("załamanie")
  'inset 0 2px 4px rgba(255,255,255,0.20);', // top bevel highlight
  'background:radial-gradient(circle at 50% 26%,',
  'rgba(255,255,255,0.16),rgba(255,255,255,0) 58%);', // glassy sheen
  '}',

  // ── Engraved title ring (SVG overlay, scales via viewBox) ──
  '.oge-ring{position:absolute;inset:0;width:100%;height:100%;',
  'pointer-events:none;z-index:3;overflow:visible;}',
  '.oge-ring-band{fill:none;stroke:rgba(214,232,250,0.22);stroke-width:9;}',
  '.oge-ring-title{fill:rgba(8,16,26,0.72);font-weight:700;',
  'font-family:Verdana,Geneva,Tahoma,sans-serif;text-transform:uppercase;',
  // Engraved-into-the-ring look: dark glyphs with a thin light highlight
  // below, so the title reads as cut into the band rather than floating.
  'filter:drop-shadow(0 0.5px 0.4px rgba(255,255,255,0.45));}',

  // ── Tap ripple (light wave from the touch point) ──
  '.oge-deco-layer{position:absolute;inset:0;border-radius:50%;',
  'overflow:hidden;pointer-events:none;z-index:1;}',
  '.oge-ripple{position:absolute;border-radius:50%;',
  'background:radial-gradient(circle,rgba(255,255,255,0.45),',
  'rgba(255,255,255,0.12) 60%,rgba(255,255,255,0) 70%);',
  'transform:translate(-50%,-50%) scale(0);',
  'animation:oge-ripple-kf 0.5s ease-out forwards;}',
  '@keyframes oge-ripple-kf{',
  'from{transform:translate(-50%,-50%) scale(0);opacity:0.9;}',
  'to{transform:translate(-50%,-50%) scale(1);opacity:0;}}',

  // ── Per-zone press feedback ──
  // No inline `filter` exists anywhere, so this always wins (unlike
  // box-shadow, which sendExp pins inline). A quick brighten reads as the
  // glassy face lighting up under the finger.
  '#oge-send-exp,#oge-send-col button,#oge-fs-unified button{',
  'transition:filter 0.12s ease;}',
  '.oge-tap-active{filter:brightness(1.18) saturate(1.08);}',

  // ── Suppress the permanent native focus ring ──
  // The buttons auto-restore focus on load (see draggableButton.js), so a
  // native outline would otherwise sit forever on one of them.
  '#oge-send-exp:focus,#oge-send-col button:focus,#oge-fs-unified button:focus',
  '{outline:none;}',
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
 * @returns {SVGSVGElement}
 */
const buildRing = (title, ringId) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'oge-ring');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');

  // The ring band itself (the thick "obwódka" the title is engraved on).
  const band = document.createElementNS(SVG_NS, 'circle');
  band.setAttribute('class', 'oge-ring-band');
  band.setAttribute('cx', '50');
  band.setAttribute('cy', '50');
  band.setAttribute('r', '45');
  svg.appendChild(band);

  // Invisible top-arc path the title rides on. Baseline at r=42 so the
  // glyphs (which extend OUTWARD from the baseline) sit centred on the
  // r=45 band rather than on the button face. sweep-flag 0 keeps the arc
  // on the TOP half so glyphs stay upright, reading left→right.
  const defs = document.createElementNS(SVG_NS, 'defs');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('id', ringId);
  path.setAttribute('fill', 'none');
  path.setAttribute('d', 'M 8 50 A 42 42 0 0 0 92 50');
  defs.appendChild(path);
  svg.appendChild(defs);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', 'oge-ring-title');
  text.setAttribute('text-anchor', 'middle');
  const upper = title.toUpperCase();
  const fontSize = Math.max(5, Math.min(9, 92 / (upper.length * 0.72)));
  text.setAttribute('font-size', fontSize.toFixed(2));
  text.setAttribute('letter-spacing', (fontSize * 0.06).toFixed(2));

  const textPath = document.createElementNS(SVG_NS, 'textPath');
  textPath.setAttribute('href', '#' + ringId);
  // Older engines only honour xlink:href.
  textPath.setAttributeNS(XLINK_NS, 'xlink:href', '#' + ringId);
  textPath.setAttribute('startOffset', '50%');
  textPath.textContent = upper;
  text.appendChild(textPath);
  svg.appendChild(text);
  return svg;
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
 * (which listens on the outer element) or fsCollect's long-press timer.
 *
 * @param {HTMLElement} zone
 * @param {HTMLElement} host
 * @param {HTMLElement} layer
 * @returns {void}
 */
const wireZoneTap = (zone, host, layer) => {
  const release = () => zone.classList.remove('oge-tap-active');
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
 * @returns {void}
 */
export const decorateButton = ({ host, zones, title, ringId }) => {
  if (!host || host.querySelector('.oge-deco-layer')) return;
  installButtonChrome();

  const layer = document.createElement('span');
  layer.className = 'oge-deco-layer';
  host.appendChild(layer);

  host.appendChild(buildRing(title, ringId));

  for (const zone of zones) wireZoneTap(zone, host, layer);
};
