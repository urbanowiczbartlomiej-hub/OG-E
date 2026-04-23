// Floating "Send Col" button — the rewrite of the old `features/sendCol/`
// split directory (6 files, 1901 LoC, 8 fields of state, 3 timers) into
// a single orchestrator file driven by a pure `derive()` → `render()`
// → `paint()` pipeline. See {@link ../../SENDCOL_DESIGN.md} for the
// authoritative spec, especially §1 axioms, §2 ButtonContext, §3 state
// fields, §4 derive pseudocode, §5 render pseudocode, §6 click handlers.
//
// # Role
//
// The colonize button. One ui widget, two halves: Send (top) picks the
// next colony target + navigates or dispatches, Scan (bottom) walks the
// galaxy DB to find systems that still need scanning.
//
// # Axioms (SENDCOL_DESIGN.md §1)
//
//   1. Scan and Send are independent. Scan never navigates to
//      fleetdispatch. Send never submits galaxy scan forms.
//   2. `window.fleetDispatcher` is the source of truth on fleetdispatch.
//   3. Abandon belongs to `abandonOverview.js` now — this file does NOT
//      reference `checkAbandonState` / `abandonPlanet`.
//   4. State machine is explicit: discriminated `ButtonContext` union
//      worked out in `derive()`, not spread across 8 fields.
//   5. Timestamps + a single 1 Hz repaint ticker replace timers.
//   6. TOS: 1 user click → at most 1 originated HTTP request.
//
// # Persistent state — five module `let`s (§3)
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
// # Tick policy (§7)
//
// Event-driven refresh calls happen on every relevant change
// (settings / scans / registry / bridge events + user clicks). One 1 Hz
// `setInterval` at mount feeds the waitGap countdown and the timeout
// detection — zero other timers (no scanUnlock, no checkTargetWatchdog,
// no countdown-setInterval).
//
// # autoRedirectColonize — REMOVED (§8)
//
// The setting stays in `state/settings.js` for backwards-compat-free
// schema (we don't migrate it, we just ignore it). The `colonizeSent`
// reactor only marks the sent slot as `empty_sent` in scansStore —
// it does NOT auto-navigate anywhere. Fits axiom #1.
//
// # Bridge event shape compat
//
// The `oge5:checkTargetResult` bridge still ships the full 13-field
// detail shape. This module only needs `errorCode` (§9 of design). We
// accept both: prefer `detail.errorCode` when present (future simplified
// bridge), else pull `detail.errorCodes[0]` from the current shape.
//
// # Integration seams
//
//   - Pure helpers live in `./sendColLogic.js` — all target-picking
//     algorithms plus URL builders + DOM coord readers are there.
//   - Drag + focus reuse `lib/draggableButton.js` (same `oge5_focusedBtn`
//     key as sendExp).
//   - Abandon overlay is `features/abandonOverview.js` — orthogonal.
//
// @see ../../SENDCOL_DESIGN.md — the authoritative spec.
// @see ./sendColLogic.js — pure helpers this orchestrator consumes.
// @see ./abandonOverview.js — the abandon-on-overview feature.
// @see ./sendExp.js — parallel mobile-button feature (reference pattern).

/** @ts-check */

import { settingsStore } from '../state/settings.js';
import { scansStore } from '../state/scans.js';
import { registryStore } from '../state/registry.js';
import { safeLS } from '../lib/storage.js';
import { parsePositions } from '../domain/positions.js';
import {
  installDrag,
  installFocusPersist as installButtonFocusPersist,
} from '../lib/draggableButton.js';
import {
  findNextScanSystem,
  findNextColonizeTarget,
  pickCandidateInView,
  getColonizeWaitTime,
  readHomePlanet,
  parseCurrentGalaxyView,
  buildFleetdispatchUrl,
  buildGalaxyUrl,
} from './sendColLogic.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../domain/registry.js').RegistryEntry} RegistryEntry
 * @typedef {{ galaxy: number, system: number, position: number }} Coords
 */

/**
 * `nextScan` + `scanCooldown` apply everywhere (user can click Scan
 * from idle / galaxy / fleetdispatch pages alike). `candidate` / `target`
 * / `phase` are page-kind specific.
 *
 * @typedef {(
 *   | {
 *       kind: 'idle',
 *       candidate: Coords | null,
 *       nextScan: { galaxy: number, system: number } | null,
 *       scanCooldown: boolean,
 *     }
 *   | {
 *       kind: 'galaxy',
 *       candidate: Coords | null,
 *       nextScan: { galaxy: number, system: number } | null,
 *       scanCooldown: boolean,
 *     }
 *   | {
 *       kind: 'fleetdispatch',
 *       target: Coords | null,
 *       phase:
 *         | { tag: 'noTarget' }
 *         | { tag: 'ready' }
 *         | { tag: 'noShip' }
 *         | { tag: 'reserved' }
 *         | { tag: 'stale' }
 *         | { tag: 'timeout' }
 *         | { tag: 'waitGap', remaining: number },
 *       nextScan: { galaxy: number, system: number } | null,
 *       scanCooldown: boolean,
 *     }
 * )} ButtonContext
 */

