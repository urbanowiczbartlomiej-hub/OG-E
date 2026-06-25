// Planet status markers — paint a tiny column of subtle status dots beside each
// `#planetList` body (LEFT of a planet, RIGHT of its moon so the two columns
// never collide), replacing the old single green expedition dot.
//
// # What it shows
//
// At most three small markers per body, one per CATEGORY present, ordered by
// priority (see `./pure.js`):
//
//   🟥 red SQUARE  — incoming attack (a foreign aggressive fleet at me) — danger
//   🔴 red circle  — my own aggression flying out
//   "FS" yellow    — a detected fleet-save in motion (a text tag, not a dot)
//   "FS" orange    — a fleet-save that LANDED and sits exposed (until re-saved/dismissed)
//   💙 blue heart  — my expedition (a small SVG)
//   🟢 green       — my logistics (transport / deploy / ACS defend)
//   🔵 blue        — my recycle
//
// Mine are round (+ a heart for expeditions); the external THREAT is the odd
// square. No counts, no direction arrows, no click target — the marker is a
// glanceable status dot, not a readout (it is far too small to click). A "?"
// icon at the top of the planet list reveals the legend on hover. The whole
// point is to tell, at a glance, that the fleets are well positioned WITHOUT
// burying the planet skins under our own clutter.
//
// # Why this is purely passive
//
// Every byte comes from DOM the game itself renders into `#eventContent` and
// `#planetList`. We never fire our own XHR/fetch — we mirror the game's own
// event ticker onto the planet list. The fleet-save flags come from the
// alarmClock producer via `state/fleetSaveSet.js` (no feature-to-feature import).
// No parallel request stream, no polling the server: just styling.
//
// The classification (which body a leg marks, and as which category) is pure
// and lives in `./pure.js`. This module is the DOM half: it scans
// `#eventContent` + `#planetList`, paints the columns, and owns the observer /
// settings / popover / optimistic-cache lifecycle.
//
// @see ./pure.js — the pure landing-classification core.
// @see ../../state/fleetSaveSet.js — the FS id channel the producer publishes.
// @see ../../state/badgeCache.js — the optimistic pre-XHR paint cache.

/** @ts-check */

import { settingsStore } from '../../state/settings.js';
import { createVisibilityObserver } from '../../lib/visibilityObserver.js';
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { readFleetSaveIds, readLandedFs } from '../../state/fleetSaveSet.js';
import { readManualLandedFs } from '../../state/manualLandedFs.js';
import { readBadgeCache, writeBadgeCache, clearBadgeCache } from '../../state/badgeCache.js';
import { injectStyle, waitFor } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { GAME } from '../../lib/gameDom.js';
import { EXPEDITION_HEART_URI } from '../../lib/markerIcons.js';
import { EVENT_BOX_LOADED_EVENT } from '../../lib/ogeEvents.js';
import { clock } from '../../lib/clock.js';
import { groupMarkers, bodyKey, MARKER_LABEL } from './pure.js';

// ── OG-E-owned ids/classes (NOT a DOM contract — ours to rename freely) ──

const STYLE_ID = 'oge-badges-style';
const HIDE_STYLE_ID = 'oge-badges-hide-style';
/** The vertical marker column appended to each body's pic container. */
const COL_CLASS = 'oge-mb-col';
/** Modifier on a moon's column: anchor it to the RIGHT of the moon, not left. */
const MOON_COL_CLASS = 'oge-mb-col-moon';
/** One status marker inside a column (category class added alongside). */
const DOT_CLASS = 'oge-mb-dot';

const REFRESH_DEBOUNCE_MS = 200;

/**
 * Grace added to a cached snapshot's expiry, covering client/server clock skew
 * (the event list itself ships a `timeDelta`) so a marker is never dropped a
 * hair before its fleet actually lands. Generous on purpose — the only thing it
 * delays is the disappearance of an already-stale optimistic paint.
 */
const CACHE_GRACE_MS = 5 * 60 * 1000;

// ── DOM read helpers (feature layer — pure.js stays DOM-free) ─────────────

/** @param {string | null | undefined} s @returns {string} dense `g:s:p`. */
const denseCoords = (s) => (s || '').replace(/[\s[\]]/g, '');

/** @param {string | null | undefined} text @returns {number} ships, or NaN. */
const shipCountOf = (text) => {
  const digits = (text || '').replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : NaN;
};

