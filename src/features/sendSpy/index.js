// @ts-check

// Floating "Spy" button — the espionage-scan FAB module. Walks the dashboard
// watch-list and sends espionage probes to each watched player's planets, one
// intentional tap per fleet, then offers a jump to the messages component to
// read the reports. A thin orchestrator over the pure `deriveSpy`/`renderSpy`
// core (./pure.js) and the shared fleetCourier — modelled 1:1 on
// features/sendColony/index.js (read that file's header for the derive→render→
// paint pipeline + the two-tap courier contract).
//
// # Differences from sendColony
//
//   - Candidate source is the WATCH-LIST + universe.xml planet coords (via the
//     apiContext handoff), not the galaxy scan DB. The pure finder lives in
//     ./pure.js (deriveSpy), fed by captureEnv() below.
//   - Ships = N espionage probes (the dashboard's "Probes" control, shared via
//     state/watchList.js); mission = espionage; owner = OWNER_SPY.
//   - Mounted ONLY when fabMode is on AND the watch-list is non-empty — so the
//     button "appears only when there's something to scan" (the user's ask),
//     reconciled on every watch-list change.
//   - No min-gap wait, no decision log, no Scan half — espionage has none of
//     colonize's constraints.
//   - "All scanned" end state is a one-tap jump to the messages component (the
//     user's PS), not a post-send auto-redirect (TOS: a navigation is a
//     deliberate tap, never chained off a send).
//
// @see ./pure.js — the pure compute core.
// @see ../sendColony/index.js — the template orchestrator.

import { settingsStore } from '../../state/settings.js';
import { watchListStore } from '../../state/watchList.js';
import { targetReportsStore } from '../../state/targets.js';
import { activityObsStore } from '../../state/activityObs.js';
import { spiedCoordsByPlayer, spiedMoonsByPlayer } from '../../domain/targetReports.js';
import { summarizeRoutine, routineBodies } from '../../domain/routine.js';
import { createButton as makeButton, labelLines } from '../shared/button.js';
import { EYE_GLYPH } from '../shared/buttonGlyphs.js';
import {
  select as courierSelect,
  retarget as courierRetarget,
  dispatch as courierDispatch,
  step as courierStep,
  readyToDispatch,
  installFleetCourier,
  bareFleetdispatchUrl,
  shipAvailability,
} from '../shared/fleetCourier.js';
import { installFabSettingsLifecycle } from '../shared/fabSettingsLifecycle.js';
import { getApiContext } from '../shared/apiContextStore.js';
import { SHIP_ESPIONAGE_PROBE, TARGET_PLANET, TARGET_MOON, MISSION_ESPIONAGE } from '../../domain/rules.js';
import { OWNER_SPY } from '../../domain/fleetOwnership.js';
import { ingameComponentUrl } from '../../domain/ogameUrl.js';
import { clock } from '../../lib/clock.js';
import { readSpySentMap, markSpySent } from '../../lib/spySentSession.js';
import {
  deriveSpy,
  renderSpy,
  BG_SPY_IDLE,
  BG_SPY_READY,
  BG_SPY_ERROR,
} from './pure.js';

export { deriveSpy, renderSpy } from './pure.js';

/**
 * @typedef {import('./pure.js').Paint} Paint
 * @typedef {import('./pure.js').SpyTarget} SpyTarget
 */

const BUTTON_ID = 'oge-send-spy';
const SEND_HALF_ID = 'oge-spy-send';
const REPAINT_TICK_MS = 2000;
/**
 * How long to hold the busy lock after a successful dispatch. The game reloads
 * the page within ~1 s on the happy path; this safety net releases the lock if
 * that reload never comes. Mirrors sendColony's post-send lock window.
 */
const SENT_LOCK_MS = 3000;

// ─── Module-local state ────────────────────────────────────────────────────

