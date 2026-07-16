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
//   - Mounted ONLY when the watch-list is non-empty — so the
//     button "appears only when there's something to scan" (the user's ask),
//     reconciled on every watch-list change. Because that list hydrates
//     ASYNC from chrome.storage, the last reconciled verdict is cached in
//     localStorage (state/spyFabCache.js) and drives an OPTIMISTIC mount on
//     page load — otherwise the button blinks in late on every navigation.
//     The hydrate then confirms or removes the optimistic mount.
//   - No min-gap wait, no decision log, no Scan half — espionage has none of
//     colonize's constraints.
//   - "All scanned" end state is a one-tap jump to the messages component (the
//     user's PS), not a post-send auto-redirect (TOS: a navigation is a
//     deliberate tap, never chained off a send).
//
// @see ./pure.js — the pure compute core.
// @see ../sendColony/index.js — the template orchestrator.

import { settingsStore } from '../../state/settings.js';
import { watchListStore, whenWatchListHydrated } from '../../state/watchList.js';
import { readSpyFabShown, writeSpyFabShown } from '../../state/spyFabCache.js';
import { targetReportsStore } from '../../state/targets.js';
import { activityObsStore } from '../../state/activityObs.js';
import { bodiesStore } from '../../state/bodies.js';
import { scansStore } from '../../state/scans.js';
import { playersStore } from '../../state/players.js';
import { spiedCoordsByPlayer, spiedMoonsByPlayer } from '../../domain/targetReports.js';
import { summarizeRoutine, routineBodies } from '../../domain/routine.js';
import {
  detectAllLandings, detectAllRechecks, detectAllSweeps, strikeMapOf,
} from '../../domain/fleetLanding.js';
import {
  patrolSystemKeys,
  patrolOccupants,
  patrolPlayers,
  buildPatrolPlan,
} from '../../domain/patrol.js';
import { galaxyStaleMs } from '../../domain/galaxyWatch.js';
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
import { setFabModuleAlert } from '../shared/unifiedFab.js';
import { getApiContext, subscribeApiContext } from '../shared/apiContextStore.js';
import { parseCurrentGalaxyView } from '../shared/galaxyView.js';
import { navigateGalaxyInPage } from '../shared/galaxyNav.js';
import { SHIP_ESPIONAGE_PROBE, TARGET_PLANET, TARGET_MOON, MISSION_ESPIONAGE } from '../../domain/rules.js';
import { OWNER_SPY } from '../../domain/fleetOwnership.js';
import { ingameComponentUrl } from '../../domain/ogameUrl.js';
import { clock } from '../../lib/clock.js';
import { readSpySentMap, markSpySent } from '../../lib/spySentSession.js';
import { readCurrentBody } from '../shared/currentBody.js';
import {
  deriveSpy,
  renderSpy,
  nearestLaunchPlanet,
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
/**
 * True while the button is DISPLAYING the dim "loading…" state (apiContext
 * handoff not yet populated). A tap in that state — including the brief window
 * after the handoff lands but before the next repaint — must never fire an
 * action; see {@link onSpyClick}.
 */
let showingLoading = false;
/**
 * True once the watch-list's async chrome.storage hydrate has settled. Until
 * then an empty `watchListStore` means "don't know yet", not "nothing
 * watched" — the optimistic mount holds the dim "loading…" paint through
 * that window instead of flashing a misleading derived state.
 */
let watchHydrated = false;

// ─── sent-coords (survives the post-send reload via sessionStorage) ─────────
// Shared module (lib/spySentSession.js): this feature marks sends with their
// timestamp; state/activityObs reads the TIMES for the self-induced-activity
// discount (a marker our own probe lit must not enter the routine).

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
  const rings = activityObsStore.get();
  const ctx = getApiContext();
  const universePlanets = ctx?.universePlanets ?? [];
  const sentMap = readSpySentMap();
  // Per-system newest scan time ("g:s" → epoch s) — the system-level coverage
  // source for BOTH the full-sweep gate (landingOpts) and the galaxy-look plan
  // (env.sysLookSec): a rendered system covers a body whose activity block
  // wasn't parseable into a ring entry OR whose observation was discounted as
  // our own probe's marker.
  /** @type {Record<string, number>} */
  const sysLookSec = {};
  for (const [k, v] of Object.entries(scansStore.get())) {
    const t = v ? Number(v.scannedAt) : 0;
    if (Number.isFinite(t) && t > 0) sysLookSec[k] = Math.floor(t / 1000);
  }
  const landingOpts = { sentMap, mode: cfg.moonStrike, sysLookSec };

  // ── Patrol territory (domain/patrol) — the hunting-grounds mode ──────────
  // With a radius configured: the systems around every own body form the
  // territory; its filtered occupants become extra strike candidates, and its
  // stale systems join the LOOK plan as patrol entries. All passive.
  const patrolSet = (cfg.patrolSystems || 0) > 0
    ? patrolSystemKeys(bodiesStore.get().bodies, cfg.patrolSystems || 0, ctx?.server ?? {})
    : null;
  const occupants = patrolSet && patrolSet.size
    ? patrolOccupants(universePlanets, patrolSet, ctx?.ownId ?? null)
    : {};
  const prey = patrolSet
    ? patrolPlayers(occupants, {
      apiPlayers: ctx?.players ?? {},
      meta: playersStore.get(),
    }).filter((pid) => !cfg.players.includes(pid)) // watch-list runs its own pass
    : [];

  // Watch-list strikes first (they carry the user's deliberate focus), then
  // the territory's — a body flagged by both keeps the watch-list signal.
  const strikes = strikeMapOf(detectAllLandings(cfg.players, universePlanets, rings, nowMs, landingOpts));
  const rechecks = detectAllRechecks(cfg.players, universePlanets, rings, nowMs, landingOpts);
  // Full-sweep gate's actionable half: players with a moon candidate but an
  // incompletely-covered account get their uncovered systems boosted in the
  // look plan — the verdict fires only after the sweep completes.
  const sweeps = detectAllSweeps(cfg.players, universePlanets, rings, nowMs, landingOpts);
  if (prey.length) {
    for (const [k, sig] of strikeMapOf(detectAllLandings(prey, universePlanets, rings, nowMs, landingOpts))) {
      if (!strikes.has(k)) strikes.set(k, sig);
    }
    // No pid collisions possible (prey excludes watch-list ids).
    Object.assign(rechecks, detectAllRechecks(prey, universePlanets, rings, nowMs, landingOpts));
    Object.assign(sweeps, detectAllSweeps(prey, universePlanets, rings, nowMs, landingOpts));
  }

  return {
    players: cfg.players,
    universePlanets,
    spiedByPlayer: spiedCoordsByPlayer(reports),
    spiedMoonsByPlayer: spiedMoonsByPlayer(reports),
    rescan: cfg.rescan,
    sentCoords: new Set(Object.keys(sentMap)),
    // Send TIMES too — the pending-reports nudge compares them against the
    // ingested report timestamps (countPendingReports).
    sentAt: sentMap,
    nowMs,
    scanBodies: cfg.scanBodies,
    // Scan mode gates the PROBE plan (off bodies excluded); galaxyMode mutes
    // the LOOK plan per player (recording stays always-on regardless).
    scanMode: cfg.scanMode,
    galaxyMode: cfg.galaxyMode,
    cadence: cfg.cadence,
    rings,
    sysLookSec,
    // Moon-strike candidates (domain/fleetLanding) → force-boosted to the
    // top of the probe plan so the FAB proposes spying that moon NOW. The
    // configured moon-strike mode (off/lone/newest/any) gates how much
    // corroboration the detector demands; the map carries each signal's
    // tier so the button words its claim per rung. Includes the patrol
    // territory's prey when a radius is configured (see above).
    strikes,
    // Ambiguous-moon re-look windows → boost those systems in the LOOK plan
    // (one look now reads exact minutes and settles the moon-vs-planet order).
    rechecks,
    // Account sweeps → the looks that must complete before a verdict may fire.
    sweeps,
    // Patrol looks: territory systems whose last galaxy scan outgrew the
    // look cadence — merged into the LOOK plan by deriveSpy.
    patrolLooks: patrolSet && patrolSet.size
      ? buildPatrolPlan({
        systems: patrolSet,
        scans: scansStore.get(),
        occupants,
        nowMs,
        staleMs: galaxyStaleMs(cfg.cadence),
      }).entries
      : [],
    dangerByPlayer: dangerByPlayer(),
    activityByPlayer: activityByPlayer(nowMs),
    playerNames: ctx?.players ?? {},
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
 * Is the watch-list value trustworthy yet? True once the async hydrate has
 * settled — or earlier, the moment the store already holds players (a set
 * with content is real data regardless of where it came from). While false
 * the button exists only via the optimistic cache mount and must hold the
 * same dim "loading…" state as a missing apiContext.
 * @returns {boolean}
 */
const watchReady = () => watchHydrated || watchListStore.get().players.length > 0;

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
  // FR-style needs-attention glow while a probe scan is proposed (renderSpy
  // sets `pulse` on exactly those paints); any other paint clears it, so the
  // pulse dies the moment the plan empties or a send takes over the zone.
  setFabModuleAlert('spy', p.pulse === true);
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
    showingLoading = false;
    paintZone({ text: 'Send', subtext: coordsLabel(spyTarget), bg: BG_SPY_READY });
    return;
  }
  // Hold a dim "loading…" state until the apiContext handoff lands AND the
  // watch-list hydrate settles — before then there are no candidates and the
  // "all scanned" done state would flash.
  if (!apiContextReady() || !watchReady()) {
    showingLoading = true;
    paintZone({ text: 'Spy', subtext: 'loading…', bg: BG_SPY_IDLE, dim: true });
    return;
  }
  showingLoading = false;
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
  if (reason === 'allFleets') return { text: 'Max fleets', bg: BG_SPY_ERROR };
  // Two distinct courier failures, one user-facing meaning for a probe order:
  // 'noShips' (plural) = select() couldn't fill the order from the planet's
  // hangar; 'noShip' (singular) = the target-validation path's missing-ship
  // case. The old compare matched only the singular, so the common empty-
  // hangar case fell through to the raw code label.
  if (reason === 'noShip' || reason === 'noShips') {
    return { text: 'No probes', subtext: coords, bg: BG_SPY_ERROR };
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
    paintZone({ text: 'Sent', bg: BG_SPY_READY, dim: true });
    if (sentLockTimer) clearTimeout(sentLockTimer);
    sentLockTimer = setTimeout(() => {
      sentLockTimer = null;
      busy = false;
      refresh();
    }, SENT_LOCK_MS);
    return;
  }

  // The button is showing the dim "loading…" state — either the handoff still
  // isn't ready, OR it quietly became ready but the label hasn't repainted yet
  // (the ≤ REPAINT_TICK_MS ticker window). Either way a tap must NOT fire an
  // action off a "loading…" button: that stale tap used to navigate to
  // fleetdispatch and then fail with a generic courier error. Repaint to the
  // real state and let the next, deliberate tap act.
  if (!apiContextReady() || !watchReady() || showingLoading) {
    refresh();
    return;
  }

  const ctx = deriveSpy(captureEnv());

  // Fresh reports await ingest → ONE tap = ONE navigation to messages
  // (opening them is what ingests the reports and advances the button).
  if (ctx.proposal === 'reports') {
    location.href = ingameComponentUrl(location.href, 'messages', {});
    return;
  }

  // Galaxy look proposed → ONE tap = ONE navigation to that system. On the
  // galaxy view step in-page (the game's own AJAX loader); anywhere else a
  // full navigation. The galaxyHook ingest of the rendered system then bumps
  // the rings and the button self-advances — no queue state, no auto-paging.
  if (ctx.proposal === 'look' && ctx.look) {
    const l = ctx.look;
    if (!parseCurrentGalaxyView() || !navigateGalaxyInPage(l.galaxy, l.system)) {
      location.href = ingameComponentUrl(location.href, 'galaxy', {
        galaxy: l.galaxy, system: l.system,
      });
    }
    return;
  }

  // Nothing left to scan → jump to the messages component to read reports
  // (a deliberate navigation on the user's tap, never chained off a send).
  if (!ctx.candidate) {
    if (ctx.hasWatched) location.href = ingameComponentUrl(location.href, 'messages', {});
    return;
  }
  const target = ctx.candidate;

  // A probe flight costs real minutes both ways (a look is free from anywhere,
  // a probe is not) — so before driving the courier, make sure we are standing
  // on the own planet NEAREST the target (donut flight distance). One tap =
  // one hop: navigate to that planet's fleetdispatch and let the next tap
  // select. The armed-send tap 2 above never reaches this gate — an already
  // selected fleet dispatches from wherever it was armed.
  //
  // 'active' probe source (dashboard config) opts OUT of the hop: `launch` stays
  // null, so `onLaunch` is true and the send fires from whatever body is active.
  const launch = watchListStore.get().probeSource === 'active'
    ? null
    : nearestLaunchPlanet(
      target, bodiesStore.get().bodies, getApiContext()?.server ?? {},
    );
  const here = readCurrentBody();
  const onLaunch = !launch || (
    !!here
    && here.type === TARGET_PLANET
    && here.galaxy === launch.galaxy
    && here.system === launch.system
    && here.position === launch.position
  );

  // Off fleetdispatch → bare nav (pinned to the launch planet when we're not
  // already on it); the next tap selects the fleet in-page.
  if (s === 'off') {
    location.href = bareFleetdispatchUrl(launch && !onLaunch ? launch.cp : undefined);
    return;
  }

  // On fleetdispatch but on the WRONG body → hop to the launch planet first.
  if (!onLaunch && launch) {
    location.href = bareFleetdispatchUrl(launch.cp);
    return;
  }

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
    paintZone({ text: 'Send', subtext: coordsLabel(target), bg: BG_SPY_READY });
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
  paintZone({ text: 'Send', subtext: coordsLabel(target), bg: BG_SPY_READY });
};