/**
 * Body type of an event-row origin/dest cell: a moon carries `figure.moon`,
 * everything else (planet / debris) is treated as planet — only OUR endpoints
 * need an accurate planet-vs-moon split, and ours are never debris.
 *
 * @param {Element | null} cell
 * @returns {number} 1 = planet, 3 = moon.
 */
const figureType = (cell) => {
  const fig = cell?.querySelector('figure');
  return fig && fig.classList.contains('moon') ? 3 : 1;
};

/**
 * Read every fleet leg out of `#eventContent` as plain {@link
 * import('./pure.js').BadgeLeg} data for {@link groupMarkers} to classify.
 *
 * @returns {import('./pure.js').BadgeLeg[]}
 */
const scanLegs = () => {
  /** @type {import('./pure.js').BadgeLeg[]} */
  const legs = [];
  for (const row of document.querySelectorAll(GAME.EVENT_FLEET_ROWS)) {
    const missionType = row.getAttribute('data-mission-type') || '';
    if (!missionType) continue;
    const arrivalAttr = row.getAttribute('data-arrival-time');
    legs.push({
      id: /** @type {HTMLElement} */ (row).id || '',
      missionType,
      isReturn: row.getAttribute('data-return-flight') === 'true',
      isHostile: Boolean(row.querySelector('.hostile')),
      origin: {
        coords: denseCoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent),
        type: figureType(row.querySelector(GAME.ORIGIN_FLEET)),
      },
      dest: {
        coords: denseCoords(row.querySelector(GAME.COORDS_DEST)?.textContent),
        type: figureType(row.querySelector(GAME.DEST_FLEET)),
      },
      arrivalAt: arrivalAttr ? Number.parseInt(arrivalAttr, 10) : NaN,
      shipCount: shipCountOf(row.querySelector(GAME.DETAILS_FLEET)?.textContent),
    });
  }
  return legs;
};

/**
 * @typedef {object} OwnBody
 * @property {string} coords Dense `g:s:p`.
 * @property {number} type   1 = planet, 3 = moon.
 * @property {HTMLElement} container The body's `.planetBarSpaceObjectContainer`.
 */

/**
 * Walk `#planetList` and collect the player's bodies plus the DOM container
 * each marker column attaches to. A planet and its moon live in the same
 * `.smallplanet` row and share coords; the moon entry uses the moon link's own
 * pic container so a moon's markers attach to the moon, not the planet.
 *
 * @returns {OwnBody[]}
 */
const scanOwnBodies = () => {
  /** @type {OwnBody[]} */
  const bodies = [];
  for (const row of document.querySelectorAll(GAME.SMALL_PLANET)) {
    const planetLink = row.querySelector(`a${GAME.PLANET_LINK}`);
    if (!planetLink) continue;
    const coords = denseCoords(planetLink.querySelector(GAME.PLANET_KOORDS)?.textContent);
    if (!coords) continue;
    const planetContainer = planetLink.querySelector('.planetBarSpaceObjectContainer');
    if (planetContainer) {
      bodies.push({ coords, type: 1, container: /** @type {HTMLElement} */ (planetContainer) });
    }
    const moonLink = row.querySelector(GAME.MOON_LINK);
    const moonContainer = moonLink?.querySelector('.planetBarSpaceObjectContainer');
    if (moonContainer) {
      bodies.push({ coords, type: 3, container: /** @type {HTMLElement} */ (moonContainer) });
    }
  }
  return bodies;
};

// ── CSS ──────────────────────────────────────────────────────────────────

