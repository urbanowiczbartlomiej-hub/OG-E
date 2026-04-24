// @ts-check

// Pure compute core of `features/sendCol.js` — `derive(env)` and
// `render(ctx)` plus every typedef / constant they reference.
//
// # Why this split exists
//
// `sendCol.js` mixes three very different kinds of code:
//   1. PURE — compute-the-right-label-for-env (derive + render).
//   2. IMPURE DOM — click handlers that navigate, paint helpers that
//      walk the mounted button halves.
//   3. LIFECYCLE — install/dispose, mount, store subscriptions, event
//      reactors, 1 Hz ticker.
//
// Before this file the first bucket lived in `sendCol.js` alongside the
// other two and had hidden reads of six module-local `let`s
// (`lastNavToFleetdispatchAt`, `lastScanSubmitAt`, `lastScanEventAt`,
// `lastCheckTargetError`, `waitStartAt`, `waitSeconds`) plus two direct
// DOM reads (`readHomePlanet`, `parseCurrentGalaxyView`). Tests worked
// around those impurities by relying on `_resetSendColForTest` zeroing
// the lets between cases — fragile coupling. Extracting the pure core
// makes the dependencies explicit: every field `derive` needs arrives
// through `env`, every field `render` needs arrives through `ctx`.
// Node-env tests can exercise 10 000 cases without a DOM.
//
// # Env contract
//
// `DeriveEnv` lists the full input set. `home` / `view` (previously
// read from DOM by `derive`) and the six state lets (previously hidden)
// are now optional with documented defaults — a test that forgets to
// pass `lastScanSubmitAt` gets "no cooldown active", which is the same
// as a fresh install would see. Production callers use `captureEnv()`
// in `sendCol.js` to fill every field from the live page.
//
// # What this file does NOT own
//
// No DOM reads, no DOM writes, no timers, no event listeners, no
// module-local mutable state. Every export is either a constant, a
// typedef, or a pure function. If you find yourself wanting to import
// `document` / `window` / `location` here, STOP — that belongs in
// `sendCol.js`, not here.
//
// @see ./sendCol.js — the orchestrator that consumes this.
// @see ../../SENDCOL_DESIGN.md — the authoritative behavioural spec.

import {
  findNextScanSystem,
  findNextColonizeTarget,
  pickCandidateInView,
  countScansRemaining,
} from './sendColLogic.js';

/**
 * @typedef {import('./sendColLogic.js').GalaxyScans} GalaxyScans
 *   Re-exported via typedef import so consumers that only need the pure
 *   core don't have to reach into `state/scans.js` themselves.
 * @typedef {import('./sendColLogic.js').RegistryEntry} RegistryEntry
 * @typedef {import('../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 * @typedef {{ galaxy: number, system: number, position: number }} Coords
 */

// ─── Mission id ───────────────────────────────────────────────────────────

/**
 * Mission code for colonize — matches `domain/rules.js MISSION_COLONIZE`.
 * Duplicated here to keep `derive()` free of the `rules.js` import
 * (important for the test env where happy-dom mocks may not have hoisted
 * the rules module yet) and because the string literal `"mission=7"` is
 * how `derive` identifies fleetdispatch URLs anyway.
 */
export const MISSION_COLONIZE = 7;

// ─── Timeouts / cooldowns ────────────────────────────────────────────────

/**
 * After this many ms without a `checkTarget` response on fleetdispatch,
 * {@link derive} returns phase `timeout`. Matches
 * `sendCol.js CHECK_TARGET_TIMEOUT_MS` 1:1 — kept here because it is the
 * pure derive's own tunable, not a DOM-side concern.
 */
export const CHECK_TARGET_TIMEOUT_MS = 15_000;

/**
 * Safety cap for the Scan half cooldown. Normally the cooldown lifts
 * event-driven (on `oge5:galaxyScanned`); this is the escape hatch for
 * when the event never arrives (AGR swallow, network death, ...).
 */
export const SCAN_COOLDOWN_MS = 8000;

// ─── BG colors (ported from the old labels.js, see SENDCOL_DESIGN §5) ────

/** Green, translucent — idle "Send" with no candidate yet. */
export const BG_SEND_IDLE = 'rgba(0, 160, 0, 0.75)';
/** Darker blue — idle "Scan" / "Skip" half. */
export const BG_SCAN_IDLE = 'rgba(60, 100, 150, 0.75)';
/** Bright green — active "Dispatch!" / "Send Colony [g:s:p]". */
export const BG_SEND_READY = 'rgba(0, 200, 0, 0.85)';
/** Amber — reserved / stale / timeout states (recoverable). */
export const BG_SEND_STALE = 'rgba(200, 150, 0, 0.85)';
/** Red — "No ship!" (unrecoverable until user builds a colonizer). */
export const BG_SEND_ERROR = 'rgba(200, 0, 0, 0.85)';
/** Yellow — mid-countdown "Wait Xs" label. */
export const BG_SEND_WAIT = 'rgba(200, 200, 0, 0.8)';

