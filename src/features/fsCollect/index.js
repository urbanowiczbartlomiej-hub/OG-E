// @ts-check

// Fleet-save micro-fleet feature — ONE unified floating button that automates the
// "park the fleet on a moon, scatter micro-fleets to the planets, then
// pull everything back" workflow.
//
// # The unified button — three zones
//
// A single circular button divided into three equal-height zones, stacked vertically:
//
//   - TOP (Micro): from the current MOON, send a fixed micro-fleet
//     (Stacjonuj / mission=4) to each target defined for that moon in the routes
//     config, skipping targets that already have a deployment inbound. Ships are
//     preloaded via the fleetdispatch URL `am<shipId>=count` param, so the page
//     lands on fleet step 1 with the micro-fleet already selected.
//   - MIDDLE (Target): long-press (300ms+) to mark the current body as the
//     ad-hoc collect target, shown as "galaxy:system:position". Single-tap
//     navigates to the target page.
//   - BOTTOM (Collect): from the current planet send EVERYTHING (all ships +
//     all resources) back to the ad-hoc collect target.
//
// # Two-tap send model (TOS-safe: one click → one originated request)
//
// On the fleetdispatch page each zone drives the game's own two-step
// form one tap at a time (the zone shows "Send", then "Next"/"Send"):
//   - first tap → (collect: select all ships) → click Continue,
//     wait for step 2.
//   - second tap → (collect: load all resources) → stash the post-send
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
// @see ../shared/draggableButton.js — drag + focus persistence.

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
  findRouteForBody,
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

const FS_UNIFIED_ID = 'oge-fs-unified';
const FS_MICRO_ZONE_ID = 'oge-fs-micro-zone';
const FS_TARGET_ZONE_ID = 'oge-fs-target-zone';
const FS_COLLECT_ZONE_ID = 'oge-fs-collect-zone';

const FS_POS_KEY = 'oge_fsUnifiedPos';
const FOCUS_KEY = 'oge_focusedBtn';

const DRAG_THRESHOLD = 8;
const DEFAULT_EDGE_OFFSET_PX = 20;
const FLASH_MS = 1500;
const SENT_LOCK_MS = 3000;
const LONG_PRESS_MS = 300;

// Colours — distinct from sendExp (blue) / sendCol (green/teal).
const BG_MICRO = '#7b3fa0'; // violet
const BG_TARGET = '#333'; // dark gray
const BG_COLLECT = '#1f6f6f'; // teal-dark

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
 * Paint a zone with up to three lines: optional top caption, main text,
 * optional bottom hint (shown dimmer and smaller than the top caption).
 *
 * @param {HTMLElement | null} el
 * @param {string} big
 * @param {string} [small]   top caption (0.5em, 85% opacity)
 * @param {string} [hint]    bottom hint (0.42em, 55% opacity)
 * @returns {void}
 */