/** @type {import('../shared/button.js').Button | null} */
let controller = null;
/** Re-entry guard while a courier select()/dispatch() is in flight. */
let busy = false;
/** True once a select()/retarget() has armed a ready-to-send espionage. */
let spyReady = false;
/** The coords the armed send is aimed at. @type {SpyTarget | null} */
let spyTarget = null;
/**
 * Active post-send lock timer — releases the busy lock if the expected
 * post-dispatch page reload never comes. `null` when no send is settling.
 *
 * @type {ReturnType<typeof setTimeout> | null}
 */
let sentLockTimer = null;

// ─── sent-coords (survives the post-send reload via sessionStorage) ─────────
// Shared module (lib/spySentSession.js): this feature marks sends with their
// timestamp; state/activityObs reads the TIMES for the self-induced-activity
// discount (a marker our own probe lit must not enter the routine).

/**
 * Coords sent this browser-tab session, so a just-probed planet isn't
 * re-proposed across the post-send page reload before its report lands.
 * @returns {Set<string>}
 */
const getSentCoords = () => new Set(Object.keys(readSpySentMap()));

/**
 * Session sent-key for a body: `g:s:p` for a planet, `g:s:p:3` for a moon, so a
 * probe sent to a planet doesn't also suppress its moon (and vice versa).
 * @param {SpyTarget} t
 * @returns {string}
 */
const sentKey = (t) =>
  t.bodyType === 3 ? `${t.galaxy}:${t.system}:${t.position}:3` : `${t.galaxy}:${t.system}:${t.position}`;

/**
 * Mark a body as sent this session (with the send time — the discount window
 * anchor).
 * @param {SpyTarget} t
 * @returns {void}
 */
const markSent = (t) => {
  markSpySent(sentKey(t), Date.now());
};

/**
 * Coords label for the armed "Send!" confirmation — includes a 🌙 for a moon
 * so the deliberate second tap shows exactly which body is about to be probed.
 * @param {SpyTarget} t
 * @returns {string}
 */
const coordsLabel = (t) =>
  `[${t.galaxy}:${t.system}:${t.position}]${t.bodyType === 3 ? ' 🌙' : ''}`;

// ─── env capture (the one impure read of the derive pipeline) ───────────────

/**
 * Per-watched-player danger D (0..100) from the apiContext handoff's profiles
 * (built by the SAME domain/dangerJoin recipe the dashboard uses). `undefined`
 * before the handoff populates — the planner then ranks danger-neutral.
 * @returns {Record<string, number> | undefined}
 */
const dangerByPlayer = () => {
  const danger = getApiContext()?.danger;
  if (!danger) return undefined;
  /** @type {Record<string, number>} */
  const out = {};
  for (const pid of watchListStore.get().players) {
    const prof = danger.get(Number(pid));
    if (prof) out[pid] = prof.danger * 100;
  }
  return out;
};

/**
 * Per-watched-player activity summary (spy history + galaxy rings) — the
 * planner's `windowBonus` input. Cheap: ≤ a few hundred lite observations per
 * watched player.
 * @param {number} nowMs
 * @returns {Record<string, import('../../domain/routine.js').ActivitySummary>}
 */
const activityByPlayer = (nowMs) => {
  const reports = targetReportsStore.get();
  const acts = activityObsStore.get();
  /** @type {Record<string, import('../../domain/routine.js').ActivitySummary>} */
  const out = {};
  for (const pid of watchListStore.get().players) {
    const bucket = reports[pid];
    const rings = acts[pid];
    if (!bucket && !rings) continue;
    out[pid] = summarizeRoutine(routineBodies(bucket, rings), nowMs).activity;
  }
  return out;
};

/**
 * Snapshot every input of {@link deriveSpy}.
 * @returns {import('./pure.js').SpyEnv}
 */
