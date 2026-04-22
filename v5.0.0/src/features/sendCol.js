// Floating "Send Col" button — the mobile-first colonization state
// machine. The single most complex feature in v5: it wires three stores
// (settings / scans / registry / uiState), three DOM events
// (`oge5:galaxyScanned`, `oge5:checkTargetResult`, and settings changes),
// two button halves, and the {@link abandonPlanet} hand-off for small
// fresh colonies — all while respecting the "1 user click = at most 1
// HTTP request" TOS rule.
//
// # Two halves, one circle
//
// The button is a 336-px round container with a sendHalf on top and a
// scanHalf below. Each half is a real `<button>` so focus / tab /
// keyboard Enter work natively; the outer `<div>` is just the drag
// handle and rounded chrome. They share drag + focus persistence with
// sendExp (`oge5_focusedBtn` is common), so tapping between the two
// big OG-E buttons never loses keyboard focus.
//
// # State machine — five user-visible states
//
//   ┌──────────┐  scan DB → target        ┌────────┐
//   │  Normal  │ ───────────────────────► │  Found │
//   │ "Send"   │                          │ "Go"   │
//   └────┬─────┘                          └───┬────┘
//        │                                    │ click → navigate
//        │                                    ▼
//        │                             ┌──────────────┐
//        │  ┌────────────────────────► │  Fleet-Ready │
//        │  │  checkTargetResult: ok   │ "Dispatch!"  │
//        │  │                          └──────┬───────┘
//        │  │                                 │ click → Enter
//        │  │                                 ▼
//        │  │  checkTargetResult: stale   (game sendFleet)
//        │  ▼
//   ┌──────────┐  click → swap form      ┌────────┐
//   │  Stale   │ ───────────────────────► (back to Fleet-Ready
//   │ "Stale…" │                          after next result)
//   └──────────┘
//
//   └──────────┐  checkAbandonState
//   │ Abandon  │  ← orthogonal: this pin preempts the others whenever
//   │ "Too     │    the overview page shows a fresh small colony.
//   │  small!" │    sendHalf is read-only; scanHalf delegates to
//   └──────────┘    {@link abandonPlanet}.
//
// # Store subscriptions
//
//   - `settingsStore` — visibility (`colonizeMode`), size (`colBtnSize`),
//     and the `colPositions` / `colPreferOtherGalaxies` inputs consumed
//     by {@link findNextColonizeTarget} on every click.
//   - `uiState`      — `pendingColLink`, `pendingColVerify`,
//                      `staleRetryActive`. Read on every click; written
//                      on successful scan / verify / stale handling.
//   - `scansStore` / `registryStore` — read only in the pure algorithms
//                                      below. We never write scans here
//                                      except in the stale reactor, which
//                                      mirrors 4.x's markPositionAbandoned.
//
// # Event reactors
//
//   - `oge5:galaxyScanned`     — after the MAIN-world galaxy hook
//     classifies a freshly scanned system, we look for a user-target
//     position in the new scan and repaint the button accordingly
//     ("Found! Go" / "No ship!" / "Scan next").
//   - `oge5:checkTargetResult` — after the game fires its own checkTarget
//     XHR on fleetdispatch the hook forwards the result. If it matches
//     our pending verify we either paint "Ready!" or mark the slot
//     abandoned + arm `staleRetryActive`.
//
// # Integration with abandon feature
//
// `checkAbandonState` is consulted on every click; when it matches we
// delegate to `abandonPlanet()` from `../features/abandon.js`. This
// feature never writes the abandon flow itself — that is the abandon
// module's job. We just surface the entry point on the scanHalf.
//
// # TOS contract
//
// Every code path in this module obeys "1 user click → at most 1 HTTP
// request originated by us". The normal flows are all
// either `location.href = …` (a single navigation the browser performs)
// or `dispatchEnter()` (which triggers the game's own `sendFleet` — not
// ours). The stale-retry path swaps three fleetdispatch form inputs
// synchronously; the game itself then fires one `checkTarget` XHR as a
// reaction to the `change` event. Still exactly one HTTP request per
// user click.

/** @ts-check */

// ─── Imports ────────────────────────────────────────────────────────────────

import { settingsStore } from '../state/settings.js';
import { scansStore } from '../state/scans.js';
import { registryStore } from '../state/registry.js';
import { uiState } from '../state/uiState.js';
import { safeLS } from '../lib/storage.js';
import {
  parsePositions,
  sysDist,
  buildGalaxyOrder,
} from '../domain/positions.js';
import { findConflict } from '../domain/registry.js';
import { isSystemStale } from '../domain/scheduling.js';
import {
  COL_MAX_SYSTEM,
  COL_MAX_GALAXY,
  MISSION_COLONIZE,
} from '../domain/rules.js';
import { checkAbandonState, abandonPlanet } from './abandon.js';

/**
 * @typedef {import('../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../state/scans.js').SystemScan} SystemScan
 * @typedef {import('../domain/registry.js').RegistryEntry} RegistryEntry
 * @typedef {import('../state/settings.js').Settings} Settings
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** DOM id of the container div. */
const BUTTON_ID = 'oge5-send-col';
/** DOM id of the top (Send) half. */
const SEND_HALF_ID = 'oge5-col-send';
/** DOM id of the bottom (Scan) half. */
const SCAN_HALF_ID = 'oge5-col-scan';

/** Shared focus-persist key with sendExp (see that module's header). */
const FOCUS_KEY = 'oge5_focusedBtn';
/** Focus-persist value written when the sendHalf holds focus. */
const FOCUS_SEND = 'col-send';
/** Focus-persist value written when the scanHalf holds focus. */
const FOCUS_SCAN = 'col-scan';

/** localStorage key for the dragged `(x, y)` position. */
const POS_KEY = 'oge5_colBtnPos';

/** Drag-vs-tap threshold — matches sendExp + 4.x. */
const DRAG_THRESHOLD = 8;

/** Delay before restoring focus on install. */
const FOCUS_RESTORE_DELAY_MS = 50;

/** Default bottom-right edge offset when no saved position. */
const DEFAULT_EDGE_OFFSET_PX = 20;

/** Background colour — idle Send half. */
const BG_SEND_IDLE = 'rgba(0, 160, 0, 0.75)';
/** Background colour — idle Scan half. */
const BG_SCAN_IDLE = 'rgba(60, 100, 150, 0.75)';
/** Green highlight — "Found! Go" / "Ready!" / "Dispatch!" */
const BG_SEND_READY = 'rgba(0, 200, 0, 0.85)';
/** Orange — stale / "Searching…" transient. */
const BG_SEND_STALE = 'rgba(200, 150, 0, 0.85)';
/** Red — "No ship!" and hard-abort states. */
const BG_SEND_ERROR = 'rgba(200, 0, 0, 0.85)';
/** Amber — the mid-countdown "Wait Xs" label. */
const BG_SEND_WAIT = 'rgba(200, 200, 0, 0.8)';
/** Dark red — scanHalf in abandon mode. */
const BG_SCAN_ABANDON = 'rgba(150, 0, 0, 0.75)';

/** Idle Send label. */
const LABEL_SEND_IDLE = 'Send';
/** Idle Scan label. */
const LABEL_SCAN_IDLE = 'Scan';
/** Fleet-ready label — clicking fires Enter. */
const LABEL_DISPATCH = 'Dispatch!';
/** Scan half when we already have a target loaded. */
const LABEL_SCAN_SKIP = 'Skip';

// ─── Pure algorithms (testable in isolation) ────────────────────────────────