/**
 * @typedef {{ text: string, bg: string, subtext?: string, dim?: boolean }} Paint
 * @typedef {{ send: Paint, scan: Paint }} RenderResult
 */

// ─── DOM ids ───────────────────────────────────────────────────────────

/** id of the wrap div that hosts both halves. */
const BUTTON_ID = 'oge5-send-col';
/** id of the Send (top) half. */
const SEND_HALF_ID = 'oge5-col-send';
/** id of the Scan (bottom) half. */
const SCAN_HALF_ID = 'oge5-col-scan';

// ─── Storage keys ──────────────────────────────────────────────────────

/** Shared focus-persist key with sendExp. */
const FOCUS_KEY = 'oge5_focusedBtn';
/** Focus-persist value written when the sendHalf holds focus. */
const FOCUS_SEND = 'col-send';
/** Focus-persist value written when the scanHalf holds focus. */
const FOCUS_SCAN = 'col-scan';
/** localStorage key for the dragged wrap `(x, y)` position. */
const POS_KEY = 'oge5_colBtnPos';

// ─── Colors (inlined from the old labels.js — see SENDCOL_DESIGN.md §5) ──

/** Green, translucent — idle "Send" with no candidate yet. */
const BG_SEND_IDLE = 'rgba(0, 160, 0, 0.75)';
/** Darker blue — idle "Scan" / "Skip" half. */
const BG_SCAN_IDLE = 'rgba(60, 100, 150, 0.75)';
/** Bright green — active "Dispatch!" / "Send Colony [g:s:p]". */
const BG_SEND_READY = 'rgba(0, 200, 0, 0.85)';
/** Amber — reserved / stale / timeout states (recoverable). */
const BG_SEND_STALE = 'rgba(200, 150, 0, 0.85)';
/** Red — "No ship!" (unrecoverable until user builds a colonizer). */
const BG_SEND_ERROR = 'rgba(200, 0, 0, 0.85)';
/** Yellow — mid-countdown "Wait Xs" label. */
const BG_SEND_WAIT = 'rgba(200, 200, 0, 0.8)';

// ─── Tunables ──────────────────────────────────────────────────────────

/** Drag-vs-tap threshold in pixels (matches sendExp + 4.x). */
const DRAG_THRESHOLD = 8;
/** Default offset from the bottom-right corner when no saved pos. */
const DEFAULT_EDGE_OFFSET_PX = 20;
/** Delay before restoring focus on install (matches sendExp). */
const FOCUS_RESTORE_DELAY_MS = 50;
/** After this many ms without a checkTarget response on fleetdispatch,
 *  derive() returns phase `timeout`. */
const CHECK_TARGET_TIMEOUT_MS = 15_000;
/** Safety cap — if `oge5:galaxyScanned` never arrives (AGR swallowed
 *  the XHR, network died, …), the Scan half unlocks anyway after this
 *  many ms. Under normal conditions the event arrives well under 1s
 *  and the cooldown lifts event-driven; this is the escape hatch. */
const SCAN_COOLDOWN_MS = 8000;
/** Repaint ticker period in ms. */
const REPAINT_TICK_MS = 1000;
/** Mission id for colonize. Duplicated here from domain/rules.js so the
 *  search-string check in derive() doesn't pay a module import. */
const MISSION_COLONIZE = 7;

// ─── Module-local state (§3) ───────────────────────────────────────────

/** Timestamp of the last "nav to fleetdispatch with a target" action. */
let lastNavToFleetdispatchAt = 0;
/**
 * Timestamp of the last `oge5:galaxyScanned` event we received. Used
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
 * `oge5:fleetDispatcher` event arrives (initial publish deferred to
 * DOMContentLoaded + microtask). On fleetdispatch, `derive()` reads
 * targetPlanet/orders/shipsOnPlanet from here.
 *
 * @type {import('../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot | null}
 */
let fleetDispatcherSnapshot = null;

let waitStartAt = 0;
/** Total seconds of the current waitGap countdown (0 = no countdown). */
let waitSeconds = 0;