// ─── Discriminated unions ────────────────────────────────────────────────

/**
 * `nextScan` + `scanCooldown` + `scansRemaining` apply everywhere (user
 * can click Scan from idle / galaxy / fleetdispatch pages alike).
 * `candidate` / `target` / `phase` are page-kind specific.
 *
 * `scansRemaining` is the count of systems that would match
 * {@link findNextScanSystem} if called repeatedly — i.e. how many scan
 * clicks it would take to make the DB fully fresh. Optional (derive
 * omits it only when a test passes an incomplete ButtonContext; render
 * treats missing/zero interchangeably).
 *
 * @typedef {(
 *   | {
 *       kind: 'idle',
 *       candidate: Coords | null,
 *       nextScan: { galaxy: number, system: number } | null,
 *       scanCooldown: boolean,
 *       scansRemaining?: number,
 *     }
 *   | {
 *       kind: 'galaxy',
 *       candidate: Coords | null,
 *       nextScan: { galaxy: number, system: number } | null,
 *       scanCooldown: boolean,
 *       scansRemaining?: number,
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
 *       scansRemaining?: number,
 *     }
 * )} ButtonContext
 */

/**
 * Single-half paint instruction. `subtext` flips the caller to a
 * two-line render (small top line + big bottom line). `dim: true`
 * renders the half at reduced opacity (cooldown / disabled hint).
 *
 * @typedef {{ text: string, bg: string, subtext?: string, dim?: boolean }} Paint
 */

/**
 * Full button render — one paint per half.
 *
 * @typedef {{ send: Paint, scan: Paint }} RenderResult
 */

/**
 * Input to {@link derive}. Every field except the first 7 is optional;
 * missing fields default to "no effect on derive's decision", so a
 * minimal test can pass just `{ search, fleetDispatcher, scans,
 * registry, targets, preferOther, now }` and reason about the idle /
 * galaxy branches.
 *
 * `home` and `view` previously came from `readHomePlanet()` /
 * `parseCurrentGalaxyView()` inside `derive`. Moving them into `env`
 * keeps the pure core DOM-free — `sendCol.js captureEnv()` makes the
 * reads in production, tests pass the values explicitly.
 *
 * The six `last*` / `wait*` fields previously lived as module-local
 * `let`s on `sendCol.js` and were read directly by `derive`. They now
 * flow through env too.
 *
 * @typedef {object} DeriveEnv
 * @property {string} search `location.search` (raw, including leading `?`).
 * @property {FleetDispatcherSnapshot | null} fleetDispatcher
 *   Snapshot published by `bridges/fleetDispatcherSnapshot.js`, or
 *   `null` when the bridge hasn't fired yet / we're off fleetdispatch.
 * @property {GalaxyScans} scans
 * @property {RegistryEntry[]} registry
 * @property {number[]} targets Parsed `colPositions`.
 * @property {boolean} preferOther `colPreferOtherGalaxies` setting.
 * @property {number} now Epoch-ms (tests pass a fixed value, production
 *   passes `Date.now()`).
 * @property {{ galaxy: number, system: number } | null} [home]
 *   Home-planet coords (from the active row in `#planetList`). `null`
 *   means `readHomePlanet` bailed (no live DOM, broken game state);
 *   callers then get `nextScan: null` and an empty-candidate idle/galaxy.
 * @property {{ galaxy: number, system: number } | null} [view]
 *   Current galaxy-view coords (from `#galaxy_input` / URL). `null`
 *   outside the galaxy component.
 * @property {number} [lastNavToFleetdispatchAt]
 *   Epoch-ms of the last navigation to a fleetdispatch URL with a
 *   target. Drives the `timeout` phase together with `now`. Default 0
 *   (no prior nav → timeout branch never fires).
 * @property {number} [lastScanSubmitAt]
 *   Epoch-ms of the last in-page galaxy submit. Together with
 *   `lastScanEventAt` drives `scanCooldown`. Default 0.
 * @property {number} [lastScanEventAt]
 *   Epoch-ms of the last `oge5:galaxyScanned` we observed. Default 0.
 * @property {number | null} [lastCheckTargetError]
 *   Error code from the most recent `checkTarget` response, or `null`.
 *   Drives the `reserved` / `noShip` sub-phases. Default `null`.
 * @property {number} [waitStartAt]
 *   Epoch-ms when the min-gap countdown started. Default 0 (no countdown).
 * @property {number} [waitSeconds]
 *   Total seconds of the active countdown. Default 0 (no countdown).
 */

// ─── Pure derive ──────────────────────────────────────────────────────────

