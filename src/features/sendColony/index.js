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
//   - `waitStartAt` / `waitSeconds` — min-gap countdown start + total.
//     Ticker reads these to derive the remaining `waitGap` phase.
//
// # Tick policy
//
// Event-driven refresh calls happen on every relevant change
// (settings / scans / registry / bridge events + user clicks). One 1 Hz
// tick on the shared `clock` feeds the waitGap countdown and the timeout
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
//     key as sendExpedition).
//   - Abandon overlay is `features/abandon/overview.js` — orthogonal.
//
// @see ./pure.js — pure helpers this orchestrator consumes.
// @see ../abandon/overview.js — the abandon-on-overview feature.
// @see ../sendExpedition/index.js — parallel mobile-button feature (reference pattern).

/** @ts-check */

import { settingsStore } from '../../state/settings.js';
import { scansStore, flushScansStore } from '../../state/scans.js';
import { registryStore } from '../../state/registry.js';
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import {
  colonizeDecisionsStore,
  flushColonizeDecisionsStore,
} from '../../state/colonizeDecisions.js';
import {
  blockingCoords,
  withDecision,
  DEC_SENT,
  DEC_TAKEN,
  DEC_RESERVED,
  RESERVE_HOLD_MS,
} from '../../domain/colonizeDecisions.js';
import { parsePositions } from '../../domain/positions.js';
import { createButton as makeButton, labelLines } from '../shared/button.js';
import { LANDER_GLYPH } from '../shared/buttonGlyphs.js';
import {
  select as courierSelect,
  retarget as courierRetarget,
  dispatch as courierDispatch,
  step as courierStep,
  readyToDispatch,
  installFleetCourier,
  bareFleetdispatchUrl,
} from '../shared/fleetCourier.js';
import {
  findNextColonizeTarget,
  derive,
  render,
  MISSION_COLONIZE,
  BG_SEND_IDLE,
  BG_SEND_READY,
  BG_SEND_ERROR,
  BG_SEND_STALE,
  BG_SEND_WAIT,
} from './pure.js';
import {
  getColonizeWaitTime,
  readHomePlanet,
  parseCurrentGalaxyView,
} from './domHelpers.js';
import { SHIP_COLONY, TARGET_PLANET } from '../../domain/rules.js';
import { OWNER_COL } from '../../domain/fleetOwnership.js';
import {
  CHECK_TARGET_RESULT_EVENT,
  GALAXY_SCANNED_EVENT,
  COLONIZE_SENT_EVENT,
  EVENT_BOX_LOADED_EVENT,
} from '../../lib/ogeEvents.js';
import { whenEventBoxReady } from '../shared/eventBoxGate.js';
import { installFabSettingsLifecycle } from '../shared/fabSettingsLifecycle.js';
import { createFleetDispatcherCache } from '../shared/fleetDispatcherCache.js';
import { getApiContext } from '../shared/apiContextStore.js';
import { clock } from '../../lib/clock.js';

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
 */

// ─── DOM ids ───────────────────────────────────────────────────────────

/** id of the wrap div that hosts the button. */
const BUTTON_ID = 'oge-send-col';
/** id of the (single) Send zone. */
const SEND_HALF_ID = 'oge-col-send';

// ─── Storage keys ──────────────────────────────────────────────────────

/** Shared focus-persist key with sendExpedition. */
const FOCUS_KEY = 'oge_focusedBtn';
/** Focus-persist value written when the Send zone holds focus. */
const FOCUS_SEND = 'col-send';

// ─── Tunables ──────────────────────────────────────────────────────────
//
// Colour constants (`BG_SEND_*` / `BG_SCAN_*`), the checkTarget /
// scan-cooldown timeouts, and `MISSION_COLONIZE` all moved to
// `./pure.js` because they belong to the pure render / derive
// surface. Imported above and used below only for the impure paint
// fallbacks (e.g. "None available" flash) and the fleetdispatch URL
// sniff.

/** Delay before restoring focus on install (matches sendExpedition). */
const FOCUS_RESTORE_DELAY_MS = 50;
/** Repaint ticker period in ms. */
const REPAINT_TICK_MS = 1000;
/** Hold duration (ms) required to trigger a manual skip of the current candidate. */
const HOLD_SKIP_MS = 2000;
/**
 * How long to hold the busy lock after a successful dispatch. The game reloads
 * the page within ~1 s on the happy path; this safety net releases the lock if
 * that reload never comes. Mirrors sendExpedition's post-send lock window.
 */