// ─── Pure derive() ─────────────────────────────────────────────────────

/**
 * @typedef {import('../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 * @typedef {{
 *   search: string,
 *   fleetDispatcher: FleetDispatcherSnapshot | null,
 *   scans: GalaxyScans,
 *   registry: RegistryEntry[],
 *   targets: number[],
 *   preferOther: boolean,
 *   now: number,
 * }} DeriveEnv
 */

/**
 * Pure `env → ButtonContext` compute. Follows SENDCOL_DESIGN.md §4
 * verbatim — fleetdispatch branch first (the richest), galaxy branch
 * second (with current-view priority), idle branch last.
 *
 * @param {DeriveEnv} env
 * @returns {ButtonContext}
 */
export const derive = (env) => {
  // Universal scan state — user can Scan from any page (idle / galaxy /
  // fleetdispatch). Cooldown is event-driven (unlocks on
  // `oge5:galaxyScanned`) with a hard safety cap for silent failures.
  const home = readHomePlanet();
  const view = parseCurrentGalaxyView();
  const nextScan = home ? findNextScanSystem(env.scans, home, view) : null;
  const scanCooldown =
    lastScanSubmitAt > lastScanEventAt &&
    env.now - lastScanSubmitAt < SCAN_COOLDOWN_MS;

  // Fleetdispatch branch — `fleetDispatcher` snapshot is the truth.
  if (
    env.search.includes('component=fleetdispatch') &&
    env.search.includes(`mission=${MISSION_COLONIZE}`)
  ) {
    const fd = env.fleetDispatcher;
    if (!fd) {
      return {
        kind: 'fleetdispatch', target: null, phase: { tag: 'noTarget' },
        nextScan, scanCooldown,
      };
    }
    const tp = fd.targetPlanet;
    /** @type {Coords | null} */
    const target =
      tp && tp.galaxy && tp.system && tp.position
        ? { galaxy: tp.galaxy, system: tp.system, position: tp.position }
        : null;
    if (!target) {
      return {
        kind: 'fleetdispatch', target: null, phase: { tag: 'noTarget' },
        nextScan, scanCooldown,
      };
    }

    const shipsOnPlanet = Array.isArray(fd.shipsOnPlanet) ? fd.shipsOnPlanet : [];
    const hasColonizer = shipsOnPlanet.some(
      (/** @type {any} */ s) => s && s.id === 208 && (s.number || 0) > 0,
    );
    const canColonize =
      fd.orders && fd.orders['7'] === true;
    const err = lastCheckTargetError;

    // Priority (§4): timeout > waitGap > reserved > noShip > stale > ready.
    /** @type {
     *   | { tag: 'noTarget' }
     *   | { tag: 'ready' }
     *   | { tag: 'noShip' }
     *   | { tag: 'reserved' }
     *   | { tag: 'stale' }
     *   | { tag: 'timeout' }
     *   | { tag: 'waitGap', remaining: number }
     * } */
    let phase = { tag: 'ready' };
    if (
      env.now - lastNavToFleetdispatchAt > CHECK_TARGET_TIMEOUT_MS &&
      lastNavToFleetdispatchAt > 0 &&
      !canColonize &&
      err === null
    ) {
      phase = { tag: 'timeout' };
    } else if (waitSeconds > 0) {
      const remaining = Math.max(
        0,
        waitSeconds - Math.floor((env.now - waitStartAt) / 1000),
      );
      // Countdown active → waitGap wins over everything else. When the
      // remaining seconds hit zero, fall through to the next block so
      // the underlying phase (usually `ready`) takes over.
      if (remaining > 0) {
        phase = { tag: 'waitGap', remaining };
      }
    }
    if (phase.tag === 'ready') {
      if (err === 140016) {
        phase = { tag: 'reserved' };
      } else if (err === 140035 || !hasColonizer) {
        phase = { tag: 'noShip' };
      } else if (!canColonize) {
        phase = { tag: 'stale' };
      }
    }
    return { kind: 'fleetdispatch', target, phase, nextScan, scanCooldown };
  }

  // Galaxy branch — current-view priority (§4) so the coords the user
  // just scanned win over the global DB pick.
  if (env.search.includes('component=galaxy')) {
    /** @type {Coords | null} */
    let candidate = null;
    if (home && view) {
      candidate = pickCandidateInView(
        env.scans,
        env.registry,
        env.targets,
        view,
        env.now,
      );
    }
    if (!candidate && home) {
      const global = findNextColonizeTarget(
        env.scans,
        env.registry,
        home,
        env.targets,
        env.preferOther,
      );
      if (global) {
        candidate = {
          galaxy: global.galaxy,
          system: global.system,
          position: global.position,
        };
      }
    }
    return { kind: 'galaxy', candidate, nextScan, scanCooldown };
  }

  // Idle branch — anywhere else (overview, galaxy-less research, ...).
  /** @type {Coords | null} */
  let candidate = null;
  if (home) {
    const global = findNextColonizeTarget(
      env.scans,
      env.registry,
      home,
      env.targets,
      env.preferOther,
    );
    if (global) {
      candidate = {
        galaxy: global.galaxy,
        system: global.system,
        position: global.position,
      };
    }
  }
  return { kind: 'idle', candidate, nextScan, scanCooldown };
};