/**
 * Find the next galaxy/system we should scan. Pure: inputs in, next
 * coord out, no DOM / storage / clock.
 *
 * Starting point follows 4.x behaviour:
 *   - when we are on the galaxy view → continue from current + 1
 *   - elsewhere                       → home.galaxy, home.system + 1
 *
 * Galaxy progression rolls through `buildGalaxyOrder(home.galaxy,
 * COL_MAX_GALAXY)` — home first, then outward — and within each galaxy
 * sweeps 1..COL_MAX_SYSTEM modularly. A system counts as "needs scan"
 * when there is no entry in `scans` for it OR the entry is stale per
 * {@link isSystemStale}.
 *
 * Returns `null` when every galaxy/system combination is already
 * scanned and fresh.
 *
 * @param {GalaxyScans} scans
 * @param {{ galaxy: number, system: number }} home
 * @param {{ galaxy: number, system: number } | null} currentView
 *   Current galaxy-view coords (null when the user isn't on the galaxy
 *   page — we then start from the home planet instead).
 * @returns {{ galaxy: number, system: number } | null}
 */
export const findNextScanSystem = (scans, home, currentView) => {
  const startG = currentView ? currentView.galaxy : home.galaxy;
  const startS = currentView ? currentView.system : home.system;

  const galaxyOrder = buildGalaxyOrder(home.galaxy, COL_MAX_GALAXY);
  const startGalaxyIdx = Math.max(0, galaxyOrder.indexOf(startG));

  for (let gi = 0; gi < galaxyOrder.length; gi++) {
    const g = galaxyOrder[(startGalaxyIdx + gi) % galaxyOrder.length];
    // Current galaxy: start at startS+1 (and wrap). Others: start at 1.
    const offset = gi === 0 ? startS : 0;
    for (let i = 0; i < COL_MAX_SYSTEM; i++) {
      const s = ((offset + i) % COL_MAX_SYSTEM) + 1;
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      const scan = scans[key];
      if (!scan || isSystemStale(scan)) {
        return { galaxy: g, system: s };
      }
    }
  }
  return null;
};

/**
 * Find the next colonization target in the local scan DB, respecting
 * the user's `colPositions` priority, the in-flight registry, and the
 * "prefer other galaxies first" toggle.
 *
 * Two-stage guard (copied verbatim from 4.x):
 *   1. `scan.positions[pos].status === 'empty'` — the game observed
 *      the slot empty (so `empty_sent` from prior fleets is filtered).
 *   2. `inFlight.has("g:s:pos")` — any entry in `registry` with
 *      `arrivalAt > now` blocks the same coord key. This is the
 *      second line of defence after `mergeScanResult`'s empty_sent
 *      preservation.
 *
 * Galaxy-order policy:
 *   - `preferOther=false` (default): [home, home+1, home-1, …]
 *   - `preferOther=true`: move home to the end — trades fast home
 *     sends for predictable min-gap timing across galaxies.
 *
 * Within a galaxy, the home galaxy is searched farthest-first (better
 * arrival spread), other galaxies are linear 1..499.
 *
 * @param {GalaxyScans} scans
 * @param {RegistryEntry[]} registry
 * @param {{ galaxy: number, system: number }} home
 * @param {number[]} targets  user's parsed `colPositions` list
 * @param {boolean} preferOther  move home galaxy to end of order
 * @returns {{ galaxy: number, system: number, position: number, link: string } | null}
 */
export const findNextColonizeTarget = (
  scans,
  registry,
  home,
  targets,
  preferOther,
) => {
  if (targets.length === 0) return null;

  const now = Date.now();
  const inFlight = new Set(
    registry.filter((r) => (r.arrivalAt || 0) > now).map((r) => r.coords),
  );

  let order = buildGalaxyOrder(home.galaxy, COL_MAX_GALAXY);
  if (preferOther && order.length > 1) {
    order = [...order.slice(1), order[0]];
  }

  for (const g of order) {
    // Home galaxy — farthest first; others — sequential 1..N.
    const systems =
      g === home.galaxy
        ? Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1).sort(
            (a, b) => sysDist(b, home.system) - sysDist(a, home.system),
          )
        : Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1);

    for (const s of systems) {
      const key = /** @type {`${number}:${number}`} */ (`${g}:${s}`);
      const scan = scans[key];
      if (!scan || !scan.positions) continue;
      for (const pos of targets) {
        const p = scan.positions[pos];
        if (!p || p.status !== 'empty') continue;
        const coordKey =
          /** @type {`${number}:${number}:${number}`} */ (`${g}:${s}:${pos}`);
        if (inFlight.has(coordKey)) continue;
        const base = location.href.split('?')[0];
        const link =
          base +
          `?page=ingame&component=fleetdispatch` +
          `&galaxy=${g}&system=${s}&position=${pos}` +
          `&type=1&mission=${MISSION_COLONIZE}&am208=1`;
        return { galaxy: g, system: s, position: pos, link };
      }
    }
  }
  return null;
};

// ─── Min-gap wait helper ────────────────────────────────────────────────────

/**
 * Compute the number of seconds we must wait before firing the current
 * fleetdispatch to keep min-gap with all pending colonize arrivals in
 * the registry. Zero = safe to send. Synchronous: reads
 * `#durationOneWay` from the DOM and the registry from
 * {@link registryStore}.
 *
 * Mirror of 4.x's `mobile.js:getColonizeWaitTime`, consolidated around
 * the pure {@link findConflict} helper. The strict "< minGap" semantics
 * are what findConflict already enforces — so this wrapper only has to
 * handle the DOM parsing and the final seconds-to-wait math.
 *
 * @returns {number} whole seconds to wait (`Math.ceil`), 0 when safe.
 */
const getColonizeWaitTime = () => {
  const durEl = document.getElementById('durationOneWay');
  if (!durEl) return 0;
  const parts = (durEl.textContent ?? '').trim().split(':').map(Number);
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0;
  let durSec = 0;
  if (parts.length === 3) {
    durSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 4) {
    durSec = parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  }
  if (!durSec) return 0;

  const now = Date.now();
  const ourArrival = now + durSec * 1000;
  const minGapMs = settingsStore.get().colMinGap * 1000;
  const registry = registryStore.get();
  const conflict = findConflict(registry, ourArrival, minGapMs);

  // Opt-in diagnostic (4.9.4 port). Flip `localStorage.oge5_debugMinGap
  // = 'true'` in DevTools and the next Send click logs every input the
  // calculation used. Useful when the user reports "min-gap didn't
  // block even though arrivals coincided" — usually turns out to be a
  // registry entry with a malformed arrivalAt, a stale entry that
  // should have been pruned, or a durationOneWay that parsed to 0.
  if (safeLS.bool('oge5_debugMinGap', false)) {
    const pending = registry
      .filter((r) => (Number(r.arrivalAt) || 0) > now)
      .map((r) => ({ coords: r.coords, arrivalAt: r.arrivalAt }));
    // eslint-disable-next-line no-console
    console.debug('[OG-E min-gap]', {
      durationSec: durSec,
      ourArrival,
      minGapMs,
      pending,
      conflict,
      resultWaitSec: conflict
        ? Math.max(
          0,
          Math.ceil((minGapMs - Math.abs(Number(conflict.arrivalAt) - ourArrival)) / 1000),
        )
        : 0,
    });
  }

  if (!conflict) return 0;
  const gap = Math.abs((Number(conflict.arrivalAt) || 0) - ourArrival);
  const waitMs = minGapMs - gap;
  if (waitMs <= 0) return 0;
  return Math.ceil(waitMs / 1000);
};

