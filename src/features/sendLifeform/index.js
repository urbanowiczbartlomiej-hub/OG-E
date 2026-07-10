// @ts-check

// Floating "Lifeforms" button — the lifeform system-discovery automator.
// Single-zone sibling of the two command buttons: the lifecycle (mount /
// dispose / drag / focus / settings reactions / 1 Hz ticker) follows
// `sendExpedition/index.js`; the galaxy-walk + scansStore marking follows the
// Send-Col Scan half. The pure compute pipeline lives in `./pure.js`, the
// DOM readers + game-button click in `./domHelpers.js`.
//
// # What one tap does (each tap = exactly ONE game action, TOS-safe)
//
//   1. Off galaxy view        → full-navigate to the bare galaxy URL.
//   2. On galaxy, viewed system needs discovery + the game's
//      `#discoverSystemBtn` is present → click it. The GAME issues
//      `sendSystemDiscoveryFleet`; we never originate it. The
//      `bridges/systemDiscoveryObserver.js` observer republishes the result as
//      `oge:systemDiscoveryResult`, which we use to mark the system.
//   3. On galaxy, viewed system already covered → in-page hop to the
//      NEAREST system that still needs discovery (wrap-aware).
//   4. Nothing left anywhere   → "All discovered!".
//   0. (outranks all) Artifact cap reached → button gated as "Full"; the
//      tap navigates to the lfresearch page (spend artifacts there — the
//      visit also refreshes the counter). The counter is harvested from
//      every lfresearch visit (passive DOM read, never an automated request).
//
// # Marking + 7-day retention
//
// On a successful discovery we stamp `SystemScan.lfScannedAt = now` (the
// per-system retention gate) and merge `sentToCoordinates` into
// `lfPositions` (per-position record). A `shipsSent:0` success still stamps
// `lfScannedAt` so the button advances past an already-covered system. A
// fleet-cap rejection ("Maksymalna liczba flot") marks nothing.
//
// @see ./pure.js — derive/render + target pickers consumed here.
// @see ../../bridges/systemDiscoveryObserver.js — the result observer this listens to.

import { settingsStore } from '../../state/settings.js';
import { scansStore, flushScansStore } from '../../state/scans.js';
import { readLfArtifacts, writeLfArtifacts } from '../../state/lifeformArtifacts.js';
import { createButton as makeButton, labelLines } from '../shared/button.js';
import { DNA_GLYPH } from '../shared/buttonGlyphs.js';
import { FAB_MODULES } from '../shared/fabModules.js';
import { installFabSettingsLifecycle } from '../shared/fabSettingsLifecycle.js';
import { SYSTEM_DISCOVERY_RESULT_EVENT } from '../../lib/ogeEvents.js';
import { clock } from '../../lib/clock.js';
import {
  derive,
  render,
  buildGalaxyUrl,
  buildGalaxySystemUrl,
  buildLfResearchUrl,
  DISCOVERY_COOLDOWN_MS,
  BG_LF_IDLE,
  BG_LF_WAIT,
  BG_LF_ACTIVE,
  BG_LF_ERROR,
} from './pure.js';
import {
  readHomePlanet,
  parseCurrentGalaxyView,
  navigateGalaxyInPage,
  hasDiscoverButton,
  isDiscoverButtonDisabled,
  clickDiscover,
  readArtifactCounter,
} from './domHelpers.js';

/**
 * @typedef {import('./pure.js').Paint} Paint
 * @typedef {import('./pure.js').LfContext} LfContext
 * @typedef {{ galaxy: number, system: number }} SystemCoords
 */

// ─── DOM ids / storage keys ───────────────────────────────────────────────

const BUTTON_ID = 'oge-send-lf';

// ─── Tunables (match the other buttons) ────────────────────────────────────

const REPAINT_TICK_MS = 1000;
/** How long the transient "Sent!" / "Empty" / "Max fleets" label lingers. */
const TRANSIENT_MS = 1800;

// ─── Module-local state ────────────────────────────────────────────────────

/** @type {import('../shared/button.js').Button | null} */
let controller = null;
/** Post-click cooldown: locked between a discover click and its result. */
let busy = false;
/** Safety timer that lifts `busy` if no result event arrives. */
/** @type {ReturnType<typeof setTimeout> | null} */
let cooldownTimer = null;
/** A transient label to hold (Sent / Empty / Max fleets) and its deadline. */
/** @type {Paint | null} */
let transientPaint = null;
let transientUntil = 0;

// ─── Paint ─────────────────────────────────────────────────────────────────

/**
 * Paint the single zone from a {@link Paint}. `subtext`/`hint` → stacked
 * lines (same layout as the other buttons); else a single line.
 *
 * @param {Paint} p
 * @returns {void}
 */
const paint = (p) => {
  if (!controller) return;
  if (p.subtext || p.hint) {
    controller.paintLines('main', labelLines({ main: p.text, sub: p.subtext, hint: p.hint }));
  } else {
    controller.setText('main', p.text);
  }
  controller.setBg('main', p.bg);
  controller.setDim('main', p.dim === true);
};

