// @ts-check

// Unified FAB colony module — folds the old fresh-planet banner AND the old
// red abandon overlay into ONE button on the unified FAB. Its state is
// decided per page load (and on store / DOM changes / a 1 Hz landing tick):
//
//   • ABANDON — we ARE on the overview of a fresh small colony
//     (`checkAbandonState()` truthy). The module registers + auto-activates
//     (rose). Successive taps drive the 3-step abandon flow
//     (`createAbandonFlow()` in `./index.js`): open → submit → confirm.
//
//   • NAVIGATE — a fresh colony (`used === 0`) exists somewhere in the planet
//     list and we are NOT on its overview. The module registers + auto-activates
//     (amber), labelled with the colony's coords. A tap navigates to that
//     colony's overview (a full page load → re-evaluates into ABANDON there).
//
//   • LANDING / REFRESH — a colonization lands within ≤60 s (dimmed live
//     countdown), then HAS landed while this page was open (actionable
//     "Refresh" → overview reload, which refreshes `#planetList` so the
//     states above take over). Derivation is pure (`./pure.js`); the nearest
//     upcoming arrival is cached in localStorage (`state/coloArrival.js`) so
//     the countdown arms on page load without waiting for the event-list XHR.
//
//   • none — nothing holds → the module is not registered (the FAB shows the
//     user's previous module).
//
// # Why all taps live on the FAB (and the close guard)
//
// The user asked for one button that walks the whole abandon, instead of the
// old proxy buttons injected inside the game popup. The FAB sits OUTSIDE the
// game's jQuery UI dialog, so a tap would normally be read as a focus-leave /
// outside click and close the dialog between steps. While a flow is active we
// install a close guard on the FAB wrapper that (a) stops the FAB's
// pointer/focus/click events from reaching the game's document-level handlers
// and (b) prevents the FAB from stealing focus on desktop; after each step we
// re-focus the dialog. The 1:1 user-tap → game-request (TOS) mapping is
// preserved — one tap per `advance()`, one request per `advance()`.
//
// # Why no DOM churn mid-flow
//
// The old overlay disposed itself before the flow because its MutationObserver
// fired during popup creation and broke jQuery UI init. Here `refresh()` is a
// no-op whenever a flow is running, so the observer/subscriptions never mutate
// the FAB (register/dispose) while the game is opening its dialog.
//
// @ts-check

import { settingsStore } from '../../state/settings.js';
import {
  galaxyScanConfigStore,
  whenGalaxyScanConfigHydrated,
} from '../../state/galaxyScanConfig.js';
import { createButton as makeButton, labelLines } from '../shared/button.js';
import { setActiveFabModule, FAB_WRAP_ID } from '../shared/unifiedFab.js';
import { ABANDON_GLYPH } from '../shared/buttonGlyphs.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { debounce } from '../../lib/debounce.js';
import { EVENT_BOX_LOADED_EVENT } from '../../lib/ogeEvents.js';
import { readColoArrival, writeColoArrival } from '../../state/coloArrival.js';
import {
  findFirstFreshPlanet, getOverviewCp, buildOverviewUrl, overviewUrl, readColoArrivals,
} from './detect.js';
import { deriveLanding, nextLandingTickMs, formatLandingCountdown, landingProgress } from './pure.js';
import { checkAbandonState, createAbandonFlow } from './index.js';

/** OG-E's own ids/colours for this module (not a game-DOM contract). */
const MODULE_ID = 'colony';
const BUTTON_ID = 'oge-colony-fab';
const RING_ID = 'oge-ring-colony';
/**
 * Rose — "destructive action" (matches the old abandon overlay's rim). Both
 * states (a small colony detected elsewhere, or the one we're standing on) wear
 * the SAME abandon identity: a too-small fresh colony is always a give-up
 * candidate, so the navigate state is just "go there to abandon".
 */
const ABANDON_COLOR = '#fb7185';

/** @typedef {'none' | 'navigate' | 'abandon' | 'landing' | 'refresh'} ColonyState */

/**
 * URL of the OG-E Dashboard extension page, resolved once via
 * `browser/chrome.runtime.getURL`. Empty string when the runtime API isn't
 * present (test environments). Kept local — a feature must not import another
 * feature (mirrors the resolver in `dailyRun/index.js`).
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
 * Open the Dashboard's Colonizations tab (whose ⚙ Settings hold the colonization
 * config + the abandon password) in a new tab, pre-selecting the current
 * universe. No-op (returns false) when the runtime URL is unavailable so the
 * caller can fall back to an in-place hint.
 *
 * @returns {boolean} Whether the dashboard was opened.
 */