// ─── DOM helpers ────────────────────────────────────────────────────────────

/**
 * Read the active planet's coords from `#planetList .hightlightPlanet`
 * (note the game's CSS-class typo). Returns `null` on a page that
 * doesn't carry the planet list (unexpected — we gracefully bail).
 *
 * @returns {{ galaxy: number, system: number } | null}
 */
const readHomePlanet = () => {
  const active = document.querySelector('#planetList .hightlightPlanet');
  if (!active) return null;
  const coords = active.querySelector('.planet-koords')?.textContent?.trim();
  const m = (coords || '').match(/\[(\d+):(\d+):(\d+)\]/);
  if (!m) return null;
  return { galaxy: parseInt(m[1], 10), system: parseInt(m[2], 10) };
};

/**
 * Read the galaxy view's current `(galaxy, system)` from
 * `location.search` when the user is on it, otherwise `null`.
 *
 * @returns {{ galaxy: number, system: number } | null}
 */
const parseCurrentGalaxyView = () => {
  if (!location.search.includes('component=galaxy')) return null;
  // Prefer the live form inputs over location.search. After AGR's
  // in-page submit (`navigateGalaxyInPage`) the URL stays at the
  // initial-load coords, but the input values track every subsequent
  // scan target. Reading the URL here meant the second + later scan
  // clicks all picked up the same stale starting point and looped.
  const galInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('galaxy_input')
  );
  const sysInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('system_input')
  );
  const inputG = galInput ? parseInt(galInput.value, 10) : NaN;
  const inputS = sysInput ? parseInt(sysInput.value, 10) : NaN;
  if (Number.isFinite(inputG) && Number.isFinite(inputS)) {
    return { galaxy: inputG, system: inputS };
  }
  // Fallback to URL — covers the very first scan, before AGR has had
  // a chance to render the form inputs.
  const params = new URLSearchParams(location.search);
  const g = parseInt(params.get('galaxy') ?? '', 10);
  const s = parseInt(params.get('system') ?? '', 10);
  if (!Number.isFinite(g) || !Number.isFinite(s)) return null;
  return { galaxy: g, system: s };
};

/**
 * Look up the current send / scan halves by DOM id. Returns `null`
 * for either slot when the button isn't mounted — every caller
 * tolerates that by no-op'ing.
 *
 * @returns {{ send: HTMLButtonElement | null, scan: HTMLButtonElement | null, wrap: HTMLElement | null }}
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
 * Paint a label on the send half. No-op when the button isn't mounted.
 *
 * @param {string} text
 * @param {string} [bg] CSS background. Defaults to keeping current.
 * @returns {void}
 */
const setSendLabel = (text, bg) => {
  const { send } = getHalves();
  if (!send) return;
  send.textContent = text;
  if (bg) send.style.background = bg;
};

/**
 * Two-line variant: small caption on top, big primary text underneath.
 * Built with two `<div>`s inside a flex column so line wrap is
 * deterministic regardless of the half's font-size and avoids the
 * old "Stale [g:s:p] — click Send to check system" overflow on
 * narrow buttons.
 *
 * The small line is sized at 0.5em of the half's base font and lightly
 * faded — enough to read but visually subordinate to the coords. The
 * big line keeps the half's full font-size.
 *
 * @param {string} small Top caption ("Send Colony", "Ready!", ...).
 * @param {string} big   Bottom text, typically `"[g:s:p]"`.
 * @param {string} [bg]  Optional background colour.
 * @returns {void}
 */
const setSendLabelTwo = (small, big, bg) => {
  const { send } = getHalves();
  if (!send) return;
  send.textContent = '';
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;'
    + 'justify-content:center;line-height:1.05;width:100%;';
  if (small) {
    const top = document.createElement('div');
    top.textContent = small;
    top.style.cssText = 'font-size:0.5em;opacity:0.85;letter-spacing:0.5px;';
    wrap.appendChild(top);
  }
  if (big) {
    const bottom = document.createElement('div');
    bottom.textContent = big;
    bottom.style.cssText = 'font-size:1em;margin-top:2px;';
    wrap.appendChild(bottom);
  }
  send.appendChild(wrap);
  if (bg) send.style.background = bg;
};

/**
 * Re-entry guard for {@link handleScanClick}. Flipped `true` when we
 * fire an in-page galaxy submit and wait for the `oge5:galaxyScanned`
 * event (or the safety-net timeout) to release it. Prevents a user
 * spamming the button from queueing multiple AGR form submits, which
 * in the worst case could trip rate limits or leave the scansStore
 * out of sync with the current view.
 */
let scanBusy = false;

/**
 * Safety-net timer for {@link scanBusy}. If `oge5:galaxyScanned` never
 * fires (no network, AGR swapped out its submit handler, ...), the
 * timer unlocks the button so the user isn't stuck staring at a greyed
 * control. 10 s matches the AGR-readiness timeouts elsewhere.
 *
 * @type {ReturnType<typeof setTimeout> | null}
 */
let scanUnlockTimer = null;

const SCAN_UNLOCK_TIMEOUT_MS = 10_000;

const lockScanHalf = () => {
  scanBusy = true;
  const { scan } = getHalves();
  if (scan) scan.style.opacity = '0.5';
};

const unlockScanHalf = () => {
  scanBusy = false;
  if (scanUnlockTimer) {
    clearTimeout(scanUnlockTimer);
    scanUnlockTimer = null;
  }
  const { scan } = getHalves();
  if (scan) scan.style.opacity = '1';
};

/**
 * Paint a label on the scan half. No-op when the button isn't mounted.
 *
 * @param {string} text
 * @param {string} [bg] CSS background. Defaults to keeping current.
 * @returns {void}
 */
const setScanLabel = (text, bg) => {
  const { scan } = getHalves();
  if (!scan) return;
  scan.textContent = text;
  if (bg) scan.style.background = bg;
};

/**
 * Synthesize `Enter` on `document.activeElement` so OGame's own
 * fleetdispatch form submits. Copy of `sendExp.dispatchEnter`.
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

/**
 * Remove the button container (and therefore both halves) from the
 * document if present. Safe to call unmounted.
 *
 * @returns {void}
 */
const removeButton = () => {
  const el = document.getElementById(BUTTON_ID);
  if (el) el.remove();
};

// ─── Button rendering ───────────────────────────────────────────────────────

/**
 * Apply the split-circle styles to `wrap` and both halves. Split out
 * so install can call it on fresh mount and later size updates can
 * re-apply the diameter-specific bits in place.
 *
 * @param {HTMLElement} wrap
 * @param {HTMLButtonElement} sendHalf
 * @param {HTMLButtonElement} scanHalf
 * @param {number} size  current diameter in px
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
 * Create the wrapper `<div>` plus the two `<button>` halves. Returns
 * the handles so callers can wire behaviour. Does NOT attach to the
 * DOM — the install function does that after positioning.
 *
 * @param {number} size
 * @returns {{
 *   wrap: HTMLDivElement,
 *   sendHalf: HTMLButtonElement,
 *   scanHalf: HTMLButtonElement,
 * }}
 */