const buildCss = () => `
.${COL_CLASS}{
  position:absolute;
  top:50%;
  right:calc(100% + 7px);
  transform:translateY(-50%);
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:3px;
  z-index:30;
}
.${MOON_COL_CLASS}{
  right:auto;
  left:calc(100% - 12px);
}
.${DOT_CLASS}{
  display:inline-block;
  width:7px;
  height:7px;
  box-sizing:border-box;
  border-radius:50%;
  box-shadow:0 0 2px rgba(0,0,0,.9);
}
/* Mine = round dots; the external THREAT is a loud red "!!!" glyph — the
   noisiest marker, for the highest-priority category (text, not a filled dot). */
.oge-mb-threat{
  width:auto;height:auto;
  background:none;box-shadow:none;border-radius:0;
  color:#e24b4a;font:700 10px/1 Verdana,sans-serif;letter-spacing:-1px;
  text-shadow:0 0 2px #000,0 0 1px #000;
}
.oge-mb-aggro{background:#e24b4a;}
.oge-mb-logistics{background:#4caf6a;}
.oge-mb-economy{background:#3d7fd0;}
/* "FS" text tag (a glyph, not a filled dot). */
.oge-mb-fs{
  width:auto;height:auto;
  background:none;box-shadow:none;border-radius:0;
  color:#f0c23c;font:700 8px/1 Verdana,sans-serif;letter-spacing:-.5px;
  text-shadow:0 0 2px #000,0 0 1px #000;
}
/* Landed fleet-save: the "FR" (Fleet reminder) tag, bright orange = sitting
   exposed after touchdown. It PULSES harder than an in-motion FS — faster
   breath, a deeper opacity dip, a stronger orange glow, and a hair larger — a
   landed fleet is the dangerous state the guardian watches, so it should grab
   the eye, not just sit there. Colour stays orange (red is reserved for
   threat/aggro). In-motion (yellow) FS stays static. */
.oge-mb-fs.landed{
  color:#ff8c1a;
  font-size:9px;
  animation:oge-fs-pulse 1.05s ease-in-out infinite;
}
@keyframes oge-fs-pulse{
  0%,100%{opacity:1;text-shadow:0 0 2px #000,0 0 1px #000;}
  50%{opacity:.3;text-shadow:0 0 6px #ff8c1a,0 0 3px #ff8c1a,0 0 2px #000;}
}
/* Honour the OS "reduce motion" preference — fall back to the static tag. */
@media (prefers-reduced-motion:reduce){
  .oge-mb-fs.landed{animation:none;}
}
/* Expedition — a small blue heart (the expeditor's own badge), inline SVG so
   it stays crisp at any size. */
.oge-mb-explore{
  width:10px;height:10px;
  border-radius:0;box-shadow:none;
  background:url("${EXPEDITION_HEART_URI}") center/contain no-repeat;
  filter:drop-shadow(0 0 1px rgba(0,0,0,.9));
}
/* "?" help chip overlapping the top of the planet list → hover reveals the
   legend. PORTALED to <body> (position:fixed, JS sets top/left from the planet
   list's rect) for the SAME reason as the legend: a child of #planetList is
   trapped in that subtree's stacking context and gets painted UNDER OGame's
   left-column components (a sibling context no z-index can cross) — which is why
   it was "sometimes covered". As a <body> child it sits in the root context and
   reliably wins. Sits just below the legend's z so the open panel is never
   covered by its own chip. */
.oge-mb-help{
  /* absolute (NOT fixed) + DOCUMENT coords: the chip then scrolls with the page
     natively, so it can't lag a frame behind the scroll the way a JS-tracked
     fixed element does (that was the "jumping"). Still a <body> child, so it
     stays in the root stacking context and isn't trapped under #planetList. */
  position:absolute;top:0;left:0;
  display:flex;align-items:center;justify-content:center;
  width:14px;height:14px;
  border-radius:50%;
  background:#142230;color:#9fc0d6;
  border:1px solid #2c5470;
  font:700 10px/1 Verdana,sans-serif;
  cursor:help;
  z-index:2147482000;
  /* The chip's nudge from the planet-list corner. JS pins top/left to the list's
     top-RIGHT corner (and tracks scroll), but NEVER touches transform — so THIS
     line is the one knob to tweak: edit it live in DevTools, then tell me the
     values. The chip's own box is offset from the corner here: -100% X pulls its
     whole width back inside the right edge; the px values nudge it (more-negative
     X = further left, more-negative Y = further up). */
  transform:translate(calc(-100% + 8px),-10px);
}
.oge-mb-legend{
  display:none;
  /* Portaled to <body> and positioned in VIEWPORT coords (JS sets top/left on
     show). As a <body> child it lives in the ROOT stacking context, so this
     z-index actually wins — inside #planetList even z-index:99999 still painted
     UNDER OGame's left column (a sibling stacking context the value can't reach
     across). Show/hide is JS-driven (see the legend-portal section), not :hover,
     because the panel is no longer a descendant of the chip. */
  position:fixed;top:0;left:0;
  /* Deliberately just BELOW the 32-bit max (2147483647): high enough to clear
     all normal game chrome (left column, resource bar, menus, chat), but it
     still yields to a genuine OGame system overlay (cookie/consent layer, modal
     dialog) — this is only a minor hover popover and must not cover a blocking
     dialog. */
  z-index:2147483000;
  width:max-content;max-width:280px;
  background:#0d1a24;border:1px solid #2c5470;border-radius:6px;
  padding:9px 11px;
  color:#cfe6f5;font:11px/1.5 Verdana,sans-serif;
  box-shadow:0 2px 12px rgba(0,0,0,.65);
  text-align:left;
}
.oge-mb-legend .lt{font-weight:700;color:#fff;margin:0 0 7px;}
/* Rows wrap (no nowrap): a long label — especially once translated — flows onto
   a second line inside the box instead of overflowing it; the swatch keeps to
   the first line. */
.oge-mb-legend-row{display:flex;align-items:flex-start;gap:9px;margin:4px 0;}
.oge-mb-legend-row .sw{flex:0 0 18px;display:flex;align-items:center;justify-content:center;}
.oge-mb-legend-row .lbl{min-width:0;white-space:normal;}
.oge-mb-legend .note{margin-top:7px;color:#9fb8c9;white-space:normal;}
`;

