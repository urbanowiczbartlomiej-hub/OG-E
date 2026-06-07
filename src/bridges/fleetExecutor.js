// MAIN-world bridge that performs fleetdispatch actions the ISOLATED world
// cannot: selecting ships, setting the target, and selecting the mission.
//
// Why this module exists:
//   The game's fleet form is driven by the page-world `window.fleetDispatcher`
//   controller. Setting the native `#shipNNN` inputs from the isolated world
//   does NOT register a selection (`shipsToSend` stays empty) — only
//   `fleetDispatcher.selectShip(id, n)` does. Likewise the target is set via
//   `setTargetPlanet` / `updateTarget`, not by poking the coord inputs.
//
//   So the ISOLATED-world fleet courier (features/shared/fleetCourier.js)
//   sends us a command CustomEvent and we call the matching `fleetDispatcher`
//   methods here, in the page realm, then dispatch a reply CustomEvent. The
//   native step controls that DO work from isolated (continue, load-all-
//   resources, dispatch) stay on the courier side; we own only the three
//   actions that genuinely need the controller.
//
// TOS posture: every action here is one the player's own click would
// perform via the game's UI, and it is gated behind the courier's two
// intentional taps (select, then send). We never originate a send; the
// final dispatch is a separate, user-initiated gesture.
//
// Contract with the isolated courier (both worlds share `document`):
//   • listen  `oge:fd:cmd`  detail { id:number, op:string, args:object }
//   • reply   `oge:fd:res`  detail { id:number, ok:boolean, data?, error? }
//
// Ops:
//   selectShips  { ships:[{id,count}] } → reset + selectShip each + refresh;
//                  data { totalSelected }
//   setTarget    { galaxy, system, position, type } → setTargetPlanet +
//                  setTargetType + updateTarget (fires the game's checkTarget
//                  XHR; the courier awaits oge:checkTargetResult separately)
//   selectMission{ mission } → selectMission iff available; data { available }
//
// @ts-check

import { FD_CMD_EVENT as CMD_EVENT, FD_RES_EVENT as RES_EVENT } from '../lib/fleetProtocol.js';

/**
 * @typedef {object} FdCommand
 * @property {number} id
 * @property {string} op
 * @property {Record<string, any>} [args]
 */

/**
 * Read the live page-world controller. Returns `null` when absent (not on
 * fleetdispatch, or the game hasn't initialised it yet).
 *
 * @returns {any | null}
 */
const getDispatcher = () => {
  const fd = /** @type {any} */ (window).fleetDispatcher;
  return fd && typeof fd === 'object' ? fd : null;
};

/**
 * Run one command against `fd`. Pure-ish: returns `{ ok, data }` or throws
 * (the caller turns a throw into a reply with `error`).
 *
 * @param {any} fd
 * @param {FdCommand} cmd
 * @returns {{ ok: boolean, data?: any }}
 */
const runCommand = (fd, cmd) => {
  const args = cmd.args || {};
  switch (cmd.op) {
    case 'selectShips': {
      const ships = Array.isArray(args.ships) ? args.ships : [];
      if (typeof fd.resetShips === 'function') fd.resetShips();
      for (const s of ships) {
        if (s && typeof s.id === 'number' && typeof s.count === 'number') {
          fd.selectShip(s.id, s.count);
        }
      }
      if (typeof fd.refresh === 'function') fd.refresh();
      const totalSelected =
        typeof fd.getTotalNumberOfShipsSelected === 'function'
          ? fd.getTotalNumberOfShipsSelected()
          : 0;
      return { ok: totalSelected > 0, data: { totalSelected } };
    }

    case 'setTarget': {
      const { galaxy, system, position, type } = args;
      // Set the model, then let the game re-check the target. Different
      // game versions expose slightly different setters; call whatever's
      // present. updateTarget() is what actually fires the checkTarget XHR.
      if (typeof fd.setTargetPlanet === 'function') {
        fd.setTargetPlanet({ galaxy, system, position, type });
      }
      if (typeof fd.setTargetType === 'function' && type != null) {
        fd.setTargetType(type);
      }
      if (typeof fd.updateTarget === 'function') fd.updateTarget();
      return { ok: true };
    }

    case 'selectMission': {
      const mission = Number(args.mission);
      const available =
        typeof fd.isMissionAvailable === 'function'
          ? !!fd.isMissionAvailable(mission)
          : !!(fd.orders && fd.orders[String(mission)] === true);
      if (available && typeof fd.selectMission === 'function') {
        fd.selectMission(mission);
      }
      return { ok: available, data: { available } };
    }

    default:
      return { ok: false, data: { unknownOp: cmd.op } };
  }
};

/**
 * The single command listener, kept so install is idempotent and dispose
 * removes exactly what it added.
 *
 * @type {((e: Event) => void) | null}
 */
let onCmd = null;

/**
 * Install the fleet executor. Idempotent — a second call is a no-op and
 * returns the same dispose.
 *
 * @returns {() => void} dispose
 */
export const installFleetExecutor = () => {
  if (onCmd) return dispose;

  onCmd = (e) => {
    const detail = /** @type {FdCommand | undefined} */ (
      /** @type {CustomEvent} */ (e).detail
    );
    if (!detail || typeof detail.id !== 'number' || typeof detail.op !== 'string') {
      return;
    }
    /** @type {{ ok: boolean, data?: any, error?: string }} */
    let result;
    try {
      const fd = getDispatcher();
      if (!fd) {
        result = { ok: false, error: 'noDispatcher' };
      } else {
        result = runCommand(fd, detail);
      }
    } catch (err) {
      result = { ok: false, error: String(err && /** @type {any} */ (err).message) };
    }
    document.dispatchEvent(
      new CustomEvent(RES_EVENT, { detail: { id: detail.id, ...result } }),
    );
  };

  document.addEventListener(CMD_EVENT, onCmd);
  return dispose;
};

/** Remove the command listener. @returns {void} */
const dispose = () => {
  if (onCmd) {
    document.removeEventListener(CMD_EVENT, onCmd);
    onCmd = null;
  }
};

/**
 * Test-only reset so each case starts clean.
 *
 * @returns {void}
 */
export const _resetFleetExecutorForTest = () => {
  dispose();
};
