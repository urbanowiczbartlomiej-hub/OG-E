// @ts-check

// Unified floating button ("FAB") shell — ONE draggable wrapper that hosts
// all four command buttons (sendExp / sendCol / sendLifeform / dailyRun)
// and shows exactly one of them at a time. A small "handle" satellite on
// the FAB's edge opens an orbital picker: every registered module rendered
// as a single-piece orb (split buttons too — the orb is identity only:
// module colour + glyph + a small caption), arcing toward the viewport
// centre so it never leaves the screen. Tapping an orb only SWITCHES the
// active module (it never fires the module's action — the next tap on the
// FAB does that, with the module's full zone/hold behaviour intact).
//
// Layering: lives in features/shared because it touches document, safeLS
// and settingsStore. The four features never import each other — each one
// passes `module` metadata to `createButton` (./button.js), which registers
// the built host element here. The shell owns the single shared position
// (`FAB_POS_KEY`), the single size (`settings.fabBtnSize`) and the active
// module id (`FAB_ACTIVE_KEY`) — all of which survive page reloads.
//
// Lifecycle: the shell is created lazily by the first registration and
// torn down when the last module unregisters (all four features dispose
// their buttons when `settings.fabMode` flips off, so the wrapper, handle
// and any open picker disappear with them).
//
// @see ./unifiedFabPure.js — the testable orbit geometry + active-id logic.
// @see ./button.js         — builds the per-module hosts and registers them.

import { safeLS } from '../../lib/storage.js';
import {
  settingsStore,
  FAB_POS_KEY,
  FAB_ACTIVE_KEY,
} from '../../state/settings.js';
import { installDrag, restorePosition } from './draggableButton.js';
import { appendGlyph } from './buttonChrome.js';
import {
  resolveActiveId,
  orbitLayout,
  orbDiameter,
  orbitRadius,
  handleDiameter,
} from './unifiedFabPure.js';

export { FAB_POS_KEY, FAB_ACTIVE_KEY };

/** Outer draggable wrapper (OG-E's own surface, not a game contract). */
export const FAB_WRAP_ID = 'oge-fab-wrap';
/** The picker-opening satellite button on the FAB's edge. */
export const FAB_HANDLE_ID = 'oge-fab-handle';
/** Full-screen dismiss layer behind an open picker. */
export const FAB_OVERLAY_ID = 'oge-fab-overlay';
/** One picker orb per registered module. */
export const FAB_ORB_CLASS = 'oge-fab-orb';
/** The small caption next to each orb. */
export const FAB_ORB_LABEL_CLASS = 'oge-fab-orb-label';

/** Id of the singleton <style> element this module injects. */
const STYLE_ID = 'oge-fab-style';
/** Bottom-right inset used when no dragged position is stored. */
const EDGE_OFFSET_PX = 20;
/** Gap between an orb's edge and its caption. */
const LABEL_GAP_PX = 12;

/**
 * Identity of one FAB module, shown verbatim in the picker.
 *
 * @typedef {object} FabModuleMeta
 * @property {string} id     stable module id ('exp' | 'col' | 'lf' | 'fs').
 * @property {string} name   caption next to the orb (e.g. 'Expeditions').
 * @property {string} color  the module's signature rim colour.
 * @property {string} glyph  inner SVG markup (see buttonGlyphs.js).
 */

/**
 * The picker chrome. The orbs reuse `.oge-art` (buttonChrome's watermark
 * layer) for the glyph but crank `--art-opacity` up — in the picker the
 * glyph IS the identity, not a watermark. `color-mix` keeps every shadow
 * derived from the module colour without a second palette.
 */