const HIDE_CSS = `.${COL_CLASS},.oge-mb-help,.oge-mb-legend{display:none!important;}`;

// ── Legend ("?" help chip) ───────────────────────────────────────────────

/**
 * Legend rows — each renders the REAL marker visual (same classes as the live
 * markers) next to its meaning, so the key always matches what's on screen.
 *
 * @type {{ category: string, landed?: boolean, label: string }[]}
 */
const LEGEND_ROWS = [
  { category: 'threat', label: 'Incoming attack (foreign fleet at you)' },
  { category: 'fs', label: 'Fleet-save — in motion (safe)' },
  { category: 'fs', landed: true, label: 'Fleet reminder — landed fleet' },
  { category: 'aggro', label: 'Your attack / spy on a player' },
  { category: 'explore', label: 'Your expedition' },
  { category: 'logistics', label: 'Logistics (transport / deploy / defend)' },
  { category: 'economy', label: 'Recycle' },
];

/** @returns {HTMLElement} The legend panel (child of the "?" chip). */
const buildLegend = () => {
  const panel = document.createElement('div');
  panel.className = 'oge-mb-legend';
  const title = document.createElement('div');
  title.className = 'lt';
  title.textContent = 'Planet markers';
  panel.appendChild(title);
  for (const row of LEGEND_ROWS) {
    const r = document.createElement('div');
    r.className = 'oge-mb-legend-row';
    const sw = document.createElement('span');
    sw.className = 'sw';
    const mk = document.createElement('span');
    mk.className = `${DOT_CLASS} oge-mb-${row.category}${row.landed ? ' landed' : ''}`;
    if (row.category === 'fs') mk.textContent = row.landed ? 'FR' : 'FS';
    else if (row.category === 'threat') mk.textContent = '!!!';
    sw.appendChild(mk);
    const lb = document.createElement('span');
    lb.className = 'lbl';
    lb.textContent = row.label;
    r.append(sw, lb);
    panel.appendChild(r);
  }
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent =
    'Shown where each fleet lands; max 3 per body, by priority. The red "!!!" flags an incoming attack; the rest are your own fleets.';
  panel.appendChild(note);
  return panel;
};

// ── Legend portal (singleton) ──────────────────────────────────────────────
//
// The legend lives at <body> level, NOT inside the "?" chip. A child of
// #planetList can't escape that subtree's stacking context, so its z-index —
// however high — still rendered UNDERNEATH OGame's left-column components when
// the panel flipped left to overlap them. As a <body> child positioned in
// viewport coords it sits in the root stacking context and reliably paints on
// top. One reused element (there is only ever one #planetList ⇒ one chip),
// shown on chip hover/focus and torn down on dispose.

/** @type {HTMLElement | null} */
let legendEl = null;
/** The "?" chip — a body-portaled singleton (see {@link ensureHelpChip}). */
/** @type {HTMLElement | null} */
let helpEl = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let legendHideTimer = null;

const cancelLegendHide = () => {
  if (legendHideTimer) { clearTimeout(legendHideTimer); legendHideTimer = null; }
};

/** Hide the legend immediately. */
const hideLegend = () => {
  cancelLegendHide();
  if (legendEl) legendEl.style.display = 'none';
};

/** Hide after a short grace period, so the pointer can cross the gap from the
 *  chip onto the panel without it vanishing mid-move. */