const captureEnv = () => {
  const nowMs = Date.now();
  const reports = targetReportsStore.get();
  const cfg = watchListStore.get();
  return {
    players: cfg.players,
    universePlanets: getApiContext()?.universePlanets ?? [],
    spiedByPlayer: spiedCoordsByPlayer(reports),
    spiedMoonsByPlayer: spiedMoonsByPlayer(reports),
    rescan: cfg.rescan,
    sentCoords: getSentCoords(),
    nowMs,
    scanBodies: cfg.scanBodies,
    dangerByPlayer: dangerByPlayer(),
    activityByPlayer: activityByPlayer(nowMs),
    playerNames: getApiContext()?.players ?? {},
  };
};

/**
 * Is the apiContext handoff populated yet? Until it is, `universePlanets` is
 * empty, so `deriveSpy` sees zero candidates and would paint the misleading
 * "all scanned ✓" done state on a fresh page load. The button holds a dim
 * "loading…" state (and swallows taps) until this is true — mirroring how the
 * other FABs stay disabled until their data lands.
 * @returns {boolean}
 */
const apiContextReady = () => {
  const c = getApiContext();
  return !!(c && Array.isArray(c.universePlanets) && c.universePlanets.length > 0);
};

/**
 * Probe availability on the CURRENT planet vs the armed order — `null` when no
 * fleetdispatch snapshot exists yet (off the page). Painting the shortage
 * BEFORE the tap replaces discovering it via a failed select().
 * @returns {{ have: number, need: number } | null}
 */
const probePreflight = () => {
  const avail = shipAvailability();
  if (!avail) return null;
  return {
    have: avail[SHIP_ESPIONAGE_PROBE] ?? 0,
    need: watchListStore.get().probes,
  };
};

// ─── paint ──────────────────────────────────────────────────────────────────

/**
 * Paint the single Send zone from a {@link Paint}. No-op while unmounted.
 * @param {Paint} p
 * @returns {void}
 */
const paintZone = (p) => {
  if (!controller) return;
  if (p.subtext || p.hint) {
    controller.paintLines('send', labelLines({ main: p.text, sub: p.subtext, hint: p.hint }));
  } else {
    controller.setText('send', p.text);
  }
  controller.setBg('send', p.bg);
  controller.setDim('send', p.dim === true);
};

/**
 * Full pipeline: capture → derive → render → paint. The Send zone is owned by
 * the courier handler while a select()/dispatch() is in flight (busy) or once a
 * send is armed-ready on step 2; otherwise it shows the derive-computed label.
 * @returns {void}
 */
const refresh = () => {
  if (!controller || busy) return;
  if (spyReady && spyTarget && courierStep() === 'fleet2') {
    paintZone({ text: 'Send!', subtext: coordsLabel(spyTarget), bg: BG_SPY_READY });
    return;
  }
  // Hold a dim "loading…" state until the apiContext handoff lands — before
  // then there are no candidates and the "all scanned" done state would flash.
  if (!apiContextReady()) {
    paintZone({ text: 'Spy', subtext: 'loading…', bg: BG_SPY_IDLE, dim: true });
    return;
  }
  paintZone(renderSpy(deriveSpy(captureEnv()), probePreflight()));
};

// ─── click handler (two intentional taps, mirrors sendColony) ───────────────

/**
 * Build the courier-failure paint for a coord.
 * @param {string | undefined} reason
 * @param {SpyTarget} t
 * @returns {Paint}
 */
const spyErrorPaint = (reason, t) => {
  const coords = `[${t.galaxy}:${t.system}:${t.position}]`;
  if (reason === 'allFleets') return { text: 'All fleets!', bg: BG_SPY_ERROR };
  // Two distinct courier failures, one user-facing meaning for a probe order:
  // 'noShips' (plural) = select() couldn't fill the order from the planet's
  // hangar; 'noShip' (singular) = the target-validation path's missing-ship
  // case. The old compare matched only the singular, so the common empty-
  // hangar case fell through to the raw code label.
  if (reason === 'noShip' || reason === 'noShips') {
    return { text: 'No probes!', subtext: coords, bg: BG_SPY_ERROR };
  }
  return { text: reason || 'Failed', subtext: coords, bg: BG_SPY_ERROR };
};

