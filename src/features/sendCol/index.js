// Floating "Send Col" button — a single orchestrator file driven by a
// pure `derive()` → `render()` → `paint()` pipeline.
//
// # File partitioning
//
// The PURE core of the pipeline (`derive(env)` + `render(ctx)` plus all
// the typedefs / colour constants they reference) lives in the sibling
// file {@link ./pure.js}. This file is the IMPURE orchestrator:
// module-local state, DOM paint, click handlers, event reactors, the
// 1 Hz ticker and the install/dispose lifecycle. The split keeps the
// big-by-necessity orchestrator readable (no 250-line switch statement
// buried under lifecycle wiring) and makes `derive` / `render` usable
// from any context — node tests, hypothetical SSR — that doesn't have
// a `document` to read `readHomePlanet()` from.
//
// # Role
//
// The colonize button. One ui widget, two halves: Send (top) picks the
// next colony target + navigates or dispatches, Scan (bottom) walks the
// galaxy DB to find systems that still need scanning.
//
// # Axioms
//
//   1. Scan and Send are independent. Scan never navigates to
//      fleetdispatch. Send never submits galaxy scan forms.
//   2. `window.fleetDispatcher` is the source of truth on fleetdispatch.
//   3. Abandon belongs to `abandon/overview.js` now — this file does NOT
//      reference `checkAbandonState` / `abandonPlanet`.
//   4. State machine is explicit: discriminated `ButtonContext` union
//      worked out in `derive()`, not spread across 8 fields.
//   5. Timestamps + a single 1 Hz repaint ticker replace timers.
//   6. TOS: 1 user click → at most 1 originated HTTP request.
//
// # Persistent state — five module `let`s
//
// Kept as flat primitives rather than an accessor module because every
// reader + writer lives in THIS file. A bag of helpers would just
// indirection-tax the same five assignments.
//
//   - `lastNavToFleetdispatchAt`  — when we last navigated to
//     fleetdispatch. After 15 s without a matching checkTargetResult
//     the `derive()` phase flips to `timeout`.
//   - `lastScanSubmitAt` — when we last fired an in-page galaxy submit.
//     Used only for the 1 s anti-spam cooldown on the Scan half.
//   - `lastCheckTargetError` — error code from the most recent
//     checkTarget response (or null). Used by `derive()` to pick the
//     right sub-phase (reserved = 140016, noShip = 140035, else stale).
//   - `waitStartAt` / `waitSeconds` — min-gap countdown start + total.
//     Ticker reads these to derive the remaining `waitGap` phase.
//
// # Tick policy
//
// Event-driven refresh calls happen on every relevant change
// (settings / scans / registry / bridge events + user clicks). One 1 Hz
// `setInterval` at mount feeds the waitGap countdown and the timeout
// detection — zero other timers (no scanUnlock, no checkTargetWatchdog,
// no countdown-setInterval).
//
// # Bridge event shape compat
//
// The `oge:checkTargetResult` bridge still ships the full 13-field
// detail shape. This module only needs `errorCode`. We accept both:
// prefer `detail.errorCode` when present (future simplified bridge),
// else pull `detail.errorCodes[0]` from the current shape.
//
// # Integration seams
//
//   - Pure helpers live in `./pure.js`; impure DOM helpers in
//     `./domHelpers.js` — target-picking, URL builders, coord readers.
//   - Drag + focus reuse `shared/draggableButton.js` (same `oge_focusedBtn`
//     key as sendExp).
//   - Abandon overlay is `features/abandon/overview.js` — orthogonal.
//
// @see ./pure.js — pure helpers this orchestrator consumes.
// @see ../abandon/overview.js — the abandon-on-overview feature.
// @see ../sendExp/index.js — parallel mobile-button feature (reference pattern).

/** @ts-check */

import { settingsStore } from '../../state/settings.js';
import { scansStore, flushScansStore } from '../../state/scans.js';
import { registryStore } from '../../state/registry.js';
import { safeLS } from '../../lib/storage.js';
import { parsePositions } from '../../domain/positions.js';
import { createButton as makeButton, labelLines } from '../shared/button.js';
import { LANDER_GLYPH } from '../shared/buttonGlyphs.js';
import {
  select as courierSelect,
  dispatch as courierDispatch,
  step as courierStep,
  readyToDispatch,
  installFleetCourier,
} from '../shared/fleetCourier.js';
import {
  findNextScanSystem,
  findNextColonizeTarget,
  buildGalaxyUrl,
  derive,
  render,
  MISSION_COLONIZE,
  SCAN_COOLDOWN_MS,
  BG_SEND_IDLE,
  BG_SEND_READY,
  BG_SEND_ERROR,
  BG_SEND_STALE,
  BG_SEND_WAIT,
  BG_SCAN_IDLE,
} from './pure.js';
import {
  getColonizeWaitTime,
  readHomePlanet,
  parseCurrentGalaxyView,
} from './domHelpers.js';
import { SHIP_COLONY, TARGET_PLANET } from '../../domain/rules.js';
import { GAME } from '../../lib/gameDom.js';

