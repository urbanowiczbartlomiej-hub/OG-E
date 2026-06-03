// @ts-check

// Fleet-save micro-fleet feature — TWO floating buttons that automate the
// "park the fleet on a moon, scatter micro-fleets to the planets, then
// pull everything back" workflow.
//
// # The two buttons
//
//   - "Mikrofloty" (single circle): from the current MOON, send a fixed
//     micro-fleet (Stacjonuj / mission=4) to each target defined for that
//     moon in the routes config, skipping targets that already have a
//     deployment inbound. Ships are preloaded via the fleetdispatch URL
//     `am<shipId>=count` param, so the page lands on fleet step 1 with the
//     micro-fleet already selected.
//   - "Zbieraj" (two halves like sendCol): TOP collects — from the current
//     planet send EVERYTHING (all ships + all resources) back to the
//     ad-hoc collect target. BOTTOM marks the body you're standing on as
//     that collect target ("Cel").
//
// # Two-tap send model (TOS-safe: one click → one originated request)
//
// On the fleetdispatch page each button drives the game's own two-step
// form one tap at a time:
//   - tap "Przygotuj" → (collect: select all ships) → click Continue,
//     wait for step 2, relabel "Wyślij".
//   - tap "Wyślij" → (collect: load all resources) → stash the post-send
//     redirect URL in `oge_fsRedirect` → click the native dispatch button.
// The only server-visible action a tap originates is the final dispatch.
//
// # Post-send redirect (asymmetric — see deployRedirect bridge)
//
//   - Micro: redirect to BARE fleetdispatch on the same moon. We do NOT
//     pre-pick the next target here, because the target we just sent to
//     is not yet in `#eventContent` — deferring the pick to the reloaded
//     page (where it IS) keeps "skip already-sent" correct.
//   - Collect: redirect to the next planet's fleetdispatch already aimed
//     at the collect target (we always advance PAST the current planet,
//     so the not-yet-visible current leg doesn't matter).
//
// @see ./pure.js — URL builders, target picking, the routes DSL.
// @see ./domHelpers.js — DOM readers + fleet-step drivers.
// @see ../../bridges/deployRedirect.js — consumes `oge_fsRedirect`.
// @see ../sendCol/index.js — two-half widget pattern reused here.

import { settingsStore } from '../../state/settings.js';
import {
  fsRoutesStore,
  flushFsRoutesStore,
  FS_REDIRECT_KEY,
} from '../../state/fsRoutes.js';
import {
  installDrag,
  installFocusPersist,
} from '../shared/draggableButton.js';
import {
  coordKey,
  coordTypeKey,
  buildDeployUrl,
  buildCollectUrl,
  findNextMicroTarget,
  countRemainingMicroTargets,
} from './pure.js';
import {
  readCurrentBody,
  readDeployLegs,
  findNextCollectPlanetCp,
  isStep2,
  selectAllShips,
  clickContinue,
  loadAllResources,
  clickDispatch,
  waitForStep2,
} from './domHelpers.js';

// ─── DOM ids / storage keys ─────────────────────────────────────────────

const MICRO_ID = 'oge-fs-micro';
const COLLECT_ID = 'oge-fs-collect';
const COLLECT_TOP_ID = 'oge-fs-collect-top';
const COLLECT_SET_ID = 'oge-fs-collect-set';

const MICRO_POS_KEY = 'oge_fsMicroPos';
const COLLECT_POS_KEY = 'oge_fsCollectPos';
const FOCUS_KEY = 'oge_focusedBtn';

const DRAG_THRESHOLD = 8;
const DEFAULT_EDGE_OFFSET_PX = 20;
const FLASH_MS = 1500;
const SENT_LOCK_MS = 3000;

// Colours — distinct from sendExp (blue) / sendCol (green/teal).
const BG_MICRO = '#7b3fa0'; // violet
const BG_COLLECT = '#1f6f6f'; // teal-dark
const BG_SET = '#444';

// ─── helpers (impure env reads) ─────────────────────────────────────────