const scheduleLegendHide = () => {
  cancelLegendHide();
  legendHideTimer = setTimeout(hideLegend, 160);
};

/** Build the legend once and ensure it's attached to <body>. */
const ensureLegendEl = () => {
  if (!legendEl) {
    legendEl = buildLegend();
    // Keep it open while the pointer is over the panel itself.
    legendEl.addEventListener('mouseenter', cancelLegendHide);
    legendEl.addEventListener('mouseleave', scheduleLegendHide);
  }
  if (legendEl.parentNode !== document.body) document.body.appendChild(legendEl);
  return legendEl;
};

/** Remove the portaled legend from the page (dispose / teardown). */
const removeLegendEl = () => {
  cancelLegendHide();
  legendEl?.remove();
  legendEl = null;
};

/**
 * Show the legend beside `chip`: to its RIGHT when it fits, else flipped LEFT,
 * always clamped inside the viewport. Coords are viewport-relative because the
 * panel is `position:fixed` on <body>.
 *
 * @param {HTMLElement} chip
 * @returns {void}
 */
const showLegendFor = (chip) => {
  const el = ensureLegendEl();
  cancelLegendHide();
  el.style.display = 'block';
  const r = chip.getBoundingClientRect();
  const GAP = 8;
  const MARGIN = 4;
  const lw = el.offsetWidth;
  const lh = el.offsetHeight;
  // Horizontal: prefer the right of the chip; flip left when the panel would
  // overflow the right edge; if neither side fits (tiny viewport) pin to the
  // right margin.
  let left = r.right + GAP;
  if (left + lw > window.innerWidth - MARGIN) {
    const leftSide = r.left - GAP - lw;
    left = leftSide >= MARGIN ? leftSide : Math.max(MARGIN, window.innerWidth - MARGIN - lw);
  }
  // Vertical: align near the chip top, clamped so a tall panel stays on-screen.
  let top = Math.min(r.top - 4, window.innerHeight - MARGIN - lh);
  if (top < MARGIN) top = MARGIN;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
};

/**
 * Build the "?" chip once and ensure it's attached to <body>. Like the legend,
 * it's portaled out of `#planetList` so OGame's left column can't paint over it
 * (a child of the list is trapped in that subtree's stacking context). It is a
 * singleton — there is only ever one planet list — and SURVIVES OGame's AJAX
 * swaps of the list (it isn't a child of it), so it's created once, not re-added
 * per swap. Hover/focus reveals the legend; there is no click target, the
 * markers themselves being too small to hit.
 *
 * @returns {void}
 */
const ensureHelpChip = () => {
  if (helpEl) {
    if (helpEl.parentNode !== document.body) document.body.appendChild(helpEl);
    return;
  }
  const help = document.createElement('div');
  help.className = 'oge-mb-help';
  help.textContent = '?';
  help.tabIndex = 0;
  help.setAttribute('aria-label', 'Planet markers legend');
  // Start hidden so it can't flash at (0,0) for a frame before the first
  // positionHelpChip() places it.
  help.style.display = 'none';
  help.addEventListener('mouseenter', () => showLegendFor(help));
  help.addEventListener('focusin', () => showLegendFor(help));
  help.addEventListener('mouseleave', scheduleLegendHide);
  help.addEventListener('focusout', scheduleLegendHide);
  document.body.appendChild(help);
  helpEl = help;
};

/**
 * Place the body-portaled chip over the planet list's top-right corner, in
 * DOCUMENT coords (so the absolute chip scrolls with the page). Hidden when
 * there's no visible planet list (other pages, or the list collapsed). Cheap —
 * call it on every render and on scroll/resize so it tracks the list.
 *
 * @returns {void}
 */
const positionHelpChip = () => {
  if (!helpEl) return;
  const list = document.getElementById('planetList');
  const r = list?.getBoundingClientRect();
  if (!r || (r.width === 0 && r.height === 0)) { helpEl.style.display = 'none'; return; }
  // Anchor to the list's top-RIGHT corner in DOCUMENT coords (rect is viewport →
  // add the scroll offset). Because the chip is position:absolute, this value is
  // invariant under page scroll — recomputing on scroll yields the SAME number,
  // so the chip glides with the page instead of jumping. The visual nudge lives
  // in CSS (`.oge-mb-help { transform }`), which JS NEVER writes — so it's the
  // one knob safe to tune in DevTools. We write each style only when it actually
  // changes, so a stable chip isn't churned on every render/poll tick.
  const left = `${Math.round(r.right + window.scrollX)}px`;
  const top = `${Math.round(r.top + window.scrollY)}px`;
  if (helpEl.style.display !== 'flex') helpEl.style.display = 'flex';
  if (helpEl.style.left !== left) helpEl.style.left = left;
  if (helpEl.style.top !== top) helpEl.style.top = top;
};