const SENT_LOCK_MS = 3000;

// ─── Module-local state (§3) ───────────────────────────────────────────

/**
 * Cached snapshot of `window.fleetDispatcher`, published by the MAIN-world
 * bridge `bridges/fleetDispatcherSnapshot.js` (the isolated content script
 * can't read it directly). On fleetdispatch, `derive()` reads
 * targetPlanet/orders/shipsOnPlanet from `fdCache.get()`; a fresh snapshot
 * repaints the button immediately via `onUpdate`.
 */
const fdCache = createFleetDispatcherCache({ onUpdate: () => refresh() });

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
/**
 * False while the game's async event-list XHR hasn't landed on this page view.
 * Gates `refresh()` (paints a "Wait…" hold instead of a candidate label) and
 * `onSendClick` (a tap is a no-op) so the button never computes or acts on a
 * candidate while the page — and our stores — are still hydrating. THE SAME
 * gate that drives the shared Button's visual disable (`gateUntilEventBox`),
 * so the label is never a confident "No more candidates" on a half-loaded
 * page. The `true` default keeps standalone `refresh()` paints ungated.
 * Mirrors dailyRun's eventbox gate.
 *
 * @type {boolean}
 */
let eventBoxReady = true;
/**
 * Active post-send lock timer — releases the busy lock if the expected
 * post-dispatch page reload never comes. `null` when no send is settling.
 *
 * @type {ReturnType<typeof setTimeout> | null}
 */
let sentLockTimer = null;

// ─── DOM paint (impure — drives the shared Button controller) ──────────