// ─── Pure render() ─────────────────────────────────────────────────────

/**
 * Render a `ctx` to paint instructions. Pure: no DOM, no window.
 *
 * @param {ButtonContext} ctx
 * @returns {RenderResult}
 */
export const render = (ctx) => {
  // Scan paint:
  //   - On galaxy view: two-line "Scan / [g:s]" — we'll AJAX-submit
  //     into that system. AJAX = our observer fires = store updates =
  //     persistence kicks in.
  //   - Anywhere else: "to Galaxy" — clicking just hops the user to
  //     the galaxy page (bare URL, no specific system). The first
  //     system is server-rendered without an AJAX call, so we'd miss
  //     it anyway; better to land the user on galaxy and let them
  //     drive subsequent scans via AJAX.
  //   - When the entire database is scanned fresh: "All scanned!".
  /** @type {Paint} */
  let scanPaint;
  if (!ctx.nextScan) {
    scanPaint = { text: 'All scanned!', bg: BG_SCAN_IDLE };
  } else if (ctx.kind === 'galaxy') {
    scanPaint = {
      text: `[${ctx.nextScan.galaxy}:${ctx.nextScan.system}]`,
      subtext: 'Scan',
      bg: BG_SCAN_IDLE,
      dim: ctx.scanCooldown,
    };
  } else {
    scanPaint = { text: 'to Galaxy', bg: BG_SCAN_IDLE };
  }

  if (ctx.kind === 'idle') {
    return {
      send: ctx.candidate
        ? {
            text: `[${ctx.candidate.galaxy}:${ctx.candidate.system}:${ctx.candidate.position}]`,
            subtext: 'Send Colony',
            bg: BG_SEND_READY,
          }
        : { text: 'Send', bg: BG_SEND_IDLE },
      scan: scanPaint,
    };
  }

  if (ctx.kind === 'galaxy') {
    return {
      send: ctx.candidate
        ? {
            text: `[${ctx.candidate.galaxy}:${ctx.candidate.system}:${ctx.candidate.position}]`,
            subtext: 'Send Colony',
            bg: BG_SEND_READY,
          }
        : { text: 'Send', bg: BG_SEND_IDLE },
      scan: scanPaint,
    };
  }

  // ctx.kind === 'fleetdispatch'
  const { target, phase } = ctx;
  const coords = target
    ? `[${target.galaxy}:${target.system}:${target.position}]`
    : '';
  /** @type {Paint} */
  let sendPaint;
  switch (phase.tag) {
    case 'noTarget':
      sendPaint = { text: 'Send', bg: BG_SEND_IDLE };
      break;
    case 'ready':
      sendPaint = { text: coords, subtext: 'Dispatch!', bg: BG_SEND_READY };
      break;
    case 'noShip':
      sendPaint = { text: coords, subtext: 'No ship!', bg: BG_SEND_ERROR };
      break;
    case 'reserved':
      sendPaint = { text: coords, subtext: 'Reserved', bg: BG_SEND_STALE };
      break;
    case 'stale':
      sendPaint = { text: coords, subtext: 'Stale', bg: BG_SEND_STALE };
      break;
    case 'timeout':
      sendPaint = { text: coords, subtext: 'Timeout', bg: BG_SEND_STALE };
      break;
    case 'waitGap':
      sendPaint = { text: `Wait ${phase.remaining}s`, bg: BG_SEND_WAIT };
      break;
    default:
      sendPaint = { text: 'Send', bg: BG_SEND_IDLE };
  }
  return { send: sendPaint, scan: scanPaint };
};

// ─── DOM paint (impure — walks the mounted halves) ─────────────────────