/**
 * Espionage-probe order spec for the courier.
 * @param {SpyTarget} t
 * @returns {Parameters<typeof courierSelect>[0]}
 */
const spyOrder = (t) => ({
  spec: {
    kind: 'list',
    ships: [{ id: SHIP_ESPIONAGE_PROBE, qty: watchListStore.get().probes, frac: 1 }],
  },
  target: {
    galaxy: t.galaxy,
    system: t.system,
    position: t.position,
    type: t.bodyType === 3 ? TARGET_MOON : TARGET_PLANET,
  },
  mission: MISSION_ESPIONAGE,
  owner: OWNER_SPY,
});

/**
 * Send-zone tap. State machine: dispatch the armed probe-fleet (tap 2) → else
 * jump to messages when nothing's left → else navigate/select/retarget toward
 * the next candidate (tap 1). One tap originates at most one server action.
 * @returns {Promise<void>}
 */
const onSpyClick = async () => {
  if (busy) return;
  const s = courierStep();

  // Tap 2 — dispatch the armed espionage fleet.
  if (spyReady && s === 'fleet2') {
    if (!readyToDispatch()) return;
    busy = true;
    paintZone({ text: 'Wait…', bg: BG_SPY_IDLE, dim: true });
    const r = await courierDispatch(OWNER_SPY);
    spyReady = false;
    if (!r.ok) {
      busy = false;
      if (r.reason === 'foreign') { location.href = bareFleetdispatchUrl(); return; }
      paintZone({ text: r.errorCode === 140026 ? 'No fuel' : 'Failed', bg: BG_SPY_ERROR });
      return;
    }
    if (spyTarget) markSent(spyTarget);
    spyTarget = null;
    // Success → the game navigates; HOLD the busy lock through the post-send
    // navigation window so no reactor/ticker repaints the button into a stale
    // unlocked state before the reload. The safety timeout releases the lock
    // if the expected reload never comes. Mirrors sendColony's lock + timeout.
    paintZone({ text: 'Sent!', bg: BG_SPY_READY });
    if (sentLockTimer) clearTimeout(sentLockTimer);
    sentLockTimer = setTimeout(() => {
      sentLockTimer = null;
      busy = false;
      refresh();
    }, SENT_LOCK_MS);
    return;
  }

  // Handoff still loading → swallow the tap so it can't jump to messages off an
  // empty candidate set (the button is showing the dim "loading…" state).
  if (!apiContextReady()) return;

  const ctx = deriveSpy(captureEnv());

  // Nothing left to scan → jump to the messages component to read reports
  // (a deliberate navigation on the user's tap, never chained off a send).
  if (!ctx.candidate) {
    if (ctx.hasWatched) location.href = ingameComponentUrl(location.href, 'messages', {});
    return;
  }
  const target = ctx.candidate;

  // Off fleetdispatch → bare nav; the next tap selects the fleet in-page.
  if (s === 'off') { location.href = bareFleetdispatchUrl(); return; }

  // On a fleet2 with no live armed send → retarget in place to the candidate.
  if (s === 'fleet2') {
    busy = true;
    spyReady = false;
    paintZone({ text: 'Wait…', bg: BG_SPY_IDLE, dim: true });
    const r = await courierRetarget(spyOrder(target));
    busy = false;
    if (!r.ok) {
      if (r.reason === 'foreign') { location.href = bareFleetdispatchUrl(); return; }
      paintZone(spyErrorPaint(r.reason, target));
      return;
    }
    spyReady = true;
    spyTarget = target;
    paintZone({ text: 'Send!', subtext: coordsLabel(target), bg: BG_SPY_READY });
    return;
  }

  // Tap 1 (fleet1) — select probes + target, walk to a ready step 2.
  busy = true;
  spyReady = false;
  paintZone({ text: 'Wait…', bg: BG_SPY_IDLE, dim: true });
  const r = await courierSelect(spyOrder(target));
  busy = false;
  if (!r.ok) {
    if (r.reason === 'foreign') { location.href = bareFleetdispatchUrl(); return; }
    paintZone(spyErrorPaint(r.reason, target));
    return;
  }
  spyReady = true;
  spyTarget = target;
  paintZone({ text: 'Send!', subtext: coordsLabel(target), bg: BG_SPY_READY });
};