const createButton = (size) => {
  const wrap = document.createElement('div');
  wrap.id = BUTTON_ID;

  const sendHalf = document.createElement('button');
  sendHalf.type = 'button';
  sendHalf.id = SEND_HALF_ID;
  sendHalf.className = 'oge5-col-half oge5-col-send';
  sendHalf.tabIndex = 0;
  sendHalf.setAttribute('aria-label', 'Send colonization');
  sendHalf.textContent = LABEL_SEND_IDLE;

  const scanHalf = document.createElement('button');
  scanHalf.type = 'button';
  scanHalf.id = SCAN_HALF_ID;
  scanHalf.className = 'oge5-col-half oge5-col-scan';
  scanHalf.tabIndex = 0;
  scanHalf.setAttribute('aria-label', 'Scan next system');
  scanHalf.textContent = LABEL_SCAN_IDLE;

  applyStyles(wrap, sendHalf, scanHalf, size);

  wrap.appendChild(sendHalf);
  wrap.appendChild(scanHalf);
  return { wrap, sendHalf, scanHalf };
};

// ─── Click handlers ─────────────────────────────────────────────────────────

/**
 * Module-scope min-gap countdown timer handle. Cleared on dispose,
 * on successful send, and on fresh arm (we never run two at once).
 *
 * @type {ReturnType<typeof setInterval> | null}
 */
let colWaitInterval = null;

/**
 * Stuck-protection timer for `pendingColVerify`. Started when we paint
 * the "Checking [coords]…" label on a fleetdispatch page; cancelled
 * when the matching `oge5:checkTargetResult` arrives. If it fires the
 * label flips to a recoverable "Timeout" state and we arm the
 * navigation-to-galaxy stale retry so the user can press Send again
 * to refresh reality.
 *
 * @type {ReturnType<typeof setTimeout> | null}
 */
let checkTargetWatchdog = null;

/** How long to wait for a matching checkTargetResult before giving up. */
const CHECK_TARGET_TIMEOUT_MS = 15_000;

/**
 * Set when the last checkTarget came back with error 140035
 * ("no colonization ship"). Locks the send half — clicking Send again
 * would just fire another identical XHR with the same failure, so we
 * no-op instead. Cleared on install (new content-script = fresh state)
 * and on every successful Ready.
 */
let noShipBlocked = false;

const clearCheckTargetWatchdog = () => {
  if (checkTargetWatchdog) {
    clearTimeout(checkTargetWatchdog);
    checkTargetWatchdog = null;
  }
};

/**
 * Arm the stuck-protection timer. After {@link CHECK_TARGET_TIMEOUT_MS}
 * with no matching `oge5:checkTargetResult`, paint a recoverable
 * timeout label and arm navigation-to-galaxy stale retry so the user
 * isn't trapped staring at "Checking…".
 *
 * @param {{ galaxy: number, system: number, position: number }} verify
 */
const armCheckTargetWatchdog = (verify) => {
  clearCheckTargetWatchdog();
  checkTargetWatchdog = setTimeout(() => {
    checkTargetWatchdog = null;
    // If the verify slot is still pending, the game never responded
    // (rate-limited, network blip, AGR ate the XHR, …). Move the user
    // out of the dead-end state and into stale-retry so the next
    // Send click navigates to the system's galaxy view.
    const ui = uiState.get();
    if (!ui.pendingColVerify) return;
    if (
      ui.pendingColVerify.galaxy !== verify.galaxy ||
      ui.pendingColVerify.system !== verify.system ||
      ui.pendingColVerify.position !== verify.position
    ) return;
    setSendLabelTwo(
      'Timeout',
      `[${verify.galaxy}:${verify.system}:${verify.position}]`,
      BG_SEND_STALE,
    );
    uiState.update((s) => ({
      ...s,
      pendingColVerify: null,
      staleRetryActive: true,
      staleTargetCoords: { galaxy: verify.galaxy, system: verify.system },
    }));
  }, CHECK_TARGET_TIMEOUT_MS);
};

/**
 * DESIGN.md §9.2 stale-retry: take the user to the stale system's
 * galaxy view via a single full-page navigation. The game then fires
 * its own `fetchGalaxyContent` for that system, our `galaxyHook`
 * captures the payload, and `scansStore` learns the real state of
 * every slot (reserved / inactive / mine / occupied / …). The user
 * sees the galaxy view and picks what to do next.
 *
 * Strict 1:1: user's Send click → our location.href assignment →
 * game's own XHR. No automated chain, no form-swap gymnastics.
 *
 * `staleRetryActive` is disarmed here so a double-tap during the
 * in-flight nav doesn't try to navigate twice.
 *
 * @returns {void}
 */
const navigateToStaleSystem = () => {
  const ui = uiState.get();
  const coords = ui.staleTargetCoords;
  uiState.update((s) => ({
    ...s,
    staleRetryActive: false,
    staleTargetCoords: null,
  }));
  if (!coords) {
    setSendLabel('No stale target', BG_SEND_ERROR);
    return;
  }
  const base = location.href.split('?')[0];
  location.href =
    base +
    `?page=ingame&component=galaxy&galaxy=${coords.galaxy}&system=${coords.system}`;
};

/**
 * Legacy 4.7.x stale-retry path — kept as dead code for reference
 * only. DO NOT call from production code. The form-swap approach has
 * a documented "Checking... stuck" failure mode that
 * {@link navigateToStaleSystem} replaces. Left here so future readers
 * looking for "why did we change stale-retry" have the old code in
 * one commit's blame.
 *
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
const retryWithNextCandidate = () => {
  uiState.update((s) => ({ ...s, staleRetryActive: false }));
  setSendLabel('Searching…', BG_SEND_STALE);

  const home = readHomePlanet();
  if (!home) {
    setSendLabel('No home planet', BG_SEND_ERROR);
    return;
  }
  const settings = settingsStore.get();
  const targets = parsePositions(settings.colPositions);
  const target = findNextColonizeTarget(
    scansStore.get(),
    registryStore.get(),
    home,
    targets,
    settings.colPreferOtherGalaxies,
  );
  if (!target) {
    setSendLabel('No candidates', BG_SEND_ERROR);
    return;
  }

  /** @param {string} name */
  const findInput = (name) =>
    document.getElementById(name) ||
    document.querySelector(`input[name="${name}"]`);
  const galInput = findInput('galaxy');
  const sysInput = findInput('system');
  const posInput = findInput('position');
  if (!galInput || !sysInput || !posInput) {
    setSendLabel('No form inputs', BG_SEND_ERROR);
    return;
  }

  /** @param {Element} el @param {number} v */
  const setField = (el, v) => {
    /** @type {HTMLInputElement} */ (el).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setField(galInput, target.galaxy);
  setField(sysInput, target.system);
  setField(posInput, target.position);

  uiState.update((s) => ({
    ...s,
    pendingColLink: target.link,
    pendingColVerify: {
      galaxy: target.galaxy,
      system: target.system,
      position: target.position,
    },
  }));
  setSendLabel(
    `Checking [${target.galaxy}:${target.system}:${target.position}]…`,
    BG_SEND_STALE,
  );
};

/**
 * Handle a click on the sendHalf. Dispatches based on the current
 * page + state — see file header state machine.
 *
 * @returns {void}
 */
