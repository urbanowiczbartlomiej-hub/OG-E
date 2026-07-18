// @ts-check

// Unified floating button ("FAB") shell — ONE draggable wrapper that hosts
// all four command buttons (sendExpedition / sendColony / sendLifeform / dailyRun)
// and shows exactly one of them at a time (the ACTIVE module). The other
// registered modules are rendered as small, ALWAYS-VISIBLE satellite orbs
// arcing from the FAB toward the viewport centre (so the menu never leaves
// the screen). Each orb is a single-piece node — the module's colour + glyph,
// the same look the active module wears in its in-button "oczko" (the glass
// node lens) — so tapping an orb reads as that node flying INTO the button.
// Tapping an orb only SWITCHES the active module (it never fires the module's
// action — the next tap on the FAB does that, with the module's full
// zone/hold behaviour intact); the previously active module immediately takes
// the freed orbit slot.
//
// Layering: lives in features/shared because it touches document, safeLS
// and settingsStore. The four features never import each other — each one
// passes `module` metadata to `createButton` (./button.js), which registers
// the built host element here. The shell owns the single shared position
// (`FAB_POS_KEY`), the single size (`settings.fabBtnSize`) and the active
// module id (`FAB_ACTIVE_KEY`) — all of which survive page reloads.
//
// Lifecycle: the shell is created lazily by the first registration and
// torn down when the last module unregisters (each feature disposes its
// button when its `show*Button` flag flips off, so the wrapper and the
// satellite orbs disappear with the last module).
//
// @see ./unifiedFabPure.js — the testable orbit geometry + active-id logic.
// @see ./button.js         — builds the per-module hosts and registers them.

import { safeLS } from '../../lib/storage.js';
import { injectStyle } from '../../lib/dom.js';
import {
  settingsStore,
  FAB_POS_KEY,
  FAB_ACTIVE_KEY,
} from '../../state/settings.js';
import { installDrag, restorePosition } from './draggableButton.js';
import { appendGlyph, installButtonChrome } from './buttonChrome.js';
import {
  resolveActiveId,
  orbitPlan,
  orbDiameter,
  orbitRadius,
} from './unifiedFabPure.js';

export { FAB_ACTIVE_KEY };

/** Outer draggable wrapper (OG-E's own surface, not a game contract). */
export const FAB_WRAP_ID = 'oge-fab-wrap';
/** One always-visible satellite orb per NON-active registered module. */
export const FAB_ORB_CLASS = 'oge-fab-orb';

/** Id of the singleton <style> element this module injects. */
const STYLE_ID = 'oge-fab-style';
/** Bottom-right inset used when no dragged position is stored. */
const EDGE_OFFSET_PX = 20;

/**
 * Identity of one FAB module, shown verbatim as its satellite orb.
 *
 * @typedef {object} FabModuleMeta
 * @property {string} id     stable module id ('exp' | 'col' | 'lf' | 'fs').
 * @property {string} name   accessible label for the orb (e.g. 'Expeditions').
 * @property {string} color  the module's signature colour (orb + oczko `--mod`).
 * @property {string} glyph  inner SVG markup (see buttonGlyphs.js).
 */

/**
 * Satellite-orb chrome. The dome look itself (gradient + rim + glow + glyph)
 * is the shared `.oge-node` rule from buttonChrome.js, so an orb and the
 * active module's in-button oczko are pixel-identical — only the SIZE and
 * POSITIONING differ and live here. `--mod` (set per orb) drives the colour.
 */
const FAB_CSS = [
  // Position/size only — the dome look comes from the shared `.oge-node`. No
  // left/top transition: the orbs must stay glued to the FAB while it's
  // dragged (a transition would make them lag behind the cursor).
  `.${FAB_ORB_CLASS}{position:fixed;transform:translate(-50%,-50%);`,
  'border-radius:50%;border:none;cursor:pointer;padding:0;}',
  // "Needs an ACK" pulse — a gentle, uniform glow only (a GLOW, never a
  // transform: a scale would fight the orb's translate(-50%,-50%) positioning).
  // Toggled via the `oge-fab-alert` class by setFabModuleAlert(); the glow
  // colour comes from `--oge-pulse` (the module's signature colour).
  '@keyframes oge-fab-pulse{',
  '0%,100%{box-shadow:0 0 0 0 transparent;}',
  '50%{box-shadow:0 0 9px 3px var(--oge-pulse,#e67e22);}}',
  '.oge-fab-alert{animation:oge-fab-pulse 1.6s ease-in-out infinite;}',
].join('');

/**
 * Registered modules, id → meta + host element. Insertion order is the
 * menu order (= feature install order in content.js — not load-bearing).
 *
 * @type {Map<string, { meta: FabModuleMeta, host: HTMLElement }>}
 */
const registry = new Map();

/**
 * The live shell, or `null` when no module is registered.
 *
 * @type {{
 *   wrap: HTMLElement,
 *   drag: { wasDrag: () => boolean, resetDrag: () => void },
 *   unsubSettings: () => void,
 *   onResize: () => void,
 * } | null}
 */
