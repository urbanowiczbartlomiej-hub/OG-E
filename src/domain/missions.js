// @ts-check

// Pure game knowledge: OGame mission-type ids → English mission names.
//
// The event list tags each fleet row with `data-mission-type` (a numeric id).
// These English names are locale-independent labels for push notifications and
// tooltips, so a player on any OGame language sees a stable mission word. This
// map is the single source of truth — the alarmClock push labels
// (`features/alarmClock/fleetSaveScan.fleetSaveLabelFor`, `eventList`) read it,
// and `features/threatHighlight/pure.js` documents its aggressive subset
// (`ATTACK_MISSION_TYPES`) against it.
//
// Ids are the game's own (1 Attack … 15 Expedition); kept verbatim.

/** English mission-type names, keyed by the game's `data-mission-type` id. */
export const MISSION_NAMES = /** @type {Record<string, string>} */ ({
  1: 'Attack', 2: 'ACS attack', 3: 'Transport', 4: 'Deployment',
  5: 'ACS defend', 6: 'Espionage', 7: 'Colonisation', 8: 'Recycle',
  9: 'Moon destruction', 15: 'Expedition',
});