/**
 * Snapshot every `derive()` input from the live page + module state.
 *
 * @returns {import('./pure.js').LfDeriveEnv}
 */
const captureEnv = () => {
  const scans = scansStore.get();
  return {
    search: location.search,
    scans,
    now: Date.now(),
    home: readHomePlanet(),
    view: parseCurrentGalaxyView(),
    hasDiscoverBtn: hasDiscoverButton(),
    discoverBtnDisabled: isDiscoverButtonDisabled(),
    cooldown: busy,
    artifacts: readLfArtifacts(),
  };
};

/**
 * Full pipeline: hold a live transient if one is active, else
 * capture → derive → render → paint. Called from the stores
 * subscriptions, the result listener, the 1 Hz ticker, and click handlers.
 *
 * @returns {void}
 */
const refresh = () => {
  if (!controller) return;
  if (transientPaint && Date.now() < transientUntil) {
    paint(transientPaint);
    return;
  }
  transientPaint = null;
  paint(render(derive(captureEnv())));
};

/**
 * Show a transient label for {@link TRANSIENT_MS} before the derive-driven
 * label resumes (the 1 Hz ticker clears it when the deadline passes).
 *
 * @param {Paint} p
 * @returns {void}
 */
const showTransient = (p) => {
  transientPaint = p;
  transientUntil = Date.now() + TRANSIENT_MS;
  paint(p);
};

// ─── Cooldown ──────────────────────────────────────────────────────────────

const startCooldown = () => {
  busy = true;
  if (cooldownTimer !== null) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    busy = false;
    cooldownTimer = null;
    refresh();
  }, DISCOVERY_COOLDOWN_MS);
};

const endCooldown = () => {
  busy = false;
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
};

// ─── Click handler ───────────────────────────────────────────────────────────

/**
 * One tap → one action. Branches on the derived phase.
 *
 * @returns {void}
 */
const onClick = () => {
  if (busy) return;
  const ctx = derive(captureEnv());

  switch (ctx.kind) {
    case 'checkArtifacts':
      // The displayed counter has drifted (≥ ARTIFACT_REFRESH_EVERY sends
      // since the last reading) — detour to lfresearch. The visit harvests a
      // fresh reading; checkArtifacts then dissolves on the next tap.
      location.href = buildLfResearchUrl(location.href);
      return;

    case 'offGalaxy':
      location.href = buildGalaxyUrl(location.href);
      return;

    case 'discover': {
      // Click the game's discover control; the game sends. Lock until the
      // result event (or the safety cap) lifts the cooldown.
      if (!clickDiscover()) {
        // Control vanished between derive and click — repaint and let the
        // next tap re-evaluate (likely a navigate now).
        refresh();
        return;
      }
      startCooldown();
      paint({ text: 'Wait…', bg: BG_LF_WAIT, dim: true });
      return;
    }

    case 'navigate': {
      if (navigateGalaxyInPage(ctx.target.galaxy, ctx.target.system)) {
        paint({
          text: 'Going',
          subtext: `[${ctx.target.galaxy}:${ctx.target.system}]`,
          bg: BG_LF_ACTIVE,
          dim: true,
        });
        return;
      }
      // In-page submit unavailable — full-nav fallback.
      location.href = buildGalaxySystemUrl(location.href, ctx.target);
      return;
    }

    case 'blocked':
      // The game's discover control is disabled (all fleet slots used /
      // other game-side blocker) — a click could not send anything. Just
      // repaint; the 1 Hz ticker lifts the state when the game does.
      // falls through
    case 'allDone':
      paint(render(ctx));
      return;
  }
};

// ─── Artifact counter (T10) ──────────────────────────────────────────────────
//
// Passive-only acquisition: every visit to the lfresearch page reads the
// live DOM counter and persists it. No automated background requests —
// that would violate OGame's ToS. The reading is therefore as fresh as the
// user's last natural visit to that page.

/**
 * On the lfresearch page, read the artifact counter from the live DOM and
 * persist it. No-op anywhere else.
 *
 * @returns {void}
 */
const harvestArtifactsFromPage = () => {
  if (!location.search.includes('component=lfresearch')) return;
  const counter = readArtifactCounter();
  if (!counter) return;
  writeLfArtifacts({ ...counter, readAt: Date.now() });
};

// ─── Result reactor ──────────────────────────────────────────────────────────

/** Recognise the fleet-cap rejection message. */
const MAX_FLEET_RE = /Maksymalna liczba flot/i;

/**
 * Stamp a system's lifeform discovery markers in `scansStore`:
 * `lfScannedAt = now` (retention gate) + merge `sent` positions into
 * `lfPositions`. Preserves the colonization-owned `scannedAt` / `positions`.
 *
 * @param {number} galaxy
 * @param {number} system
 * @param {Array<{ position: number }>} sent
 * @returns {void}
 */