/**
 * Paint one zone of the button from a {@link Paint}. `subtext` → two
 * stacked lines (big primary on top, small caption below — matching the
 * dailyRun / sendExpedition layout so all three buttons read the same way);
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
  const cfg = galaxyScanConfigStore.get();
  const apiCtx = getApiContext();
  return {
    search: location.search,
    // `window.fleetDispatcher` lives in the page world and is NOT
    // accessible from the isolated content script. We read a snapshot
    // published by `bridges/fleetDispatcherSnapshot.js` (MAIN world) via
    // `oge:fleetDispatcher` event. `fleetDispatcherSnapshot` below is
    // the cached latest snapshot, `null` until first event arrives.
    fleetDispatcher: fdCache.get(),
    scans: scansStore.get(),
    registry: registryStore.get(),
    targets: parsePositions(cfg.positions),
    preferOther: cfg.preferOtherGalaxies,
    farthestFirst: cfg.preferFarthestSystems,
    now: Date.now(),
    // Previously read directly by `derive`; now snapshotted here so the
    // pure core stays DOM-free. `readHomePlanet` → `#planetList`,
    // `parseCurrentGalaxyView` → `#galaxy_input` / URL.
    home: readHomePlanet(),
    view: parseCurrentGalaxyView(),
    // API occupancy index (whole-server breadth) + the decision log's current
    // blocking coords (sent/mine/abandoned/taken/reserved), so the picker
    // offers — and skips — provisional candidates. The decision log is
    // persistent + (Stage 4) synced, replacing the old transient reject set.
    index: apiCtx?.index ?? null,
    // Server grid bounds → lets derive turn occupiedByPosition into a whole-
    // universe free-slot count for the "N free" sub-label.
    serverDims: apiCtx?.server
      ? { galaxies: apiCtx.server.galaxies, systems: apiCtx.server.systems }
      : null,
    rejected: blockingCoords(colonizeDecisionsStore.get(), Date.now()),
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
  // The Send zone is owned by the courier handler while a select()/dispatch()
  // is in flight (busy) or once a send is armed-ready on step 2; otherwise it
  // shows the derive-computed next-candidate label.
  if (busy) return;
  // Event list (and our stores) not hydrated on this page view yet — hold a
  // "Wait…" label instead of computing a candidate, so the label never flashes
  // a confident "No more candidates" on a half-loaded page. The shared Button's
  // visual gate (`gateUntilEventBox`) disables taps in parallel off the same
  // signal; this keeps the LABEL honest. Mirrors dailyRun.
  if (!eventBoxReady) {
    paintZone('send', { text: 'Wait…', bg: BG_SEND_WAIT, dim: true });
    return;
  }
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
    case 'allFleets':
      // Every general fleet slot in use (T11) — nothing can launch until a
      // fleet returns. Not an error with the target, so no coords subtext.
      return { text: 'All fleets!', bg: BG_SEND_ERROR };
    case 'noShip':
      return { text: 'No ship!', subtext: coords, bg: BG_SEND_ERROR };
    case 'noMoon':
      return { text: 'No moon', subtext: coords, bg: BG_SEND_ERROR };
    case 'reserved':
      return { text: 'Reserved', subtext: coords, bg: BG_SEND_STALE };
    case 'mission':
    case 'stale':
    case 'generic':
      // 'generic' = a target-side checkTarget failure (vacation, strong-player
      // protection, bashing limit, …). The slot was just marked for skip by
      // onCheckTargetResult, so this is the "moving on" state, not a hard error.
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
  // Page/stores still hydrating — the visual gate already swallows the tap,
  // but guard here too so a focus-driven or programmatic call can't act on a
  // half-loaded candidate set (the false "No more candidates"). Mirrors dailyRun.
  if (!eventBoxReady) return;
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
    const r = await courierDispatch(OWNER_COL);
    colReady = false;
    if (!r.ok) {
      busy = false;
      // Fleet2 stopped being ours between the taps (another initiator took
      // over) — abandon it for a clean fleet1 instead of sending their fleet.
      if (r.reason === 'foreign') {
        location.href = bareFleetdispatchUrl();
        return;
      }
      paintZone('send', {
        text: r.errorCode === 140026 ? 'No fuel' : 'Failed',
        bg: BG_SEND_ERROR,
      });
      return;
    }
    // Success → the game navigates; onColonizeSent records the slot. HOLD the
    // busy lock through the post-send navigation window so no reactor / ticker
    // repaints the button into a stale unlocked state (the "weird unlocked
    // states" before reload). The safety timeout releases the lock if the
    // expected reload never comes. Mirrors sendExpedition's lock + timeout.
    colTarget = null;
    paintZone('send', { text: 'Sent!', bg: BG_SEND_READY });
    if (sentLockTimer) clearTimeout(sentLockTimer);
    sentLockTimer = setTimeout(() => {
      sentLockTimer = null;
      busy = false;
      refresh();
    }, SENT_LOCK_MS);
    return;
  }

  // Find the next DB candidate (works on AND off fleetdispatch).
  const cfg = galaxyScanConfigStore.get();
  const home = readHomePlanet();
  const candidate = home
    ? findNextColonizeTarget(
        scansStore.get(),
        registryStore.get(),
        home,
        /** @type {number[]} */ (parsePositions(cfg.positions)),
        cfg.preferOtherGalaxies,
        cfg.preferFarthestSystems,
        getApiContext()?.index ?? null,
        blockingCoords(colonizeDecisionsStore.get(), Date.now()),
      )
    : null;
  if (!candidate) {
    paintZone('send', { text: 'No more candidates', bg: BG_SEND_IDLE });
    return;
  }

  // Already on a fleet2 whose armed target turned out dead (we'd have taken
  // the dispatch branch above if it were still armed) → retarget IN PLACE to
  // the next free candidate instead of dispatching. `findNextColonizeTarget`
  // already skipped the slot the previous attempt marked, so `candidate` is a
  // fresh one. Done on this discrete click so AGR doesn't re-clobber the edit
  // (it only overwrites the fleet1→fleet2 transition, not a settled fleet2).
  if (s === 'fleet2') {
    busy = true;
    colReady = false;
    paintZone('send', { text: 'Wait…', bg: BG_SEND_WAIT, dim: true });
    const r = await courierRetarget({
      spec: { kind: 'list', ships: [{ id: SHIP_COLONY, qty: 1, frac: 1 }] },
      target: {
        galaxy: candidate.galaxy,
        system: candidate.system,
        position: candidate.position,
        type: TARGET_PLANET,
      },
      mission: MISSION_COLONIZE,
      owner: OWNER_COL,
    });
    busy = false;
    if (!r.ok) {
      // Lost ownership of fleet2 between taps → bail to a clean fleet1.
      if (r.reason === 'foreign') {
        location.href = bareFleetdispatchUrl();
        return;
      }
      // Dead again — onCheckTargetResult marked this slot too, so the next
      // tap retargets to whatever is still free.
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
    owner: OWNER_COL,
  });
  busy = false;
  if (!r.ok) {
    // The visible fleet2 belongs to someone else (player's manual send, AGR
    // routine, another OG-E button) — never arm colonize over their fleet.
    // Per T5: block and route to a bare fleetdispatch for a clean fleet1.
    if (r.reason === 'foreign') {
      location.href = bareFleetdispatchUrl();
      return;
    }
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
 * Record a colonization decision for a coord and flush synchronously so it
 * survives the game's immediate post-send page reload (mirrors
 * `flushScansStore`). Monotonic + persistent — this is the durable, Stage-4-
 * syncable replacement for the old transient reject set.
 *
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @param {import('../../domain/colonizeDecisions.js').Decision} decision
 * @returns {void}
 */