const openDashboardColony = () => {
  if (!DASHBOARD_URL) return false;
  const universeId = parseUniverseId(location.host);
  const url = DASHBOARD_URL
    + (universeId ? `?host=${encodeURIComponent(universeId)}&tab=colony` : '?tab=colony');
  window.open(url, '_blank');
  return true;
};

/** Events the close guard swallows on the FAB wrapper while a flow runs. */
const GUARD_TYPES = ['pointerdown', 'mousedown', 'touchstart', 'click', 'focusin'];

/**
 * Re-focus the game popup so jQuery UI's focus trap doesn't treat the FAB tap
 * as a focus-leave and close the dialog. Best-effort: focuses the first live
 * popup control we can find. No-op when nothing matches.
 *
 * @returns {void}
 */
const refocusDialog = () => {
  const el = /** @type {HTMLElement | null} */ (
    document.querySelector('#validate input[type="submit"]')
    ?? document.querySelector('#errorBoxDecision .yes, .errorBox .yes')
    ?? document.getElementById('abandonplanet')
  );
  try { el?.focus?.(); } catch { /* focus is best-effort */ }
};

/**
 * Install a close guard on the FAB wrapper for the duration of an abandon flow.
 * Stops the FAB's interaction events from bubbling to the game's document-level
 * close handlers, and prevents desktop focus-steal. Returns a remove fn.
 *
 * @returns {() => void}
 */
const installPopupCloseGuard = () => {
  const wrap = document.getElementById(FAB_WRAP_ID);
  if (!wrap) return () => {};
  /** @param {Event} e */
  const onEvt = (e) => {
    // The zone's own handlers run first (they're deeper in the tree), so the
    // tap's onTap has already fired by the time this bubble-phase guard stops
    // the event from reaching the game's document-level close/focus handlers.
    e.stopPropagation();
    // preventDefault on mousedown keeps focus inside the dialog on desktop
    // (touch focus is handled by refocusDialog after each step instead — a
    // touchstart preventDefault would also cancel the synthetic click).
    if (e.type === 'mousedown') e.preventDefault();
  };
  for (const t of GUARD_TYPES) wrap.addEventListener(t, onEvt, false);
  return () => { for (const t of GUARD_TYPES) wrap.removeEventListener(t, onEvt, false); };
};

/**
 * Module-scope install handle; `null` when not installed. Makes
 * {@link installColonyFab} idempotent.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the unified FAB colony module. Idempotent.
 *
 * @returns {() => void} Dispose handle.
 */
