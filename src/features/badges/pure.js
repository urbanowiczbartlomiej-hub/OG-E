// @ts-check

// Pure classification for the planet status MARKERS. No DOM, no timers, no
// storage — plain functions over plain data, Node-testable.
//
// # The model: one marker per CATEGORY, on the body where a leg LANDS
//
// OGame's event list gives every fleet leg a direction-stable origin (the
// launcher) + dest (the target) and a `return-flight` flag. We attach a marker
// to the body where the leg LANDS — an outbound leg lands at `dest`, a return
// leg lands back at `origin` (home) — and only when that landing body is mine.
// A leg landing on a foreign body is not ours to mark; for a round trip the
// OTHER leg lands on one of my bodies, so nothing relevant is lost.
//
// This is the key to the "fleet-save caught" glance: my FS lands at its
// destination, and an incoming attack targets that SAME body, so both markers
// land together on one planet.
//
// # Categories (priority high → low), at most {@link MAX_MARKERS} per body
//
//   threat     — a FOREIGN aggressive fleet arriving at my body (attack / ACS
//                attack / espionage / moon destruction). The danger.
//   fs         — my fleet the reminders producer flagged as a fleet-save.
//   aggro      — MY aggressive fleet (same mission set, my own); shown on home
//                via its return leg ("I'm attacking out from here").
//   explore    — my expedition.
//   logistics  — my transport / deployment / ACS defend.
//   economy    — my recycle.
//
// Each present category renders ONE marker (no counts, no directions — the
// marker is a subtle status dot, per-fleet detail lives in the click popover).
// Per body we keep the distinct categories present, ordered by priority, capped
// at {@link MAX_MARKERS}; lower-priority overflow is dropped.
//
// Excluded entirely: colonisation (7) and discovery (18) — sent in bulk, pure
// noise — and any FOREIGN non-aggressive arrival (e.g. an ally's transport).

import { TARGET_PLANET, TARGET_MOON } from '../../domain/rules.js';

/** Max markers rendered on one body (priority-ordered; the rest are dropped). */
export const MAX_MARKERS = 3;

/**
 * Category ids in priority order — first = highest priority, also the render
 * order top-to-bottom in a body's column.
 *
 * @type {readonly string[]}
 */
export const MARKER_ORDER = ['threat', 'fs', 'aggro', 'explore', 'logistics', 'economy'];

/**
 * Human label per category, for the click popover header + native tooltip.
 *
 * @type {Record<string, string>}
 */
export const MARKER_LABEL = {
  threat: 'Incoming attack',
  fs: 'Fleet-save',
  aggro: 'My attack',
  explore: 'Expedition',
  logistics: 'Logistics',
  economy: 'Recycle',
};

/** Aggressive missions: attack, ACS attack, espionage, moon destruction. */
const AGGRESSIVE = new Set(['1', '2', '6', '9']);
/** My logistics: transport, deployment, ACS defend. */
const LOGISTICS = new Set(['3', '4', '5']);
/** My exploration: expedition. */
const EXPLORE = new Set(['15']);
/** My economy: recycle. */
const ECONOMY = new Set(['8']);
// Excluded (never a marker): colonisation '7', discovery '18' — sent in bulk.

/**
 * Identity of a body for matching a leg endpoint against the player's own
 * bodies. A planet and its moon share `g:s:p`, so the `type` (1 planet /
 * 3 moon) is part of the key — byte-identical to `domain/bodies` identity.
 *
 * @param {string} coords Dense `g:s:p` coords (no brackets/whitespace).
 * @param {number} type   1 = planet, 3 = moon.
 * @returns {string}
 */
export const bodyKey = (coords, type) => `${coords}:${type}`;

/**
 * @typedef {object} BadgeEndpoint
 * @property {string} coords Dense `g:s:p`, or '' when unreadable.
 * @property {number} type   1 = planet, 3 = moon (best-effort; planet default).
 */

/**
 * One fleet leg read out of the event list, normalised to plain data.
 *
 * @typedef {object} BadgeLeg
 * @property {string} id           Row id (`eventRow-<n>`).
 * @property {string} missionType  `data-mission-type` value (string).
 * @property {boolean} isReturn    `data-return-flight === 'true'`.
 * @property {boolean} isHostile   Row carries the `.hostile` class.
 * @property {BadgeEndpoint} origin Launcher / home body.
 * @property {BadgeEndpoint} dest   Mission target body.
 * @property {number} arrivalAt    Epoch seconds, or NaN.
 * @property {number} shipCount    Total ships, or NaN.
 */