const FAB_CSS = [
  `#${FAB_HANDLE_ID}{`,
  'position:absolute;right:2%;bottom:2%;z-index:3;border-radius:50%;border:none;',
  'background:#0b1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;',
  'cursor:pointer;padding:0;',
  'box-shadow:0 0 0 1.5px color-mix(in oklab,var(--mod,#38bdf8) 60%,transparent),0 3px 10px rgba(0,0,0,.6);}',
  `#${FAB_HANDLE_ID} svg{width:55%;height:55%;fill:none;stroke:currentColor;`,
  'stroke-width:2.4;stroke-linecap:round;transition:transform .2s ease;}',
  `.oge-fab-open #${FAB_HANDLE_ID} svg{transform:rotate(45deg);}`,
  `#${FAB_OVERLAY_ID}{position:fixed;inset:0;background:rgba(2,6,12,.55);}`,
  `.${FAB_ORB_CLASS}{position:fixed;transform:translate(-50%,-50%);border-radius:50%;`,
  'border:none;cursor:pointer;padding:0;color:#e2e8f0;',
  'background:radial-gradient(circle at 35% 28%,color-mix(in oklab,var(--mod) 30%,#0b1220) 0%,#0b1220 75%);',
  'box-shadow:0 0 0 1.5px color-mix(in oklab,var(--mod) 60%,transparent),',
  '0 0 18px color-mix(in oklab,var(--mod) 35%,transparent),0 8px 22px rgba(0,0,0,.7);}',
  `.${FAB_ORB_CLASS}.is-active{box-shadow:0 0 0 2.5px var(--mod),`,
  '0 0 26px color-mix(in oklab,var(--mod) 65%,transparent),0 8px 22px rgba(0,0,0,.7);}',
  `.${FAB_ORB_LABEL_CLASS}{position:fixed;transform:translate(-50%,-50%);pointer-events:none;`,
  'font:700 10px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Verdana,sans-serif;',
  'letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;color:#cbd5e1;',
  'text-shadow:0 1px 4px #000;}',
].join('');

/**
 * Registered modules, id → meta + host element. Insertion order is the
 * picker order (= feature install order in content.js — not load-bearing).
 *
 * @type {Map<string, { meta: FabModuleMeta, host: HTMLElement }>}
 */
const registry = new Map();

/**
 * The live shell, or `null` when no module is registered.
 *
 * @type {{
 *   wrap: HTMLElement,
 *   handle: HTMLButtonElement,
 *   drag: { wasDrag: () => boolean, resetDrag: () => void },
 *   unsubSettings: () => void,
 * } | null}
 */
let shell = null;

/** Elements of the currently open picker (empty when closed). @type {HTMLElement[]} */
let menuEls = [];
let menuOpen = false;

/** @param {KeyboardEvent} e */
const onMenuKeydown = (e) => {
  if (e.key === 'Escape') closeMenu();
};

/** Current FAB diameter (settings-driven). @returns {number} */
const currentSize = () => settingsStore.get().fabBtnSize;

/** Inject the picker stylesheet once. @returns {void} */
const ensureCss = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FAB_CSS;
  document.head.appendChild(style);
};

/**
 * Show the active module's host, hide the rest, tint the handle to the
 * active colour. Falls back to the first registered module when the
 * stored id is missing or stale — see {@link resolveActiveId}.
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
  const meta = active !== null ? registry.get(active)?.meta : undefined;
  if (meta) shell.handle.style.setProperty('--mod', meta.color);
};

/**
 * Persist + apply a new active module. Public so tests (and a future
 * keyboard shortcut) can switch without the picker.
 *
 * @param {string} id
 * @returns {void}
 */
export const setActiveFabModule = (id) => {
  safeLS.set(FAB_ACTIVE_KEY, id);
  applyActive();
};

/** @returns {void} */
const closeMenu = () => {
  if (!menuOpen) return;
  menuOpen = false;
  for (const el of menuEls) el.remove();
  menuEls = [];
  document.removeEventListener('keydown', onMenuKeydown);
  if (shell) {
    shell.wrap.classList.remove('oge-fab-open');
    shell.handle.setAttribute('aria-expanded', 'false');
  }
};

/**
 * Build and show the orbital picker around the FAB's current position.
 * Every registered module gets one single-piece orb (its colour + glyph,
 * `.is-active` ring on the current one) plus a small caption. Clicking an
 * orb switches the active module and closes; overlay click / Escape just
 * close.
 *
 * @returns {void}
 */