// Re-export the pure pipeline so existing call-sites (e.g. the test
// file which imports `derive` + `render` from this module) keep
// working without a migration step.
export { derive, render } from './pure.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../domain/registry.js').RegistryEntry} RegistryEntry
 * @typedef {{ galaxy: number, system: number, position: number }} Coords
 * @typedef {import('./pure.js').ButtonContext} ButtonContext
 * @typedef {import('./pure.js').Paint} Paint
 * @typedef {import('./pure.js').RenderResult} RenderResult
 * @typedef {import('./pure.js').DeriveEnv} DeriveEnv
 * @typedef {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 */

// ─── DOM ids ───────────────────────────────────────────────────────────

/** id of the wrap div that hosts both halves. */
const BUTTON_ID = 'oge-send-col';
/** id of the Send (top) half. */
const SEND_HALF_ID = 'oge-col-send';
/** id of the Scan (bottom) half. */
const SCAN_HALF_ID = 'oge-col-scan';

// ─── Storage keys ──────────────────────────────────────────────────────

/** Shared focus-persist key with sendExp. */
const FOCUS_KEY = 'oge_focusedBtn';
/** Focus-persist value written when the sendHalf holds focus. */
const FOCUS_SEND = 'col-send';
/** Focus-persist value written when the scanHalf holds focus. */
const FOCUS_SCAN = 'col-scan';
/** localStorage key for the dragged wrap `(x, y)` position. */
const POS_KEY = 'oge_colBtnPos';

// ─── Tunables ──────────────────────────────────────────────────────────
//
// Colour constants (`BG_SEND_*` / `BG_SCAN_*`), the checkTarget /
// scan-cooldown timeouts, and `MISSION_COLONIZE` all moved to
// `./pure.js` because they belong to the pure render / derive
// surface. Imported above and used below only for the impure paint
// fallbacks (e.g. "None available" flash) and the fleetdispatch URL
// sniff.

/** Drag-vs-tap threshold in pixels (matches sendExp). */
const DRAG_THRESHOLD = 8;
/** Default offset from the bottom-right corner when no saved pos. */
const DEFAULT_EDGE_OFFSET_PX = 20;
/** Delay before restoring focus on install (matches sendExp). */
const FOCUS_RESTORE_DELAY_MS = 50;
/** Repaint ticker period in ms. */
const REPAINT_TICK_MS = 1000;
/** Hold duration (ms) required to trigger a manual skip of the current candidate. */
const HOLD_SKIP_MS = 2000;

// ─── Module-local state (§3) ───────────────────────────────────────────

/**
 * Timestamp of the last `oge:galaxyScanned` event we received. Used
 * together with {@link lastScanSubmitAt} to derive `scanCooldown`:
 * the Scan half is considered busy iff we submitted more recently than
 * we received a response (plus a hard safety cap for silent failures).
 *
 * Event-driven (vs. the earlier fixed-timer design) so the UI unlocks
 * the Scan button as soon as the game's response lands, not after some
 * arbitrary wait.
 */
let lastScanEventAt = 0;
/** Timestamp of the last in-page galaxy submit — anti-spam cooldown. */
let lastScanSubmitAt = 0;
/** Error code from the most recent matching checkTarget response. */
let lastCheckTargetError = /** @type {number | null} */ (null);
/** Epoch-ms when the current waitGap countdown started. */
/**
 * Cached snapshot of `window.fleetDispatcher` published by the MAIN-world
 * bridge `bridges/fleetDispatcherSnapshot.js`. `null` until the first
 * `oge:fleetDispatcher` event arrives (initial publish deferred to
 * DOMContentLoaded + microtask). On fleetdispatch, `derive()` reads
 * targetPlanet/orders/shipsOnPlanet from here.
 *
 * @type {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot | null}
 */
let fleetDispatcherSnapshot = null;

/**
 * The shared {@link makeButton} controller (view + gestures). `null` until
 * mounted; the top-level paint helpers below no-op while it's null.
 *
 * @type {import('../shared/button.js').Button | null}
 */
let controller = null;

/** Re-entry guard while a courier select()/dispatch() is in flight. */
let busy = false;
/** True once a select() has armed a ready-to-send colonize on step 2. */
let colReady = false;
/** The candidate the armed send is aimed at (for the ready label). */
let colTarget = /** @type {Coords | null} */ (null);
/** Epoch-ms when the current min-gap wait started (0 = not in wait). */
let waitStartAt = 0;
/** Total wait seconds measured at the start of the current min-gap cycle. */
let waitTotalSecs = 0;

/** Bare fleetdispatch URL — the courier sets the colony ship + target
 * in-page, so no coords/mission/am params (avoids the second reload). */
const bareFleetdispatchUrl = () =>
  location.href.split('?')[0] + '?page=ingame&component=fleetdispatch';

// ─── DOM paint (impure — drives the shared Button controller) ──────────

/**
 * Paint one zone of the button from a {@link Paint}. `subtext` → two
 * stacked lines (big primary on top, small caption below — matching the
 * fsCollect / sendExp layout so all three buttons read the same way);
 * otherwise a single line. Always writes the background and the dim
 * (greyed-out) flag. No-op while unmounted.
 *
 * @param {'send'|'scan'} key
 * @param {Paint} p
 * @returns {void}
 */
const paintZone = (key, p) => {
  if (!controller) return;
  if (p.subtext || p.hint) {
    controller.paintLines(key, labelLines({ main: p.text, sub: p.subtext, hint: p.hint }));
  } else {
    controller.setText(key, p.text);
  }
  controller.setBg(key, p.bg);
  // `dim: true` greys the zone so the user sees a click would be ignored.
  controller.setDim(key, p.dim === true);
};

/**
 * Apply a {@link RenderResult} to the mounted button. No-op when unmounted.
 *
 * @param {RenderResult} result
 * @returns {void}
 */
export const paint = (result) => {
  paintZone('send', result.send);
  paintZone('scan', result.scan);
};

// ─── captureEnv + refresh ──────────────────────────────────────────────

/**
 * Snapshot every input of `derive()` into a single `env` object. This is
 * the one-and-only impure read in the derive/render pipeline — making
 * `./pure.js` completely DOM- and store-free by construction. All
 * of `location.search`, `#planetList .hightlightPlanet`, `#galaxy_input`,
 * and the module-local `lastXxx` / `waitXxx` lets flow through here.
 *
 * @returns {DeriveEnv}
 */
const captureEnv = () => {
  const settings = settingsStore.get();
  return {
    search: location.search,
    // `window.fleetDispatcher` lives in the page world and is NOT
    // accessible from the isolated content script. We read a snapshot
    // published by `bridges/fleetDispatcherSnapshot.js` (MAIN world) via
    // `oge:fleetDispatcher` event. `fleetDispatcherSnapshot` below is
    // the cached latest snapshot, `null` until first event arrives.
    fleetDispatcher: fleetDispatcherSnapshot,
    scans: scansStore.get(),
    registry: registryStore.get(),
    targets: parsePositions(settings.colPositions),
    preferOther: settings.colPreferOtherGalaxies,
    now: Date.now(),
    // Previously read directly by `derive`; now snapshotted here so the
    // pure core stays DOM-free. `readHomePlanet` → `#planetList`,
    // `parseCurrentGalaxyView` → `#galaxy_input` / URL.
    home: readHomePlanet(),
    view: parseCurrentGalaxyView(),
    // Scan-cooldown timing (the only module-local state derive still reads;
    // the Send half on fleetdispatch is courier-driven in the handler).
    lastScanSubmitAt,
    lastScanEventAt,
  };
};

/**
 * Full pipeline: capture env → derive → render → paint. Called from
 * the settings / stores subscriptions, from every bridge-event
 * listener, from the 1 Hz ticker, and at the end of the click
 * handlers so the user's action is reflected before the navigation
 * starts.
 *
 * @returns {void}
 */
const refresh = () => {
  const ctx = derive(captureEnv());
  const result = render(ctx);
  // Scan half is always derive-driven. The Send half is owned by the
  // courier handler while a select()/dispatch() is in flight (busy) or once
  // a send is armed-ready on step 2; otherwise it shows the derive-computed
  // next-candidate label (which, on a bare fleetdispatch, is the idle-branch
  // "[g:s:p] Send Colony").
  paintZone('scan', result.scan);
  if (busy) return;
  if (colReady && colTarget && courierStep() === 'fleet2') {
    // Armed and ready — but keep showing a live min-gap countdown if a
    // colony arrival is too close (the 1 Hz ticker drives it down).
    const wait = getColonizeWaitTime();
    if (wait > 0) {
      // Record start time + total on first tick of this wait cycle.
      if (waitStartAt === 0) {
        waitStartAt = Date.now();
        waitTotalSecs = wait;
      }
      // Progress arc: fills proportionally as the wait elapses (0 → 1).
      const elapsed = (Date.now() - waitStartAt) / 1000;
      controller?.setProgress(Math.min(elapsed / waitTotalSecs, 1));
      paintZone('send', { text: `Wait ${wait}s`, bg: BG_SEND_WAIT, dim: true });
    } else {
      // Wait cleared — reset arc and show ready state.
      if (waitStartAt !== 0) {
        waitStartAt = 0;
        waitTotalSecs = 0;
        controller?.setProgress(0);
      }
      paintZone('send', {
        text: 'Send!',
        subtext: `[${colTarget.galaxy}:${colTarget.system}:${colTarget.position}]`,
        bg: BG_SEND_READY,
      });
    }
    return;
  }
  // Not armed or not on fleet2 — clear any leftover progress arc.
  if (waitStartAt !== 0) {
    waitStartAt = 0;
    waitTotalSecs = 0;
    controller?.setProgress(0);
  }
  paintZone('send', result.send);
};


// ─── Click handlers ───────────────────────────────────────────────────

/**
 * Build the send-zone paint for a courier select() failure. reserved/stale
 * slots are ALSO recorded in scansStore by onCheckTargetResult (it fires
 * from the game's checkTarget that the courier triggered), so the next tap
 * picks a different candidate.
 *
 * @param {string | undefined} reason
 * @param {Coords} c
 * @returns {Paint}
 */
const colErrorPaint = (reason, c) => {
  const coords = `[${c.galaxy}:${c.system}:${c.position}]`;
  switch (reason) {
    case 'noShip':
      return { text: 'No ship!', subtext: coords, bg: BG_SEND_ERROR };
    case 'noMoon':
      return { text: 'No moon', subtext: coords, bg: BG_SEND_ERROR };
    case 'reserved':
      return { text: 'Reserved', subtext: coords, bg: BG_SEND_STALE };
    case 'mission':
    case 'stale':
      return { text: 'Stale', subtext: coords, bg: BG_SEND_STALE };
    case 'timeout':
      return { text: 'Timeout', subtext: coords, bg: BG_SEND_STALE };
    default:
      // Surface the raw courier reason (selectFailed / noFleet2 / empty /
      // notReady / generic / …) so a failure is diagnosable at a glance
      // instead of a catch-all "Failed".
      return { text: reason || 'Failed', subtext: coords, bg: BG_SEND_ERROR };
  }
};

/**
 * Send-half handler — two intentional taps via the shared courier (bare-URL
 * entry, in-page colony-ship + target selection, `.off` readiness, sendFleet
 * result handling). The Scan half + candidate finding are unchanged.
 *
 * @returns {Promise<void>}
 */
const onSendClick = async () => {
  if (busy) return;
  const s = courierStep();

  // Tap 2 — dispatch the armed colonize, gated by the min-gap.
  if (colReady && s === 'fleet2') {
    if (!readyToDispatch()) return;
    const wait = getColonizeWaitTime();
    if (wait > 0) {
      // Min-gap: too close to an existing colony arrival. Show it and let
      // the user re-tap once the gap passes (no live countdown — low value).
      paintZone('send', { text: `Wait ${wait}s`, bg: BG_SEND_WAIT, dim: true });
      return;
    }
    busy = true;
    paintZone('send', { text: 'Wait…', bg: BG_SEND_WAIT, dim: true });
    const r = await courierDispatch();
    busy = false;
    colReady = false;
    if (!r.ok) {
      paintZone('send', {
        text: r.errorCode === 140026 ? 'No fuel' : 'Failed',
        bg: BG_SEND_ERROR,
      });
      return;
    }
    // Success → the game navigates; onColonizeSent records the slot.
    colTarget = null;
    paintZone('send', { text: 'Sent!', bg: BG_SEND_READY });
    return;
  }

  // Find the next DB candidate (works on AND off fleetdispatch).
  const settings = settingsStore.get();
  const home = readHomePlanet();
  const candidate = home
    ? findNextColonizeTarget(
        scansStore.get(),
        registryStore.get(),
        home,
        /** @type {number[]} */ (parsePositions(settings.colPositions)),
        settings.colPreferOtherGalaxies,
      )
    : null;
  if (!candidate) {
    paintZone('send', { text: 'No more candidates', bg: BG_SEND_IDLE });
    return;
  }

  // Off fleetdispatch → bare nav; the next tap selects the fleet in-page.
  if (s === 'off') {
    location.href = bareFleetdispatchUrl();
    return;
  }

  // Tap 1 — select the colony ship + target, walk to a ready step 2.
  busy = true;
  colReady = false;
  paintZone('send', { text: 'Wait…', bg: BG_SEND_WAIT, dim: true });
  const r = await courierSelect({
    spec: { kind: 'list', ships: [{ id: SHIP_COLONY, qty: 1, frac: 1 }] },
    target: {
      galaxy: candidate.galaxy,
      system: candidate.system,
      position: candidate.position,
      type: TARGET_PLANET,
    },
    mission: MISSION_COLONIZE,
  });
  busy = false;
  if (!r.ok) {
    paintZone('send', colErrorPaint(r.reason, candidate));
    return;
  }
  colReady = true;
  colTarget = candidate;
  paintZone('send', {
    text: 'Send!',
    subtext: `[${candidate.galaxy}:${candidate.system}:${candidate.position}]`,
    bg: BG_SEND_READY,
  });
};

/**
 * Handle a click on the Scan half. Scan is independent from Send (axiom
 * #1): we pick the next system to scan and either navigate full-page
 * (outside galaxy view) or submit the in-page galaxy form.
 *
 * @returns {void}
 */
const onScanClick = () => {
  // Two behaviours:
  //   1. NOT on galaxy view: "to Galaxy" — full-page nav to the bare
  //      galaxy URL (no specific coords). The game serves whatever
  //      its default system is, which it server-renders without an
  //      AJAX call — meaning our hooks would miss it anyway. So we
  //      don't try to scan a specific system from here; we just get
  //      the user onto galaxy view, where every subsequent click
  //      AJAX-submits and is observed.
  //   2. ON galaxy view: find next unscanned system, in-page submit
  //      via the galaxy form. Cooldown is event-driven (locks until
  //      `oge:galaxyScanned` arrives, hard cap 8 s).
  const home = readHomePlanet();
  if (safeLS.bool('oge_debugSendCol', false)) {
    const view = parseCurrentGalaxyView();
    const next = home ? findNextScanSystem(scansStore.get(), home, view) : null;
    // eslint-disable-next-line no-console
    console.debug('[OG-E sendCol] onScanClick', {
      home,
      view,
      nextScanSystem: next,
      scansEntryCount: Object.keys(scansStore.get()).length,
      lastScanSubmitAt,
      lastScanEventAt,
      now: Date.now(),
    });
  }
  if (!home) return;

  // Off galaxy view: hop to bare galaxy. No coord targeting (full-nav
  // initial-system loads aren't AJAX-observed; would silently waste the
  // user's click).
  if (!location.search.includes('component=galaxy')) {
    const base = location.href.split('?')[0];
    location.href = `${base}?page=ingame&component=galaxy`;
    return;
  }

  // On galaxy view: cooldown then in-page submit to next unscanned.
  const now = Date.now();
  if (lastScanSubmitAt > lastScanEventAt && now - lastScanSubmitAt < SCAN_COOLDOWN_MS) {
    return;
  }

  const view = parseCurrentGalaxyView();
  const next = findNextScanSystem(scansStore.get(), home, view);
  if (!next) {
    paintZone('scan', { text: 'All scanned!', bg: BG_SCAN_IDLE });
    return;
  }

  lastScanSubmitAt = now;
  if (navigateGalaxyInPage(next.galaxy, next.system)) {
    refresh();  // repaint so cooldown dim applies immediately
    return;
  }
  // Fallback: in-page submit failed (no form? AGR quirk?). Do a full
  // nav — accepts the "first system not scanned" cost since it's the
  // exception path.
  location.href = buildGalaxyUrl(next);
};

/**
 * Update the galaxy-view form inputs and submit for a fast in-page nav.
 * Returns `true` when the submit button was found + clicked; `false` so
 * the caller can fall back to a full-page `location.href =` navigation.
 *
 * @param {number} galaxy
 * @param {number} system
 * @returns {boolean}
 */
const navigateGalaxyInPage = (galaxy, system) => {
  const galInput = /** @type {HTMLInputElement | null} */ (
    document.querySelector(GAME.GALAXY_INPUT)
  );
  const sysInput = /** @type {HTMLInputElement | null} */ (
    document.querySelector(GAME.SYSTEM_INPUT)
  );
  if (!sysInput) return false;
  if (galInput) galInput.value = String(galaxy);
  sysInput.value = String(system);
  const submitBtn = /** @type {HTMLElement | null} */ (
    document.querySelector(GAME.GALAXY_SUBMIT) ??
      document.querySelector(GAME.GALAXY_SUBMIT_FALLBACK)
  );
  if (submitBtn) {
    submitBtn.click();
    return true;
  }
  return false;
};

// ─── Event reactors (§7) ───────────────────────────────────────────────

/**
 * Extract an error code from a `oge:checkTargetResult` detail. Handles
 * both the current bridge shape (`errorCodes: number[]`) and the future
 * simplified shape (`errorCode: number | null`).
 *
 * @param {any} detail
 * @returns {number | null}
 */
const extractErrorCode = (detail) => {
  if (!detail) return null;
  if (typeof detail.errorCode === 'number') return detail.errorCode;
  if (detail.errorCode === null) return null;
  if (Array.isArray(detail.errorCodes) && typeof detail.errorCodes[0] === 'number') {
    return detail.errorCodes[0];
  }
  return null;
};

/**
 * React to `oge:checkTargetResult`. Cross-check the event's coords
 * against `window.fleetDispatcher.targetPlanet` — an old response from
 * an earlier target must not poison the current derive().
 *
 * @param {Event} e
 * @returns {void}
 */
const onCheckTargetResult = (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail;
  if (!detail) return;
  const { galaxy, system, position } = detail;
  if (
    typeof galaxy !== 'number' ||
    typeof system !== 'number' ||
    typeof position !== 'number'
  ) {
    return;
  }
  // Coord match against the cached fleetDispatcher snapshot — skip
  // ancient responses that arrived after the user moved on. When the
  // snapshot isn't yet populated (first event race), accept the result.
  const tp = fleetDispatcherSnapshot && fleetDispatcherSnapshot.targetPlanet;
  if (
    tp &&
    (tp.galaxy !== galaxy || tp.system !== system || tp.position !== position)
  ) {
    return;
  }
  lastCheckTargetError = extractErrorCode(detail);

  // Proactively mark the slot in `scansStore` so `findNextColonizeTarget`
  // stops proposing it. This matters because stale-retry's response is
  // a full-page NAVIGATION to the system's galaxy view — the game
  // server-renders that view without firing `fetchGalaxyContent`, so
  // our galaxyHook observes NOTHING and the DB stays wrong unless we
  // mark here. A later user-driven scan (AJAX in-page submit) refreshes
  // the slot's real status.
  //
  //   - error 140016 (reserved for planet-move) → status 'reserved',
  //     RESCAN_AFTER 24 h (planet-move cooldown).
  //   - error 140035 (no colonization ship) → NO mark: slot is fine,
  //     we just lack a ship. Changing active planet (or building one)
  //     lets us send later.
  //   - everything else (`!canColonize` without the above codes) →
  //     treat as generic stale: mark as 'abandoned' with
  //     `hasAbandonedPlanet` flag so it sits out the ~day cooldown
  //     and a later scan reclassifies.
  const fd = fleetDispatcherSnapshot;
  const stillMatching =
    !fd || !fd.targetPlanet ||
    (fd.targetPlanet.galaxy === galaxy &&
      fd.targetPlanet.system === system &&
      fd.targetPlanet.position === position);
  if (stillMatching) {
    const canColonize = fd && fd.orders && fd.orders['7'] === true;
    /** @type {import('../../domain/scans.js').Position | null} */
    let newPos = null;
    if (lastCheckTargetError === 140016) {
      newPos = { status: 'reserved' };
    } else if (
      lastCheckTargetError !== 140035 &&
      !canColonize
    ) {
      newPos = {
        status: 'abandoned',
        flags: { hasAbandonedPlanet: true },
      };
    }
    if (newPos) {
      const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
      const p = newPos;
      scansStore.update((prev) => {
        const existing = prev[key] ?? { scannedAt: Date.now(), positions: {} };
        /** @type {Record<number, import('../../domain/scans.js').Position>} */
        const newPositions = { ...existing.positions, [position]: p };
        return {
          ...prev,
          [key]: { scannedAt: Date.now(), positions: newPositions },
        };
      });
    }
  }

  refresh();
};

/**
 * React to `oge:fleetDispatcher` — MAIN-world bridge publishing a fresh
 * snapshot of `window.fleetDispatcher`. Stash it and refresh so the
 * button reflects the new target/orders/ship inventory immediately.
 *
 * @param {Event} e
 * @returns {void}
 */
const onFleetDispatcherSnapshot = (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail;
  if (!detail || typeof detail !== 'object') return;
  fleetDispatcherSnapshot =
    /** @type {FleetDispatcherSnapshot} */ (detail);
  refresh();
};

/**
 * React to `oge:galaxyScanned`. Three things happen:
 *
 *   1. Timestamp — record that the game answered. `scanCooldown` goes
 *      false on the next derive, dropping the Scan half dim. No more
 *      fixed-duration waiting: the UI unlocks exactly as fast as the
 *      game does.
 *   2. Store update — `state/scans.js` already merged the payload into
 *      `scansStore`; that fires its own subscribe → refresh path too.
 *   3. Refresh — repaint both halves with the new data.
 *
 * @returns {void}
 */
const onGalaxyScanned = () => {
  lastScanEventAt = Date.now();
  refresh();
};

/**
 * React to `oge:colonizeSent`: mark the just-sent slot `'empty_sent'`
 * in `scansStore` so {@link findNextColonizeTarget} stops picking it
 * until the fleet either lands (next scan sees `mine`) or fails
 * (auto-prune of registry + re-scan flips it back).
 *
 * Does NOT auto-navigate anywhere. Each user click produces at most
 * one navigation; chaining a redirect off the post-send event would
 * fire a second navigation without a second click. The user pulls up
 * the next target themselves — usually by tapping Scan or Send again.
 *
 * @param {Event} e
 * @returns {void}
 */
const onColonizeSent = (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail;
  if (!detail) return;
  const { galaxy, system, position } = detail;
  if (
    typeof galaxy !== 'number' ||
    typeof system !== 'number' ||
    typeof position !== 'number'
  ) {
    return;
  }
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  scansStore.update((prev) => {
    const existing = prev[key] ?? { scannedAt: Date.now(), positions: {} };
    /** @type {Record<number, import('../../domain/scans.js').Position>} */
    const newPositions = {
      ...existing.positions,
      [position]: { status: 'empty_sent' },
    };
    return {
      ...prev,
      [key]: { scannedAt: existing.scannedAt, positions: newPositions },
    };
  });
  // Bypass the 200 ms debounce so the mark survives a page reload that
  // the game triggers immediately after a successful sendFleet.
  flushScansStore();
};

/**
 * Hold gesture (3 s) on the Send zone: manually skip the current candidate
 * by marking it `'empty_sent'` without dispatching a fleet. The slot returns
 * to requires-rescan after `RESCAN_AFTER.empty_sent` hours so the next scan
 * reveals what was blocking colonization.
 *
 * Intended for unhandled game-side blocks: the position can't be colonized
 * but our DB still shows it as a valid target, causing the button to stall.
 * Hold lets the player move past it without losing progress.
 *
 * @returns {void}
 */
const onSendHold = () => {
  if (busy) return;
  // Only available after step 1 — skip the armed target and reset to idle.
  // In the idle state the hold does nothing (no visible hint, no known target).
  const c = colReady && colTarget ? colTarget : null;
  if (!c) return;

  const key = /** @type {`${number}:${number}`} */ (`${c.galaxy}:${c.system}`);
  scansStore.update((prev) => {
    const existing = prev[key];
    if (!existing) return prev;
    const pos = existing.positions?.[c.position];
    if (!pos) return prev;
    return {
      ...prev,
      [key]: {
        ...existing,
        positions: {
          ...existing.positions,
          [c.position]: { ...pos, status: 'empty_sent' },
        },
      },
    };
  });
  // Bypass the 200 ms debounce — same reason as onColonizeSent.
  flushScansStore();

  colReady = false;
  colTarget = null;
};

// ─── Lifecycle ─────────────────────────────────────────────────────────

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Makes `installSendCol` idempotent.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the colonize button. Idempotent — a second call returns the
 * SAME dispose fn as the first.
 *
 * Lifecycle:
 *   1. Snapshot settings. If `colonizeMode === false` we skip DOM work
 *      entirely but still subscribe to settings so a later flip to
 *      `true` creates the button live.
 *   2. Renders (if enabled): `<div id="oge-send-col">` + two halves.
 *      Position from `oge_colBtnPos` or bottom-right default. Drag +
 *      focus wired via `shared/draggableButton.js`.
 *   3. Paints the initial label via derive → render → paint.
 *   4. Starts a 1 Hz repaint ticker.
 *   5. Subscribes to settings / scans / registry stores + three
 *      bridge events for refresh triggers.
 *   6. Returns dispose: removes button, unsubs all, removes listeners,
 *      clears ticker.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSendCol = () => {
  if (installed) return installed.dispose;

  // Cache the fleetDispatcher snapshot (colony-ship availability) so the
  // courier's select() can resolve the fleet.
  installFleetCourier();

  /**
   * Create + mount the button DOM. Idempotent: bails when already mounted.
   *
   * @returns {void}
   */
  const mount = () => {
    // Already mounted → keep the live controller; a redundant call must
    // NOT overwrite it with makeButton's null (idempotency-guard return).
    if (document.getElementById(BUTTON_ID)) return;

    const size = settingsStore.get().colBtnSize;
    controller = makeButton({
      id: BUTTON_ID,
      title: 'Colonization',
      ringId: 'oge-ring-col',
      size,
      fontScale: 0.12,
      posKey: POS_KEY,
      focusKey: FOCUS_KEY,
      edgeOffset: DEFAULT_EDGE_OFFSET_PX,
      dragThreshold: DRAG_THRESHOLD,
      holdMs: HOLD_SKIP_MS,
      zones: [
        {
          key: 'send',
          id: SEND_HALF_ID,
          ariaLabel: 'Send colonization',
          bg: BG_SEND_IDLE,
          glyph: LANDER_GLYPH,
          onTap: () => void onSendClick(),
          onHold: onSendHold,
          focusValue: FOCUS_SEND,
          focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
          labelShiftY: 17,
        },
        {
          key: 'scan',
          id: SCAN_HALF_ID,
          ariaLabel: 'Scan next system',
          bg: BG_SCAN_IDLE,
          onTap: onScanClick,
          focusValue: FOCUS_SCAN,
          focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
          labelShiftY: -17,
        },
      ],
    });
    if (!controller) return;

    // First paint driven by the full pipeline.
    refresh();
  };

  /**
   * Remove the button container (and therefore both halves) from the
   * DOM. Safe to call unmounted.
   *
   * @returns {void}
   */
  const removeButton = () => {
    controller?.dispose();
    controller = null;
  };

  /**
   * Live-resize the currently mounted button. No-op when unmounted.
   *
   * @param {number} size
   * @returns {void}
   */
  const updateButtonSize = (size) => controller?.resize(size);

  // Bootstrap snapshot BEFORE first mount — so the initial paint sees
  // the right phase. If `window.fleetDispatcher` happens to be readable
  // right now (Firefox Xray, tests assigning directly), seed the cache.
  // Chrome MV3 isolated scripts get undefined here; we rely on the
  // bridge event (`oge:fleetDispatcher` from `bridges/fleetDispatcherSnapshot.js`)
  // to populate it asynchronously in production.
  if (!fleetDispatcherSnapshot) {
    const liveFd = /** @type {any} */ (window).fleetDispatcher;
    if (liveFd && typeof liveFd === 'object') {
      fleetDispatcherSnapshot = /** @type {FleetDispatcherSnapshot} */ (liveFd);
    }
  }

  // Initial render based on current settings.
  const initial = settingsStore.get();
  if (initial.colonizeMode) {
    if (document.body) {
      mount();
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          if (installed && settingsStore.get().colonizeMode) mount();
        },
        { once: true },
      );
    }
  }

  // Live settings reactions.
  let prevColonizeMode = initial.colonizeMode;
  let prevColBtnSize = initial.colBtnSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.colonizeMode !== prevColonizeMode) {
      if (next.colonizeMode) {
        if (document.body) mount();
      } else {
        removeButton();
      }
      prevColonizeMode = next.colonizeMode;
    }
    if (next.colBtnSize !== prevColBtnSize) {
      updateButtonSize(next.colBtnSize);
      prevColBtnSize = next.colBtnSize;
    }
    // Any other settings change (colPositions, colPreferOtherGalaxies, ...)
    // can flip the candidate, so refresh on every settings notification.
    refresh();
  });

  const unsubScans = scansStore.subscribe(() => refresh());
  const unsubRegistry = registryStore.subscribe(() => refresh());

  // Bridge event listeners.
  document.addEventListener('oge:fleetDispatcher', onFleetDispatcherSnapshot);
  document.addEventListener('oge:checkTargetResult', onCheckTargetResult);
  document.addEventListener('oge:galaxyScanned', onGalaxyScanned);
  document.addEventListener('oge:colonizeSent', onColonizeSent);

  // 1 Hz repaint ticker — the only timer in the whole feature.
  const tickerHandle = setInterval(refresh, REPAINT_TICK_MS);

  installed = {
    dispose: () => {
      clearInterval(tickerHandle);
      removeButton();
      unsubSettings();
      unsubScans();
      unsubRegistry();
      document.removeEventListener('oge:fleetDispatcher', onFleetDispatcherSnapshot);
      document.removeEventListener('oge:checkTargetResult', onCheckTargetResult);
      document.removeEventListener('oge:galaxyScanned', onGalaxyScanned);
      document.removeEventListener('oge:colonizeSent', onColonizeSent);
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset — runs the current dispose (if any) and zeroes the
 * module-local state so each test starts from a clean slate. `_`-prefixed
 * to signal "do not import from production code".
 *
 * @returns {void}
 */
/** Exposed only for unit-tests — do not call from production code. */
export const _onSendHoldForTest = onSendHold;

export const _resetSendColForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  lastScanSubmitAt = 0;
  lastScanEventAt = 0;
  lastCheckTargetError = null;
  fleetDispatcherSnapshot = null;
  busy = false;
  colReady = false;
  colTarget = null;
  waitStartAt = 0;
  waitTotalSecs = 0;
};