const handleSendClick = () => {
  const settings = settingsStore.get();

  // Abandon mode: sendHalf is the "Too small!" info; no-op on click.
  if (checkAbandonState(settings)) return;

  const ui = uiState.get();
  const isFleet = location.search.includes('component=fleetdispatch');
  const isColMission = location.search.includes(
    `mission=${MISSION_COLONIZE}`,
  );

  if (isFleet && isColMission) {
    // Short-circuit on the no-ship lock (set by the checkTarget
    // reactor when error 140035 came back). Clicking would fire
    // another identical failing XHR — no-op instead.
    if (noShipBlocked) return;
    if (ui.staleRetryActive) {
      // DESIGN.md §9.2: stale retry navigates to the system's galaxy
      // view. One visible user click → one location.href → one game
      // fetchGalaxyContent → scansStore learns the real state (empty
      // / reserved / inactive / …) and the user sees what happened.
      // Mirror of v4 4.9.2. Replaced the form-swap retry, which had
      // a "Checking... stuck" failure mode when two consecutive
      // candidates were both stale.
      navigateToStaleSystem();
      return;
    }
    dispatchColonizeWithGapCheck();
    return;
  }

  // Outside fleetdispatch: search the DB, then GO — no intermediate
  // "Found! Go" label + a second user click. If we find a candidate,
  // stash `pendingColVerify` so the checkTarget listener on the
  // destination page can flip us to Ready/Stale, and navigate.
  const home = readHomePlanet();
  if (!home) return;
  const targets = parsePositions(settings.colPositions);
  const target = findNextColonizeTarget(
    scansStore.get(),
    registryStore.get(),
    home,
    targets,
    settings.colPreferOtherGalaxies,
  );
  if (target) {
    uiState.update((s) => ({
      ...s,
      pendingColLink: null,
      pendingColVerify: {
        galaxy: target.galaxy,
        system: target.system,
        position: target.position,
      },
    }));
    location.href = target.link;
    return;
  }
  // No candidate in the local DB → user still needs to scan first.
  // Hop onto galaxy view so the next Scan click has a live form to
  // submit; if already on galaxy view, say so plainly.
  setSendLabel('None available');
  if (!location.search.includes('component=galaxy')) {
    const base = location.href.split('?')[0];
    location.href = base + '?page=ingame&component=galaxy';
  }
};

/**
 * Handle a click on the scanHalf.
 *
 *   - Abandon mode → delegate to {@link abandonPlanet}.
 *   - Otherwise    → find next system to scan and either navigate to
 *                    its galaxy-view URL or (on the galaxy view) update
 *                    the galaxy/system inputs for an in-page navigation.
 *
 * @returns {void}
 */
const handleScanClick = () => {
  // Block re-entry while an in-page scan is still resolving. Without
  // this, a user spamming the button queues several AGR submits and
  // the scansStore ends up merging partial responses out of order.
  if (scanBusy) return;
  // Clear any no-ship lock — user is moving on to another candidate,
  // so the "click Send" path should work again at the next stop.
  noShipBlocked = false;

  const settings = settingsStore.get();
  if (checkAbandonState(settings)) {
    // Fire-and-forget; the abandon feature manages its own state.
    void abandonPlanet();
    return;
  }
  const home = readHomePlanet();
  if (!home) return;
  // Clear any leftover pendingColLink — user explicitly asked to scan.
  uiState.update((s) => ({ ...s, pendingColLink: null }));
  const currentView = parseCurrentGalaxyView();
  const next = findNextScanSystem(scansStore.get(), home, currentView);
  if (!next) {
    setScanLabel('All scanned!');
    return;
  }
  // Try the in-page form submit first (no full reload — much faster
  // and matches v4 UX). When the user IS on galaxy view, this runs
  // AGR's own submit handler, which fires `fetchGalaxyContent` so our
  // scansStore captures the new system. URL doesn't change, but
  // `#galaxy_input` / `#system_input` do — `parseCurrentGalaxyView`
  // reads from those first, so the next click sees fresh coords.
  if (currentView) {
    if (navigateGalaxyInPage(next.galaxy, next.system)) {
      // Lock until the galaxy event lands (or the safety timer fires).
      lockScanHalf();
      scanUnlockTimer = setTimeout(unlockScanHalf, SCAN_UNLOCK_TIMEOUT_MS);
      return;
    }
  }
  // Fallback: full nav. The page reload replaces this content script,
  // so we don't lock — the new instance starts with scanBusy=false.
  const base = location.href.split('?')[0];
  location.href =
    base +
    `?page=ingame&component=galaxy&galaxy=${next.galaxy}&system=${next.system}`;
};

/**
 * Try to update the galaxy-view form inputs for a fast in-page nav
 * (avoids a full page reload). Returns `true` when the submit button
 * was found and clicked; `false` when the caller should fall back to a
 * full `location.href =` navigation.
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

/**
 * The "I'm on fleetdispatch with mission=7" send path. Runs the
 * min-gap guard: if a conflict exists we paint "Wait Xs" and start a
 * 1-Hz countdown to "Dispatch!"; the user must click again to actually
 * fire. Otherwise we synthesize Enter immediately.
 *
 * @returns {void}
 */
const dispatchColonizeWithGapCheck = () => {
  const waitSec = getColonizeWaitTime();
  if (waitSec > 0) {
    setSendLabel(`Wait ${waitSec}s`, BG_SEND_WAIT);
    if (colWaitInterval) clearInterval(colWaitInterval);
    let remaining = waitSec;
    colWaitInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        if (colWaitInterval) clearInterval(colWaitInterval);
        colWaitInterval = null;
        setSendLabel(LABEL_DISPATCH, BG_SEND_READY);
      } else {
        setSendLabel(`Wait ${remaining}s`);
      }
    }, 1000);
    return;
  }
  dispatchEnter();
};

// ─── Event reactors ─────────────────────────────────────────────────────────

/**
 * React to `oge5:galaxyScanned`. After the MAIN-world galaxy hook
 * classifies a freshly scanned system, we scan the new positions for
 * a user-target and update the button labels:
 *
 *   - empty + canColonize     → "Found! Go" + stash pendingColLink
 *   - empty + NOT canColonize → "No ship!" (user has no colonizer)
 *   - no target empty         → revert to "Scan next"
 *
 * `e.detail` shape: `{ galaxy, system, positions, canColonize }` —
 * identical to the 4.x contract.
 *
 * @param {Event} e
 * @returns {void}
 */
const onGalaxyScanned = (e) => {
  const detail =
    /** @type {{ galaxy?: number, system?: number, positions?: Record<number, import('../domain/scans.js').Position>, canColonize?: boolean } | undefined} */ (
      /** @type {CustomEvent} */ (e).detail
    );
  if (!detail || !detail.positions) return;
  // A galaxy event means the in-page scan cycle resolved — release
  // the scan lock even when we don't know whether it was ours.
  unlockScanHalf();
  // Narrow via locals so every use below is a concrete `number`.
  // tsc doesn't propagate the optional-field guard through the
  // CustomEvent<T> cast when we dereference `detail.galaxy` directly.
  const { galaxy, system, canColonize, positions } = detail;
  if (typeof galaxy !== 'number' || typeof system !== 'number') return;
  if (!document.getElementById(BUTTON_ID)) return;

  const targets = parsePositions(settingsStore.get().colPositions);
  /** @type {number | null} */
  let foundPos = null;
  for (const pos of targets) {
    if (positions[pos]?.status === 'empty') {
      foundPos = pos;
      break;
    }
  }

  if (foundPos !== null && canColonize) {
    // Auto-navigate straight to fleetdispatch. The old "Found! Go"
    // label + a second user click was a needless two-step — we
    // already know the coords and the fleet is available, so just
    // take them there. Stashing `pendingColVerify` here means the
    // checkTarget listener can still paint Ready/Stale after the
    // page reload without the old `pendingColLink` round-trip.
    const base = location.href.split('?')[0];
    const link =
      base +
      `?page=ingame&component=fleetdispatch` +
      `&galaxy=${galaxy}&system=${system}` +
      `&position=${foundPos}&type=1&mission=${MISSION_COLONIZE}&am208=1`;
    uiState.update((s) => ({
      ...s,
      pendingColLink: null,
      pendingColVerify: { galaxy, system, position: foundPos },
    }));
    location.href = link;
    return;
  }
  // Empty target in THIS system but not auto-navigable (either
  // `canColonize === false`, meaning the scanning planet has no
  // colonizer right now, or the target picker rejected the pick
  // for some other reason). Show the coords on the Send label
  // anyway so the user sees what's queued — clicking Send takes
  // them to fleetdispatch, where `onCheckTargetResult` paints
  // "No ship!" / "Reserved" / "Stale" from the real checkTarget
  // response. No "No ship!" label here: the galaxy XHR's
  // `canColonize` reflects only the scanning planet's ship
  // inventory, which is the wrong context.
  if (foundPos !== null) {
    uiState.update((s) => ({ ...s, pendingColLink: null }));
    setSendLabelTwo(
      'Send Colony',
      `[${galaxy}:${system}:${foundPos}]`,
      BG_SEND_READY,
    );
    setScanLabel('Scan next');
    return;
  }

  // Nothing empty in this scan — fall back to whichever candidate
  // the scansStore has queued from prior scans. `refreshSendPreview`
  // handles the "nothing anywhere" case by painting plain idle.
  uiState.update((s) => ({ ...s, pendingColLink: null }));
  refreshSendPreview();
  setScanLabel('Scan next');
};