const recordDecision = (galaxy, system, position, decision) => {
  const key = /** @type {`${number}:${number}:${number}`} */ (`${galaxy}:${system}:${position}`);
  colonizeDecisionsStore.update((prev) => withDecision(prev, key, decision));
  void flushColonizeDecisionsStore();
};

/**
 * React to `oge:checkTargetResult` by recording, in `scansStore`, that a
 * colonize candidate the game just reported as un-colonizable should stop
 * being proposed. THE authority here is the event's own `detail` — its
 * coords, its `orders` map, its `errorCode` — never the fleetDispatcher
 * snapshot.
 *
 * Why not the snapshot: it is published by a SEPARATE bridge one microtask
 * AFTER this synchronous `oge:checkTargetResult` dispatch, so at this instant
 * it is always one checkTarget behind the event we're handling. Reading
 * `fd.targetPlanet` / `fd.orders` here (the old code) therefore compared the
 * fresh response against the PREVIOUS target — bailing on the coord guard, or
 * misjudging `canColonize` from stale orders — and silently skipped the mark.
 * The dead slot stayed `empty`, so `findNextColonizeTarget` re-proposed it on
 * the next tap → the wait→Stale→nothing soft-lock. The `detail` carries the
 * same authoritative `orders` the courier reads, so we use it directly.
 *
 * Marking is deliberately a DOWNGRADE of an existing `empty` candidate only —
 * never a phantom create (which would also mark the whole system scan-fresh
 * and starve the Scan half) and never a touch on a non-empty slot. That scopes
 * the reactor to exactly the soft-lock case and leaves unrelated checkTargets
 * (expeditions, manual sends) alone.
 *
 *   - errorCode 140016 (reserved for planet-move) → 'reserved' (24 h cooldown).
 *   - errorCode 140035 (no colony ship aboard) → NO mark: the slot is fine,
 *     we just lack a ship (build/move one and retry). This is the SOLE error
 *     about us rather than the target.
 *   - ANY other checkTarget failure errorCode (player on vacation 140008,
 *     strong-player / bashing-limit / noob protection, …) → 'abandoned': the
 *     slot is not a usable target right now, so stop proposing it. A later scan
 *     reclassifies it (e.g. to 'vacation'); meanwhile it sits out the ~day
 *     cooldown. Skipping these is what breaks the wait→timeout loop, since a
 *     same-coord retry would just hit the game's checkTarget dedup.
 *   - success (no error) with orders present and `orders['7'] !== true` →
 *     'abandoned' too (slot inhabited / taken). 'abandoned' is a generic
 *     player-less marker — we have no player block to record here.
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
  const errorCode = extractErrorCode(detail);
  const orders =
    detail.orders && typeof detail.orders === 'object' ? detail.orders : null;
  const canColonize = !!orders && orders[String(MISSION_COLONIZE)] === true;

  /** @type {import('../../domain/scans.js').Position | null} */
  let newPos = null;
  if (errorCode === 140016) {
    newPos = { status: 'reserved' };
  } else if (errorCode != null && errorCode !== 140035) {
    // Any target-side checkTarget failure other than "no colony ship".
    newPos = { status: 'abandoned', flags: { hasAbandonedPlanet: true } };
  } else if (errorCode == null && orders && !canColonize) {
    // Success response, but colonize is not permitted on this target.
    newPos = { status: 'abandoned', flags: { hasAbandonedPlanet: true } };
  }
  if (!newPos) {
    refresh();
    return;
  }

  // Persistently record the refusal in the decision log so the picker stops
  // re-proposing it (and Stage 4 syncs it). 140016 = a temporary planet-move
  // hold (reserved, expires after ~RESERVE_HOLD_MS); anything else here = the
  // slot is occupied/blocked (taken). Covers API-only candidates that have no
  // scan entry to downgrade below. (140035 "no colony ship" took the !newPos
  // path above — it's about us, not the slot, so it is never recorded.)
  const decNow = Date.now();
  recordDecision(
    galaxy,
    system,
    position,
    errorCode === 140016
      ? { s: DEC_RESERVED, ts: decNow, aa: decNow + RESERVE_HOLD_MS }
      : { s: DEC_TAKEN, ts: decNow },
  );

  // Only ever downgrade an EXISTING 'empty' colonize candidate (preserving its
  // original scannedAt) — see the doc comment for why we never create here.
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  const cur = scansStore.get()[key];
  if (cur?.positions?.[position]?.status === 'empty') {
    const p = newPos;
    scansStore.update((prev) => {
      const existing = prev[key];
      if (existing?.positions?.[position]?.status !== 'empty') return prev;
      return {
        ...prev,
        [key]: {
          ...existing,
          positions: { ...existing.positions, [position]: p },
        },
      };
    });
  }

  refresh();
};