/**
 * Paint a two-line label on a half: a small caption on top, a big
 * primary line below. Built with two flex-column `<div>`s so line wrap
 * is deterministic regardless of the half's font-size.
 *
 * @param {HTMLElement} half
 * @param {string} small
 * @param {string} big
 * @param {string} bg
 * @returns {void}
 */
const setHalfTwoLine = (half, small, big, bg) => {
  half.textContent = '';
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;line-height:1.05;width:100%;';
  const top = document.createElement('div');
  top.textContent = small;
  top.style.cssText = 'font-size:0.5em;opacity:0.85;letter-spacing:0.5px;';
  const bottom = document.createElement('div');
  bottom.textContent = big;
  bottom.style.cssText = 'font-size:1em;margin-top:2px;';
  wrap.appendChild(top);
  wrap.appendChild(bottom);
  half.appendChild(wrap);
  half.style.background = bg;
};

/**
 * Paint a single-line label on a half.
 *
 * @param {HTMLElement} half
 * @param {string} text
 * @param {string} bg
 * @returns {void}
 */
const setHalfOneLine = (half, text, bg) => {
  half.textContent = text;
  half.style.background = bg;
};

/**
 * Apply a {@link Paint} to a half DOM element. `subtext` triggers the
 * two-line layout; otherwise it's one line.
 *
 * @param {HTMLElement} half
 * @param {Paint} p
 * @returns {void}
 */
const applyPaint = (half, p) => {
  if (p.subtext) {
    setHalfTwoLine(half, p.subtext, p.text, p.bg);
  } else {
    setHalfOneLine(half, p.text, p.bg);
  }
  // Visual cooldown indicator — `dim: true` greys the half out so the
  // user can see a click would be ignored right now. Render paths that
  // don't set `dim` imply full opacity, so we always explicitly write it.
  half.style.opacity = p.dim ? '0.5' : '1';
};

/**
 * Walk to the currently mounted halves + wrap. Any may be null when the
 * button isn't mounted — every caller no-ops in that case.
 *
 * @returns {{
 *   wrap: HTMLElement | null,
 *   send: HTMLButtonElement | null,
 *   scan: HTMLButtonElement | null,
 * }}
 */
const getHalves = () => ({
  wrap: document.getElementById(BUTTON_ID),
  send: /** @type {HTMLButtonElement | null} */ (
    document.getElementById(SEND_HALF_ID)
  ),
  scan: /** @type {HTMLButtonElement | null} */ (
    document.getElementById(SCAN_HALF_ID)
  ),
});

/**
 * Apply a {@link RenderResult} to the mounted DOM. No-op when the button
 * is not mounted.
 *
 * @param {RenderResult} result
 * @returns {void}
 */
export const paint = (result) => {
  const { send, scan } = getHalves();
  if (send) applyPaint(send, result.send);
  if (scan) applyPaint(scan, result.scan);
};

// ─── captureEnv + refresh ──────────────────────────────────────────────

/**
 * Snapshot the reactive inputs of `derive()` into a single `env` object.
 * The only impurity here is the read of `window.fleetDispatcher`,
 * `location.search`, `settingsStore.get()`, and the two scan / registry
 * stores — all deterministic at the moment of call.
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
    // `oge5:fleetDispatcher` event. `fleetDispatcherSnapshot` below is
    // the cached latest snapshot, `null` until first event arrives.
    fleetDispatcher: fleetDispatcherSnapshot,
    scans: scansStore.get(),
    registry: registryStore.get(),
    targets: parsePositions(settings.colPositions),
    preferOther: settings.colPreferOtherGalaxies,
    now: Date.now(),
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
  paint(render(derive(captureEnv())));
};

// ─── Keyboard synth (Enter on the focused dispatch form) ───────────────

/**
 * Synthesize `Enter` on `document.activeElement` so OGame's own
 * fleetdispatch form submits. Copy of `labels.js:dispatchEnter`.
 *
 * @returns {void}
 */
const dispatchEnter = () => {
  const target = document.activeElement || document;
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  );
  target.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  );
};

// ─── Click handlers (§6) ───────────────────────────────────────────────

/**
 * Handle a click on the Send half. Switches on `ctx.kind` × `phase.tag`
 * per SENDCOL_DESIGN.md §6.
 *
 * @returns {void}
 */
