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
} from '../shared/fleetCourier.js';
import { installFabSettingsLifecycle } from '../shared/fabSettingsLifecycle.js';
import { getApiContext } from '../shared/apiContextStore.js';
import { SHIP_ESPIONAGE_PROBE, TARGET_PLANET, MISSION_ESPIONAGE } from '../../domain/rules.js';
import { OWNER_SPY } from '../../domain/fleetOwnership.js';
import { ingameComponentUrl } from '../../domain/ogameUrl.js';
import { clock } from '../../lib/clock.js';
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
const FOCUS_KEY = 'oge_focusedBtn';
const FOCUS_SPY = 'spy-send';
const FOCUS_RESTORE_DELAY_MS = 50;
const REPAINT_TICK_MS = 2000;
/** sessionStorage key (page origin, per tab) for coords sent this session. */
const SENT_COORDS_KEY = 'oge_spySentCoords';
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

/**
 * Coords sent this browser-tab session, so a just-probed planet isn't
 * re-proposed across the post-send page reload before its report lands.
 * @returns {Set<string>}
 */
const getSentCoords = () => {
  try {
    const raw = window.sessionStorage.getItem(SENT_COORDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
};

/**
 * Mark a coord as sent this session.
 * @param {SpyTarget} t
 * @returns {void}
 */
const markSent = (t) => {
  const set = getSentCoords();
  set.add(`${t.galaxy}:${t.system}:${t.position}`);
  try {
    window.sessionStorage.setItem(SENT_COORDS_KEY, JSON.stringify([...set]));
  } catch {
    /* sessionStorage unavailable — degrade to in-memory only (no persistence). */
  }
};

// ─── env capture (the one impure read of the derive pipeline) ───────────────

/**
 * Project the espionage-report cache into `playerId → (coord → newest ts)`. The
 * report key is a bodyKey "g:s:p:type"; strip the trailing ":type" for the coord.
 * @returns {Record<string, Record<string, number>>}
 */
const spiedCoordsByPlayer = () => {
  const reports = targetReportsStore.get();
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const pid of Object.keys(reports)) {
    const bucket = reports[pid];
    if (!bucket) continue;
    /** @type {Record<string, number>} */
    const coordTs = {};
    for (const key of Object.keys(bucket)) {
      const lastColon = key.lastIndexOf(':');
      const coord = lastColon >= 0 ? key.slice(0, lastColon) : key;
      coordTs[coord] = bucket[key].timestamp ?? 0;
    }
    out[pid] = coordTs;
  }
  return out;
};

/**
 * Snapshot every input of {@link deriveSpy}.
 * @returns {import('./pure.js').SpyEnv}
 */
const captureEnv = () => ({
  players: watchListStore.get().players,
  universePlanets: getApiContext()?.universePlanets ?? [],
  spiedByPlayer: spiedCoordsByPlayer(),
  rescan: watchListStore.get().rescan,
  sentCoords: getSentCoords(),
  nowMs: Date.now(),
});

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
    paintZone({
      text: 'Send!',
      subtext: `[${spyTarget.galaxy}:${spyTarget.system}:${spyTarget.position}]`,
      bg: BG_SPY_READY,
    });
    return;
  }
  paintZone(renderSpy(deriveSpy(captureEnv())));
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
  if (reason === 'noShip') return { text: 'No probes!', subtext: coords, bg: BG_SPY_ERROR };
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
  target: { galaxy: t.galaxy, system: t.system, position: t.position, type: TARGET_PLANET },
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
    paintZone({
      text: 'Send!',
      subtext: `[${target.galaxy}:${target.system}:${target.position}]`,
      bg: BG_SPY_READY,
    });
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
  paintZone({
    text: 'Send!',
    subtext: `[${target.galaxy}:${target.system}:${target.position}]`,
    bg: BG_SPY_READY,
  });
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
      title: 'Espionage scan',
      ringId: 'oge-ring-spy',
      size,
      fontScale: 0.18,
      module: { id: 'spy', name: 'Spy', color: BG_SPY_IDLE, glyph: EYE_GLYPH },
      gateUntilEventBox: true,
      focusKey: FOCUS_KEY,
      zones: [
        {
          key: 'send',
          id: SEND_HALF_ID,
          ariaLabel: 'Send espionage scan',
          bg: BG_SPY_IDLE,
          glyph: EYE_GLYPH,
          onTap: () => void onSpyClick(),
          focusValue: FOCUS_SPY,
          focusRestoreDelay: FOCUS_RESTORE_DELAY_MS,
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
