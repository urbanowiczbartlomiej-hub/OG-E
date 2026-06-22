// @ts-check
//
// Central registry of OG-E's internal `oge:*` CustomEvent names — the wire
// contract by which MAIN-world bridges, isolated-world features, the state
// layer and the sync layer talk to each other across `document`.
//
// Why this file exists:
//   These names were bare string literals on ~30 dispatch/listen sites across
//   ~20 files. A typo in one of them silently no-ops — CustomEvents never
//   throw on a missing listener — so a mistyped name fails closed and quiet.
//   Naming each event once here turns that class of bug into an import error.
//   `lib/fleetProtocol.js` already proved the pattern for the fleet-courier
//   events; this is the same idea for the rest.
//
// Layering: this module lives in `lib/` and is dependency-free (pure consts),
// so bridges (MAIN world, no chrome.*) may import it just as freely as
// features and state — the same property that lets `fleetProtocol.js` and
// `storageKeys.js` sit here.
//
// Convention: every export ends in `_EVENT` and its value is the wire string.
// The three fleet-courier names keep their home in `fleetProtocol.js` and are
// re-exported below, so this file is the single import surface for event names.

// ── Bridge → feature projections (MAIN world dispatches, features listen) ──
/** Galaxy scan XHR projected to the isolated world. */
export const GALAXY_SCANNED_EVENT = 'oge:galaxyScanned';
/** A colonize send confirmed by the sendFleet XHR. */
export const COLONIZE_SENT_EVENT = 'oge:colonizeSent';
/** Result of the game's `checkTarget` XHR (target free / occupied). */
export const CHECK_TARGET_RESULT_EVENT = 'oge:checkTargetResult';
/** A snapshot of the MAIN-world `fleetDispatcher` state. */
export const FLEET_DISPATCHER_EVENT = 'oge:fleetDispatcher';
/** The event ticker (`#eventContent`) finished an AJAX (re)load. */
export const EVENT_BOX_LOADED_EVENT = 'oge:eventBoxLoaded';
/** A merchant "place bid" action completed. */
export const TRADER_BID_PLACED_EVENT = 'oge:traderBidPlaced';
/** A merchant "import" trade completed. */
export const TRADER_IMPORT_TRADED_EVENT = 'oge:traderImportTraded';
/** Result of a lifeform system-discovery XHR. */
export const SYSTEM_DISCOVERY_RESULT_EVENT = 'oge:systemDiscoveryResult';

// ── Sync / state / UI signals ──────────────────────────────────────────────
/** The sync layer settled a gist sync (success or failure). */
export const SYNC_STATUS_EVENT = 'oge:syncStatus';
/** A user-initiated "Sync now" request. */
export const SYNC_FORCE_EVENT = 'oge:syncForce';
/** A user-initiated "preview the attack alarm" request from settings. */
export const ATTACK_ALARM_TEST_EVENT = 'oge:attackAlarmTest';
/** Daily-action state changed (rewards / merchant claimed). */
export const DAILY_STATE_CHANGED_EVENT = 'oge:dailyStateChanged';
/** A manual landed-FS mark was toggled on the fleet1 screen. */
export const MANUAL_FS_CHANGED_EVENT = 'oge:manualFsChanged';

// ── Fleet-courier protocol (defined in fleetProtocol.js; re-exported here so
//    callers have one import surface for every event name) ──────────────────
export { FD_CMD_EVENT, FD_RES_EVENT, FD_SEND_RESULT_EVENT } from './fleetProtocol.js';
