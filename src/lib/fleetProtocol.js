// @ts-check
//
// The CustomEvent names that bridge the ISOLATED-world fleet courier
// (features/shared/fleetCourier.js) and the MAIN-world fleet executor
// (bridges/fleetExecutor.js). They live in lib/ — the dependency-free
// foundation — so BOTH a bridge and a feature may import them without
// either crossing the layering contract (a feature must never import a
// bridge, and a bridge must never import a feature).
//
// Wire shape (both worlds share `document`):
//   • command  CMD_EVENT  detail { id:number, op:string, args?:object }
//   • reply    RES_EVENT  detail { id:number, ok:boolean, data?, error? }

/** Command: isolated courier → MAIN executor. */
export const FD_CMD_EVENT = 'oge:fd:cmd';
/** Reply: MAIN executor → isolated courier. */
export const FD_RES_EVENT = 'oge:fd:res';
/**
 * Result of the game's own `action=sendFleet` XHR, published by
 * bridges/sendFleetResultHook.js so the courier's dispatch() can tell a
 * real send (200 + success:true) from a rejected one (200 + success:false,
 * e.g. error 140026 "insufficient fuel").
 * detail { success:boolean, errorCode:number|null, mission:number|null }
 */
export const FD_SEND_RESULT_EVENT = 'oge:sendFleetResult';
