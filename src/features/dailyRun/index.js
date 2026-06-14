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
//     redirect URL in `oge_dailyRunRedirect` → click the native dispatch button.
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
// @see ../../bridges/deployRedirect.js — consumes `oge_dailyRunRedirect`.
// @see ../shared/draggableButton.js — drag + focus persistence.

import { settingsStore } from '../../state/settings.js';
import { parseUniverseId } from '../../lib/universeId.js';
import {
  dailyRunRoutesStore,
  flushDailyRunRoutesStore,
  stampDailyRunRoutesChanged,
  DAILY_RUN_REDIRECT_KEY,
} from '../../state/dailyRunRoutes.js';
import {
  createButton as makeButton,
  LABEL_CLASS,
  renderLines,
  labelLines,
} from '../shared/button.js';
import { PLANET_ARROW_GLYPH } from '../shared/buttonGlyphs.js';
import {
  select as courierSelect,
  dispatch as courierDispatch,
  step as courierStep,
  readyToDispatch,
  shipAvailability,
  installFleetCourier,
  bareFleetdispatchUrl,
} from '../shared/fleetCourier.js';
import { MISSION_DEPLOYMENT } from '../../domain/rules.js';
import { OWNER_FS } from '../../domain/fleetOwnership.js';
import { mayCompleteFleet2 } from '../shared/fleetOwnership.js';
import { GAME } from '../../lib/gameDom.js';
import { EVENT_BOX_LOADED_EVENT } from '../../lib/ogeEvents.js';
import { resolveSelection } from '../../domain/fleetPlan.js';
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

const FOCUS_KEY = 'oge_focusedBtn';

const FLASH_MS = 1500;
const SENT_LOCK_MS = 3000;
const LONG_PRESS_MS = 2000;

// Colours — distinct from sendExp (blue #4aa8ff) / sendCol (cyan #13d1de).
// Daily Run uses pure green: micro & collect both in green family (minimal difference).
const BG_MICRO = '#34d96e';   // green rim (micro zone)
const BG_COLLECT = '#43cf72'; // green rim (collect zone, slightly brighter)

// ─── Eventbox readiness gate ────────────────────────────────────────────
// OGame fetches the fleet-event list asynchronously, up to a few seconds
// AFTER page load. Until that XHR lands, `#eventContent` has no rows, so
// the DISPATCH label's "next target / N left" would be computed against an
// EMPTY in-flight set — confidently wrong, self-correcting only once the
// rows appear. While the gate is closed the WHOLE button sits in an amber
// "Wait…" (wait pulse, taps just flash) — a micro send picked off stale
// data could duplicate an in-flight deployment, so blocking beats guessing.
// The gate opens when: `#eventContent` already exists at install (we
// loaded after hydration), the `oge:eventBoxLoaded` bridge signal arrives,
// or the safety timeout expires (degrade to the pre-gate behaviour rather
// than wait forever on a changed game URL).
const BG_WAIT = '#fbbf24'; // amber — same wait colour as sendCol/sendExp
const EVENTBOX_SAFETY_TIMEOUT_MS = 6000;
// The bridge's XHR 'load' signal can precede the game's own success
// handler inserting the rows — repaint once more after a settle delay.
const EVENTBOX_SETTLE_MS = 150;

// ─── helpers (impure env reads) ─────────────────────────────────────────

/** @param {string} name */
const urlParam = (name) => new URLSearchParams(location.search).get(name);
/** "→ g:s:p 🪐/🌙" label for a target coord.
 * @param {import('../../state/dailyRunRoutes.js').TargetCoord | null | undefined} t */
const targetLabel = (t) =>
  t ? `→ ${t.galaxy}:${t.system}:${t.position} ${t.type === 3 ? '🌙' : '🪐'}` : '';

/** Like {@link targetLabel} but prefers the body's NAME (resolved from the
 * live planet list) over its coords — used by the "Send All" collect zone.
 * Falls back to coords when the name can't be resolved.
 * @param {import('../../state/dailyRunRoutes.js').TargetCoord | null | undefined} t */
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
 * @param {import('../../state/dailyRunRoutes.js').TargetCoord | null} target
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

// ─── pre-tap availability checks (snapshot-driven, null = unknown) ──────