const setLabel = (el, big, small, hint) => {
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
  const middle = document.createElement('div');
  middle.textContent = big;
  middle.style.cssText = 'font-size:1em;margin-top:2px;';
  wrap.appendChild(middle);
  if (hint) {
    const bot = document.createElement('div');
    bot.textContent = hint;
    bot.style.cssText = 'font-size:0.42em;opacity:0.55;margin-top:1px;letter-spacing:0.3px;';
    wrap.appendChild(bot);
  }
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
 * TOP zone (Send) click. Idle/elsewhere → navigate to the next target for the
 * current source's route. On fleetdispatch → two-tap drive (Send → Next).
 *
 * @returns {void}
 */
const onMicroClick = () => {
  if (busy) return;
  const microZone = document.getElementById(FS_MICRO_ZONE_ID);

  if (onFleetdispatch()) {
    if (isStep2()) {
      stashMicroRedirect();
      clickDispatch();
      setLabel(microZone, 'Sent');
      lockBriefly();
      return;
    }
    if (urlHasAm()) {
      // Step 1 with the micro-fleet preloaded → advance to step 2.
      clickContinue();
      setLabel(microZone, 'Wait…');
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
  const route = findRouteForBody(fsRoutesStore.get().routes, body);
  if (!route) {
    flash(microZone, 'No route');
    return;
  }
  const next = findNextMicroTarget(route.targets, microInFlightKeys());
  if (!next) {
    flash(microZone, 'All sent');
    return;
  }
  location.href = buildDeployUrl(gameBase(), next, route.microFleet);
};

/**
 * BOTTOM zone (Collect) click. Idle/elsewhere → navigate to the collect
 * target from the current planet. On fleetdispatch → two-tap drive,
 * selecting all ships (step 1) and all resources (step 2).
 *
 * @returns {void}
 */
const onCollectClick = () => {
  if (busy) return;
  const collectZone = document.getElementById(FS_COLLECT_ZONE_ID);
  const target = fsRoutesStore.get().collectTarget;

  if (onFleetdispatch()) {
    if (isStep2()) {
      loadAllResources();
      stashCollectRedirect(target);
      clickDispatch();
      setLabel(collectZone, 'Sent');
      lockBriefly();
      return;
    }
    // Step 1: select all ships, then continue.
    selectAllShips();
    clickContinue();
    setLabel(collectZone, 'Wait…');
    busy = true;
    waitForStep2().then(() => {
      busy = false;
      refresh();
    });
    return;
  }

  if (!target) {
    flash(collectZone, 'No target');
    return;
  }
  location.href = buildCollectUrl(gameBase(), target);
};

/**
 * MIDDLE zone (Target) long-press. Mark the body you're currently on as the
 * ad-hoc collect target and persist it immediately.
 *
 * @returns {void}
 */
const onSetTargetClick = () => {
  const targetZone = document.getElementById(FS_TARGET_ZONE_ID);
  const body = readCurrentBody();
  if (!body) {
    flash(targetZone, '?');
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

// ─── refresh (repaint unified button) ───────────────────────────────────

/**
 * Recompute and repaint the unified button from current DOM + store state.
 *
 * @returns {void}
 */
const refresh = () => {
  const microZone = document.getElementById(FS_MICRO_ZONE_ID);
  const targetZone = document.getElementById(FS_TARGET_ZONE_ID);
  const collectZone = document.getElementById(FS_COLLECT_ZONE_ID);

  // Send (top zone) label.
  if (microZone) {
    if (onFleetdispatch() && isStep2()) {
      setLabel(microZone, 'Send', 'send');
    } else if (onFleetdispatch() && urlHasAm()) {
      setLabel(microZone, 'Next', 'send');
    } else {
      const body = readCurrentBody();
      const route = findRouteForBody(fsRoutesStore.get().routes, body);
      if (!route) {
        setLabel(microZone, 'Send', 'no route');
      } else {
        const left = countRemainingMicroTargets(route.targets, microInFlightKeys());
        setLabel(microZone, left > 0 ? `${left}` : '✓', 'send');
      }
    }
  }

  // Target (middle zone) label — shows current collect target + long-press hint.
  if (targetZone) {
    const t = fsRoutesStore.get().collectTarget;
    setLabel(targetZone, t ? `${t.galaxy}:${t.system}:${t.position}` : '—', 'target', 'hold to set');
  }

  // Collect (bottom zone) label.
  if (collectZone) {
    if (onFleetdispatch() && isStep2()) {
      setLabel(collectZone, 'Send', 'collect');
    } else if (onFleetdispatch()) {
      setLabel(collectZone, 'Next', 'collect');
    } else {
      setLabel(collectZone, 'Collect');
    }
  }
};

// ─── mount / dispose ────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

// Middle (target) zone is visually smaller — it's rarely interacted with and
// serves mainly as a status display for the collect target.
const ZONE_FLEX = [1.15, 0.7, 1.15];
/** @param {number} size @param {number} i */
const zoneFontSize = (size, i) =>
  Math.round(size * (i === 1 ? 0.11 : 0.14)) + 'px';

/**
 * Style the unified three-zone circular button. The wrapper defines the
 * outer circle geometry, and each zone (micro/target/collect) is a flex
 * child. The middle (target) zone takes less space and uses a smaller font.
 *
 * @param {HTMLElement} wrap
 * @param {HTMLElement[]} zones  [microZone, targetZone, collectZone]
 * @param {number} size
 * @param {string[]} bgs  one bg per zone
 * @returns {void}
 */
const styleThreeZone = (wrap, zones, size, bgs) => {
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
  zones.forEach((z, i) => {
    z.style.cssText = [
      `flex:${ZONE_FLEX[i]}`,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'text-align:center',
      'color:#fff',
      'font-weight:bold',
      'border:none',
      'cursor:pointer',
      `font-size:${zoneFontSize(size, i)}`,
      `background:${bgs[i]}`,
    ].join(';');
  });
};

/**
 * Restore a saved drag position onto `wrap`, else anchor bottom-right.
 *
 * @param {HTMLElement} wrap
 * @param {string} posKey
 * @param {number} size
 * @returns {void}
 */
const placeWrap = (wrap, posKey, size) => {
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
    wrap.style.bottom = DEFAULT_EDGE_OFFSET_PX + 'px';
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
 * Install the unified fleet-save button. Idempotent — a second call returns the
 * same dispose fn. Gated on `settings.fsCollectMode`; flipping it at
 * runtime mounts/removes the widget live.
 *
 * @returns {() => void} Dispose handle.
 */
export const installFsCollect = () => {
  if (installed) return installed.dispose;

  /** @type {ReturnType<import('../shared/draggableButton.js').installDrag> | null} */
  let dragHandle = null;
  /** @type {number | null} */
  let longPressTimer = null;

  const mount = () => {
    if (document.getElementById(FS_UNIFIED_ID)) {
      return;
    }
    const size = settingsStore.get().fsBtnSize;

    // Create wrapper and three zones.
    const wrap = document.createElement('div');
    wrap.id = FS_UNIFIED_ID;

    const microZone = document.createElement('button');
    microZone.type = 'button';
    microZone.id = FS_MICRO_ZONE_ID;
    microZone.tabIndex = 0;
    microZone.setAttribute('aria-label', 'Send micro-fleets');

    const targetZone = document.createElement('button');
    targetZone.type = 'button';
    targetZone.id = FS_TARGET_ZONE_ID;
    targetZone.tabIndex = 0;
    targetZone.setAttribute('aria-label', 'Set or view collect target (long-press)');

    const collectZone = document.createElement('button');
    collectZone.type = 'button';
    collectZone.id = FS_COLLECT_ZONE_ID;
    collectZone.tabIndex = 0;
    collectZone.setAttribute('aria-label', 'Collect to target');

    styleThreeZone(wrap, [microZone, targetZone, collectZone], size, [BG_MICRO, BG_TARGET, BG_COLLECT]);
    wrap.appendChild(microZone);
    wrap.appendChild(targetZone);
    wrap.appendChild(collectZone);
    placeWrap(wrap, FS_POS_KEY, size);
    document.body.appendChild(wrap);

    // Install drag on the outer wrapper.
    dragHandle = installDrag({ element: wrap, posKey: FS_POS_KEY, dragThreshold: DRAG_THRESHOLD });

    // Micro zone — regular click.
    microZone.addEventListener('click', (e) => {
      if (dragHandle?.wasDrag()) { dragHandle.resetDrag(); return; }
      e.stopPropagation();
      onMicroClick();
    });

    // Target zone — long-press sets target, regular click ignored (or navigates to target).
    targetZone.addEventListener('pointerdown', (e) => {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        onSetTargetClick();
      }, LONG_PRESS_MS);
    });
    targetZone.addEventListener('pointerup', () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });
    targetZone.addEventListener('pointercancel', () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });
    targetZone.addEventListener('click', (e) => {
      if (dragHandle?.wasDrag()) { dragHandle.resetDrag(); return; }
      e.stopPropagation();
      // Regular click does nothing for now (target-only shows via label).
    });

    // Collect zone — regular click.
    collectZone.addEventListener('click', (e) => {
      if (dragHandle?.wasDrag()) { dragHandle.resetDrag(); return; }
      e.stopPropagation();
      onCollectClick();
    });

    installFocusPersist({ button: microZone, focusKey: FOCUS_KEY, focusValue: 'fs-unified-micro' });
    installFocusPersist({ button: targetZone, focusKey: FOCUS_KEY, focusValue: 'fs-unified-target' });
    installFocusPersist({ button: collectZone, focusKey: FOCUS_KEY, focusValue: 'fs-unified-collect' });

    refresh();
  };

  const removeButton = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    document.getElementById(FS_UNIFIED_ID)?.remove();
  };

  /**
   * Live-resize the mounted button. Only width/height/font-size change —
   * NOT the full cssText — so a dragged position survives a size change.
   *
   * @param {number} size
   */
  const updateSize = (size) => {
    const wrap = document.getElementById(FS_UNIFIED_ID);
    if (wrap) {
      wrap.style.width = size + 'px';
      wrap.style.height = size + 'px';
    }
    const zoneIds = [FS_MICRO_ZONE_ID, FS_TARGET_ZONE_ID, FS_COLLECT_ZONE_ID];
    zoneIds.forEach((id, i) => {
      const z = document.getElementById(id);
      if (z) z.style.fontSize = zoneFontSize(size, i);
    });
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
      else removeButton();
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
      removeButton();
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