/** Remove the portaled chip from the page (dispose / teardown). */
const removeHelpEl = () => { helpEl?.remove(); helpEl = null; };

// ── Render ─────────────────────────────────────────────────────────────────

const clearColumns = () => {
  document.querySelectorAll(`.${COL_CLASS}`).forEach((el) => el.remove());
};

/**
 * @param {import('./pure.js').Marker} m
 * @returns {HTMLElement}
 */
const buildMarker = (m) => {
  const el = document.createElement('span');
  el.className = `${DOT_CLASS} oge-mb-${m.category}${m.landed ? ' landed' : ''}`;
  // explore renders via a CSS background SVG (a heart); the FS + threat tags are
  // text ("FS" / "!!!"), everything else a filled dot.
  if (m.category === 'fs') el.textContent = m.landed ? 'FR' : 'FS';
  else if (m.category === 'threat') el.textContent = '!!!';
  el.title = m.landed
    ? 'Fleet reminder · landed fleet (exposed)'
    : MARKER_LABEL[m.category] || 'Fleet';
  return el;
};

/**
 * Flipped true once OGame's event-list XHR has populated `#eventContent` (the
 * `oge:eventBoxLoaded` bridge signal). Until then a render with no legs is
 * AMBIGUOUS — "no activity" vs "data not here yet" — so we must not let an
 * empty live pass overwrite the optimistic cache paint.
 */
let eventBoxReady = false;

/**
 * Whether the event list is loaded, so an empty render is authoritative. The
 * presence of any event row is a sufficient signal on its own; the flag
 * additionally covers the loaded-but-idle (zero fleets) case.
 *
 * @returns {boolean}
 */
const eventBoxLoaded = () => eventBoxReady || document.querySelector(GAME.EVENT_FLEET_ROWS) != null;

/**
 * The detected fleet-save row-ids to mark — but only while alarmClock' master
 * switch AND the per-universe FS toggle are both on, so a stale published set
 * never paints FS markers after the feature is turned off.
 *
 * @returns {Set<string>}
 */
const fsIdSet = () => {
  const on = settingsStore.get().alarmClockMasterEnabled && galaxyScanConfigStore.get().fsEnabled;
  return new Set(on ? readFleetSaveIds() : []);
};

/**
 * Body keys with a LANDED (exposed) fleet-save: the producer's auto set (already
 * dismiss-pruned at the source, gated like {@link fsIdSet}) in UNION with the
 * user's MANUAL marks. Neither carries a timer — an exposed flag clears only on
 * re-save, departure, or an explicit dismiss. Manual marks are also NOT gated by
 * the auto-FS toggles (the user asked for this body specifically). See
 * `state/manualLandedFs.js`.
 *
 * @returns {Set<string>}
 */
const landedFsKeySet = () => {
  const on = settingsStore.get().alarmClockMasterEnabled && galaxyScanConfigStore.get().fsEnabled;
  const keys = on ? readLandedFs().map((e) => e.bodyKey) : [];
  for (const e of readManualLandedFs()) keys.push(e.bodyKey);
  return new Set(keys);
};

/**
 * Paint one body's marker column. Shared by the live render and the optimistic
 * cache render so both produce identical DOM.
 *
 * @param {OwnBody} body
 * @param {import('./pure.js').Marker[]} markers
 * @returns {void}
 */
const paintBody = (body, markers) => {
  if (markers.length === 0) return;
  // Defensive: make the pic container the positioning context so the column
  // anchors to its edge (the green dot relied on this too).
  if (getComputedStyle(body.container).position === 'static') {
    body.container.style.position = 'relative';
  }
  const col = document.createElement('div');
  col.className = body.type === 3 ? `${COL_CLASS} ${MOON_COL_CLASS}` : COL_CLASS;
  for (const m of markers) col.appendChild(buildMarker(m));
  body.container.appendChild(col);
};