const gameBase = () => location.href.split('?')[0];
const onFleetdispatch = () => location.search.includes('component=fleetdispatch');
const urlHasAm = () => /[?&]am\d+=/.test(location.search);
/** @param {string} name */
const urlParam = (name) => new URLSearchParams(location.search).get(name);

/**
 * Set of {@link coordTypeKey}s that currently have a deployment inbound —
 * the "already sent a micro-fleet here" guard.
 *
 * @returns {Set<string>}
 */
const microInFlightKeys = () => {
  const set = new Set();
  for (const leg of readDeployLegs()) set.add(coordTypeKey(leg.dest));
  return set;
};

/**
 * Set of {@link coordKey}s of planets that already have a deployment
 * inbound to `target` — the "already collected" guard for the next-planet
 * walk.
 *
 * @param {import('../../state/fsRoutes.js').TargetCoord | null} target
 * @returns {Set<string>}
 */
const collectedOriginKeys = (target) => {
  const set = new Set();
  if (!target) return set;
  const tkt = coordTypeKey(target);
  for (const leg of readDeployLegs()) {
    if (leg.origin && coordTypeKey(leg.dest) === tkt) {
      set.add(coordKey(leg.origin));
    }
  }
  return set;
};

// ─── label painting ─────────────────────────────────────────────────────

/**
 * Paint a button/half with a big primary line and an optional small line.
 *
 * @param {HTMLElement | null} el
 * @param {string} big
 * @param {string} [small]
 * @returns {void}
 */
const setLabel = (el, big, small) => {
  if (!el) return;
  el.textContent = '';
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.05;width:100%;';
  if (small) {
    const top = document.createElement('div');
    top.textContent = small;
    top.style.cssText = 'font-size:0.5em;opacity:0.85;letter-spacing:0.5px;';
    wrap.appendChild(top);
  }
  const bottom = document.createElement('div');
  bottom.textContent = big;
  bottom.style.cssText = 'font-size:1em;margin-top:2px;';
  wrap.appendChild(bottom);
  el.appendChild(wrap);
};

/**
 * Flash a transient label on an element, then repaint via {@link refresh}.
 *
 * @param {HTMLElement | null} el
 * @param {string} text
 * @returns {void}
 */
const flash = (el, text) => {
  if (!el) return;
  setLabel(el, text);
  setTimeout(() => refresh(), FLASH_MS);
};

// ─── redirect handoff ───────────────────────────────────────────────────

/**
 * Stash the post-send redirect for a MICRO send: bare fleetdispatch on the
 * same body (so the next tap re-derives the next target from a refreshed
 * event ticker). Written synchronously, just before the dispatch click.
 *
 * @returns {void}
 */
const stashMicroRedirect = () => {
  const cp = urlParam('cp');
  const url =
    gameBase() + '?page=ingame&component=fleetdispatch' + (cp ? `&cp=${cp}` : '');
  safeWrite(url);
};

/**
 * Stash the post-send redirect for a COLLECT send: the next planet still
 * needing collection, already aimed at the collect target. No redirect
 * (clears the key) when nothing's left — the game's own redirect stands.
 *
 * @param {import('../../state/fsRoutes.js').TargetCoord | null} target
 * @returns {void}
 */
const stashCollectRedirect = (target) => {
  if (!target) return;
  const nextCp = findNextCollectPlanetCp(
    collectedOriginKeys(target),
    coordKey(target),
  );
  if (!nextCp) return;
  const url = buildCollectUrl(gameBase(), target) + `&cp=${nextCp}`;
  safeWrite(url);
};

/** @param {string} url */
const safeWrite = (url) => {
  try {
    localStorage.setItem(FS_REDIRECT_KEY, url);
  } catch {
    // Private mode / quota — the send still works, just no auto-redirect.
  }
};

// ─── click handlers ─────────────────────────────────────────────────────

/** @type {boolean} */
let busy = false;

/**
 * "Mikrofloty" click. Idle/elsewhere → navigate to the next target for the
 * current moon's route. On fleetdispatch → two-tap drive (Przygotuj/Wyślij).
 *
 * @returns {void}
 */