const onSendClick = () => {
  const ctx = derive(captureEnv());
  if (safeLS.bool('oge5_debugSendCol', false)) {
    // eslint-disable-next-line no-console
    console.debug('[OG-E sendCol] onSendClick ctx:', ctx);
  }

  if (ctx.kind === 'idle' || ctx.kind === 'galaxy') {
    if (ctx.candidate) {
      lastNavToFleetdispatchAt = Date.now();
      lastCheckTargetError = null;
      waitSeconds = 0;
      location.href = buildFleetdispatchUrl(ctx.candidate);
      return;
    }
    // No candidate — transient "None available" flash, then revert.
    const { send } = getHalves();
    if (send) setHalfOneLine(send, 'None available', BG_SEND_IDLE);
    return;
  }

  // ctx.kind === 'fleetdispatch'
  switch (ctx.phase.tag) {
    case 'noTarget':
    case 'noShip':
      return;

    case 'reserved': {
      // Reserved (error 140016 = another player reserved via DM). We
      // already marked the slot as `'reserved'` in scansStore from the
      // checkTarget reactor, so `findNextColonizeTarget` skips it for
      // the 24 h cooldown window. Best action on click: jump straight
      // to the next candidate in the DB so the user isn't stuck.
      const settings = settingsStore.get();
      const home = readHomePlanet();
      if (!home) return;
      const next = findNextColonizeTarget(
        scansStore.get(),
        registryStore.get(),
        home,
        /** @type {number[]} */ (parsePositions(settings.colPositions)),
        settings.colPreferOtherGalaxies,
      );
      if (!next) {
        const { send } = getHalves();
        if (send) setHalfOneLine(send, 'No more candidates', BG_SEND_IDLE);
        return;
      }
      lastNavToFleetdispatchAt = Date.now();
      lastCheckTargetError = null;
      waitSeconds = 0;
      location.href = buildFleetdispatchUrl({
        galaxy: next.galaxy,
        system: next.system,
        position: next.position,
      });
      return;
    }

    case 'stale':
    case 'timeout': {
      if (!ctx.target) return;
      // Stale-retry: navigate to the galaxy view of the stuck system.
      // One click → one location.href → game's own fetchGalaxyContent.
      location.href = buildGalaxyUrl({
        galaxy: ctx.target.galaxy,
        system: ctx.target.system,
      });
      return;
    }

    case 'waitGap':
      // Countdown in progress — user click is a no-op (repaint handles
      // the visible timer; a click would otherwise re-check min-gap and
      // bounce right back into waitGap).
      return;

    case 'ready': {
      const wait = getColonizeWaitTime();
      if (wait > 0) {
        waitStartAt = Date.now();
        waitSeconds = wait;
        refresh();
        return;
      }
      dispatchEnter();
      return;
    }
  }
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
  //      `oge5:galaxyScanned` arrives, hard cap 8 s).
  const home = readHomePlanet();
  if (safeLS.bool('oge5_debugSendCol', false)) {
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
    const { scan } = getHalves();
    if (scan) setHalfOneLine(scan, 'All scanned!', BG_SCAN_IDLE);
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
    document.getElementById('galaxy_input')
  );
  const sysInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('system_input')
  );
  if (!sysInput) return false;
  if (galInput) galInput.value = String(galaxy);
  sysInput.value = String(system);
  const submitBtn = /** @type {HTMLElement | null} */ (
    document.querySelector('.btn_blue[onclick*="submitForm"]') ??
      document.querySelector('#galaxyHeader .btn_blue')
  );
  if (submitBtn) {
    submitBtn.click();
    return true;
  }
  return false;
};

// ─── Event reactors (§7) ───────────────────────────────────────────────

/**
 * Extract an error code from a `oge5:checkTargetResult` detail. Handles
 * both the current bridge shape (`errorCodes: number[]`) and the future
 * simplified shape (`errorCode: number | null`) per SENDCOL_DESIGN.md §9.
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
 * React to `oge5:checkTargetResult`. Cross-check the event's coords
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
    /** @type {import('../domain/scans.js').Position | null} */
    let newPos = null;
    if (lastCheckTargetError === 140016) {
      newPos = { status: 'reserved' };
    } else if (
      lastCheckTargetError !== 140035 &&
      lastCheckTargetError !== null &&
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
        /** @type {Record<number, import('../domain/scans.js').Position>} */
        const newPositions = { ...existing.positions, [position]: p };
        return {
          ...prev,
          [key]: { scannedAt: Date.now(), positions: newPositions },
        };
      });
    }
  }

  // A response means we're no longer waiting — reset the nav timestamp
  // so a subsequent timeout measurement starts from "after we heard back".
  // Leaving it set would make the timeout branch fire once the clock
  // wandered past 15 s even though we got an answer.
  lastNavToFleetdispatchAt = 0;
  refresh();
};

