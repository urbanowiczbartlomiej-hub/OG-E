// @ts-check

// Pure helpers + constants for sendExpedition. The orchestrator (`./index.js`)
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
// Mirrors the layout of `features/sendColony/{pure,domHelpers}.js`, with
// one less file because sendExpedition's DOM readers are tightly coupled to
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

import { ingameComponentUrl } from '../../domain/ogameUrl.js';
import { FAB_MODULES } from '../shared/fabModules.js';
import { TONE_ERROR, TONE_WAIT } from '../shared/statusTones.js';

/**
 * @typedef {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot} FleetDispatcherSnapshot
 */

// ─── DOM ids / storage keys ──────────────────────────────────────────

/**
 * DOM id of the floating button. Stable so repeated mount calls
 * short-circuit, and so tests / CSS overrides can target it.
 */
export const BUTTON_ID = 'oge-send-exp';

// ─── Visual / interaction constants ──────────────────────────────────

/**
 * How long the "All sent" warning label stays on the button when the
 * click handler bails due to the per-planet cap. 2 s is long enough to
 * read, short enough that a user retrying immediately after adding
 * a slot is not interrupted.
 */
export const MAX_LABEL_MS = 2000;

/**
 * Hold duration (ms) for the long-press "skip this planet" gesture. Matches
 * sendColony's skip hold — a deliberate 2 s press (with the shared button's
 * radial charge arc as live feedback) so an ordinary tap can never trip it.
 */
export const HOLD_SKIP_MS = 2000;

// The eventbox-readiness gate moved to the shared Button (`gateUntilEventBox`)
// and `features/shared/eventBoxGate.js`, which owns the safety-timeout
// constant now — every fleet-send button shares one implementation.

// ─── Button copy ─────────────────────────────────────────────────────

/** Default button copy — what the user sees in the "idle" state. */
export const BUTTON_TEXT = 'Exped';

/**
 * Transient copy when every planet has hit `maxExpeditionsPerPlanet`. The
 * copy is the shared exhaustion phrase (same as dailyRun's micro zone), not
 * the state's name — short enough to fit the button, no exclamation.
 */
export const ALL_MAXED_LABEL = 'All sent';

/**
 * Transient copy when every GENERAL fleet slot is in use (T11) — distinct
 * from {@link ALL_MAXED_LABEL} so the user can tell "my expedition budget
 * is spent" apart from "no fleet of any kind can launch right now".
 */
export const ALL_FLEETS_LABEL = 'All fleets!';

// ─── Background colors ───────────────────────────────────────────────

/**
 * Rim colour for the idle button (cerulean blue). Doubles as the module's
 * signature colour, so it is sourced from the shared FAB identity table —
 * idle rim, satellite orb and settings module tile can never diverge.
 */
export const BG_IDLE = FAB_MODULES.exp.color;

/** Rim colour for the "All sent" state — the shared FAB wait tone (amber). */
export const BG_MAX = TONE_WAIT;

/** Rim colour for an error state — the shared FAB error tone (rose). */
export const BG_ERROR = TONE_ERROR;

// ─── Routine-off diagnosis ───────────────────────────────────────────

/**
 * Transient label when AGR's Expeditions routine is OFF (routine 7 absent),
 * so the dispatch can't be driven. Short enough to fit the label span.
 */
export const EXP_ROUTINE_OFF_LABEL = 'AGR exp off';

/** Native tooltip spelling out the fix for {@link EXP_ROUTINE_OFF_LABEL}. */
export const EXP_ROUTINE_OFF_HINT = 'Enable Expeditions in AGR fleet settings';

/** How long the routine-off error stays before restoring idle (ms). */
export const ROUTINE_OFF_LABEL_MS = 4000;

// The "why did the routine wait fail?" classifier moved to the shared
// `features/shared/agrRoutine.js` (`classifyRoutineFailure`) — the guardian's
// fleet-save routine needs the same absent-vs-timeout split.

// ─── Pure helpers ────────────────────────────────────────────────────

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
export const buildFleetdispatchUrl = (cp) =>
  ingameComponentUrl(location.href, 'fleetdispatch', { cp });

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
 * Pure: does the snapshot show the active planet holds NO ships at all? An
 * empty `shipsOnPlanet` on a populated snapshot is the game's own "no ships on
 * this planet" state — the same data the game renders the fleet1 ship list from,
 * so it is locale- AND AGR-independent.
 *
 * Why this matters (the 1.13 regression it fixes): with no fleet on the planet,
 * AGR no longer emits its Expeditions routine (`#ago_routine_7` lives in a
 * section the game omits when there's nothing to send). The routine-driver then
 * waits out its full timeout and reports `'routineOff'`, so the button painted a
 * spurious "AGR exp off" error and stalled instead of hopping to the next
 * planet. Detecting shiplessness up front lets the click handler treat an empty
 * planet exactly like a maxed one — hop onward — as it did pre-1.13.
 *
 * `null` snapshot returns `false` (unknown ⇒ don't short-circuit; fall through
 * to the normal AGR-routine path).
 *
 * @param {FleetDispatcherSnapshot | null} snapshot
 * @returns {boolean}
 */
export const isPlanetShipless = (snapshot) =>
  !!snapshot && snapshot.shipsOnPlanet.length === 0;

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