const onMicroClick = () => {
  if (busy) return;
  const micro = document.getElementById(MICRO_ID);

  if (onFleetdispatch()) {
    if (isStep2()) {
      stashMicroRedirect();
      clickDispatch();
      setLabel(micro, 'Sent');
      lockBriefly();
      return;
    }
    if (urlHasAm()) {
      // Step 1 with the micro-fleet preloaded → advance to step 2.
      clickContinue();
      setLabel(micro, 'Wait…');
      busy = true;
      waitForStep2().then(() => {
        busy = false;
        refresh();
      });
      return;
    }
    // On fleetdispatch but nothing configured (e.g. after a bare redirect)
    // → fall through to navigate to the next target.
  }

  const body = readCurrentBody();
  const route = body ? fsRoutesStore.get().routes[coordKey(body)] : null;
  if (!route) {
    flash(micro, 'No route');
    return;
  }
  const next = findNextMicroTarget(route.targets, microInFlightKeys());
  if (!next) {
    flash(micro, 'All sent');
    return;
  }
  location.href = buildDeployUrl(gameBase(), next, route.microFleet);
};

/**
 * "Zbieraj" (top half) click. Idle/elsewhere → navigate to the collect
 * target from the current planet. On fleetdispatch → two-tap drive,
 * selecting all ships (step 1) and all resources (step 2).
 *
 * @returns {void}
 */
const onCollectClick = () => {
  if (busy) return;
  const top = document.getElementById(COLLECT_TOP_ID);
  const target = fsRoutesStore.get().collectTarget;

  if (onFleetdispatch()) {
    if (isStep2()) {
      loadAllResources();
      stashCollectRedirect(target);
      clickDispatch();
      setLabel(top, 'Sent');
      lockBriefly();
      return;
    }
    // Step 1: select all ships, then continue.
    selectAllShips();
    clickContinue();
    setLabel(top, 'Wait…');
    busy = true;
    waitForStep2().then(() => {
      busy = false;
      refresh();
    });
    return;
  }

  if (!target) {
    flash(top, 'No target');
    return;
  }
  location.href = buildCollectUrl(gameBase(), target);
};

/**
 * "Cel" (bottom half) click. Mark the body you're currently on as the
 * ad-hoc collect target and persist it immediately.
 *
 * @returns {void}
 */
const onSetTargetClick = () => {
  const setHalf = document.getElementById(COLLECT_SET_ID);
  const body = readCurrentBody();
  if (!body) {
    flash(setHalf, '?');
    return;
  }
  fsRoutesStore.update((prev) => ({ ...prev, collectTarget: body }));
  // Persist now — the user may navigate away before the debounce fires.
  flushFsRoutesStore();
  refresh();
};

/** Briefly lock the buttons while a dispatch + reload settles. */
const lockBriefly = () => {
  busy = true;
  setTimeout(() => {
    busy = false;
    refresh();
  }, SENT_LOCK_MS);
};

// ─── refresh (repaint both widgets) ─────────────────────────────────────

/**
 * Recompute and repaint both buttons from current DOM + store state.
 *
 * @returns {void}
 */
const refresh = () => {
  const micro = document.getElementById(MICRO_ID);
  const top = document.getElementById(COLLECT_TOP_ID);
  const setHalf = document.getElementById(COLLECT_SET_ID);

  // Micro label.
  if (micro) {
    if (onFleetdispatch() && isStep2()) {
      setLabel(micro, 'Send', 'micro');
    } else if (onFleetdispatch() && urlHasAm()) {
      setLabel(micro, 'Next', 'micro');
    } else {
      const body = readCurrentBody();
      const route = body ? fsRoutesStore.get().routes[coordKey(body)] : null;
      if (!route) {
        setLabel(micro, 'Micro', 'no route');
      } else {
        const left = countRemainingMicroTargets(route.targets, microInFlightKeys());
        setLabel(micro, left > 0 ? `${left}` : '0', 'micro');
      }
    }
  }

  // Collect top label.
  if (top) {
    if (onFleetdispatch() && isStep2()) {
      setLabel(top, 'Send', 'collect');
    } else if (onFleetdispatch()) {
      setLabel(top, 'Next', 'collect');
    } else {
      setLabel(top, 'Collect');
    }
  }

  // Collect set-target label.
  if (setHalf) {
    const t = fsRoutesStore.get().collectTarget;
    setLabel(setHalf, t ? `${t.galaxy}:${t.system}:${t.position}` : '—', 'target');
  }
};