export const installColonyFab = () => {
  if (installed) return installed.dispose;

  /** @type {import('../shared/button.js').Button | null} */
  let controller = null;
  /** @type {ColonyState} */
  let currentState = 'none';
  /** The mounted navigate target's colony-planet id (0 when not in navigate). */
  let currentCp = 0;
  /** @type {import('./index.js').AbandonFlow | null} */
  let flow = null;
  /** True while an abandon flow is mid-popup — refresh() is suppressed. */
  let flowRunning = false;
  /** @type {(() => void) | null} */
  let removeGuard = null;

  /** Page-birth time — an arrival older than this never arms landing/refresh. */
  const pageBornMs = Date.now();
  /** Arrival latched as "landed while this page was open" (epoch s; 0 = none). */
  let landedAt = 0;
  /** Last landing derivation — the countdown repaint reads its `arrivalAt`. */
  /** @type {import('./pure.js').LandingResult} */
  let lastLanding = { phase: 'idle', arrivalAt: 0, cacheWrite: null, latch: 0 };
  /** Self-scheduled landing tick (1 Hz in-window, window-boundary wake outside). */
  /** @type {number | null} */
  let tickTimer = null;

  /** (Re)arm the landing tick; `delayMs <= 0` just cancels. @param {number} delayMs */
  const scheduleLandingTick = (delayMs) => {
    if (tickTimer !== null) { clearTimeout(tickTimer); tickTimer = null; }
    if (delayMs <= 0) return;
    tickTimer = window.setTimeout(() => {
      tickTimer = null;
      if (installed && !flowRunning) refresh();
    }, delayMs);
  };

  /**
   * One landing step: live event list (cache fallback) → pure derivation →
   * write-through the upcoming-arrival cache → schedule the next tick.
   *
   * @returns {import('./pure.js').LandingResult}
   */
  const evalLanding = () => {
    const nowMs = Date.now();
    const derived = deriveLanding({
      domArrivals: readColoArrivals(),
      cachedArrival: readColoArrival(),
      latchedArrival: landedAt,
      pageBornMs,
      nowMs,
    });
    landedAt = derived.latch;
    if (derived.cacheWrite !== null) writeColoArrival(derived.cacheWrite);
    lastLanding = derived;
    scheduleLandingTick(nextLandingTickMs(derived.phase, derived.arrivalAt, nowMs));
    return derived;
  };

  /** @returns {{ state: ColonyState, cp: number }} the state the page warrants right now (cp = navigate target's colony-planet id, else 0). */
  const desiredState = () => {
    if (checkAbandonState()) return { state: 'abandon', cp: 0 };
    // A fresh colony elsewhere is only worth surfacing when it's ALSO too small
    // to keep — read straight from its planet-list tooltip (`max` fields), so
    // we flag a give-up candidate without first navigating to its overview.
    const min = galaxyScanConfigStore.get().colonyMinFields;
    const fresh = findFirstFreshPlanet({ belowFields: min });
    if (fresh && getOverviewCp() !== fresh.cp) return { state: 'navigate', cp: fresh.cp };
    // Pre-arrival states only when nothing actionable is on the board — a
    // fresh colony awaiting a decision outranks the next one's countdown
    // (handling it ends in a reload, which re-arms the countdown anyway).
    const landing = evalLanding();
    if (landing.phase !== 'idle') return { state: landing.phase, cp: 0 };
    return { state: 'none', cp: 0 };
  };

  /** Tear down the button (and any in-flight flow guard). @returns {void} */
  const unmount = () => {
    controller?.dispose();
    controller = null;
    currentState = 'none';
    currentCp = 0;
  };

  /**
   * paintLines + the dim flag in one call. `dim` greys the fill — every
   * transient "a tap does nothing right now" label wears it (the shared
   * status language of the send buttons). `shrink` drops the primary to
   * 0.9em: the long flow words (Working…, Deleting…, ⚠ DELETE ⚠) overflow
   * the orb at 1em.
   *
   * @param {{ main: string, sub?: string, hint?: string, dim?: boolean, shrink?: boolean }} p
   * @returns {void}
   */
  const paintGo = ({ main, sub, hint, dim = false, shrink = false }) => {
    if (!controller) return;
    const lines = labelLines({ main, sub, hint });
    if (shrink) lines[0].em = '0.9em';
    controller.paintLines('go', lines);
    controller.setDim('go', dim);
  };

  /** @param {import('./index.js').AdvanceResult['phase']} phase @param {{max:number}|null} [info] */
  const paint = (phase, info) => {
    if (!controller) return;
    if (phase === 'opened') {
      paintGo({ main: 'Submit', sub: 'password' });
    } else if (phase === 'submitted') {
      paintGo({ main: '⚠ DELETE ⚠', hint: 'tap to confirm', shrink: true });
    } else if (phase === 'done') {
      paintGo({ main: 'Deleting…', dim: true, shrink: true });
    } else if (phase === 'aborted') {
      paintGo({ main: 'Abandon', sub: info ? `${info.max} fields` : undefined, hint: 'tap to retry' });
    }
  };

  /** End the current flow: release the guard + clear the running flag. */
  const endFlow = () => {
    // Release the flow's re-entry guard (flowActive). cancel() no-ops when the
    // flow is already dead (done/aborted paths), so this is safe everywhere.
    flow?.cancel();
    flow = null;
    flowRunning = false;
    if (removeGuard) { removeGuard(); removeGuard = null; }
  };

  /** Drive one abandon step per FAB tap. @returns {Promise<void>} */
  const onAbandonTap = async () => {
    if (!controller) return;
    if (!flow) {
      // The password lives in async-hydrating chrome.storage; on a slow device
      // a tap can land BEFORE the load resolves, when the store still holds the
      // default (empty password) — which used to mis-route the user to "Set
      // password" despite one being configured. Await the hydrate (milliseconds
      // in the worst case, already-resolved on every later tap) so the check
      // below reads the real config.
      await whenGalaxyScanConfigHydrated();
      if (!controller || flow) return; // disposed / re-entered while waiting
      if (!galaxyScanConfigStore.get().colonyPassword) {
        // No abandon password yet — open the dashboard's Colonizations tab
        // (its ⚙ Settings hold the password) so the user can set it; fall back
        // to an in-place hint when the runtime URL isn't available.
        const opened = openDashboardColony();
        paintGo({ main: 'Set password', sub: opened ? 'opening dashboard…' : 'in dashboard', shrink: true });
        return;
      }
      flow = createAbandonFlow();
      if (!flow) { paint('aborted', checkAbandonState()); return; }
      flowRunning = true;
      removeGuard = installPopupCloseGuard();
    }
    paintGo({ main: 'Working…', dim: true, shrink: true });
    const res = await flow.advance();
    refocusDialog();
    if (res.phase === 'done') {
      paint('done');
      endFlow();
      return;
    }
    if (res.phase === 'aborted') {
      endFlow();
      paint('aborted', checkAbandonState());
      // The popup may have vanished — re-evaluate (deferred so we don't churn
      // the DOM inside the tap handler). Guard against a dispose landing in this
      // 100 ms window, which would otherwise remount the FAB post-teardown.
      setTimeout(() => { if (installed) refresh(); }, 100);
      return;
    }
    paint(res.phase);
  };

  /** Mount the button for `state` and auto-activate it. @param {ColonyState} state */
  const mountFor = (state) => {
    const size = settingsStore.get().fabBtnSize;
    if (state === 'navigate') {
      const min = galaxyScanConfigStore.get().colonyMinFields;
      const fresh = findFirstFreshPlanet({ belowFields: min });
      if (!fresh) return;
      controller = makeButton({
        id: BUTTON_ID, title: 'Abandon colony', ringId: RING_ID, size, fontScale: 0.18,
        module: { id: MODULE_ID, name: 'Abandon', color: ABANDON_COLOR, glyph: ABANDON_GLYPH },
        zones: [{
          key: 'go',
          id: `${BUTTON_ID}-go`,
          ariaLabel: `Abandon colony ${fresh.coords}`,
          bg: ABANDON_COLOR,
          glyph: ABANDON_GLYPH,
          onTap: () => { location.href = buildOverviewUrl(fresh.cp); },
        }],
      });
      if (!controller) return;
      controller.paintLines('go', labelLines({ main: 'Abandon', sub: `${fresh.max} fields`, hint: 'too small' }));
      currentState = 'navigate';
      currentCp = fresh.cp;
      setActiveFabModule(MODULE_ID);
    } else if (state === 'abandon') {
      const info = checkAbandonState();
      if (!info) return;
      controller = makeButton({
        id: BUTTON_ID, title: 'Abandon colony', ringId: RING_ID, size, fontScale: 0.18,
        module: { id: MODULE_ID, name: 'Abandon', color: ABANDON_COLOR, glyph: ABANDON_GLYPH },
        zones: [{
          key: 'go',
          id: `${BUTTON_ID}-go`,
          ariaLabel: 'Abandon this colony',
          bg: ABANDON_COLOR,
          glyph: ABANDON_GLYPH,
          onTap: () => void onAbandonTap(),
        }],
      });
      if (!controller) return;
      controller.paintLines('go', labelLines({ main: 'Abandon', sub: `${info.max} fields`, hint: 'too small' }));
      currentState = 'abandon';
      setActiveFabModule(MODULE_ID);
    } else if (state === 'landing' || state === 'refresh') {
      // Same module identity as the decision states — this IS the abandon
      // button showing up early: countdown (dimmed — a tap does nothing yet),
      // then an actionable full reload to overview, where the planet list is
      // fresh and the navigate/abandon states above take over.
      controller = makeButton({
        id: BUTTON_ID, title: 'Colonization landing', ringId: RING_ID, size, fontScale: 0.18,
        module: { id: MODULE_ID, name: 'Abandon', color: ABANDON_COLOR, glyph: ABANDON_GLYPH },
        zones: [{
          key: 'go',
          id: `${BUTTON_ID}-go`,
          ariaLabel: 'Colonization landing — reload overview',
          bg: ABANDON_COLOR,
          glyph: ABANDON_GLYPH,
          // Read the LIVE state, not the mount-time one: the landing →
          // refresh flip repaints this same button in place (see refresh()),
          // so one handler serves both — a no-op while the dimmed countdown
          // runs, the overview reload once the landing is processed.
          onTap: () => { if (currentState === 'refresh') location.href = overviewUrl(); },
        }],
      });
      if (!controller) return;
      paintLanding(state);
      currentState = state;
      setActiveFabModule(MODULE_ID);
    }
  };

  /**
   * Label + dim for the pre-arrival states. Landing repaints at 1 Hz (the
   * tick calls refresh(), which lands in the same-state branch below).
   *
   * @param {ColonyState} state
   * @returns {void}
   */
  const paintLanding = (state) => {
    if (state === 'refresh') {
      // Landed — the ring is full (mirrors the countdown reaching arrival).
      paintGo({ main: 'Refresh', sub: 'colo landed' });
      controller?.setProgress(1);
    } else {
      // Progress arc fills as the landing nears (same feel as sendColony's
      // min-gap wait), repainted each 1 Hz tick alongside the countdown text.
      paintGo({
        main: formatLandingCountdown(lastLanding.arrivalAt, Date.now()),
        sub: 'colo landing',
        dim: true,
      });
      controller?.setProgress(landingProgress(lastLanding.arrivalAt, Date.now()));
    }
  };

  /**
   * Re-evaluate the desired state and (un)mount to match. A NO-OP while a flow
   * is running (so we never register/dispose the FAB — i.e. mutate the DOM —
   * while the game is opening its jQuery UI dialog).
   *
   * @returns {void}
   */
  const refresh = () => {
    if (flowRunning) return;
    const { state: want, cp: wantCp } = desiredState();
    if (want === currentState && wantCp === currentCp) {
      // Same state — but a running countdown still needs its 1 Hz repaint.
      if (want === 'landing') paintLanding('landing');
      return;
    }
    // The landing → refresh flip repaints the SAME mounted button in place —
    // remounting would churn the DOM at the exact moment the user reaches for
    // the tap (and could eat it).
    if (
      controller &&
      (want === 'landing' || want === 'refresh') &&
      (currentState === 'landing' || currentState === 'refresh')
    ) {
      currentState = want;
      paintLanding(want);
      return;
    }
    // Remount when the state changes OR when we're staying in 'navigate' but the
    // chosen first-fresh colony changed (the mounted button's onTap closes over
    // a now-stale cp).
    unmount();
    if (want !== 'none') mountFor(want);
  };

  // Initial pass (deferred to DOMContentLoaded when body isn't ready yet).
  if (document.body) refresh();
  else document.addEventListener('DOMContentLoaded', () => { if (installed) refresh(); }, { once: true });

  // React to config edits (colonyMinFields bump) and to OGame
  // AJAX overview swaps (planet switch via #planetList). The observer is
  // inert while a flow runs (see refresh()).
  //
  // `fabBtnSize` is handled separately from `refresh()`: a size change does
  // NOT change the desired state, so refresh() would early-return and leave
  // the live button at its old size. Resize the mounted controller in place
  // instead — matching the other FAB modules' `prevFabBtnSize` handling.
  let prevFabBtnSize = settingsStore.get().fabBtnSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fabBtnSize !== prevFabBtnSize) {
      prevFabBtnSize = next.fabBtnSize;
      controller?.resize(next.fabBtnSize);
    }
    refresh();
  });
  const unsubConfig = galaxyScanConfigStore.subscribe(refresh);
  // Debounce so OGame's 1 Hz ticker DOM churn doesn't re-run refresh() on every
  // mutation; the `if (installed)` guard also closes the observer-path teardown
  // gap (a mutation landing after dispose can't remount the FAB).
  const scheduleRefresh = debounce(() => { if (installed) refresh(); }, 200);
  const observer = new MutationObserver(scheduleRefresh);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });

  // A fresh eventbox payload is the moment new in-flight legs (a just-sent
  // colonization) become readable — re-evaluate right away instead of waiting
  // for incidental DOM churn to trip the observer.
  const onEventBoxLoaded = () => scheduleRefresh();
  document.addEventListener(EVENT_BOX_LOADED_EVENT, onEventBoxLoaded);

  installed = {
    dispose: () => {
      endFlow();
      unmount();
      scheduleLandingTick(0);
      document.removeEventListener(EVENT_BOX_LOADED_EVENT, onEventBoxLoaded);
      unsubSettings();
      unsubConfig();
      observer.disconnect();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs the current
 * dispose (if any) so each case starts clean. Prefixed `_` to signal "do not
 * import from production code".
 *
 * @returns {void}
 */
export const _resetColonyFabForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
