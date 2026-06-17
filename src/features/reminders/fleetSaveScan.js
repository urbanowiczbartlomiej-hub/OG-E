// @ts-check

// DOM scan helpers for fleet-save (FS) auto-detection. The one place that
// reads each leg's SHIP COUNT and OWNERSHIP out of the event list, shared by
// the producer (which schedules FS pushes) and the badge UI (which marks FS
// rows). Kept in the feature layer — `domain/fleetSave.js` stays DOM-free.
//
// @see ../../domain/fleetSave.js — the pure threshold/offset logic.

import { isFleetSaveLeg } from '../../domain/fleetSave.js';
import { GAME } from '../../lib/gameDom.js';

/** @typedef {import('../../domain/fleetSave.js').FleetSaveCandidate} FleetSaveCandidate */

/** English mission-type names for the push label (locale-independent). */
const MISSION_NAMES = /** @type {Record<string, string>} */ ({
  1: 'Attack', 2: 'ACS attack', 3: 'Transport', 4: 'Deployment',
  5: 'ACS defend', 6: 'Espionage', 7: 'Colonisation', 8: 'Recycle',
  9: 'Moon destruction', 15: 'Expedition',
});

/** @param {string | null | undefined} s @returns {string} dense `g:s:p` */
const denseCoords = (s) => (s || '').replace(/[\s[\]]/g, '');

/** @param {Element} row @param {string} sel @returns {string} bracketed dense coords, or ''. */
const coordsFieldOf = (row, sel) => {
  const d = denseCoords(row.querySelector(sel)?.textContent);
  return d ? `[${d}]` : '';
};

/**
 * Body name out of an origin/dest cell. The visible text is truncated
 * (`"Bezgranic..."`), so prefer the full name carried in the inner span's
 * `title` (`"Bezgraniczna dal"`); fall back to the trimmed text (origin cells
 * are short — `"K4"` — and carry no title).
 *
 * @param {Element | null} cell
 * @returns {string}
 */
const bodyNameOf = (cell) => {
  if (!cell) return '';
  const titled = cell.querySelector('span[title]');
  const title = titled && titled.getAttribute('title');
  return (title || cell.textContent || '').trim();
};

/**
 * Per-leg metadata shared by the ad-hoc and fleet-save push contexts — the
 * fields both kinds now expose as the unified `{origin}` / `{originName}` /
 * `{target}` / `{targetName}` / `{shipCount}` wildcards. `origin`/`target` are
 * the leg's LAUNCH (`.coordsOrigin`) and MISSION TARGET (`.destCoords`) — fixed
 * across both legs — so they stay distinct from the landing point that the
 * label (and `{coords}`) already carries (origin on a return, dest outbound).
 *
 * @typedef {object} FleetRowMeta
 * @property {string} origin      Launch coords, bracketed (`[g:s:p]`), or ''.
 * @property {string} originName  Launch body name (e.g. `P1`, `K4`), or ''.
 * @property {string} target      Mission-target coords, bracketed, or ''.
 * @property {string} targetName  Mission-target body name, or ''.
 * @property {number} [shipCount] Total ships on the leg, when parseable.
 *
 * @param {Element} row
 * @returns {FleetRowMeta}
 */
export const fleetRowMeta = (row) => {
  const ships = shipCountOf(row);
  return {
    origin: coordsFieldOf(row, GAME.COORDS_ORIGIN),
    originName: bodyNameOf(row.querySelector(GAME.ORIGIN_FLEET)),
    target: coordsFieldOf(row, GAME.COORDS_DEST),
    targetName: bodyNameOf(row.querySelector(GAME.DEST_FLEET)),
    ...(Number.isFinite(ships) ? { shipCount: ships } : {}),
  };
};

/**
 * Total ship count of a fleet-leg row, parsed from the `detailsFleet` cell
 * (OGame renders the fleet's total ships there as a locale-formatted
 * integer, e.g. `"8.256.872"`). Locale-independent: we strip every
 * non-digit and parse what's left. Returns `NaN` when absent / unparseable.
 *
 * @param {Element} row
 * @returns {number}
 */
export const shipCountOf = (row) => {
  const txt = row.querySelector(GAME.DETAILS_FLEET)?.textContent || '';
  const digits = txt.replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : NaN;
};

/**
 * Whether a row is the player's OWN (or friendly) fleet. OGame marks the
 * countdown of own/friendly fleets with the `friendly` class and hostile
 * incoming fleets with `hostile` — a locale-independent signal. FS
 * auto-detection only ever applies to your own fleets, never an incoming
 * attack (whose composition you usually can't even see).
 *
 * @param {Element} row
 * @returns {boolean}
 */
export const isOwnFleet = (row) => Boolean(row.querySelector('.friendly'));

/**
 * Push label naming where the leg LANDS, e.g. `"Deployment → [4:478:14]"`.
 * A return flight lands at its origin (`.coordsOrigin`); an outbound leg at
 * its destination (`.destCoords`). Mirrors the ad-hoc labeller in
 * `eventList.js`.
 *
 * @param {Element} row
 * @returns {string}
 */
export const fleetSaveLabelFor = (row) => {
  const mt = row.getAttribute('data-mission-type') || '';
  const mission = MISSION_NAMES[mt] || 'Fleet';
  const isReturn = row.getAttribute('data-return-flight') === 'true';
  const landing = denseCoords(row.querySelector(isReturn ? GAME.COORDS_ORIGIN : GAME.COORDS_DEST)?.textContent);
  return landing ? `${mission} → [${landing}]` : mission;
};

/**
 * Extract every OWN fleet leg that could be a fleet-save as a
 * {@link FleetSaveCandidate}. Threshold-INDEPENDENT (the domain applies the
 * threshold), so the producer's scan signature stays stable across threshold
 * edits and a setting change is the only thing that re-runs the FS
 * computation for an unchanged event list.
 *
 * Skips the OUTBOUND leg of round-trip missions: a mission like Transport or
 * Espionage shows an outbound + a return leg at once, and only the RETURN
 * lands the fleet back home (see {@link isFleetSaveLeg}). One-way missions
 * (Deployment / Colonisation) keep their outbound leg — the fleet stays
 * there. Pure-ish DOM read, same passive style as the producer's other
 * extractors.
 *
 * @param {ParentNode} [root=document]
 * @returns {FleetSaveCandidate[]}
 */
export const extractFleetSaveCandidates = (root = document) => {
  /** @type {FleetSaveCandidate[]} */
  const out = [];
  for (const row of root.querySelectorAll(GAME.EVENT_FLEET_ROWS)) {
    if (!isOwnFleet(row)) continue;
    const isReturn = row.getAttribute('data-return-flight') === 'true';
    const missionType = row.getAttribute('data-mission-type') || '';
    if (!isFleetSaveLeg(missionType, isReturn)) continue;
    const id = /** @type {HTMLElement} */ (row).id;
    const arrivalAttr = row.getAttribute('data-arrival-time');
    const arrivalAt = arrivalAttr ? Number.parseInt(arrivalAttr, 10) : NaN;
    const shipCount = shipCountOf(row);
    if (id && Number.isFinite(arrivalAt) && Number.isFinite(shipCount)) {
      out.push({ id, arrivalAt, shipCount, label: fleetSaveLabelFor(row), ...fleetRowMeta(row) });
    }
  }
  return out;
};