// ─── mount / dispose ────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Style a SINGLE circular button (the Micro widget). Combines the circle
 * geometry, content centering, and background in one `cssText` — splitting
 * it across two assignments on the same element would clobber the first,
 * leaving an unstyled rectangle in the document flow.
 *
 * @param {HTMLElement} btn
 * @param {number} size
 * @param {string} bg
 * @returns {void}
 */
const styleSingle = (btn, size, bg) => {
  btn.style.cssText = [
    'position:fixed',
    'border-radius:50%',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'text-align:center',
    'color:#fff',
    'font-weight:bold',
    'border:none',
    'cursor:pointer',
    'z-index:99999',
    'touch-action:none',
    'user-select:none',
    'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
    `width:${size}px`,
    `height:${size}px`,
    `font-size:${Math.round(size * 0.14)}px`,
    `background:${bg}`,
  ].join(';');
};

/**
 * Style a SPLIT widget — an outer circular wrap clipping two stacked
 * half-buttons. Wrap and halves are distinct elements, so the two
 * `cssText` assignments don't collide.
 *
 * @param {HTMLElement} wrap
 * @param {HTMLElement[]} halves
 * @param {number} size
 * @param {string[]} bgs  one bg per half
 * @returns {void}
 */
const styleSplit = (wrap, halves, size, bgs) => {
  const fontSize = Math.round(size * 0.14) + 'px';
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
    'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
    `width:${size}px`,
    `height:${size}px`,
  ].join(';');
  halves.forEach((h, i) => {
    h.style.cssText = [
      'flex:1',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'text-align:center',
      'color:#fff',
      'font-weight:bold',
      'border:none',
      'cursor:pointer',
      `font-size:${fontSize}`,
      `background:${bgs[i]}`,
    ].join(';');
  });
};

/**
 * Restore a saved drag position onto `wrap`, else anchor bottom-right with
 * a per-button vertical offset so the two widgets don't spawn on top of
 * each other.
 *
 * @param {HTMLElement} wrap
 * @param {string} posKey
 * @param {number} size
 * @param {number} stackOffset
 * @returns {void}
 */
const placeWrap = (wrap, posKey, size, stackOffset) => {
  const saved = safeJson(posKey);
  if (
    saved &&
    typeof saved === 'object' &&
    typeof (/** @type {any} */ (saved).x) === 'number' &&
    typeof (/** @type {any} */ (saved).y) === 'number'
  ) {
    const p = /** @type {{ x: number, y: number }} */ (saved);
    wrap.style.left = Math.min(p.x, window.innerWidth - size) + 'px';
    wrap.style.top = Math.min(p.y, window.innerHeight - size) + 'px';
  } else {
    wrap.style.right = DEFAULT_EDGE_OFFSET_PX + 'px';
    wrap.style.bottom = DEFAULT_EDGE_OFFSET_PX + stackOffset + 'px';
  }
};

/** @param {string} key */
const safeJson = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/**
 * Install the fleet-save buttons. Idempotent — a second call returns the
 * same dispose fn. Gated on `settings.fsCollectMode`; flipping it at
 * runtime mounts/removes both widgets live.
 *
 * @returns {() => void} Dispose handle.
 */