/**
 * Pure `env → ButtonContext` compute. Follows SENDCOL_DESIGN.md §4
 * verbatim — fleetdispatch branch first (the richest), galaxy branch
 * second (with current-view priority), idle branch last.
 *
 * @param {DeriveEnv} env
 * @returns {ButtonContext}
 */
export const derive = (env) => {
  // Materialise optional fields with documented defaults. `??` (not `||`)
  // so a legitimate `0` stays `0` rather than falling to the default.
  const home = env.home ?? null;
  const view = env.view ?? null;
  const lastNavToFleetdispatchAt = env.lastNavToFleetdispatchAt ?? 0;
  const lastScanSubmitAt = env.lastScanSubmitAt ?? 0;
  const lastScanEventAt = env.lastScanEventAt ?? 0;
  const lastCheckTargetError = env.lastCheckTargetError ?? null;
  const waitStartAt = env.waitStartAt ?? 0;
  const waitSeconds = env.waitSeconds ?? 0;

  // Universal scan state — user can Scan from any page (idle / galaxy /
  // fleetdispatch). Cooldown is event-driven (unlocks on
  // `oge5:galaxyScanned`) with a hard safety cap for silent failures.
  const nextScan = home ? findNextScanSystem(env.scans, home, view) : null;
  const scanCooldown =
    lastScanSubmitAt > lastScanEventAt &&
    env.now - lastScanSubmitAt < SCAN_COOLDOWN_MS;
  // Cheap full-universe count so the Scan button label can show the
  // user how far the scan-fresh frontier is from covering everything.
  const scansRemaining = countScansRemaining(env.scans);

  // Fleetdispatch branch — `fleetDispatcher` snapshot is the truth.
  if (
    env.search.includes('component=fleetdispatch') &&
    env.search.includes(`mission=${MISSION_COLONIZE}`)
  ) {
    const fd = env.fleetDispatcher;
    if (!fd) {
      return {
        kind: 'fleetdispatch',
        target: null,
        phase: { tag: 'noTarget' },
        nextScan,
        scanCooldown,
        scansRemaining,
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
        kind: 'fleetdispatch',
        target: null,
        phase: { tag: 'noTarget' },
        nextScan,
        scanCooldown,
        scansRemaining,
      };
    }

    const shipsOnPlanet = Array.isArray(fd.shipsOnPlanet) ? fd.shipsOnPlanet : [];
    const hasColonizer = shipsOnPlanet.some(
      (/** @type {any} */ s) => s && s.id === 208 && (s.number || 0) > 0,
    );
    const canColonize = fd.orders && fd.orders['7'] === true;
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
    return {
      kind: 'fleetdispatch',
      target,
      phase,
      nextScan,
      scanCooldown,
      scansRemaining,
    };
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
    return { kind: 'galaxy', candidate, nextScan, scanCooldown, scansRemaining };
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
  return { kind: 'idle', candidate, nextScan, scanCooldown, scansRemaining };
};

// ─── Pure render ──────────────────────────────────────────────────────────

/**
 * Render a `ctx` to paint instructions. Pure: no DOM, no window.
 *
 * @param {ButtonContext} ctx
 * @returns {RenderResult}
 */
export const render = (ctx) => {
  // Scan paint:
  //   - On galaxy view: two-line "Scan · N left / [g:s]" — one AJAX
  //     click shrinks `scansRemaining` by (up to) 1 as the observer
  //     writes the fresh scan into scansStore. The count is a useful
  //     progress signal against the 3493-system scan universe.
  //   - Anywhere else: "to Galaxy / N left" — clicking just hops the
  //     user to the galaxy page. The first system is server-rendered
  //     without an AJAX call, so we'd miss it from the isolated
  //     content script; better to land the user on galaxy and let
  //     them drive subsequent scans via AJAX.
  //   - When the entire database is scanned fresh: "All scanned!"
  //     (no count — zero remaining by definition).
  const remaining = ctx.scansRemaining ?? 0;
  /** @type {Paint} */
  let scanPaint;
  if (!ctx.nextScan) {
    scanPaint = { text: 'All scanned!', bg: BG_SCAN_IDLE };
  } else if (ctx.kind === 'galaxy') {
    scanPaint = {
      text: `[${ctx.nextScan.galaxy}:${ctx.nextScan.system}]`,
      subtext: remaining > 0 ? `Scan · ${remaining} left` : 'Scan',
      bg: BG_SCAN_IDLE,
      dim: ctx.scanCooldown,
    };
  } else {
    scanPaint =
      remaining > 0
        ? {
            text: 'to Galaxy',
            subtext: `${remaining} left`,
            bg: BG_SCAN_IDLE,
          }
        : { text: 'to Galaxy', bg: BG_SCAN_IDLE };
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
