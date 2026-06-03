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
export const fsLabelFor = (row) => {
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
      out.push({ id, arrivalAt, shipCount, label: fsLabelFor(row) });
    }
  }
  return out;
};
