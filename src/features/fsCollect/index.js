// @ts-check

// Fleet-save micro-fleet feature — ONE unified floating button that automates the
// "park the fleet on a moon, scatter micro-fleets to the planets, then
// pull everything back" workflow.
//
// # The unified button — two zones
//
// A single circular button split into two equal-height zones, stacked vertically:
//
//   - TOP (Send): from the current MOON, send a fixed micro-fleet
//     (Stacjonuj / mission=4) to each target defined for that moon in the routes
//     config, skipping targets that already have a deployment inbound. Ships are
//     preloaded via the fleetdispatch URL `am<shipId>=count` param, so the page
//     lands on fleet step 1 with the micro-fleet already selected. With no route
//     for the current body, a tap opens the dashboard's route-setup tab instead.
//   - BOTTOM (Collect): TAP sends EVERYTHING (all ships + all resources) from the
//     current planet back to the ad-hoc collect target. LONG-PRESS (300ms+) marks
//     the body you're standing on as that collect target. The label shows the
//     current target so it's clear where a collect run goes.
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
import { parseUniverseId } from '../../lib/universeId.js';
import {
  fsRoutesStore,
  flushFsRoutesStore,
  stampFsRoutesChanged,
  FS_REDIRECT_KEY,
} from '../../state/fsRoutes.js';
import {
  createButton as makeButton,
  LABEL_CLASS,
  renderLines,
  labelLines,
} from '../shared/button.js';
import {
  select as courierSelect,
  dispatch as courierDispatch,
  step as courierStep,
  readyToDispatch,
  installFleetCourier,
} from '../shared/fleetCourier.js';
import { MISSION_DEPLOYMENT } from '../../domain/rules.js';
import {
  coordKey,
  coordTypeKey,
  findRouteForBody,
  findNextMicroTarget,
  countRemainingMicroTargets,
} from './pure.js';
import {
  readCurrentBody,
  readDeployLegs,
  findNextCollectPlanetCp,
  bodyNameByCoord,
} from './domHelpers.js';

// ─── DOM ids / storage keys ─────────────────────────────────────────────

const FS_UNIFIED_ID = 'oge-fs-unified';
const FS_MICRO_ZONE_ID = 'oge-fs-micro-zone';
const FS_COLLECT_ZONE_ID = 'oge-fs-collect-zone';

const FS_POS_KEY = 'oge_fsUnifiedPos';
const FOCUS_KEY = 'oge_focusedBtn';

const DRAG_THRESHOLD = 8;
const DEFAULT_EDGE_OFFSET_PX = 20;
const FLASH_MS = 1500;
const SENT_LOCK_MS = 3000;
const LONG_PRESS_MS = 3000;

// Colours — distinct from sendExp (blue #4aa8ff) / sendCol (cyan #13d1de).
// Daily Run uses pure green: micro & collect both in green family (minimal difference).
const BG_MICRO = '#34d96e';   // green rim (micro zone)
const BG_COLLECT = '#43cf72'; // green rim (collect zone, slightly brighter)

// ─── helpers (impure env reads) ─────────────────────────────────────────

const gameBase = () => location.href.split('?')[0];
/** @param {string} name */
const urlParam = (name) => new URLSearchParams(location.search).get(name);
/** Bare fleetdispatch URL (no ship/target params — the courier sets those
 * in-page), optionally pinned to a planet via `cp`.
 * @param {string | null} [cp] */
const bareFleetdispatchUrl = (cp) =>
  gameBase() + '?page=ingame&component=fleetdispatch' + (cp ? `&cp=${cp}` : '');
/** "→ g:s:p 🪐/🌙" label for a target coord.
 * @param {import('../../state/fsRoutes.js').TargetCoord | null | undefined} t */
const targetLabel = (t) =>
  t ? `→ ${t.galaxy}:${t.system}:${t.position} ${t.type === 3 ? '🌙' : '🪐'}` : '';

/** Like {@link targetLabel} but prefers the body's NAME (resolved from the
 * live planet list) over its coords — used by the "Send All" collect zone.
 * Falls back to coords when the name can't be resolved.
 * @param {import('../../state/fsRoutes.js').TargetCoord | null | undefined} t */
const collectTargetLabel = (t) => {
  if (!t) return '';
  const name = bodyNameByCoord(t);
  return name ? `→ ${name} ${t.type === 3 ? '🌙' : '🪐'}` : targetLabel(t);
};

/**
 * URL of the OG-E Dashboard extension page, resolved once via
 * `browser/chrome.runtime.getURL`. Empty string when the WebExtension
 * runtime API isn't present (test environments) — {@link openDashboardRoutes}
 * guards on this. Mirrors the resolver in `settingsUi/sections/data.js`
 * (kept local — a feature must not import another feature).
 *
 * @type {string}
 */