// ─── lifecycle ────────────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the espionage-scan button. Idempotent — a second call returns the
 * SAME dispose fn. The button mounts only when the watch-list
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
    // The alert flag lives in the FAB shell (survives unregistration) — clear
    // it so a re-mount never inherits a stale pulse.
    setFabModuleAlert('spy', false);
    controller?.dispose();
    controller = null;
  };

  /** Live-resize the mounted button. @param {number} size @returns {void} */
  const updateButtonSize = (size) => controller?.resize(size);

  /**
   * Mount when the watch-list is non-empty — OR, while the async hydrate is
   * still pending, when last load's reconciled verdict says the button was
   * shown (the optimistic mount that kills the per-navigation blink; the
   * hydrate-driven reconcile below confirms or removes it).
   * @returns {void}
   */
  const gatedMount = () => {
    if (watchListStore.get().players.length > 0
      || (!watchHydrated && readSpyFabShown())) mount();
  };

  /**
   * Reconcile mount state against the watch-list: mount when work appears,
   * remove when the last watched player is cleared. Once the hydrate has
   * settled, the verdict is also cached for the next load's optimistic mount.
   * @returns {void}
   */
  const reconcile = () => {
    const hasWatched = watchListStore.get().players.length > 0;
    const mounted = !!document.getElementById(BUTTON_ID);
    if (hasWatched && !mounted && document.body) mount();
    else if (!hasWatched && mounted && watchHydrated) removeButton();
    if (watchHydrated) writeSpyFabShown(hasWatched);
    refresh();
  };

  // `enabled: () => true` — the spy button's visibility is watch-list-driven
  // (reconcile above), not settings-driven; the lifecycle contributes the
  // initial gated mount + the live fabBtnSize resize.
  const unsubSettings = installFabSettingsLifecycle({
    settingsStore,
    enabled: () => true,
    mount: gatedMount,
    removeButton,
    updateButtonSize,
    isInstalled: () => installed !== null,
    onSettingsChange: refresh,
  });
  // The watch-list drives both visibility (mount/remove) and the candidate.
  const unsubWatch = watchListStore.subscribe(reconcile);
  // The hydrate settling is the moment the optimistic mount gets judged: an
  // empty hydrated list never fires the subscription above (persist keeps the
  // store's initial value), so without this a stale cache flag would leave a
  // ghost button in its "loading…" state forever.
  void whenWatchListHydrated().then(() => {
    if (!installed) return;
    watchHydrated = true;
    reconcile();
  });
  // A landed spy report flips a planet from "needs scan" to spied — repaint.
  const unsubReports = targetReportsStore.subscribe(refresh);
  // A galaxy ingest (oge:galaxyScanned → rings) flips a looked-at system to
  // fresh — the look proposal self-advances on this repaint.
  const unsubActivity = activityObsStore.subscribe(refresh);
  // Repaint the instant the apiContext handoff lands — clears the dim
  // "loading…" state immediately instead of waiting up to REPAINT_TICK_MS for
  // the next slow tick (the visible post-reload lag on the Spyglass button).
  const unsubApiCtx = subscribeApiContext(refresh);
  // Slow ticker now only catches staleness ticking (the handoff itself is
  // event-driven above).
  const unsubTicker = clock.subscribe(refresh, { everyMs: REPAINT_TICK_MS });

  installed = {
    dispose: () => {
      unsubTicker();
      unsubApiCtx();
      removeButton();
      unsubSettings();
      unsubWatch();
      unsubReports();
      unsubActivity();
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
  showingLoading = false;
  watchHydrated = false;
  if (sentLockTimer) {
    clearTimeout(sentLockTimer);
    sentLockTimer = null;
  }
};