let shell = null;

/** The live satellite orbs (one per non-active module). @type {HTMLElement[]} */
let orbEls = [];

/**
 * Arc centre chosen on the previous {@link positionOrbs} pass — fed back into
 * the layout so the feasible-window pick is STICKY across drag frames (two
 * near-equidistant windows must not flip winners under a jittering finger;
 * see unifiedFabPure.feasibleArcCenter). Reset with the shell.
 * @type {number | null}
 */
let lastArcCentre = null;

/**
 * Module ids currently flagged "needs an ACK" — they pulse on whichever
 * representation is live (active host or satellite orb). Kept in a Set (not on
 * the DOM) so the flag survives orb rebuilds: {@link buildOrbs} re-applies it.
 *
 * @type {Set<string>}
 */
const alerting = new Set();

/**
 * Apply the pulse class to a module's live nodes — the in-FAB host (always in
 * the registry) and its satellite orb when one is built. The glow colour is set
 * from the module's meta colour. Idempotent; safe when a node isn't built yet.
 *
 * @param {string} id
 * @returns {void}
 */
const applyAlert = (id) => {
  const on = alerting.has(id);
  const entry = registry.get(id);
  if (entry) {
    entry.host.classList.toggle('oge-fab-alert', on);
    entry.host.style.setProperty('--oge-pulse', entry.meta.color);
  }
  const orb = orbEls.find((o) => o.dataset.mod === id);
  if (orb) orb.classList.toggle('oge-fab-alert', on);
};

/**
 * Flag / unflag a module as "needs an ACK". The flagged module gently pulses on
 * its live representation (active host or satellite orb). The guardian uses this
 * to nudge the player after a quiet spell while a fleet sits bare.
 *
 * @param {string} id
 * @param {boolean} on
 * @returns {void}
 */
export const setFabModuleAlert = (id, on) => {
  if (on) alerting.add(id);
  else alerting.delete(id);
  applyAlert(id);
};

/** Current FAB diameter (settings-driven). @returns {number} */
const currentSize = () => settingsStore.get().fabBtnSize;

/** Inject the satellite-orb stylesheet once. @returns {void} */
const ensureCss = () => injectStyle(STYLE_ID, FAB_CSS);

/**
 * Re-measure the FAB and lay the live orbs on the arc toward the viewport
 * centre, also (re)applying each orb's size. Cheap enough to call on every
 * drag-move / resize. getBoundingClientRect is authoritative in production
 * (handles the right/bottom-anchored default position); happy-dom returns
 * all zeros, in which case the orbit simply fans from the top-left.
 *
 * @returns {void}
 */
const positionOrbs = () => {
  if (!shell || orbEls.length === 0) return;
  const size = currentSize();
  const r = shell.wrap.getBoundingClientRect();
  const cx = r.left + (r.width || size) / 2;
  const cy = r.top + (r.height || size) / 2;
  const orbSize = orbDiameter(size);
  const { items, centre } = orbitPlan({
    cx,
    cy,
    count: orbEls.length,
    radius: orbitRadius(size, orbSize),
    orbSize,
    vw: window.innerWidth,
    vh: window.innerHeight,
    prevCentre: lastArcCentre,
  });
  lastArcCentre = centre;
  orbEls.forEach((orb, i) => {
    orb.style.width = `${orbSize}px`;
    orb.style.height = `${orbSize}px`;
    orb.style.left = `${items[i].x}px`;
    orb.style.top = `${items[i].y}px`;
  });
};

/** Drop every live satellite orb from the DOM. @returns {void} */
const clearOrbs = () => {
  for (const orb of orbEls) orb.remove();
  orbEls = [];
  lastArcCentre = null;
};

/**
 * (Re)build the satellite orbs to match the current NON-active module set
 * (the active module lives in the FAB itself, never in the menu) and lay
 * them out. Called whenever the active id or the registration set changes.
 *
 * @returns {void}
 */
const buildOrbs = () => {
  if (!shell) return;
  clearOrbs();
  const ids = [...registry.keys()];
  const active = resolveActiveId(safeLS.get(FAB_ACTIVE_KEY), ids);
  const wrapZ = parseInt(shell.wrap.style.zIndex, 10) || 99999;
  for (const [id, { meta }] of registry) {
    if (id === active) continue;
    const orb = document.createElement('button');
    orb.type = 'button';
    orb.className = `${FAB_ORB_CLASS} oge-node`;
    orb.setAttribute('aria-label', `Switch to ${meta.name}`);
    orb.title = meta.name;
    orb.style.zIndex = String(wrapZ - 1);
    orb.style.setProperty('--mod', meta.color);
    orb.style.setProperty('--oge-pulse', meta.color);
    orb.dataset.mod = id;
    if (alerting.has(id)) orb.classList.add('oge-fab-alert');
    appendGlyph(orb, meta.glyph);
    orb.addEventListener('click', () => setActiveFabModule(id));
    document.body.appendChild(orb);
    orbEls.push(orb);
  }
  positionOrbs();
};