const markSystemDiscovered = (galaxy, system, sent) => {
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  const now = Date.now();
  scansStore.update((prev) => {
    const existing = prev[key] ?? { scannedAt: now, positions: {} };
    /** @type {Record<number, number>} */
    const lfPositions = { ...(existing.lfPositions ?? {}) };
    for (const c of sent) {
      if (typeof c.position === 'number') lfPositions[c.position] = now;
    }
    return {
      ...prev,
      [key]: { ...existing, lfScannedAt: now, lfPositions },
    };
  });
  // Bypass the 200 ms debounce — the user may navigate immediately after.
  flushScansStore();
};

/**
 * React to `oge:systemDiscoveryResult` from `bridges/systemDiscoveryObserver.js`.
 *
 * @param {Event} e
 * @returns {void}
 */
const onDiscoveryResult = (e) => {
  const detail = /** @type {CustomEvent<import('../../bridges/systemDiscoveryObserver.js').SystemDiscoveryResultDetail>} */ (
    e
  ).detail;
  if (!detail) return;
  endCooldown();

  // Resolve the system to mark: the bridge parses it from the request body;
  // fall back to the current galaxy view if the body lacked the coords.
  const view = parseCurrentGalaxyView();
  const galaxy = detail.galaxy ?? view?.galaxy ?? null;
  const system = detail.system ?? view?.system ?? null;

  if (detail.success) {
    if (galaxy !== null && system !== null) {
      markSystemDiscovered(galaxy, system, detail.sentToCoordinates);
    }
    const coords = galaxy !== null && system !== null ? `[${galaxy}:${system}]` : undefined;
    showTransient(
      detail.shipsSent > 0
        ? { text: `Sent ${detail.shipsSent}!`, subtext: coords, bg: BG_LF_ACTIVE }
        : { text: 'Empty', subtext: coords, bg: BG_LF_IDLE },
    );
    return;
  }

  // Failure. Fleet cap (or the game flat-out reports it can't send more) →
  // surface it and mark NOTHING (the system still needs discovering).
  if ((detail.message && MAX_FLEET_RE.test(detail.message)) || detail.canSendDiscovery === false) {
    showTransient({ text: 'Max fleets', bg: BG_LF_ERROR });
    return;
  }
  showTransient({ text: 'Failed', bg: BG_LF_ERROR });
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the Lifeforms button. Idempotent — a second call returns the SAME
 * dispose fn as the first. Gated on the `showLifeformButton` setting (mount /
 * remove live on toggle); resized live on `fabBtnSize`. Registers as the
 * 'lf' module of the unified FAB.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSendLifeform = () => {
  if (installed) return installed.dispose;

  const mount = () => {
    if (document.getElementById(BUTTON_ID)) return;
    const size = settingsStore.get().fabBtnSize;
    controller = makeButton({
      id: BUTTON_ID,
      title: 'Lifeforms',
      ringId: 'oge-ring-lf',
      size,
      fontScale: 0.18,
      module: FAB_MODULES.lf,
      gateUntilEventBox: true,
      zones: [
        {
          key: 'main',
          id: BUTTON_ID,
          ariaLabel: 'Discover lifeforms in the next system',
          bg: BG_LF_IDLE,
          glyph: DNA_GLYPH,
          onTap: onClick,
        },
      ],
    });
    if (!controller) return;
    // Violet glow (the planted TODO's intended look).
    controller.el.style.setProperty('--glow', '1.15');
    refresh();
  };

  const removeButton = () => {
    controller?.dispose();
    controller = null;
  };

  /** @param {number} size */
  const updateButtonSize = (size) => controller?.resize(size);

  // Passive artifact-counter harvest — NOT gated on the button toggle: like the
  // galaxy scans it's pure data collection, and a reading taken while the
  // button is off is immediately correct when the user re-enables it.
  if (document.body) {
    harvestArtifactsFromPage();
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        if (installed) harvestArtifactsFromPage();
      },
      { once: true },
    );
  }

  // Settings-driven mount/teardown + live resize — the wiring shared by every
  // send* FAB feature, gated on the per-module `showLifeformButton` toggle
  // (the settings module bar; mirrors sendExpedition).
  const unsubSettings = installFabSettingsLifecycle({
    settingsStore,
    enabled: (s) => s.showLifeformButton,
    mount: () => mount(),
    removeButton,
    updateButtonSize,
    isInstalled: () => installed !== null,
  });

  const unsubScans = scansStore.subscribe(() => refresh());
  document.addEventListener(SYSTEM_DISCOVERY_RESULT_EVENT, onDiscoveryResult);

  const unsubTicker = clock.subscribe(refresh, { everyMs: REPAINT_TICK_MS });

  installed = {
    dispose: () => {
      unsubTicker();
      endCooldown();
      removeButton();
      unsubSettings();
      unsubScans();
      document.removeEventListener(SYSTEM_DISCOVERY_RESULT_EVENT, onDiscoveryResult);
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset — runs dispose (if any) and zeroes module-local state.
 *
 * @returns {void}
 */
export const _resetSendLifeformForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  busy = false;
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  transientPaint = null;
  transientUntil = 0;
};

/** Exposed only for unit tests — do not call from production code. */
export const _onDiscoveryResultForTest = onDiscoveryResult;