/**
 * React to `oge5:fleetDispatcher` — MAIN-world bridge publishing a fresh
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
 * React to `oge5:galaxyScanned`. Three things happen:
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
 * React to `oge5:colonizeSent`. Two things happen:
 *
 *   1. Mark the just-sent slot `'empty_sent'` in `scansStore` so
 *      {@link findNextColonizeTarget} stops picking it until the fleet
 *      either lands (next scan sees `mine`) or fails (auto-prune of
 *      registry + re-scan flips it back).
 *   2. If `settings.autoRedirectColonize` is on, hop straight to the
 *      next colonize target. Mirrors `autoRedirectExpedition` for
 *      expeditions — after a successful send the user usually wants
 *      the next one set up. Deferred by 100 ms so the game's own
 *      post-send navigation flushes first (direct `location.href`
 *      during the response handler races the game's redirect).
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
    /** @type {Record<number, import('../domain/scans.js').Position>} */
    const newPositions = {
      ...existing.positions,
      [position]: { status: 'empty_sent' },
    };
    return {
      ...prev,
      [key]: { scannedAt: existing.scannedAt, positions: newPositions },
    };
  });

  // Auto-redirect to next candidate (opt-in, default true — matches
  // `autoRedirectExpedition` behaviour). User can disable in settings.
  if (!settingsStore.get().autoRedirectColonize) return;
  const home = readHomePlanet();
  if (!home) return;
  const settings = settingsStore.get();
  const next = findNextColonizeTarget(
    scansStore.get(),
    registryStore.get(),
    home,
    /** @type {number[]} */ (parsePositions(settings.colPositions)),
    settings.colPreferOtherGalaxies,
  );
  if (!next) return;
  // Defer one tick — the game's own `redirectUrl` post-send handler
  // fires right after our event; setting `location.href` immediately
  // would race with (and could be preempted by) that redirect.
  setTimeout(() => {
    lastNavToFleetdispatchAt = Date.now();
    lastCheckTargetError = null;
    waitSeconds = 0;
    location.href = buildFleetdispatchUrl({
      galaxy: next.galaxy,
      system: next.system,
      position: next.position,
    });
  }, 100);
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
 * Apply the wrap + halves styling for a given diameter. Split out so
 * live size updates can re-apply without recreating the DOM.
 *
 * @param {HTMLElement} wrap
 * @param {HTMLButtonElement} sendHalf
 * @param {HTMLButtonElement} scanHalf
 * @param {number} size
 * @returns {void}
 */
const applyStyles = (wrap, sendHalf, scanHalf, size) => {
  const fontSize = Math.round(size * 0.12) + 'px';
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
  const halfStyle = [
    'flex:1',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'color:#fff',
    'font-weight:bold',
    'border:none',
    'cursor:pointer',
    `font-size:${fontSize}`,
  ].join(';');
  sendHalf.style.cssText = halfStyle + ';background:' + BG_SEND_IDLE + ';';
  scanHalf.style.cssText = halfStyle + ';background:' + BG_SCAN_IDLE + ';';
};