/**
 * Slim the painted markers to the cache shape (just the ordered category ids —
 * the optimistic paint needs nothing else; per-fleet detail is re-derived live).
 *
 * @param {Record<string, import('./pure.js').Marker[]>} snapshot
 * @returns {Record<string, string[]>}
 */
const slimSnapshot = (snapshot) => {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [key, markers] of Object.entries(snapshot)) {
    // Encode a landed FS as a distinct token so the optimistic paint keeps its
    // orange variant across a reload.
    out[key] = markers.map((m) => (m.category === 'fs' && m.landed ? 'fsLanded' : m.category));
  }
  return out;
};

/**
 * Epoch-ms after which a snapshot built from these legs is certainly stale: the
 * latest in-flight fleet ARRIVAL (the event row's `data-arrival-time` is a
 * server timestamp in SECONDS) plus {@link CACHE_GRACE_MS}. `undefined` when no
 * leg carries a finite arrival (e.g. a landed-FS-only snapshot), which leaves
 * the cache non-expiring — the live render reconciles those via their own TTL.
 *
 * @param {import('./pure.js').BadgeLeg[]} legs
 * @returns {number | undefined}
 */
const cacheExpiry = (legs) => {
  let maxSec = 0;
  for (const leg of legs) {
    if (Number.isFinite(leg.arrivalAt)) maxSec = Math.max(maxSec, leg.arrivalAt);
  }
  return maxSec > 0 ? maxSec * 1000 + CACHE_GRACE_MS : undefined;
};

/**
 * One LIVE render pass: read the current event + planet state, classify it into
 * per-body markers, paint one column per active body, and refresh the
 * optimistic cache.
 *
 * @returns {void}
 */
const renderColumns = () => {
  ensureHelpChip();
  positionHelpChip();
  const ready = eventBoxLoaded();
  // Pre-XHR window: keep the optimistic cache paint rather than wiping it with
  // an empty live pass. Once the event box has loaded, the live result is
  // authoritative and replaces it.
  if (!ready && document.querySelector(`.${COL_CLASS}`)) return;

  clearColumns();
  const bodies = scanOwnBodies();
  if (bodies.length === 0) return;
  const myKeys = new Set(bodies.map((b) => bodyKey(b.coords, b.type)));
  const legs = scanLegs();
  const byBody = groupMarkers(legs, myKeys, fsIdSet(), landedFsKeySet());

  /** @type {Record<string, import('./pure.js').Marker[]>} */
  const snapshot = {};
  for (const body of bodies) {
    const key = bodyKey(body.coords, body.type);
    const markers = byBody.get(key);
    if (!markers || markers.length === 0) continue;
    paintBody(body, markers);
    snapshot[key] = markers;
  }

  // Persist for the next reload's instant paint. Overwrite with an EMPTY result
  // only when the event list is genuinely loaded-and-idle — never in the
  // pre-XHR gap (handled by the early-return above). The expiry lets a reload
  // discard the paint once the cached fleets have all landed, so missions that
  // complete while the tab is closed don't keep their markers forever.
  if (Object.keys(snapshot).length > 0) writeBadgeCache(slimSnapshot(snapshot), cacheExpiry(legs));
  else if (ready) clearBadgeCache();
};

/**
 * Optimistic paint from the previous page's cached markers, so the badges show
 * instantly on load — before the event-list XHR (which {@link renderColumns}
 * computes everything from) has even arrived. The live render replaces it.
 *
 * @returns {void}
 */
const renderFromCache = () => {
  const cache = readBadgeCache();
  if (!cache) return;
  const bodies = scanOwnBodies();
  if (bodies.length === 0) return;
  clearColumns();
  for (const body of bodies) {
    const cats = cache[bodyKey(body.coords, body.type)];
    if (!cats || cats.length === 0) continue;
    paintBody(
      body,
      cats.map((cat) =>
        cat === 'fsLanded'
          ? { category: 'fs', landed: true, fleets: [] }
          : { category: cat, landed: false, fleets: [] },
      ),
    );
  }
};

// ── Install / dispose ────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Attach the MutationObserver to `#planetList` + `#eventContent` when present,
 * always also observing `<body>` (OGame AJAX-swaps both containers, detaching
 * a scoped observer). Mirrors the previous badge feature's strategy.
 *
 * @param {import('../../lib/visibilityObserver.js').VisibilityObserver} observer
 * @returns {void}
 */