/**
 * Parse the `?galaxy=&system=&position=` triple out of the current
 * fleetdispatch URL. Returns `null` when we're not on fleetdispatch
 * or any coordinate is missing / non-numeric.
 *
 * Used by the install path to recover an implicit verify target when
 * the user landed on fleetdispatch through some path other than our
 * Send Col flow (manual URL, AGR menu, post-send game redirect, …).
 *
 * @returns {{ galaxy: number, system: number, position: number } | null}
 */
const parseFleetdispatchUrlCoords = () => {
  if (!location.search.includes('component=fleetdispatch')) return null;
  const params = new URLSearchParams(location.search);
  const g = parseInt(params.get('galaxy') ?? '', 10);
  const s = parseInt(params.get('system') ?? '', 10);
  const p = parseInt(params.get('position') ?? '', 10);
  if (!Number.isFinite(g) || !Number.isFinite(s) || !Number.isFinite(p)) {
    return null;
  }
  return { galaxy: g, system: s, position: p };
};

/**
 * Preview the next colonize candidate (from the scansStore + registry)
 * on the Send half as `"Send [g:s:p]"`. When there's no eligible
 * candidate at all the label falls back to the plain idle text.
 *
 * Called in three places:
 *   - `mount()` after install so the button comes up already showing
 *     the queued target.
 *   - `onGalaxyScanned()` after a scan so the label updates when a
 *     new empty slot appears in the DB.
 *   - settings subscriber reacts to colPositions / preferOtherGalaxies
 *     edits without a page reload.
 *
 * No-op on fleetdispatch — that page has its own label flow
 * ("Checking…" / "Ready!" / "Stale…"). Also no-op in abandon state,
 * which owns the "Too small!" label.
 *
 * @returns {void}
 */
const refreshSendPreview = () => {
  const isFleetCol =
    location.search.includes('component=fleetdispatch') &&
    location.search.includes(`mission=${MISSION_COLONIZE}`);
  if (isFleetCol) return;
  const settings = settingsStore.get();
  if (checkAbandonState(settings)) return;
  const home = readHomePlanet();
  if (!home) {
    setSendLabel(LABEL_SEND_IDLE, BG_SEND_IDLE);
    return;
  }
  const targets = parsePositions(settings.colPositions);
  const next = findNextColonizeTarget(
    scansStore.get(),
    registryStore.get(),
    home,
    targets,
    settings.colPreferOtherGalaxies,
  );
  if (next) {
    setSendLabelTwo(
      'Send Colony',
      `[${next.galaxy}:${next.system}:${next.position}]`,
      BG_SEND_READY,
    );
  } else {
    setSendLabel(LABEL_SEND_IDLE, BG_SEND_IDLE);
  }
};

/**
 * Mirror of 4.x's `markPositionAbandoned`. Write a single position as
 * `'abandoned'` in `scansStore` so the target picker stops proposing
 * it. No historyStore touch — the histogram wants to see abandoned
 * planets (see abandon.js file header for the 4.8.3 lesson).
 *
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @returns {void}
 */
const markPositionAbandoned = (galaxy, system, position) => {
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  scansStore.update((prev) => {
    const existing = prev[key] ?? {
      scannedAt: Date.now(),
      positions: {},
    };
    /** @type {Record<number, import('../domain/scans.js').Position>} */
    const newPositions = {
      ...existing.positions,
      [position]: {
        status: 'abandoned',
        flags: { hasAbandonedPlanet: true },
      },
    };
    return {
      ...prev,
      [key]: { scannedAt: Date.now(), positions: newPositions },
    };
  });
};

/**
 * Mark a single slot as `'reserved'` (planet-move by another player,
 * checkTarget error 140016). 4.9.2 semantics: distinct from abandoned
 * — no `hasAbandonedPlanet` flag, 24h rescan window so the slot
 * becomes available again after the DM cooldown.
 *
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @returns {void}
 */
const markPositionReserved = (galaxy, system, position) => {
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  scansStore.update((prev) => {
    const existing = prev[key] ?? {
      scannedAt: Date.now(),
      positions: {},
    };
    /** @type {Record<number, import('../domain/scans.js').Position>} */
    const newPositions = {
      ...existing.positions,
      [position]: { status: 'reserved' },
    };
    return {
      ...prev,
      [key]: { scannedAt: Date.now(), positions: newPositions },
    };
  });
};

/**
 * React to `oge5:checkTargetResult`. The event is fired every time the
 * game runs its own `checkTarget` XHR on the fleetdispatch page. We
 * only care when the coords match our `pendingColVerify` (i.e. the
 * user is verifying a target OUR flow pointed them at).
 *
 *   - `colonizable === true`  → clear verify, paint "Ready!".
 *   - otherwise              → mark the slot abandoned, arm
 *                               `staleRetryActive`, paint "Stale —
 *                               click Send".
 *
 * The caller (checkTargetHook) computes `colonizable` = `success &&
 * targetOk && orders[7] === true && !targetInhabited`; we consume the
 * field verbatim rather than re-deriving here.
 *
 * @param {Event} e
 * @returns {void}
 */