/**
 * Install the colonize button. Idempotent — a second call returns the
 * SAME dispose fn as the first.
 *
 * Lifecycle:
 *   1. Snapshot settings. If `colonizeMode === false` we skip DOM work
 *      entirely but still subscribe to settings so a later flip to
 *      `true` creates the button live.
 *   2. Renders (if enabled): `<div id="oge5-send-col">` + two halves.
 *      Position from `oge5_colBtnPos` or bottom-right default. Drag +
 *      focus wired via `lib/draggableButton.js`.
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

  /**
   * Create + mount the button DOM. Idempotent: bails when already mounted.
   *
   * @returns {void}
   */
  const mount = () => {
    if (document.getElementById(BUTTON_ID)) return;

    const size = settingsStore.get().colBtnSize;
    const wrap = document.createElement('div');
    wrap.id = BUTTON_ID;

    const sendHalf = document.createElement('button');
    sendHalf.type = 'button';
    sendHalf.id = SEND_HALF_ID;
    sendHalf.className = 'oge5-col-half oge5-col-send';
    sendHalf.tabIndex = 0;
    sendHalf.setAttribute('aria-label', 'Send colonization');
    sendHalf.textContent = 'Send';

    const scanHalf = document.createElement('button');
    scanHalf.type = 'button';
    scanHalf.id = SCAN_HALF_ID;
    scanHalf.className = 'oge5-col-half oge5-col-scan';
    scanHalf.tabIndex = 0;
    scanHalf.setAttribute('aria-label', 'Scan next system');
    scanHalf.textContent = 'Scan';

    applyStyles(wrap, sendHalf, scanHalf, size);
    wrap.appendChild(sendHalf);
    wrap.appendChild(scanHalf);

    // Position — saved drag target or bottom-right default.
    const savedPos = safeLS.json(POS_KEY);
    if (
      savedPos &&
      typeof savedPos === 'object' &&
      savedPos !== null &&
      typeof /** @type {any} */ (savedPos).x === 'number' &&
      typeof /** @type {any} */ (savedPos).y === 'number'
    ) {
      const p = /** @type {{ x: number, y: number }} */ (savedPos);
      wrap.style.left = Math.min(p.x, window.innerWidth - size) + 'px';
      wrap.style.top = Math.min(p.y, window.innerHeight - size) + 'px';
    } else {
      wrap.style.right = DEFAULT_EDGE_OFFSET_PX + 'px';
      wrap.style.bottom = DEFAULT_EDGE_OFFSET_PX + 'px';
    }

    document.body.appendChild(wrap);

    // If we're landing on fleetdispatch directly (user typed a URL,
    // page reload after send, AGR menu), assume the nav timestamp is
    // "now" so the timeout branch doesn't immediately fire on startup.
    if (
      location.search.includes('component=fleetdispatch') &&
      location.search.includes(`mission=${MISSION_COLONIZE}`)
    ) {
      lastNavToFleetdispatchAt = Date.now();
    }

    // Drag + click wiring. Drag lives on the outer wrap so a touch on
    // either half still drags the whole circle. Click handlers consult
    // `wasDrag()` so a drag terminating on a half doesn't double-fire.
    const drag = installDrag({
      element: wrap,
      posKey: POS_KEY,
      size,
      dragThreshold: DRAG_THRESHOLD,
    });
    sendHalf.addEventListener('click', (e) => {
      if (drag.wasDrag()) {
        drag.resetDrag();
        return;
      }
      e.stopPropagation();
      onSendClick();
    });
    scanHalf.addEventListener('click', (e) => {
      if (drag.wasDrag()) {
        drag.resetDrag();
        return;
      }
      e.stopPropagation();
      onScanClick();
    });

    // Focus persistence — shared `oge5_focusedBtn` key with sendExp.
    installButtonFocusPersist({
      button: sendHalf,
      focusKey: FOCUS_KEY,
      focusValue: FOCUS_SEND,
      focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
    });
    installButtonFocusPersist({
      button: scanHalf,
      focusKey: FOCUS_KEY,
      focusValue: FOCUS_SCAN,
      focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
    });

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
    const el = document.getElementById(BUTTON_ID);
    if (el) el.remove();
  };

  /**
   * Live-resize the currently mounted button. No-op when unmounted.
   *
   * @param {number} size
   * @returns {void}
   */
  const updateButtonSize = (size) => {
    const { wrap, send, scan } = getHalves();
    if (!wrap || !send || !scan) return;
    applyStyles(wrap, send, scan, size);
  };

  // Bootstrap snapshot BEFORE first mount — so the initial paint sees
  // the right phase. If `window.fleetDispatcher` happens to be readable
  // right now (Firefox Xray, tests assigning directly), seed the cache.
  // Chrome MV3 isolated scripts get undefined here; we rely on the
  // bridge event (`oge5:fleetDispatcher` from `bridges/fleetDispatcherSnapshot.js`)
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
  document.addEventListener('oge5:fleetDispatcher', onFleetDispatcherSnapshot);
  document.addEventListener('oge5:checkTargetResult', onCheckTargetResult);
  document.addEventListener('oge5:galaxyScanned', onGalaxyScanned);
  document.addEventListener('oge5:colonizeSent', onColonizeSent);

  // 1 Hz repaint ticker — the only timer in the whole feature.
  const tickerHandle = setInterval(refresh, REPAINT_TICK_MS);

  installed = {
    dispose: () => {
      clearInterval(tickerHandle);
      removeButton();
      unsubSettings();
      unsubScans();
      unsubRegistry();
      document.removeEventListener('oge5:fleetDispatcher', onFleetDispatcherSnapshot);
      document.removeEventListener('oge5:checkTargetResult', onCheckTargetResult);
      document.removeEventListener('oge5:galaxyScanned', onGalaxyScanned);
      document.removeEventListener('oge5:colonizeSent', onColonizeSent);
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
export const _resetSendColForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  lastNavToFleetdispatchAt = 0;
  lastScanSubmitAt = 0;
  lastScanEventAt = 0;
  lastCheckTargetError = null;
  waitStartAt = 0;
  waitSeconds = 0;
  fleetDispatcherSnapshot = null;
};
