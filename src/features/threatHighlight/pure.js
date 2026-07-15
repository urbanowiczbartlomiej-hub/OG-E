// @ts-check
//
// Pure decision + summary logic for the threat highlight. No DOM, no timers,
// no listeners — the orchestrator (./index.js) reads the page and feeds
// these functions plain data, so the "are we under attack / how bad is it"
// rules stay unit-testable without happy-dom (the pure-core rule in CLAUDE.md).

/**
 * Mission-type ids that count as an ACTUAL attack on us — not espionage,
 * not a friendly/own movement. `1` Attack · `2` ACS attack · `9` Moon
 * destruction. Mirrors the set OGame's own top-bar `#attack_alert` flag
 * reacts to, so the event-list enrichment never disagrees with the flag by
 * counting an inbound spy probe as an attack. (Numbers are the
 * `data-mission-type` ids catalogued in `domain/missions.js`'s MISSION_NAMES —
 * reverse-engineered game knowledge.)
 *
 * @type {ReadonlySet<string>}
 */
export const ATTACK_MISSION_TYPES = new Set(['1', '2', '9']);

/**
 * "All-clear" tokens on the `#attack_alert` element — their presence means we
 * are NOT under an active attack. Two of them, both reverse-engineered game
 * knowledge:
 *
 *   • `noAttack` — the plain all-clear. OGame ships the flag as
 *     `<div id="attack_alert" class="tooltip noAttack">` and REMOVES this token
 *     the instant a hostile attack is inbound.
 *   • `wreckField` — the AFTERMATH state. After your fleet is destroyed OGame
 *     reuses this very element to show the wreck-field / repair-layer indicator
 *     (`class="tooltip overlay wreckField"`, a repairlayer link + a
 *     `#wreckFieldCountDown` child, tooltip "Wreckages: …"). That state also
 *     lacks `noAttack`, so the naive "no noAttack ⇒ attack" test fired a FALSE
 *     alarm for a battle that was already over. The wreck field is a distinct
 *     repurposing of the element, never OGame's live-attack state, so its
 *     presence is treated as "not under attack".
 *
 * @type {ReadonlySet<string>}
 */
const CLEAR_TOKENS = new Set(['noAttack', 'wreckField']);

/**
 * Whether the top-bar attack flag says we're under an active attack. "Under
 * attack" is "the element exists and carries none of the {@link CLEAR_TOKENS}".
 * We test for a clear token's ABSENCE rather than a positive attack class
 * because the game adds different markers (`soon`, etc.) in different attack
 * states, whereas the clear states are the stable, enumerable ones.
 *
 * @param {string | null | undefined} className The element's `className`, or
 *   null/undefined when the element isn't on the page (treated as "not under
 *   attack" — a missing flag is not a positive signal).
 * @returns {boolean}
 */
export const isUnderAttack = (className) => {
  if (className == null) return false;
  return !className.split(/\s+/).some((t) => CLEAR_TOKENS.has(t));
};

/**
 * One inbound fleet leg, as extracted from an event-list row by the
 * orchestrator (kept DOM-free here).
 *
 * @typedef {object} HostileLeg
 * @property {string} missionType `data-mission-type` value (string form).
 * @property {boolean} isReturn   `data-return-flight === 'true'`.
 * @property {boolean} isHostile  row carries the `.hostile` countdown marker.
 * @property {number} arrivalAt   epoch SECONDS (`data-arrival-time`); NaN if absent.
 * @property {string} target      landing coords, bracketed `[g:s:p]`, or ''.
 */

/**
 * @typedef {object} AttackSummary
 * @property {number} count            number of inbound hostile attack legs.
 * @property {number} soonestArrivalAt epoch SECONDS of the earliest arrival, or 0.
 * @property {string[]} targets        unique target coords, earliest-arrival first.
 */

/**
 * Reduce parsed event-list legs to just the inbound hostile ATTACKS and
 * summarise them for the banner. Espionage / friendly / return legs are
 * dropped. Pure — `legs` is plain data the orchestrator extracted.
 *
 * @param {HostileLeg[]} legs
 * @returns {AttackSummary}
 */
export const summarizeAttacks = (legs) => {
  const hostile = legs.filter(
    (l) => l.isHostile && !l.isReturn && ATTACK_MISSION_TYPES.has(l.missionType),
  );
  hostile.sort((a, b) => (a.arrivalAt || Infinity) - (b.arrivalAt || Infinity));
  /** @type {string[]} */
  const targets = [];
  for (const l of hostile) {
    if (l.target && !targets.includes(l.target)) targets.push(l.target);
  }
  const soonest = hostile.find((l) => Number.isFinite(l.arrivalAt) && l.arrivalAt > 0);
  return {
    count: hostile.length,
    soonestArrivalAt: soonest ? soonest.arrivalAt : 0,
    targets,
  };
};

/**
 * A stable signature of "how bad is it right now", used to decide when a
 * dismissed (muted) alarm should re-fire: a new wave or an earlier arrival
 * changes the fingerprint and breaks the mute. `count` alone would miss a
 * faster fleet replacing a slower one at the same count.
 *
 * @param {AttackSummary} s
 * @returns {string}
 */
export const attackFingerprint = (s) => `${s.count}|${s.soonestArrivalAt}`;

/**
 * Format a seconds-from-now ETA as a compact countdown: `m:ss`, or `h:mm:ss`
 * past an hour. Non-positive / non-finite collapses to a dash.
 *
 * @param {number} sec
 * @returns {string}
 */
export const formatEta = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};