const onCheckTargetResult = (e) => {
  const detail =
    /** @type {{
     *   galaxy?: number, system?: number, position?: number,
     *   colonizable?: boolean, reserved?: boolean, noShip?: boolean,
     * } | undefined} */ (
      /** @type {CustomEvent} */ (e).detail
    );
  if (!detail) return;
  const { galaxy, system, position, colonizable, reserved, noShip } = detail;
  if (
    typeof galaxy !== 'number' ||
    typeof system !== 'number' ||
    typeof position !== 'number'
  ) {
    return;
  }

  const verify = uiState.get().pendingColVerify;
  if (!verify) return;
  if (
    verify.galaxy !== galaxy ||
    verify.system !== system ||
    verify.position !== position
  ) {
    return;
  }

  const coordLabel = `[${galaxy}:${system}:${position}]`;

  // Whatever the verdict, the game answered — release the watchdog.
  clearCheckTargetWatchdog();

  if (colonizable) {
    setSendLabelTwo('Ready!', coordLabel, BG_SEND_READY);
    // Fresh green light → clear any prior no-ship block so Send
    // works again for this new target.
    noShipBlocked = false;
    uiState.update((s) => ({
      ...s,
      pendingColVerify: null,
      staleRetryActive: false,
    }));
    return;
  }

  // "No ship!" — game refused the send with error 140035 ("no
  // colonization ship"). Not a stale target (destination is fine);
  // the fix is "build a colonizer". Paint the label and stop — no
  // stale-retry nav, no abandoned mark, so the slot stays in the
  // `empty` pool for when the user has ships again.
  //
  // Detected purely by error code so we don't depend on `orders`
  // being populated: OGame's failure response omits `orders`
  // entirely when it rejects on missing-ship grounds.
  if (noShip) {
    setSendLabelTwo('No ship!', coordLabel, BG_SEND_ERROR);
    // Lock the Send half — retrying just fires another failing
    // XHR, and the label would flicker every time. User should go
    // build a colonizer (or click Scan for a different target).
    noShipBlocked = true;
    uiState.update((s) => ({
      ...s,
      pendingColVerify: null,
      staleRetryActive: false,
    }));
    return;
  }

  // Reserved (planet-move, error 140016): the slot is held for ~22h
  // and no amount of retry will help until it frees up. Mark distinct
  // status + 24h rescan window; label calls it out so the user knows
  // this isn't the usual "player moved in" stale.
  if (reserved) {
    markPositionReserved(galaxy, system, position);
    setSendLabelTwo('Reserved', coordLabel, BG_SEND_STALE);
    uiState.update((s) => ({
      ...s,
      pendingColVerify: null,
      staleRetryActive: true,
      staleTargetCoords: { galaxy, system },
    }));
    return;
  }

  // Generic stale (player moved in, mission not available, ...).
  // Mark abandoned + arm navigation-to-galaxy retry so the user's
  // next Send click refreshes the whole system from the game.
  markPositionAbandoned(galaxy, system, position);
  setSendLabelTwo('Stale', coordLabel, BG_SEND_STALE);
  uiState.update((s) => ({
    ...s,
    pendingColVerify: null,
    staleRetryActive: true,
    staleTargetCoords: { galaxy, system },
  }));
};

/**
 * React to `oge5:colonizeSent` (dispatched by `sendFleetHook` in the
 * MAIN world after the game's own `sendFleet` XHR came back
 * `success: true` for a colonize mission).
 *
 * Two things happen here:
 *
 *   1. Mark the just-sent slot `'empty_sent'` in scansStore so
 *      `findNextColonizeTarget` won't re-pick it (matched against the
 *      pending registry in `mergeScanResult` — the registry entry was
 *      pre-written synchronously before the send by sendFleetHook).
 *   2. If `settings.autoRedirectColonize` is on, hop straight to the
 *      next colonize target. Mirrors the expedition-redirect UX:
 *      after a successful send the user usually wants to send the
 *      next one, not re-select it by hand. We wait one tick so the
 *      game's own post-send navigation flushes before we overwrite
 *      it (direct `location.href` during the response handler can
 *      race the game's redirect).
 *
 * @param {Event} e
 * @returns {void}
 */
const onColonizeSent = (e) => {
  const detail =
    /** @type {{ galaxy?: number, system?: number, position?: number } | undefined} */ (
      /** @type {CustomEvent} */ (e).detail
    );
  if (!detail) return;
  const { galaxy, system, position } = detail;
  if (
    typeof galaxy !== 'number' ||
    typeof system !== 'number' ||
    typeof position !== 'number'
  ) {
    return;
  }

  // Mark empty_sent so the slot filters out of the target picker
  // until the fleet either lands (scan will show `mine`) or fails
  // (auto-prune of the registry + re-scan will flip it back).
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

  if (!settingsStore.get().autoRedirectColonize) return;

  const home = readHomePlanet();
  if (!home) return;
  const settings = settingsStore.get();
  const targets = parsePositions(settings.colPositions);
  const next = findNextColonizeTarget(
    scansStore.get(),
    registryStore.get(),
    home,
    targets,
    settings.colPreferOtherGalaxies,
  );
  if (!next) return;

  // Defer one tick: the game's post-send navigation (its own
  // redirectUrl) happens a moment after our event fires. Setting
  // location.href now would race that nav and could be preempted.
  // A small setTimeout lets the game flush first; ours lands second
  // and wins.
  setTimeout(() => {
    uiState.update((s) => ({
      ...s,
      pendingColVerify: {
        galaxy: next.galaxy,
        system: next.system,
        position: next.position,
      },
    }));
    location.href = next.link;
  }, 100);
};

// ─── Install / dispose ──────────────────────────────────────────────────────