/**
 * One fleet's contribution to a marker's detail list (for the popover).
 *
 * @typedef {object} TileFleet
 * @property {string} origin    Launcher coords.
 * @property {string} dest      Target coords.
 * @property {boolean} isReturn Currently flying home.
 * @property {number} arrivalAt Epoch seconds, or NaN.
 * @property {number} shipCount Ships, or NaN.
 */

/**
 * A rendered marker: one category on one body, plus its fleets for the popover.
 *
 * @typedef {object} Marker
 * @property {string} category One of {@link MARKER_ORDER}.
 * @property {TileFleet[]} fleets Per-fleet detail for the popover.
 */

/**
 * Sort one fleet leg into a (landing body, category), or null when it is not
 * ours to mark (lands on a foreign body, or an excluded / foreign-friendly
 * mission).
 *
 * @param {BadgeLeg} leg
 * @param {Set<string>} myKeys Set of {@link bodyKey} for the player's bodies.
 * @param {Set<string>} fsIds  Row-ids flagged as a detected fleet-save.
 * @returns {{ key: string, category: string } | null}
 */
const classifyLeg = (leg, myKeys, fsIds) => {
  // Where this leg LANDS: a return leg lands back home (origin), an outbound
  // leg lands at its target (dest).
  const landing = leg.isReturn ? leg.origin : leg.dest;
  if (!landing.coords) return null;
  const key = bodyKey(landing.coords, landing.type);
  if (!myKeys.has(key)) return null;

  const originMine = myKeys.has(bodyKey(leg.origin.coords, leg.origin.type));
  /** @type {string | null} */
  let category = null;
  if (!originMine) {
    // A foreign fleet arriving at my body — only aggression earns a marker;
    // an ally's friendly transport/defend is noise.
    if (AGGRESSIVE.has(leg.missionType)) category = 'threat';
  } else if (leg.id && fsIds.has(leg.id)) {
    category = 'fs';
  } else if (AGGRESSIVE.has(leg.missionType)) {
    category = 'aggro';
  } else if (LOGISTICS.has(leg.missionType)) {
    category = 'logistics';
  } else if (EXPLORE.has(leg.missionType)) {
    category = 'explore';
  } else if (ECONOMY.has(leg.missionType)) {
    category = 'economy';
  }
  return category ? { key, category } : null;
};

/**
 * Group fleet legs into per-body markers. Returns a Map keyed by the landing
 * body identity ({@link bodyKey}) → markers on that body, each present category
 * once, ordered by {@link MARKER_ORDER} and capped at {@link MAX_MARKERS}.
 *
 * Pure: no DOM, no clock. `arrivalAt` is carried through verbatim; the renderer
 * turns it into a countdown at paint time.
 *
 * @param {BadgeLeg[]} legs
 * @param {Set<string>} myKeys Set of {@link bodyKey} for the player's bodies.
 * @param {Set<string>} [fsIds] Row-ids the reminders producer flagged as a
 *   detected fleet-save; such a leg becomes the `fs` category.
 * @returns {Map<string, Marker[]>}
 */
export const groupMarkers = (legs, myKeys, fsIds = /** @type {Set<string>} */ (new Set())) => {
  /** @type {Map<string, Map<string, TileFleet[]>>} body → category → fleets. */
  const byBody = new Map();
  for (const leg of legs) {
    const c = classifyLeg(leg, myKeys, fsIds);
    if (!c) continue;
    let cats = byBody.get(c.key);
    if (!cats) {
      cats = new Map();
      byBody.set(c.key, cats);
    }
    let fleets = cats.get(c.category);
    if (!fleets) {
      fleets = [];
      cats.set(c.category, fleets);
    }
    fleets.push({
      origin: leg.origin.coords,
      dest: leg.dest.coords,
      isReturn: leg.isReturn,
      arrivalAt: leg.arrivalAt,
      shipCount: leg.shipCount,
    });
  }

  /** @type {Map<string, Marker[]>} */
  const out = new Map();
  for (const [key, cats] of byBody) {
    const markers = MARKER_ORDER.filter((cat) => cats.has(cat))
      .slice(0, MAX_MARKERS)
      .map((cat) => ({ category: cat, fleets: /** @type {TileFleet[]} */ (cats.get(cat)) }));
    out.set(key, markers);
  }
  return out;
};

// Re-exported so the renderer and tests share one definition of the two
// body-type constants without reaching into domain/rules directly.
export { TARGET_PLANET, TARGET_MOON };
