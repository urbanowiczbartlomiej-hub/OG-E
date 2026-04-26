// @ts-check

// Pure helpers + constants for sendExp. The orchestrator (`./index.js`)
// consumes these for its initial-label decision, the global-cap gates,
// the URL builder, and the various visual constants.
//
// # Why this split exists
//
// `./index.js` mixes lifecycle (mount/dispose, settings subscription,
// AGR-routine polling) with DOM readers and the click-handler state
// machine. Pulling the truly-pure bits — constants and pure decision
// functions that take their inputs explicitly — into this file keeps
// `index.js` focused on side effects and gives tests a small, mock-free
// surface for the decision functions.
//
// Mirrors the layout of `features/sendCol/{pure,domHelpers}.js`, with
// one less file because sendExp's DOM readers are tightly coupled to
// the orchestrator's settings reads and live there instead.
//
// # What this file does NOT own
//
// No DOM reads, no DOM writes, no timers, no event listeners, no
// module-local mutable state. Every export is a constant or a pure
// function whose only external read is `location.href` (URL builder).
// If you find yourself wanting to import `document` / `window` /
// `settingsStore` here, STOP — that belongs in `./index.js`.
//
// @see ./index.js — orchestrator that consumes this.

/**
 * @typedef {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 */

// ─── DOM ids / storage keys ──────────────────────────────────────────

/**
 * DOM id of the floating button. Stable so repeated mount calls
 * short-circuit, and so tests / CSS overrides can target it.
 */
export const BUTTON_ID = 'oge-send-exp';

/**
 * localStorage key — holds the id of whichever of our buttons was last
 * focused. Currently only {@link FOCUS_VALUE} ever lands here, but the
 * value string is namespaced (e.g. `'send-exp'`) so additional buttons
 * can share this key without collision.
 */
export const FOCUS_KEY = 'oge_focusedBtn';

/** Focus-persist value written/read by this feature. */
export const FOCUS_VALUE = 'send-exp';

/** localStorage key — holds `{ x: number, y: number }` dragged position. */
export const POS_KEY = 'oge_enterBtnPos';

// ─── Visual / interaction constants ──────────────────────────────────

/**
 * Movement threshold in pixels before a pointer gesture counts as a
 * drag. Anything below this (jitter from thumb contact, touch-start
 * micro-moves) still fires as a click.
 */
export const DRAG_THRESHOLD = 8;

/**
 * How long the "All maxed!" warning label stays on the button when the
 * click handler bails due to the per-planet cap. 2 s is long enough to
 * read, short enough that a user retrying immediately after adding
 * a slot is not interrupted.
 */
export const MAX_LABEL_MS = 2000;

/**
 * Timeout for waiting on AGR's routine element / fleet panel hydration.
 * 15 s is long enough for a slow phone on a cold cache to receive the
 * async fleet-panel assets, short enough that an obviously-broken page
 * doesn't lock the button forever.
 */
export const POLL_TIMEOUT_MS = 15_000;

/** Poll interval for AGR-readiness checks. */
export const POLL_INTERVAL_MS = 300;

/** Default offset from the bottom-right corner when no saved pos. */
export const DEFAULT_EDGE_OFFSET_PX = 20;

/** Delay before restoring focus on install. */
export const FOCUS_RESTORE_DELAY_MS = 50;

/**
 * Safety fallback for the eventbox-readiness gate (fleetdispatch only).
 * If `oge:eventBoxLoaded` hasn't arrived within this window — a missed
 * XHR (run_at race, future OGame URL change, ...) — the button activates
 * anyway. The gate's only purpose is to swallow taps in the very first
 * moment after a fleetdispatch nav lands; a missed XHR here is much
 * less costly than blocking the user's normal flow. The window.load
 * listener is the primary fallback (fires reliably right after the
 * page settles); this constant is the worst-case backstop.
 */
export const EVENTBOX_SAFETY_TIMEOUT_MS = 1200;

/**
 * How long the transient "Loading..." cue stays on the button when the
 * user clicks before the eventbox-readiness gate opens. Short enough
 * that it doesn't outlast a missed-XHR safety window — once the gate
 * opens, the button must be ready to accept the very next tap.
 */
export const EVENTBOX_LOADING_LABEL_MS = 400;

// ─── Button copy ─────────────────────────────────────────────────────

/** Default button copy — what the user sees in the "idle" state. */
export const BUTTON_TEXT = 'Send Exp';