const attachObserver = (observer) => {
  const planetList = document.getElementById('planetList');
  const eventContent = document.querySelector(GAME.EVENT_CONTENT);
  if (planetList) observer.observe(planetList, { childList: true, subtree: true });
  if (eventContent) observer.observe(eventContent, { childList: true, subtree: true });
  observer.observe(document.body, { childList: true, subtree: true });
};

/**
 * Install the planet status markers. Idempotent: a second call while installed
 * returns the same dispose handle. The dispose fn disconnects the observer,
 * clears the safety poll, unsubscribes from settings, removes every column +
 * the "?" help chip + both style nodes, and detaches the event-box handler.
 *
 * @returns {() => void}
 */
export const installBadges = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, buildCss());

  /** @type {import('../../lib/visibilityObserver.js').VisibilityObserver | null} */
  let observer = null;

  // Run a paint with the observer paused so our own DOM writes don't feed back
  // into a refresh loop (the writes would otherwise re-trigger it).
  /** @param {() => void} fn */
  const guarded = (fn) => {
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer) attachObserver(observer);
    }
  };
  const renderGuarded = () => guarded(renderColumns);

  /** @param {boolean} enabled @returns {void} */
  const applyVisibility = (enabled) => {
    if (enabled) {
      document.getElementById(HIDE_STYLE_ID)?.remove();
      // Instant optimistic paint from the previous load's cache, BEFORE the
      // live render — so the markers show while the event XHR is still in
      // flight. The live pass then preserves it (pre-XHR) or replaces it.
      guarded(renderFromCache);
      renderGuarded();
      // Post-reload race: containers exist but are empty until OGame's inline
      // scripts populate them. Poll until the planet list has rows, then
      // render once more. No-op if the first render already succeeded.
      void waitFor(() => document.querySelectorAll(GAME.SMALL_PLANET).length > 0, {
        timeoutMs: 5000,
        intervalMs: 250,
      }).then(() => {
        if (installed && settingsStore.get().expeditionBadges) renderGuarded();
      });
    } else {
      injectStyle(HIDE_STYLE_ID, HIDE_CSS);
    }
  };

  applyVisibility(settingsStore.get().expeditionBadges);

  const scheduleRefresh = debounce(() => {
    if (!installed) return;
    if (settingsStore.get().expeditionBadges) renderGuarded();
  }, REFRESH_DEBOUNCE_MS);

  let prevEnabled = settingsStore.get().expeditionBadges;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.expeditionBadges !== prevEnabled) {
      applyVisibility(next.expeditionBadges);
      prevEnabled = next.expeditionBadges;
    }
  });

  // The event-list XHR landing is our authority for "an empty render is real".
  // Mark it ready and refresh so a loaded-but-idle list clears the cache.
  const onEventBox = () => {
    eventBoxReady = true;
    scheduleRefresh();
  };
  document.addEventListener(EVENT_BOX_LOADED_EVENT, onEventBox);

  observer = createVisibilityObserver(() => scheduleRefresh());
  attachObserver(observer);

  // Window scroll is handled for free (absolute chip in document coords moves
  // with the page). This listener is the backstop for layout shifts and for
  // scrolls inside an inner scroller (the left menu), where the document-coord
  // anchor genuinely changes; capture-phase catches those. Recompute is a no-op
  // under plain window scroll, so it can't reintroduce the jump. Pure read+style
  // writes, no DOM structure change, so it can't loop the observer.
  const onReposition = () => positionHelpChip();
  window.addEventListener('scroll', onReposition, true);
  window.addEventListener('resize', onReposition);

  // Safety net: OGame refreshes #eventContent on a ~30s AJAX tick and has
  // historically dodged scoped observers. 5s is still far tighter than that
  // and the re-render is O(#planets) — practically free. On the shared,
  // visibility-aware clock; gated on the setting.
  const unsubPoll = clock.subscribe(() => {
    if (settingsStore.get().expeditionBadges) renderGuarded();
  }, { everyMs: 5000 });

  installed = {
    dispose: () => {
      observer?.disconnect();
      unsubPoll();
      unsubSettings();
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener(EVENT_BOX_LOADED_EVENT, onEventBox);
      eventBoxReady = false;
      clearColumns();
      removeHelpEl();
      removeLegendEl();
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById(HIDE_STYLE_ID)?.remove();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset: runs the current dispose fn (if any) so DOM/observers are
 * left clean between cases. Do not import from production code.
 *
 * @returns {void}
 */
export const _resetBadgesForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