// ─── lifecycle ────────────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the espionage-scan button. Idempotent — a second call returns the
 * SAME dispose fn. The button mounts only when fabMode is on AND the watch-list
 * has at least one player (so it stays out of the FAB until the user marks
 * targets in the dashboard); it's reconciled on every watch-list change.
 *
 * @returns {() => void}
 */
export const installSendSpy = () => {
  if (installed) return installed.dispose;

  installFleetCourier();

  /** Build + mount the button DOM. Idempotent. @returns {void} */
  const mount = () => {
    if (document.getElementById(BUTTON_ID)) return;
    const size = settingsStore.get().fabBtnSize;
    controller = makeButton({
      id: BUTTON_ID,
      title: 'Spyglass',
      ringId: 'oge-ring-spy',
      size,
      fontScale: 0.18,
      module: { id: 'spy', name: 'Spy', color: BG_SPY_IDLE, glyph: EYE_GLYPH },
      gateUntilEventBox: true,
      zones: [
        {
          key: 'send',
          id: SEND_HALF_ID,
          ariaLabel: 'Send espionage scan',
          bg: BG_SPY_IDLE,
          glyph: EYE_GLYPH,
          onTap: () => void onSpyClick(),
        },
      ],
    });
    if (!controller) return;
    refresh();
  };

  /** Detach the button. Safe unmounted. @returns {void} */
  const removeButton = () => {
    controller?.dispose();
    controller = null;
  };

  /** Live-resize the mounted button. @param {number} size @returns {void} */
  const updateButtonSize = (size) => controller?.resize(size);

  /** Mount only when the watch-list is non-empty. @returns {void} */
  const gatedMount = () => {
    if (watchListStore.get().players.length > 0) mount();
  };

  /**
   * Reconcile mount state against (fabMode AND watch-list non-empty): mount
   * when work appears, remove when the last watched player is cleared.
   * @returns {void}
   */
  const reconcile = () => {
    const enabled = settingsStore.get().fabMode;
    const hasWatched = watchListStore.get().players.length > 0;
    const mounted = !!document.getElementById(BUTTON_ID);
    if (enabled && hasWatched && !mounted && document.body) mount();
    else if (!hasWatched && mounted) removeButton();
    refresh();
  };

  const unsubSettings = installFabSettingsLifecycle({
    settingsStore,
    mount: gatedMount,
    removeButton,
    updateButtonSize,
    isInstalled: () => installed !== null,
    onSettingsChange: refresh,
  });
  // The watch-list drives both visibility (mount/remove) and the candidate.
  const unsubWatch = watchListStore.subscribe(reconcile);
  // A landed spy report flips a planet from "needs scan" to spied — repaint.
  const unsubReports = targetReportsStore.subscribe(refresh);
  // Slow ticker catches the apiContext handoff populating + staleness ticking.
  const unsubTicker = clock.subscribe(refresh, { everyMs: REPAINT_TICK_MS });

  installed = {
    dispose: () => {
      unsubTicker();
      removeButton();
      unsubSettings();
      unsubWatch();
      unsubReports();
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
 * Test-only reset.
 * @returns {void}
 */
export const _resetSendSpyForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  busy = false;
  spyReady = false;
  spyTarget = null;
  if (sentLockTimer) {
    clearTimeout(sentLockTimer);
    sentLockTimer = null;
  }
};