/**
 * The route's micro-fleet shortfall on the current body, or `null` when the
 * fleet can be filled — or when availability is UNKNOWN (off the
 * fleetdispatch page / no snapshot yet), so the off-page tap still
 * navigates instead of false-flagging "no ships".
 *
 * @param {{ microFleet: { shipId: number | string, count: number | string } }} route
 * @returns {{ have: number, want: number } | null}
 */
const microShortfall = (route) => {
  const avail = shipAvailability();
  if (!avail) return null;
  const f = route.microFleet;
  const sel = resolveSelection(
    { kind: 'list', ships: [{ id: Number(f.shipId), qty: Number(f.count), frac: 1 }] },
    avail,
  );
  if (sel.ok) return null;
  const s = sel.shortfalls[0];
  return { have: s?.have ?? 0, want: s?.want ?? Number(f.count) };
};

/**
 * Whether the current planet has NOTHING for a Send All to take — i.e. the
 * snapshot is present and holds zero ships. `false` when availability is
 * unknown (no snapshot), so off-page behaviour is untouched.
 *
 * @returns {boolean}
 */
const collectPlanetEmpty = () => {
  const avail = shipAvailability();
  return !!avail && !resolveSelection({ kind: 'all' }, avail).ok;
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
 * @param {import('../../state/dailyRunRoutes.js').TargetCoord | null} target
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
    localStorage.setItem(DAILY_RUN_REDIRECT_KEY, url);
  } catch {
    // Private mode / quota — the send still works, just no auto-redirect.
  }
};