/** Transient copy when every planet has hit `maxExpPerPlanet`. */
export const ALL_MAXED_LABEL = 'All maxed!';

// ─── Background colors ───────────────────────────────────────────────

/** Background color for the idle button (blue, translucent). */
export const BG_IDLE = 'rgba(0,150,255,0.7)';

/** Background color for the "All maxed!" state (amber, more opaque). */
export const BG_MAX = 'rgba(200,150,0,0.85)';

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * Strip the surrounding `[` and `]` from a coords string. OGame renders
 * both `.planet-koords` (planet list) and `.coordsOrigin` (event row)
 * with the brackets — stripping them once gives a consistent `g:s:p`
 * key usable for equality comparison across the two lookups.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export const stripBrackets = (raw) => (raw ?? '').trim().replace(/^\[|]$/g, '');

/**
 * Build a fleetdispatch URL pointing at the given `cp`. No `mission`
 * param — AGR's own expedition routine sets the mission when the user
 * taps it on the fleetdispatch page, so baking `mission=15` into the
 * URL here would be redundant and would miss the case where the user
 * lands on fleetdispatch through our redirect and then changes AGR's
 * selection.
 *
 * Base is derived from `location.href` so we stay on the origin/path
 * the game served; the query tail is dropped to avoid leaking stale
 * params (old `position=`, `mission=`) into the navigation.
 *
 * @param {number} cp
 * @returns {string}
 */
export const buildFleetdispatchUrl = (cp) => {
  const base = location.href.split('?')[0];
  return `${base}?page=ingame&component=fleetdispatch&cp=${cp}`;
};

/**
 * Pure: snapshot reports every expedition slot in use
 * (`expeditionCount >= maxExpeditionCount`, e.g. 14/14)? `null` snapshot
 * returns `false` — the gate is opt-in via the bridge populating it.
 *
 * `maxExpeditionCount > 0` guards against an uninitialised snapshot
 * where both numbers are 0 (technically `0 >= 0` would otherwise report
 * max reached, which is wrong).
 *
 * @param {FleetDispatcherSnapshot | null} snapshot
 * @returns {boolean}
 */
export const isGlobalExpeditionCapReached = (snapshot) => {
  if (!snapshot) return false;
  return (
    snapshot.maxExpeditionCount > 0 &&
    snapshot.expeditionCount >= snapshot.maxExpeditionCount
  );
};

/**
 * Pure: snapshot reports we're one send away from the cap
 * (`expeditionCount >= maxExpeditionCount - 1`, e.g. 13/14)? Used after
 * a successful Phase 1 send to skip the post-send auto-redirect: if
 * this send makes us 14/14, there's no point walking to another
 * planet — every planet will then report full once the send lands and
 * the game refreshes its counts.
 *
 * @param {FleetDispatcherSnapshot | null} snapshot
 * @returns {boolean}
 */
export const isGlobalExpeditionCapReachedAfterNextSend = (snapshot) => {
  if (!snapshot) return false;
  return (
    snapshot.maxExpeditionCount > 0 &&
    snapshot.expeditionCount >= snapshot.maxExpeditionCount - 1
  );
};

/**
 * Inputs to {@link computeInitialLabel}. The orchestrator's mount path
 * reads the live page; tests pass the booleans explicitly.
 *
 * @typedef {object} InitialLabelEnv
 * @property {string} search `location.search` (raw, including leading `?`).
 * @property {boolean} hasDispatchFleet `document.getElementById('dispatchFleet')` returned non-null.
 * @property {boolean} hasAgoRoutine7 `document.getElementById('ago_routine_7')` returned non-null.
 */

/**
 * Pure: pick the right initial label for the floating button based on
 * the page state at render time:
 *
 *   - On fleetdispatch with `#dispatchFleet` already in the DOM →
 *     "Send!" (user's next tap fires the send).
 *   - On fleetdispatch with `#ago_routine_7` but no dispatch button →
 *     "Prepare" (user's next tap kicks AGR's routine).
 *   - Otherwise → the default {@link BUTTON_TEXT} ("Send Exp").
 *
 * Snapshot only — the button is recreated on every page reload anyway,
 * so we don't need a live update path.
 *
 * @param {InitialLabelEnv} env
 * @returns {string}
 */
export const computeInitialLabel = (env) => {
  if (!env.search.includes('component=fleetdispatch')) return BUTTON_TEXT;
  if (env.hasDispatchFleet) return 'Send!';
  if (env.hasAgoRoutine7) return 'Prepare';
  return BUTTON_TEXT;
};