const openMenu = () => {
  if (!shell || menuOpen) return;
  const size = currentSize();
  // getBoundingClientRect is authoritative in production (handles the
  // right/bottom-anchored default position); happy-dom returns all zeros,
  // in which case the orbit simply fans from the viewport's top-left.
  const r = shell.wrap.getBoundingClientRect();
  const cx = r.left + (r.width || size) / 2;
  const cy = r.top + (r.height || size) / 2;
  const orbSize = orbDiameter(size);
  const items = orbitLayout({
    cx,
    cy,
    count: registry.size,
    radius: orbitRadius(size, orbSize),
    orbSize,
    labelGap: LABEL_GAP_PX,
    vw: window.innerWidth,
    vh: window.innerHeight,
  });

  const wrapZ = parseInt(shell.wrap.style.zIndex, 10) || 99999;
  const overlay = document.createElement('div');
  overlay.id = FAB_OVERLAY_ID;
  overlay.style.zIndex = String(wrapZ - 2);
  overlay.addEventListener('click', closeMenu);
  menuEls.push(overlay);

  const activeId = resolveActiveId(safeLS.get(FAB_ACTIVE_KEY), [...registry.keys()]);
  let i = 0;
  for (const [id, { meta }] of registry) {
    const pos = items[i];
    i += 1;
    const orb = document.createElement('button');
    orb.type = 'button';
    orb.className = FAB_ORB_CLASS + (id === activeId ? ' is-active' : '');
    orb.setAttribute('aria-label', `Switch to ${meta.name}`);
    orb.title = meta.name;
    orb.style.cssText = [
      `left:${pos.x}px`,
      `top:${pos.y}px`,
      `width:${orbSize}px`,
      `height:${orbSize}px`,
      `z-index:${wrapZ - 1}`,
    ].join(';');
    orb.style.setProperty('--mod', meta.color);
    // In the picker the glyph is the identity, not a watermark.
    orb.style.setProperty('--art-opacity', '0.9');
    appendGlyph(orb, meta.glyph);
    orb.addEventListener('click', () => {
      if (id !== activeId) setActiveFabModule(id);
      closeMenu();
    });
    menuEls.push(orb);

    const label = document.createElement('div');
    label.className = FAB_ORB_LABEL_CLASS;
    label.textContent = meta.name;
    label.style.cssText = [
      `left:${pos.labelX}px`,
      `top:${pos.labelY}px`,
      `z-index:${wrapZ - 1}`,
    ].join(';');
    menuEls.push(label);
  }

  for (const el of menuEls) document.body.appendChild(el);
  menuOpen = true;
  document.addEventListener('keydown', onMenuKeydown);
  shell.wrap.classList.add('oge-fab-open');
  shell.handle.setAttribute('aria-expanded', 'true');
};

/**
 * Create the wrapper + handle on first registration. The wrapper owns the
 * shared drag (one `{x,y}` for every module) and reacts live to
 * `fabBtnSize` (the hosts resize themselves via their own features'
 * subscriptions; an open picker is closed because its layout went stale).
 *
 * @returns {void}
 */
const ensureShell = () => {
  if (shell) return;
  ensureCss();
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

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.id = FAB_HANDLE_ID;
  handle.setAttribute('aria-label', 'Switch floating button module');
  handle.setAttribute('aria-expanded', 'false');
  const handleSize = handleDiameter(size);
  handle.style.width = handleSize + 'px';
  handle.style.height = handleSize + 'px';
  handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  wrap.appendChild(handle);
  document.body.appendChild(wrap);

  const drag = installDrag({ element: wrap, posKey: FAB_POS_KEY });
  handle.addEventListener('click', (e) => {
    if (drag.wasDrag()) {
      drag.resetDrag();
      return;
    }
    e.stopPropagation();
    if (menuOpen) closeMenu();
    else openMenu();
  });

  let prevSize = size;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fabBtnSize === prevSize) return;
    prevSize = next.fabBtnSize;
    wrap.style.width = next.fabBtnSize + 'px';
    wrap.style.height = next.fabBtnSize + 'px';
    const hs = handleDiameter(next.fabBtnSize);
    handle.style.width = hs + 'px';
    handle.style.height = hs + 'px';
    closeMenu();
  });

  shell = { wrap, handle, drag, unsubSettings };
};

/** Tear the shell down once the last module is gone. @returns {void} */
const maybeTeardown = () => {
  if (!shell || registry.size > 0) return;
  closeMenu();
  shell.unsubSettings();
  shell.wrap.remove();
  shell = null;
};

/**
 * Mount a module's host element into the unified FAB. Called by
 * `createButton` when its config carries `module` metadata; features never
 * call this directly. The host is inserted UNDER the handle (so the handle
 * always stays tappable) and immediately shown/hidden per the active id.
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
  s.wrap.insertBefore(host, s.handle);
  // Touching the FAB itself (tap or drag-start) dismisses an open picker —
  // its layout is about to go stale, and the user is clearly acting on the
  // active module. The handle is excluded so its toggle still works.
  host.addEventListener('mousedown', closeMenu);
  host.addEventListener('touchstart', closeMenu, { passive: true });
  applyActive();
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
 * Test-only reset: drop every registration, the shell DOM and the picker.
 * Mirrors the `_reset*ForTest` convention of the features.
 *
 * @returns {void}
 */
export const _resetUnifiedFabForTest = () => {
  closeMenu();
  registry.clear();
  if (shell) {
    shell.unsubSettings();
    shell.wrap.remove();
    shell = null;
  }
  document.getElementById(STYLE_ID)?.remove();
};