/** Drop a stashed redirect (the send was rejected, so no navigation). */
const clearRedirectStash = () => {
  try {
    localStorage.removeItem(DAILY_RUN_REDIRECT_KEY);
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
 * False while the game's async event-list XHR hasn't landed on this page
 * view (see the Eventbox readiness gate constants). Initialised per
 * install; the `true` default keeps standalone `refresh()` paints ungated.
 *
 * @type {boolean}
 */
let eventBoxReady = true;
/**
 * The order whose select() succeeded and is now ready to dispatch — set on
 * tap 1, consumed on tap 2 to stash the right post-send redirect. `null`
 * when no select is currently armed.
 *
 * @type {{ mode: 'micro' | 'collect', target: import('../../state/dailyRunRoutes.js').TargetCoord } | null}
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
    const route = findRouteForBody(dailyRunRoutesStore.get().routes, readCurrentBody());
    if (!route) return { flash: 'No route', openDash: true };
    const next = findNextMicroTarget(route.targets, microInFlightKeys());
    if (!next) return { flash: 'All sent' };
    // Hard gate BEFORE any courier action: a micro-fleet that can't be
    // filled must never start the select→continue walk (the label already
    // says why — see refresh()).
    if (microShortfall(route)) return { flash: 'No ships' };
    const f = route.microFleet;
    return {
      order: {
        spec: { kind: 'list', ships: [{ id: Number(f.shipId), qty: Number(f.count), frac: 1 }] },
        target: next,
        mission: MISSION_DEPLOYMENT,
        owner: OWNER_FS,
      },
    };
  }
  const target = dailyRunRoutesStore.get().collectTarget;
  if (!target) return { flash: 'No target' };
  return {
    order: {
      spec: { kind: 'all' }, target, mission: MISSION_DEPLOYMENT, resources: 'all', owner: OWNER_FS,
    },
  };
};

/**
 * Map a courier failure reason to a short, standardised zone flash.
 *
 * @param {string | undefined} reason
 * @returns {string}
 */
const reasonLabel = (reason) => {
  switch (reason) {
    case 'allFleets': return 'All fleets!';
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
  // Event list not loaded yet — any target/in-flight derivation would run
  // on stale data; the label already says Wait…, the tap just re-flashes it.
  if (!eventBoxReady) {
    flash(zone, 'Wait…');
    return;
  }
  const s = courierStep();

  // Tap 2 — dispatch (only when the game says it's ready). The redirect is
  // stashed BEFORE the click (deployRedirect consumes it on the send-phase);
  // we await the game's result and, on a rejected send (e.g. no fuel), drop
  // that stash and surface the error instead of a false "Sent".
  if (s === 'fleet2') {
    // Ownership gate (T5): treat fleet2 as "our tap 2" only when our own
    // tap 1 armed it (pending) AND the ownership session still names us.
    // Anything else — the player's manual send, AGR's routine, another OG-E
    // button — must not be dispatched from here: block and route to a bare
    // fleetdispatch so the next tap starts from a clean fleet1.
    if (!pending || !mayCompleteFleet2(OWNER_FS).allowed) {
      location.href = bareFleetdispatchUrl();
      return;
    }
    if (!readyToDispatch()) return;
    if (mode === 'micro') stashMicroRedirect();
    else stashCollectRedirect(dailyRunRoutesStore.get().collectTarget);
    busy = true;
    setLabel(zone, 'Wait…');
    dimZone(zone, true);
    const r = await courierDispatch(OWNER_FS);
    if (!r.ok) {
      clearRedirectStash();
      // Belt-and-braces: the gate above already vetted ownership, but keep
      // the courier's own refusal mapped to the same recovery as sendCol.
      if (r.reason === 'foreign') {
        location.href = bareFleetdispatchUrl();
        return;
      }
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
  // Send All on an EMPTY planet: nothing to take here, so instead of a dead
  // "No ships" the tap accepts the jump the label proposes — straight to the
  // next planet still needing collection (same walk as the post-send
  // redirect). Nothing left → everything is collected.
  if (mode === 'collect' && collectPlanetEmpty()) {
    const target = dailyRunRoutesStore.get().collectTarget;
    const nextCp = target
      ? findNextCollectPlanetCp(collectedOriginKeys(target), coordKey(target))
      : null;
    if (!nextCp) {
      flash(zone, 'All done');
      return;
    }
    location.href = bareFleetdispatchUrl(nextCp);
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
  dailyRunRoutesStore.update((prev) => ({ ...prev, collectTarget: body }));
  // Persist now — the user may navigate away before the debounce fires.
  flushDailyRunRoutesStore();
  // Stamp the cross-device sync clock so this collect-target change wins
  // the next whole-universe newest-wins merge.
  void stampDailyRunRoutesChanged();
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
 * Reflect the eventbox gate on the button: while the event list hasn't
 * loaded, BOTH zones (and the host glow) go amber with a wait pulse and a
 * "Wait…" label; once it lands, the per-zone greens are restored and the
 * pulse stops. Rim is set directly on the live elements (the controller is
 * closure-scoped to the installer); the host carries the `data-flag`.
 *
 * @param {HTMLElement | null} microZone
 * @param {HTMLElement | null} collectZone
 * @returns {void}
 */
const paintEventBoxGate = (microZone, collectZone) => {
  const wait = !eventBoxReady;
  const host = document.getElementById(FS_UNIFIED_ID);
  if (host) {
    if (wait) host.dataset.flag = 'wait';
    else if (host.dataset.flag === 'wait') delete host.dataset.flag;
    host.style.setProperty('--rim', wait ? BG_WAIT : BG_MICRO);
  }
  if (microZone) microZone.style.setProperty('--rim', wait ? BG_WAIT : BG_MICRO);
  if (collectZone) collectZone.style.setProperty('--rim', wait ? BG_WAIT : BG_COLLECT);
  if (wait) {
    setLabel(microZone, 'Wait…', undefined, '(event list)');
    setLabel(collectZone, 'Wait…', undefined, '(event list)');
  }
};

/**
 * Recompute and repaint the unified button from current DOM + store state.
 *
 * @returns {void}
 */
const refresh = () => {
  const microZone = document.getElementById(FS_MICRO_ZONE_ID);
  const collectZone = document.getElementById(FS_COLLECT_ZONE_ID);
  paintEventBoxGate(microZone, collectZone);
  if (!eventBoxReady) return;
  const onF2Ready = courierStep() === 'fleet2' && readyToDispatch();

  // DISPATCH (top / micro) label.
  if (microZone) {
    const route = findRouteForBody(dailyRunRoutesStore.get().routes, readCurrentBody());
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
        const short = microShortfall(route);
        if (short) {
          // Not enough ships for the micro-fleet — say so persistently
          // (and buildOrder blocks the tap with the same message).
          setLabel(microZone, 'No ships', `${short.have}/${short.want}`, '(micro-fleet short)');
        } else {
          const left = countRemainingMicroTargets(route.targets, inflight);
          setLabel(microZone, 'Send', collectTargetLabel(next), `${left} left`);
        }
      }
    }
  }

  // Send All (bottom / collect) label — TAP sends, LONG-PRESS sets target.
  if (collectZone) {
    const t = dailyRunRoutesStore.get().collectTarget;
    if (!t) {
      setLabel(collectZone, 'Send All', undefined, '(hold to set target)');
    } else if (onF2Ready && pending && pending.mode === 'collect') {
      setLabel(collectZone, 'Send All', collectTargetLabel(t), '(tap to send)');
    } else if (collectPlanetEmpty()) {
      // Nothing to take here — propose the jump; the tap performs it
      // (see handleZone). Mirrors the post-send "advance to the next
      // planet" flow, just without a send.
      setLabel(collectZone, 'Empty', '→ next planet', '(tap to jump)');
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
 * same dispose fn. Gated on `settings.fabMode`; flipping it at
 * runtime mounts/removes the widget live.
 *
 * @returns {() => void} Dispose handle.
 */
export const installDailyRun = () => {
  if (installed) return installed.dispose;

  // Ensure the shared courier is caching the fleetDispatcher snapshot (ship
  // availability) so select() can resolve the fleet.
  installFleetCourier();

  // Eventbox readiness gate — see the constants block for the rationale.
  // `#eventContent` already present means the list hydrated before we
  // installed; otherwise wait for the bridge signal (every eventbox
  // refresh also re-fires it — a free instant repaint) or the safety net.
  eventBoxReady = !!document.querySelector(GAME.EVENT_CONTENT);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let settleTimer = null;
  const onEventBoxLoaded = () => {
    eventBoxReady = true;
    refresh();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(refresh, EVENTBOX_SETTLE_MS);
  };
  document.addEventListener(EVENT_BOX_LOADED_EVENT, onEventBoxLoaded);
  const safetyTimer = setTimeout(() => {
    if (!eventBoxReady) {
      eventBoxReady = true;
      refresh();
    }
  }, EVENTBOX_SAFETY_TIMEOUT_MS);

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

    const size = settingsStore.get().fabBtnSize;
    controller = makeButton({
      id: FS_UNIFIED_ID,
      title: 'Daily Run',
      ringId: 'oge-ring-fs',
      size,
      // Matches sendCol so identical `em` labels render at identical px.
      fontScale: 0.12,
      module: { id: 'fs', name: 'Daily Run', color: BG_MICRO, glyph: PLANET_ARROW_GLYPH },
      focusKey: FOCUS_KEY,
      holdMs: LONG_PRESS_MS,
      zones: [
        {
          key: 'micro',
          id: FS_MICRO_ZONE_ID,
          ariaLabel: 'Send micro-fleets',
          bg: BG_MICRO,
          glyph: PLANET_ARROW_GLYPH,
          onTap: onMicroClick,
          focusValue: 'fs-unified-micro',
          labelShiftY: -14,
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
          labelShiftY: 14,
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
  if (initial.fabMode) {
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', () => {
      if (installed && settingsStore.get().fabMode) mount();
    }, { once: true });
  }

  let prevMode = initial.fabMode;
  let prevSize = initial.fabBtnSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fabMode !== prevMode) {
      if (next.fabMode) { if (document.body) mount(); }
      else removeButton();
      prevMode = next.fabMode;
    }
    if (next.fabBtnSize !== prevSize) {
      updateSize(next.fabBtnSize);
      prevSize = next.fabBtnSize;
    }
  });

  const unsubRoutes = dailyRunRoutesStore.subscribe(() => refresh());

  // 1 Hz repaint ticker — keeps "N left" counter in sync even if OGame populates
  // #eventContent after our initial refresh.
  const tickerHandle = setInterval(refresh, 1000);

  installed = {
    dispose: () => {
      removeButton();
      unsubSettings();
      unsubRoutes();
      clearInterval(tickerHandle);
      document.removeEventListener(EVENT_BOX_LOADED_EVENT, onEventBoxLoaded);
      clearTimeout(safetyTimer);
      if (settleTimer) clearTimeout(settleTimer);
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
export const _resetDailyRunForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  busy = false;
  eventBoxReady = true;
};

// Re-export the pure pipeline pieces some tests import via the feature
// entry point (mirrors sendCol re-exporting derive/render).
export { refresh as _refreshForTest };