/**
 * React to `oge:galaxyScanned`: a live scan just landed in `scansStore`
 * (merged by `state/scans.js`). Repaint so the picker reflects the fresher
 * data — a live scan overrides the API breadth layer in the composite (a slot
 * the API thought empty but the scan sees taken, or vice-versa).
 *
 * @returns {void}
 */
const onGalaxyScanned = () => {
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

  // Also record a persistent + (Stage 4) syncable 'sent' decision so a second
  // device knows this slot is in-flight and continues with only the remaining
  // free positions. `aa` = arrival, so it stops blocking after arrival+grace if
  // the colony never lands (recall/fail). Skip when arrivalAt is unknown (0) —
  // the local empty_sent + registry still guard the same-device case.
  if (typeof detail.arrivalAt === 'number' && detail.arrivalAt > 0) {
    recordDecision(galaxy, system, position, {
      s: DEC_SENT,
      ts: Date.now(),
      aa: detail.arrivalAt,
    });
  }
};

/**
 * Hold gesture on the Send zone: manually skip the current candidate so the
 * picker stops proposing it (and the "N free" stat drops by one).
 *
 * Intended for unhandled game-side blocks: the position can't be colonized but
 * our data still shows it as a valid target, causing the button to stall. Hold
 * lets the player move past it without losing progress.
 *
 * Records a durable `taken` DECISION rather than the old `scansStore`
 * empty_sent write. The scans-only path silently bailed for API-only candidates
 * (systems never live-scanned have no `scans[key]` entry to mutate) — so skip
 * appeared to do nothing on exactly the breadth-layer targets it's needed for.
 * A decision blocks the coord regardless of any scan entry, persists, and (Stage
 * 4) syncs. `refresh()` is explicit because the decisions store is what changed.
 *
 * @returns {void}
 */
const onSendHold = () => {
  if (busy) return;
  // Only available after step 1 — skip the armed target and reset to idle.
  // In the idle state the hold does nothing (no visible hint, no known target).
  const c = colReady && colTarget ? colTarget : null;
  if (!c) return;

  recordDecision(c.galaxy, c.system, c.position, { s: DEC_TAKEN, ts: Date.now() });

  colReady = false;
  colTarget = null;
  refresh();
};

// ─── Lifecycle ─────────────────────────────────────────────────────────