/**
 * Show the active module's host, hide the rest, and rebuild the satellite
 * menu (the freed/taken orbit slot). Falls back to the first registered
 * module when the stored id is missing or stale — see {@link resolveActiveId}.
 *
 * @returns {void}
 */
const applyActive = () => {
  if (!shell) return;
  const ids = [...registry.keys()];
  const active = resolveActiveId(safeLS.get(FAB_ACTIVE_KEY), ids);
  for (const [id, entry] of registry) {
    entry.host.style.display = id === active ? '' : 'none';
  }
  buildOrbs();
};

/**
 * Persist + apply a new active module — the tapped orb's module flies into
 * the FAB and the previously active one drops into its orbit slot. Public so
 * tests (and a future keyboard shortcut) can switch without the menu.
 *
 * @param {string} id
 * @returns {void}
 */
export const setActiveFabModule = (id) => {
  safeLS.set(FAB_ACTIVE_KEY, id);
  applyActive();
};

/**
 * Create the wrapper on first registration. The wrapper owns the shared drag
 * (one `{x,y}` for every module) and reacts live to `fabBtnSize` (the hosts
 * resize themselves via their own features' subscriptions; the orbs resize +
 * relayout here).
 *
 * @returns {void}
 */
const ensureShell = () => {
  if (shell) return;
  ensureCss();
  // The satellite orbs reuse the shared `.oge-node` dome look, which lives in
  // the button-chrome stylesheet — ensure it exists even before the first
  // command button decorates itself.
  installButtonChrome();
  const size = currentSize();

  const wrap = document.createElement('div');
  wrap.id = FAB_WRAP_ID;
  wrap.style.cssText = [
    'position:fixed',
    'z-index:99999',
    'touch-action:none',
    'user-select:none',
    `width:${size}px`,
    `height:${size}px`,
  ].join(';');
  restorePosition({ element: wrap, posKey: FAB_POS_KEY, size, edgeOffset: EDGE_OFFSET_PX });
  document.body.appendChild(wrap);

  const drag = installDrag({ element: wrap, posKey: FAB_POS_KEY, onMove: positionOrbs });

  let prevSize = size;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fabBtnSize === prevSize) return;
    prevSize = next.fabBtnSize;
    wrap.style.width = next.fabBtnSize + 'px';
    wrap.style.height = next.fabBtnSize + 'px';
    positionOrbs();
  });

  // Re-aim the orbs when the viewport reflows (the centre they fan toward,
  // and the FAB's own anchored position, both moved).
  const onResize = () => positionOrbs();
  window.addEventListener('resize', onResize);

  shell = { wrap, drag, unsubSettings, onResize };
};

/** Tear the shell down once the last module is gone. @returns {void} */
const maybeTeardown = () => {
  if (!shell || registry.size > 0) return;
  clearOrbs();
  shell.unsubSettings();
  window.removeEventListener('resize', shell.onResize);
  shell.wrap.remove();
  shell = null;
};

/**
 * Mount a module's host element into the unified FAB. Called by
 * `createButton` when its config carries `module` metadata; features never
 * call this directly. The host is inserted into the wrapper and immediately
 * shown/hidden per the active id (with the satellite menu rebuilt to match).
 *
 * @param {object} opts
 * @param {FabModuleMeta} opts.meta
 * @param {HTMLElement} opts.host  the built `.oge-host` element
 *   (position:absolute — the wrapper provides the fixed position).
 * @returns {{
 *   drag: { wasDrag: () => boolean, resetDrag: () => void },
 *   dispose: () => void,
 * }} the shared drag predicates (for the zones' click discriminator) and
 *   an unregister handle.
 */
export const registerFabModule = ({ meta, host }) => {
  ensureShell();
  const s = /** @type {NonNullable<typeof shell>} */ (shell);
  registry.set(meta.id, { meta, host });
  s.wrap.appendChild(host);
  applyActive();
  // Re-apply any alert flagged BEFORE this module's node existed (e.g. a
  // caller sets the alert and mounts the button in the same refresh pass) —
  // applyAlert no-ops harmlessly when the module isn't alerting.
  applyAlert(meta.id);
  return {
    drag: s.drag,
    dispose: () => {
      registry.delete(meta.id);
      host.remove();
      if (registry.size > 0) applyActive();
      maybeTeardown();
    },
  };
};

/**
 * Test-only reset: drop every registration, the shell DOM and the orbs.
 * Mirrors the `_reset*ForTest` convention of the features.
 *
 * @returns {void}
 */
export const _resetUnifiedFabForTest = () => {
  clearOrbs();
  alerting.clear();
  registry.clear();
  if (shell) {
    shell.unsubSettings();
    window.removeEventListener('resize', shell.onResize);
    shell.wrap.remove();
    shell = null;
  }
  document.getElementById(STYLE_ID)?.remove();
};