export const installFsCollect = () => {
  if (installed) return installed.dispose;

  const mount = () => {
    if (document.getElementById(MICRO_ID) || document.getElementById(COLLECT_ID)) {
      return;
    }
    const size = settingsStore.get().fsBtnSize;

    // Micro — single button.
    const micro = document.createElement('button');
    micro.type = 'button';
    micro.id = MICRO_ID;
    micro.tabIndex = 0;
    micro.setAttribute('aria-label', 'Send micro-fleets');
    styleSingle(micro, size, BG_MICRO);
    placeWrap(micro, MICRO_POS_KEY, size, size + 12);
    document.body.appendChild(micro);

    // Collect — two halves (top collect, bottom set-target).
    const collect = document.createElement('div');
    collect.id = COLLECT_ID;
    const top = document.createElement('button');
    top.type = 'button';
    top.id = COLLECT_TOP_ID;
    top.tabIndex = 0;
    top.setAttribute('aria-label', 'Collect to target');
    const setHalf = document.createElement('button');
    setHalf.type = 'button';
    setHalf.id = COLLECT_SET_ID;
    setHalf.tabIndex = 0;
    setHalf.setAttribute('aria-label', 'Set collect target');
    styleSplit(collect, [top, setHalf], size, [BG_COLLECT, BG_SET]);
    collect.appendChild(top);
    collect.appendChild(setHalf);
    placeWrap(collect, COLLECT_POS_KEY, size, 0);
    document.body.appendChild(collect);

    // Drag + click wiring.
    const microDrag = installDrag({ element: micro, posKey: MICRO_POS_KEY, dragThreshold: DRAG_THRESHOLD });
    micro.addEventListener('click', (e) => {
      if (microDrag.wasDrag()) { microDrag.resetDrag(); return; }
      e.stopPropagation();
      onMicroClick();
    });

    const collectDrag = installDrag({ element: collect, posKey: COLLECT_POS_KEY, dragThreshold: DRAG_THRESHOLD });
    top.addEventListener('click', (e) => {
      if (collectDrag.wasDrag()) { collectDrag.resetDrag(); return; }
      e.stopPropagation();
      onCollectClick();
    });
    setHalf.addEventListener('click', (e) => {
      if (collectDrag.wasDrag()) { collectDrag.resetDrag(); return; }
      e.stopPropagation();
      onSetTargetClick();
    });

    installFocusPersist({ button: micro, focusKey: FOCUS_KEY, focusValue: 'fs-micro' });
    installFocusPersist({ button: top, focusKey: FOCUS_KEY, focusValue: 'fs-collect' });

    refresh();
  };

  const removeButtons = () => {
    document.getElementById(MICRO_ID)?.remove();
    document.getElementById(COLLECT_ID)?.remove();
  };

  /**
   * Live-resize the mounted widgets. Only width/height/font-size change —
   * NOT the full cssText — so a dragged position survives a size change.
   *
   * @param {number} size
   */
  const updateSize = (size) => {
    const fontSize = Math.round(size * 0.14) + 'px';
    const micro = document.getElementById(MICRO_ID);
    if (micro) {
      micro.style.width = size + 'px';
      micro.style.height = size + 'px';
      micro.style.fontSize = fontSize;
    }
    const collect = document.getElementById(COLLECT_ID);
    if (collect) {
      collect.style.width = size + 'px';
      collect.style.height = size + 'px';
    }
    const top = document.getElementById(COLLECT_TOP_ID);
    const setHalf = document.getElementById(COLLECT_SET_ID);
    if (top) top.style.fontSize = fontSize;
    if (setHalf) setHalf.style.fontSize = fontSize;
    refresh();
  };

  const initial = settingsStore.get();
  if (initial.fsCollectMode) {
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', () => {
      if (installed && settingsStore.get().fsCollectMode) mount();
    }, { once: true });
  }

  let prevMode = initial.fsCollectMode;
  let prevSize = initial.fsBtnSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fsCollectMode !== prevMode) {
      if (next.fsCollectMode) { if (document.body) mount(); }
      else removeButtons();
      prevMode = next.fsCollectMode;
    }
    if (next.fsBtnSize !== prevSize) {
      updateSize(next.fsBtnSize);
      prevSize = next.fsBtnSize;
    }
  });

  const unsubRoutes = fsRoutesStore.subscribe(() => refresh());

  installed = {
    dispose: () => {
      removeButtons();
      unsubSettings();
      unsubRoutes();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset — runs dispose and clears the busy flag so each case
 * starts clean.
 *
 * @returns {void}
 */
export const _resetFsCollectForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  busy = false;
};

// Re-export the pure pipeline pieces some tests import via the feature
// entry point (mirrors sendCol re-exporting derive/render).
export { refresh as _refreshForTest };