const DASHBOARD_URL = (() => {
  try {
    const g = /** @type {any} */ (/** @type {unknown} */ (globalThis));
    const ns = g.browser ?? g.chrome;
    const url = ns?.runtime?.getURL?.('dashboard.html');
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
})();

/**
 * Open the Dashboard's Daily Run tab in a new tab, pre-selecting the
 * current universe (`?host=`) and deep-linking the routes tab (`?tab=routes`).
 * No-op (returns false) when the runtime URL is unavailable, so the caller
 * can fall back to an in-place hint.
 *
 * @returns {boolean} Whether the dashboard was opened.
 */
const openDashboardRoutes = () => {
  if (!DASHBOARD_URL) return false;
  const universeId = parseUniverseId(location.host);
  const url =
    DASHBOARD_URL +
    (universeId ? `?host=${encodeURIComponent(universeId)}&tab=routes` : '?tab=routes');
  window.open(url, '_blank');
  return true;
};

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
 * Paint a zone with up to three lines: main text, optional subtitle below,
 * optional micro-hint at the bottom. Renders through the SHARED
 * {@link renderLines} + {@link labelLines} so this button reads exactly
 * like sendCol / sendExp (one source of truth for the font sizes).
 *
 * @param {HTMLElement | null} el
 * @param {string} big
 * @param {string} [small]   subtitle below main
 * @param {string} [hint]    micro-hint at bottom (low-weight)
 * @returns {void}
 */
const setLabel = (el, big, small, hint) => {
  if (!el) return;
  // Paint into the shared Button's label span so the ring/ripple
  // decoration (on the wrap) survives; fall back to the element itself.
  const target = el.querySelector('.' + LABEL_CLASS) || el;
  renderLines(
    /** @type {HTMLElement} */ (target),
    labelLines({ main: big, sub: small, hint }),
  );
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
  safeWrite(bareFleetdispatchUrl(urlParam('cp')));
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
  // Bare fleetdispatch on the next planet still needing collection; the
  // courier re-selects + re-targets there on the next tap (the collect
  // target comes from the store, not the URL).
  safeWrite(bareFleetdispatchUrl(nextCp));
};

/** @param {string} url */
const safeWrite = (url) => {
  try {
    localStorage.setItem(FS_REDIRECT_KEY, url);
  } catch {
    // Private mode / quota — the send still works, just no auto-redirect.
  }
};

/** Drop a stashed redirect (the send was rejected, so no navigation). */
const clearRedirectStash = () => {
  try {
    localStorage.removeItem(FS_REDIRECT_KEY);
  } catch {
    // ignore
  }
};

/** Short label for a rejected sendFleet, by error code.
 * @param {number | null | undefined} code */
const sendErrorLabel = (code) => (code === 140026 ? 'No fuel' : 'Failed');

// ─── click handlers ─────────────────────────────────────────────────────

/** @type {boolean} */
let busy = false;
/**
 * The order whose select() succeeded and is now ready to dispatch — set on
 * tap 1, consumed on tap 2 to stash the right post-send redirect. `null`
 * when no select is currently armed.
 *
 * @type {{ mode: 'micro' | 'collect', target: import('../../state/fsRoutes.js').TargetCoord } | null}
 */
let pending = null;

/**
 * Build the {@link import('../shared/fleetCourier.js').FleetOrder} for a
 * zone, or a `{ flash }` describing why we can't. Micro → the route's
 * single-ship fleet (frac 1) to the next un-sent target; Collect → all
 * ships to the stored collect target.
 *
 * @param {'micro' | 'collect'} mode
 * @returns {{ order: import('../shared/fleetCourier.js').FleetOrder } | { flash: string, openDash?: boolean }}
 */
const buildOrder = (mode) => {
  if (mode === 'micro') {
    const route = findRouteForBody(fsRoutesStore.get().routes, readCurrentBody());
    if (!route) return { flash: 'No route', openDash: true };
    const next = findNextMicroTarget(route.targets, microInFlightKeys());
    if (!next) return { flash: 'All sent' };
    const f = route.microFleet;
    return {
      order: {
        spec: { kind: 'list', ships: [{ id: Number(f.shipId), qty: Number(f.count), frac: 1 }] },
        target: next,
        mission: MISSION_DEPLOYMENT,
      },
    };
  }
  const target = fsRoutesStore.get().collectTarget;
  if (!target) return { flash: 'No target' };
  return { order: { spec: { kind: 'all' }, target, mission: MISSION_DEPLOYMENT, resources: 'all' } };
};

/**
 * Map a courier failure reason to a short, standardised zone flash.
 *
 * @param {string | undefined} reason
 * @returns {string}
 */
const reasonLabel = (reason) => {
  switch (reason) {
    case 'noShips': return 'No ships';
    case 'empty': return 'No ships';
    case 'noShip': return 'No ship';
    case 'noMoon': return 'No moon';
    case 'reserved': return 'Reserved';
    case 'mission': return 'Bad target';
    case 'timeout': return 'Timeout';
    case 'notReady': return 'Wait…';
    default: return 'Error';
  }
};

/**
 * Unified two-tap handler for both zones. Branches on the live fleetdispatch
 * step (read from the DOM via the courier), NOT on URL params:
 *   • off fleetdispatch → navigate to a bare fleetdispatch (the courier
 *     selects the fleet + target in-page; no second reload);
 *   • step 1 → tap 1 "Wybór": select the fleet + target, walk to a ready
 *     step 2 (label sits on "Wait…" until the game marks dispatch ready);
 *   • step 2 + ready → tap 2 "Wysłanie": stash the post-send redirect and
 *     fire the one server-visible action (dispatch).
 *
 * @param {'micro' | 'collect'} mode
 * @returns {Promise<void>}
 */
const handleZone = async (mode) => {
  if (busy) return;
  const zoneId = mode === 'micro' ? FS_MICRO_ZONE_ID : FS_COLLECT_ZONE_ID;
  const zone = document.getElementById(zoneId);
  const s = courierStep();

  // Tap 2 — dispatch (only when the game says it's ready). The redirect is
  // stashed BEFORE the click (deployRedirect consumes it on the send-phase);
  // we await the game's result and, on a rejected send (e.g. no fuel), drop
  // that stash and surface the error instead of a false "Sent".
  if (s === 'fleet2') {
    if (!readyToDispatch()) return;
    if (mode === 'micro') stashMicroRedirect();
    else stashCollectRedirect(fsRoutesStore.get().collectTarget);
    busy = true;
    setLabel(zone, 'Wait…');
    dimZone(zone, true);
    const r = await courierDispatch();
    if (!r.ok) {
      clearRedirectStash();
      busy = false;
      dimZone(zone, false);
      flash(zone, sendErrorLabel(r.errorCode));
      return;
    }
    // Success → the game navigates via the stashed redirect; keep the zone
    // locked (greyed) until that reload settles.
    setLabel(zone, 'Sent');
    pending = null;
    lockBriefly(zone);
    return;
  }

  // Off fleetdispatch — go there (bare); the next tap selects in-page.
  if (s === 'off') {
    const built = buildOrder(mode);
    if ('flash' in built) {
      if (built.openDash && openDashboardRoutes()) return;
      flash(zone, built.flash);
      return;
    }
    location.href = bareFleetdispatchUrl();
    return;
  }

  // Tap 1 — select the fleet + target and prepare a ready step 2.
  const built = buildOrder(mode);
  if ('flash' in built) {
    if (built.openDash && openDashboardRoutes()) return;
    flash(zone, built.flash);
    return;
  }
  busy = true;
  setLabel(zone, 'Wait…');
  dimZone(zone, true);
  const r = await courierSelect(built.order);
  busy = false;
  dimZone(zone, false);
  if (!r.ok) {
    flash(zone, reasonLabel(r.reason));
    return;
  }
  pending = { mode, target: built.order.target };
  refresh();
};

const onMicroClick = () => void handleZone('micro');
const onCollectClick = () => void handleZone('collect');

/** Grey a zone out (or restore it) to show it's working / locked.
 * @param {HTMLElement | null} zone @param {boolean} on */
const dimZone = (zone, on) => {
  if (zone) zone.style.opacity = on ? '0.5' : '1';
};

/**
 * Collect-zone LONG-PRESS. Mark the body you're currently on as the ad-hoc
 * collect target and persist it immediately.
 *
 * @returns {void}
 */
const onSetTargetClick = () => {
  const collectZone = document.getElementById(FS_COLLECT_ZONE_ID);
  const body = readCurrentBody();
  if (!body) {
    flash(collectZone, '?');
    return;
  }
  fsRoutesStore.update((prev) => ({ ...prev, collectTarget: body }));
  // Persist now — the user may navigate away before the debounce fires.
  flushFsRoutesStore();
  // Stamp the cross-device sync clock so this collect-target change wins
  // the next whole-universe newest-wins merge.
  void stampFsRoutesChanged();
  refresh();
};

/** Briefly lock (and grey) a zone while a dispatch + reload settles.
 * @param {HTMLElement | null} [zone] */
const lockBriefly = (zone) => {
  busy = true;
  dimZone(zone ?? null, true);
  setTimeout(() => {
    busy = false;
    dimZone(zone ?? null, false);
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
  const collectZone = document.getElementById(FS_COLLECT_ZONE_ID);
  const onF2Ready = courierStep() === 'fleet2' && readyToDispatch();

  // DISPATCH (top / micro) label.
  if (microZone) {
    const route = findRouteForBody(fsRoutesStore.get().routes, readCurrentBody());
    if (!route) {
      setLabel(microZone, 'Setup', undefined, '(no routes)');
    } else if (onF2Ready && pending && pending.mode === 'micro') {
      setLabel(microZone, 'Send', collectTargetLabel(pending.target), '(tap to send)');
    } else {
      const inflight = microInFlightKeys();
      const next = findNextMicroTarget(route.targets, inflight);
      if (!next) {
        setLabel(microZone, 'Done', undefined, 'all sent');
      } else {
        const left = countRemainingMicroTargets(route.targets, inflight);
        setLabel(microZone, 'Send', collectTargetLabel(next), `${left} left`);
      }
    }
  }

  // Send All (bottom / collect) label — TAP sends, LONG-PRESS sets target.
  if (collectZone) {
    const t = fsRoutesStore.get().collectTarget;
    if (!t) {
      setLabel(collectZone, 'Send All', undefined, '(hold to set target)');
    } else if (onF2Ready && pending && pending.mode === 'collect') {
      setLabel(collectZone, 'Send All', collectTargetLabel(t), '(tap to send)');
    } else {
      setLabel(collectZone, 'Send All', collectTargetLabel(t), '(hold to change)');
    }
  }
};

// ─── mount / dispose ────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the unified fleet-save button. Idempotent — a second call returns the
 * same dispose fn. Gated on `settings.fsCollectMode`; flipping it at
 * runtime mounts/removes the widget live.
 *
 * @returns {() => void} Dispose handle.
 */
export const installFsCollect = () => {
  if (installed) return installed.dispose;

  // Ensure the shared courier is caching the fleetDispatcher snapshot (ship
  // availability) so select() can resolve the fleet.
  installFleetCourier();

  /**
   * The shared {@link makeButton} controller — owns geometry, placement,
   * the engraved ring, drag, the collect-zone long-press + sweep, and
   * focus persistence. `null` until mounted.
   *
   * @type {import('../shared/button.js').Button | null}
   */
  let controller = null;

  const mount = () => {
    // Already mounted → keep the live controller (makeButton returns null).
    if (document.getElementById(FS_UNIFIED_ID)) return;

    const size = settingsStore.get().fsBtnSize;
    controller = makeButton({
      id: FS_UNIFIED_ID,
      title: 'Daily Run',
      ringId: 'oge-ring-fs',
      size,
      // Matches sendCol so identical `em` labels render at identical px.
      fontScale: 0.12,
      posKey: FS_POS_KEY,
      focusKey: FOCUS_KEY,
      edgeOffset: DEFAULT_EDGE_OFFSET_PX,
      dragThreshold: DRAG_THRESHOLD,
      holdMs: LONG_PRESS_MS,
      zones: [
        {
          key: 'micro',
          id: FS_MICRO_ZONE_ID,
          ariaLabel: 'Send micro-fleets',
          bg: BG_MICRO,
          onTap: onMicroClick,
          focusValue: 'fs-unified-micro',
          labelShiftY: 10,
        },
        {
          // TAP collects; LONG-PRESS (onHold) sets the collect target.
          key: 'collect',
          id: FS_COLLECT_ZONE_ID,
          ariaLabel:
            'Tap to collect; long-press to set the collect target',
          bg: BG_COLLECT,
          onTap: onCollectClick,
          onHold: onSetTargetClick,
          focusValue: 'fs-unified-collect',
          labelShiftY: -10,
        },
      ],
    });
    if (!controller) return;

    // Initial paint.
    refresh();
  };

  const removeButton = () => {
    controller?.dispose();
    controller = null;
  };

  /**
   * Live-resize the mounted button. Only width/height/font-size change —
   * NOT the full cssText — so a dragged position survives a size change.
   *
   * @param {number} size
   */
  const updateSize = (size) => {
    controller?.resize(size);
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

  // 1 Hz repaint ticker — keeps "N left" counter in sync even if OGame populates
  // #eventContent after our initial refresh.
  const tickerHandle = setInterval(refresh, 1000);

  installed = {
    dispose: () => {
      removeButton();
      unsubSettings();
      unsubRoutes();
      clearInterval(tickerHandle);
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