/**
 * Module-scope install handle. Identical pattern to sendExp.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the split-button colonize helper. Idempotent.
 *
 * Lifecycle:
 *   1. If `settings.colonizeMode === false` we skip DOM work entirely
 *      but still subscribe to settings — a later flip to `true`
 *      creates the button live.
 *   2. Renders the `<div id="oge5-send-col">` + two halves. Position
 *      from `oge5_colBtnPos` or bottom-right default. Drag, focus,
 *      and click wiring attached.
 *   3. Installs document-level listeners for `oge5:galaxyScanned` and
 *      `oge5:checkTargetResult`.
 *   4. Returns a dispose fn that removes button, unsubs settings,
 *      removes event listeners, and cancels any pending countdown.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSendCol = () => {
  if (installed) return installed.dispose;

  /**
   * Wire touch + mouse drag on `wrap`, plus the click listeners on the
   * two halves. The click handler consults `hasMoved` so a drag
   * terminating on a half doesn't double-fire as a click.
   *
   * @param {HTMLElement} wrap
   * @param {HTMLButtonElement} sendHalf
   * @param {HTMLButtonElement} scanHalf
   * @param {number} size
   * @returns {void}
   */
  const installDragAndClick = (wrap, sendHalf, scanHalf, size) => {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    /** @param {number} cx @param {number} cy */
    const onStart = (cx, cy) => {
      isDragging = true;
      hasMoved = false;
      startX = cx;
      startY = cy;
      const r = wrap.getBoundingClientRect();
      startLeft = r.left;
      startTop = r.top;
    };

    /** @param {number} cx @param {number} cy */
    const onMove = (cx, cy) => {
      if (!isDragging) return;
      const dx = cx - startX;
      const dy = cy - startY;
      if (
        !hasMoved &&
        Math.abs(dx) < DRAG_THRESHOLD &&
        Math.abs(dy) < DRAG_THRESHOLD
      ) {
        return;
      }
      hasMoved = true;
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
      const newX = Math.max(
        0,
        Math.min(startLeft + dx, window.innerWidth - size),
      );
      const newY = Math.max(
        0,
        Math.min(startTop + dy, window.innerHeight - size),
      );
      wrap.style.left = newX + 'px';
      wrap.style.top = newY + 'px';
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      if (hasMoved) {
        safeLS.setJSON(POS_KEY, {
          x: parseInt(wrap.style.left, 10),
          y: parseInt(wrap.style.top, 10),
        });
      }
    };

    wrap.addEventListener(
      'touchstart',
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        onStart(t.clientX, t.clientY);
      },
      { passive: true },
    );
    wrap.addEventListener(
      'touchmove',
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        onMove(t.clientX, t.clientY);
        if (hasMoved) e.preventDefault();
      },
      { passive: false },
    );
    wrap.addEventListener('touchend', () => {
      onEnd();
    });
    wrap.addEventListener('mousedown', (e) => {
      onStart(e.clientX, e.clientY);
      /** @param {MouseEvent} ev */
      const mv = (ev) => onMove(ev.clientX, ev.clientY);
      const up = () => {
        onEnd();
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    sendHalf.addEventListener('click', (e) => {
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      e.stopPropagation();
      handleSendClick();
    });
    scanHalf.addEventListener('click', (e) => {
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      e.stopPropagation();
      handleScanClick();
    });
  };

  /**
   * Focus-persistence wiring: write the half's tag to `FOCUS_KEY` on
   * focus, clear on blur iff we're the current owner, and — if the
   * saved tag matches one of our halves at install time — restore
   * focus 50 ms later.
   *
   * @param {HTMLButtonElement} sendHalf
   * @param {HTMLButtonElement} scanHalf
   * @returns {void}
   */
  const installFocusPersist = (sendHalf, scanHalf) => {
    sendHalf.addEventListener('focus', () =>
      safeLS.set(FOCUS_KEY, FOCUS_SEND),
    );
    sendHalf.addEventListener('blur', () => {
      if (safeLS.get(FOCUS_KEY) === FOCUS_SEND) safeLS.remove(FOCUS_KEY);
    });
    scanHalf.addEventListener('focus', () =>
      safeLS.set(FOCUS_KEY, FOCUS_SCAN),
    );
    scanHalf.addEventListener('blur', () => {
      if (safeLS.get(FOCUS_KEY) === FOCUS_SCAN) safeLS.remove(FOCUS_KEY);
    });
    const current = safeLS.get(FOCUS_KEY);
    if (current === FOCUS_SEND) {
      setTimeout(() => sendHalf.focus(), FOCUS_RESTORE_DELAY_MS);
    } else if (current === FOCUS_SCAN) {
      setTimeout(() => scanHalf.focus(), FOCUS_RESTORE_DELAY_MS);
    }
  };

  /**
   * Position + paint context-aware labels on the freshly mounted
   * button, taking current page / abandon-state into account.
   *
   * @param {HTMLElement} wrap
   * @param {HTMLButtonElement} sendHalf
   * @param {HTMLButtonElement} scanHalf
   * @param {number} size
   * @returns {void}
   */
  const positionAndLabel = (wrap, sendHalf, scanHalf, size) => {
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

    const settings = settingsStore.get();
    const abandonInfo = checkAbandonState(settings);
    const isFleetCol =
      location.search.includes('component=fleetdispatch') &&
      location.search.includes(`mission=${MISSION_COLONIZE}`);

    if (abandonInfo) {
      sendHalf.textContent = `Too small! (${abandonInfo.max})`;
      sendHalf.style.background = BG_SEND_ERROR;
      scanHalf.textContent = 'Abandon';
      scanHalf.style.background = BG_SCAN_ABANDON;
    } else if (isFleetCol) {
      // Show the coords we just redirected to so the user can see
      // WHICH slot they're about to send to, not just "Dispatch".
      // v4 parity — the per-slot label was in `mobile.js` too.
      //
      // Recover an implicit verify target from the URL when the user
      // landed here without going through our Send flow (manual URL,
      // AGR menu, page reload after send, …). The game itself fires
      // checkTarget on initial fleetdispatch load if the URL carries
      // coords — we simply hold the watchdog and listen for the
      // result so the label transitions Checking → Ready/No ship/
      // Stale/Reserved instead of staying on a generic "Dispatch!".
      let verify = uiState.get().pendingColVerify;
      if (!verify) {
        const urlCoords = parseFleetdispatchUrlCoords();
        if (urlCoords) {
          verify = urlCoords;
          uiState.update((s) => ({ ...s, pendingColVerify: urlCoords }));
        }
      }
      if (verify) {
        // Two-line: "Checking" / "[g:s:p]" so the coords don't get
        // truncated even at the smallest button sizes.
        sendHalf.textContent = '';
        const wrap = document.createElement('div');
        wrap.style.cssText =
          'display:flex;flex-direction:column;align-items:center;'
          + 'justify-content:center;line-height:1.05;width:100%;';
        const top = document.createElement('div');
        top.textContent = 'Checking…';
        top.style.cssText = 'font-size:0.5em;opacity:0.85;letter-spacing:0.5px;';
        const bottom = document.createElement('div');
        bottom.textContent = `[${verify.galaxy}:${verify.system}:${verify.position}]`;
        bottom.style.cssText = 'font-size:1em;margin-top:2px;';
        wrap.appendChild(top);
        wrap.appendChild(bottom);
        sendHalf.appendChild(wrap);
        sendHalf.style.background = BG_SEND_STALE;
        // Arm the stuck-protection watchdog. If checkTarget never
        // comes back (rate limit, AGR oddity, …) we still recover.
        armCheckTargetWatchdog(verify);
      } else {
        sendHalf.textContent = LABEL_DISPATCH;
        sendHalf.style.background = BG_SEND_READY;
      }
      scanHalf.textContent = LABEL_SCAN_SKIP;
    }
  };

  /**
   * Create + mount the button. Idempotent (no-op when already present).
   *
   * @returns {void}
   */
  const mount = () => {
    if (document.getElementById(BUTTON_ID)) return;
    const size = settingsStore.get().colBtnSize;
    const { wrap, sendHalf, scanHalf } = createButton(size);
    positionAndLabel(wrap, sendHalf, scanHalf, size);
    document.body.appendChild(wrap);
    // After the button is in the DOM, preview the queued candidate
    // on the Send label. `positionAndLabel` only handles the broad
    // "fleet-dispatch" / "abandon" / "idle" branches — this one adds
    // the per-candidate coordinate preview for the idle case.
    refreshSendPreview();
    installDragAndClick(wrap, sendHalf, scanHalf, size);
    installFocusPersist(sendHalf, scanHalf);
  };

  /**
   * Live-resize the currently mounted button.
   *
   * @param {number} size
   * @returns {void}
   */
  const updateButtonSize = (size) => {
    const { wrap, send, scan } = getHalves();
    if (!wrap || !send || !scan) return;
    applyStyles(wrap, send, scan, size);
  };

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

  // React to settings changes — visibility + size.
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
  });

  // Event reactors attach at document level — they fire across page
  // transitions and we want them live for the whole install span.
  document.addEventListener('oge5:galaxyScanned', onGalaxyScanned);
  document.addEventListener('oge5:checkTargetResult', onCheckTargetResult);
  document.addEventListener('oge5:colonizeSent', onColonizeSent);

  installed = {
    dispose: () => {
      if (colWaitInterval) {
        clearInterval(colWaitInterval);
        colWaitInterval = null;
      }
      clearCheckTargetWatchdog();
      // Also clear the scan-half lock so a fresh install (e.g. after
      // a settings toggle removed and re-mounted us) doesn't inherit
      // a busy=true that no event will ever release.
      if (scanUnlockTimer) {
        clearTimeout(scanUnlockTimer);
        scanUnlockTimer = null;
      }
      scanBusy = false;
      noShipBlocked = false;
      removeButton();
      unsubSettings();
      document.removeEventListener('oge5:galaxyScanned', onGalaxyScanned);
      document.removeEventListener(
        'oge5:checkTargetResult',
        onCheckTargetResult,
      );
      document.removeEventListener('oge5:colonizeSent', onColonizeSent);
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset of the module-scope install handle. Runs dispose
 * first so DOM + subscriptions don't leak across cases.
 *
 * @returns {void}
 */
export const _resetSendColForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  if (colWaitInterval) {
    clearInterval(colWaitInterval);
    colWaitInterval = null;
  }
};
