// @ts-check

// Galaxy-Scan configuration — the per-universe colonize/abandon knobs plus the
// fleet-save alarmClock knobs (`fs*`) and the bare-fleet guardian knobs. These
// are all server-scoped settings edited from the dashboard, folded into ONE
// per-universe `chrome.storage` slot (see `state/galaxyScanConfig.js`) so they
// ride its whole-slot newest-wins gist sync for free. They share the store, not
// the concept.
//
// Historical note (§5d): this module also held the per-status "rescan after"
// thresholds + the `RescanPolicy` projection consumed by `isSystemStale`. After
// the OGame-API migration, galaxy occupancy is re-derived from the public API
// per device and colonization state lives in the decision log
// (`domain/colonizeDecisions.js`) with its own built-in horizons
// (sent/reserved/taken). The manual rescan policy + the whole staleness
// machinery (`domain/scheduling.js`) became dead and were removed.
//
// Everything here is PURE: no DOM, no storage, no clock — unit-testable in Node
// and shared verbatim across the game/dashboard origins.

/**
 * The full Galaxy-Scan config, persisted per-universe.
 *
 * @typedef {object} GalaxyScanConfig
 * @property {string} positions  Comma/range list of target positions
 *   (e.g. `"8,10-12,15"`). Drives both which positions count as a "free
 *   region" and which the colonize button targets (one shared value).
 * @property {boolean} preferOtherGalaxies  Prefer neighbouring galaxies for
 *   colonization (was `colPreferOtherGalaxies`).
 * @property {boolean} preferFarthestSystems  Within the home galaxy, propose the
 *   FARTHEST free system first (better arrival spread — the historical default).
 *   Off ⇒ nearest free system first. Only affects home-galaxy ordering; other
 *   galaxies stay linear.
 * @property {boolean} showFabButton  Show the Colonize module on the unified
 *   FAB. Off ⇒ the button unmounts (its satellite orb too); scanning, the
 *   decision log and the dashboard are unaffected.
 * @property {number} colonyMinGap  Min seconds between colonize arrivals (the
 *   min-gap scheduling guard read by `features/sendColony`).
 * @property {number} colonyMinFields  Abandon-eligibility floor: a fresh
 *   colony under this many fields is offered for abandon.
 * @property {string} colonyPassword  Account password the abandon flow
 *   autofills into the game's give-up confirmation form.
 * @property {boolean} fsEnabled  Fleet-save auto-detection on/off (per-server:
 *   the "big fleet" cutoff is speed-dependent, so it lives here, not global).
 * @property {number} fsThreshold  Minimum total ships for a leg to count as a
 *   fleet-save.
 * @property {number} fsMinFlightSec  Minimum flight time (s) for a leg to count
 *   as a fleet-save — excludes short planet⇄moon hops. Server-speed dependent.
 * @property {string} fsOffsets  Fleet-save alarmClock offsets relative to landing
 *   (comma-separated, minutes-first; negative = before, 0 = at, + = after).
 * @property {boolean} guardianEnabled  Bare-fleet guardian on/off: an escalation
 *   ntfy push when a landed fleet-save sits exposed (no re-save). Per-universe.
 * @property {number} guardianIntervalMin  Minutes after landing the guardian push
 *   fires if the fleet is still sitting bare.
 * @property {number} guardianAckIntervalMin  Minutes with no page reload before
 *   the in-game guardian button starts pulsing to demand an ACK — the "are you
 *   still watching?" presence nudge. In-game only (no ntfy); reset by any page
 *   reload or an ack tap.
 */

/**
 * Factory for the built-in default config — the predefined preset that
 * reproduces OG-E's historical behaviour (positions `8`, prefer other
 * galaxies). A fresh function each call so callers can't mutate a shared
 * literal; also the "reset to defaults" payload for the dashboard button.
 *
 * @returns {GalaxyScanConfig}
 */
export const defaultGalaxyScanConfig = () => ({
  positions: '8',
  preferOtherGalaxies: true,
  preferFarthestSystems: true,
  showFabButton: true,
  colonyMinGap: 15,
  colonyMinFields: 320,
  colonyPassword: '',
  fsEnabled: false,
  fsThreshold: 100000,
  fsMinFlightSec: 600,
  fsOffsets: '-10m, 0m, 10m',
  guardianEnabled: true,
  guardianIntervalMin: 20,
  guardianAckIntervalMin: 3,
});

/**
 * Coerce one stored value to a finite, non-negative integer, falling back to
 * `fallback` for garbage / negatives. Used by {@link normalizeGalaxyScanConfig}
 * so a corrupt or partial persisted blob (or an older shape) never produces NaN.
 *
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
const coerceInt = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Normalise an arbitrary (possibly partial / legacy / null) stored value into a
 * complete {@link GalaxyScanConfig}, filling every missing field from
 * {@link defaultGalaxyScanConfig}. Pure and total — always returns a valid
 * config. The store's hydrate path runs this on load so consumers never have to
 * defend against holes. (A legacy `rescan` field, if present, is simply ignored
 * — §5d.)
 *
 * @param {unknown} raw
 * @returns {GalaxyScanConfig}
 */
export const normalizeGalaxyScanConfig = (raw) => {
  const d = defaultGalaxyScanConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = /** @type {Partial<GalaxyScanConfig>} */ (raw);
  return {
    positions: typeof r.positions === 'string' ? r.positions : d.positions,
    preferOtherGalaxies:
      typeof r.preferOtherGalaxies === 'boolean'
        ? r.preferOtherGalaxies
        : d.preferOtherGalaxies,
    preferFarthestSystems:
      typeof r.preferFarthestSystems === 'boolean'
        ? r.preferFarthestSystems
        : d.preferFarthestSystems,
    showFabButton:
      typeof r.showFabButton === 'boolean' ? r.showFabButton : d.showFabButton,
    colonyMinGap: coerceInt(r.colonyMinGap, d.colonyMinGap),
    colonyMinFields: coerceInt(r.colonyMinFields, d.colonyMinFields),
    colonyPassword:
      typeof r.colonyPassword === 'string' ? r.colonyPassword : d.colonyPassword,
    // fs* are the fleet-save alarmClock knobs. Threshold / min-flight are
    // non-negative ints; offsets is a free-form duration-list string.
    fsEnabled: typeof r.fsEnabled === 'boolean' ? r.fsEnabled : d.fsEnabled,
    fsThreshold: coerceInt(r.fsThreshold, d.fsThreshold),
    fsMinFlightSec: coerceInt(r.fsMinFlightSec, d.fsMinFlightSec),
    fsOffsets: typeof r.fsOffsets === 'string' ? r.fsOffsets : d.fsOffsets,
    guardianEnabled:
      typeof r.guardianEnabled === 'boolean' ? r.guardianEnabled : d.guardianEnabled,
    guardianIntervalMin: coerceInt(r.guardianIntervalMin, d.guardianIntervalMin),
    guardianAckIntervalMin: coerceInt(r.guardianAckIntervalMin, d.guardianAckIntervalMin),
  };
};