/**
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Makes `installSendColony` idempotent.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the colonize button. Idempotent — a second call returns the
 * SAME dispose fn as the first.
 *
 * Lifecycle:
 *   1. Snapshot settings. If `fabMode === false` we skip DOM work
 *      entirely but still subscribe to settings so a later flip to
 *      `true` creates the button live.
 *   2. Renders (if enabled): `<div id="oge-send-col">` + two halves,
 *      registered as the 'col' module of the unified FAB (which owns
 *      position + drag). Focus wired via `shared/draggableButton.js`.
 *   3. Paints the initial label via derive → render → paint.
 *   4. Starts a 1 Hz repaint ticker.
 *   5. Subscribes to settings / scans / registry stores + three
 *      bridge events for refresh triggers.
 *   6. Returns dispose: removes button, unsubs all, removes listeners,
 *      clears ticker.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSendColony = () => {
  if (installed) return installed.dispose;

  // Cache the fleetDispatcher snapshot (colony-ship availability) so the
  // courier's select() can resolve the fleet.
  installFleetCourier();

  // Eventbox readiness — the SAME gate that drives the button's visual disable
  // (`gateUntilEventBox` below). Starts not-ready on fleetdispatch and opens on
  // the first of the eventList XHR, window load, or the safety net; off
  // fleetdispatch it opens synchronously (nothing to wait for). At that one
  // moment we flip the flag and repaint with a real candidate — so the label is
  // honest at-or-before the instant the button becomes enabled. Mirrors dailyRun.
  eventBoxReady = false;
  const stopGate = whenEventBoxReady(() => {
    eventBoxReady = true;
    refresh();
  });
  // Permanent repaint on EVERY later eventbox refresh so a candidate first
  // computed when the gate opened via the fallback (before the first XHR
  // landed) is corrected without waiting on the 1 Hz ticker. (Unlike dailyRun
  // we read candidates from OG-E stores, not the freshly-inserted event rows,
  // so no post-load settle repaint is needed.)
  const onEventBoxLoaded = () => refresh();
  document.addEventListener(EVENT_BOX_LOADED_EVENT, onEventBoxLoaded);

  /**
   * Create + mount the button DOM. Idempotent: bails when already mounted.
   *
   * @returns {void}
   */
  const mount = () => {
    // Already mounted → keep the live controller; a redundant call must
    // NOT overwrite it with makeButton's null (idempotency-guard return).
    if (document.getElementById(BUTTON_ID)) return;

    const size = settingsStore.get().fabBtnSize;
    controller = makeButton({
      id: BUTTON_ID,
      title: 'Colonization',
      ringId: 'oge-ring-col',
      size,
      // Matches sendExpedition / sendLifeform so the single-word labels read at
      // the same size across the 1-zone command buttons (was 0.12 — too small).
      fontScale: 0.18,
      module: { id: 'col', name: 'Colonization', color: BG_SEND_IDLE, glyph: LANDER_GLYPH },
      gateUntilEventBox: true,
      focusKey: FOCUS_KEY,
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

  // Bootstrap snapshot BEFORE first mount — so the initial paint sees the
  // right phase (seeds from a live `window.fleetDispatcher` when readable;
  // otherwise the bridge event populates it asynchronously).
  fdCache.bootstrap();

  // Settings-driven mount/teardown + live resize — the wiring shared by
  // every send* FAB feature. Any settings change can flip the candidate,
  // so repaint on every notification via `onSettingsChange`.
  const unsubSettings = installFabSettingsLifecycle({
    settingsStore,
    mount,
    removeButton,
    updateButtonSize,
    isInstalled: () => installed !== null,
    onSettingsChange: refresh,
  });

  // Galaxy-Scan config (positions / preference / rescan policy) drives both
  // the candidate and the Scan-remaining count — refresh on every change,
  // including the ones sync applies after a cross-device edit.
  const unsubGalaxyConfig = galaxyScanConfigStore.subscribe(() => refresh());
  const unsubScans = scansStore.subscribe(() => refresh());
  const unsubRegistry = registryStore.subscribe(() => refresh());
  // The "N free" stat subtracts decision-log blocks (sent / skipped / taken /
  // reserved), so a decision change must repaint — e.g. a manual skip writes a
  // `taken` decision and nothing else.
  const unsubDecisions = colonizeDecisionsStore.subscribe(() => refresh());

  // Bridge event listeners.
  fdCache.attach();
  document.addEventListener(CHECK_TARGET_RESULT_EVENT, onCheckTargetResult);
  document.addEventListener(GALAXY_SCANNED_EVENT, onGalaxyScanned);
  document.addEventListener(COLONIZE_SENT_EVENT, onColonizeSent);

  // 1 Hz repaint ticker — the only timer in the whole feature.
  const unsubTicker = clock.subscribe(refresh, { everyMs: REPAINT_TICK_MS });

  installed = {
    dispose: () => {
      unsubTicker();
      removeButton();
      unsubSettings();
      unsubGalaxyConfig();
      unsubScans();
      unsubRegistry();
      unsubDecisions();
      fdCache.detach();
      document.removeEventListener(CHECK_TARGET_RESULT_EVENT, onCheckTargetResult);
      document.removeEventListener(GALAXY_SCANNED_EVENT, onGalaxyScanned);
      document.removeEventListener(COLONIZE_SENT_EVENT, onColonizeSent);
      document.removeEventListener(EVENT_BOX_LOADED_EVENT, onEventBoxLoaded);
      stopGate();
      if (sentLockTimer) {
        clearTimeout(sentLockTimer);
        sentLockTimer = null;
      }
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

export const _resetSendColonyForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  fdCache.reset();
  busy = false;
  colReady = false;
  colTarget = null;
  waitStartAt = 0;
  waitTotalSecs = 0;
  eventBoxReady = true;
  if (sentLockTimer) {
    clearTimeout(sentLockTimer);
    sentLockTimer = null;
  }
};
