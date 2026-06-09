// MAIN-world bridge that performs fleetdispatch actions the ISOLATED world
// cannot: selecting ships, setting the target, and selecting the mission.
//
// Why this module exists:
//   The game's fleet form is driven by the page-world `window.fleetDispatcher`
//   controller. Setting the native `#shipNNN` inputs from the isolated world
//   does NOT register a selection (`shipsToSend` stays empty) — only
//   `fleetDispatcher.selectShip(id, n)` does, which needs the controller.
//   The TARGET is a different story: AGR overwrites the native fleet2 coord
//   inputs with its own target, so we set coords + planet/moon type on AGR's
//   dedicated fleet1 controls (`#ago_galaxy` … `#ago_type` spans) instead.
//
//   So the ISOLATED-world fleet courier (features/shared/fleetCourier.js)
//   sends us a command CustomEvent and we run the matching action here, in
//   the page realm, then dispatch a reply CustomEvent. The native step
//   controls that DO work from isolated (continue, load-all-resources,
//   dispatch) stay on the courier side.
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
//   setTarget    { galaxy, system, position, type } → write AGR's fleet1
//                  coord inputs + click the planet/moon type span (AGR
//                  action:42). AGR applies the target and fires the game's
//                  checkTarget XHR; the courier awaits oge:checkTargetResult.
//   selectMission{ mission } → selectMission iff available; data { available }
//
// @ts-check

import { FD_CMD_EVENT as CMD_EVENT, FD_RES_EVENT as RES_EVENT } from '../lib/fleetProtocol.js';
import { GAME } from '../lib/gameDom.js';

/**
 * Write `value` into every input matching `sel` and fire the full event
 * sequence a real keystroke produces — including `keydown`/`keyup` as real
 * `KeyboardEvent`s — so AGR's `ago_keys_arrows` handler auto-applies the
 * value (AGR aims the fleet straight off the fleet1 inputs; no submit
 * click is needed). The coord ids may exist on more than one node, so we
 * set every match.
 *
 * @param {string} sel
 * @param {string | number} value
 * @returns {void}
 */
const fireInput = (sel, value) => {
  for (const el of document.querySelectorAll(sel)) {
    const input = /** @type {HTMLInputElement} */ (el);
    if (typeof input.focus === 'function') input.focus();
    input.value = String(value);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }
};

/**
 * Ensure AGR's target type matches `type` (1 planet · 3 moon). The row's
 * planet/moon spans carry a `.selected` class for the active one; clicking
 * a span re-fires AGR `action:42`. We click ONLY when the wanted span is
 * not already selected — re-clicking the already-active span re-triggers
 * action:42 and can stomp the coords AGR just auto-applied from the inputs.
 *
 * For moon (type=3) AGR guards the type-span click with isTrusted, so the
 * synthetic click is ignored. Workaround: click the first
 * span.ago_shortcuts_moon inside td.ago_shortcuts_own BEFORE writing coords —
 * that path in AGR's shortcuts handler does accept synthetic events and sets
 * the internal moon flag. After that, writing the coords via fireInput keeps
 * moon selected because we never click the planet span.
 *
 * @param {number} type
 * @returns {void}
 */
const setTargetType = (type) => {
  const wantSel = type === 3 ? GAME.AGO_TYPE_MOON : GAME.AGO_TYPE_PLANET;
  const el = /** @type {HTMLElement | null} */ (document.querySelector(wantSel));
  if (el && !el.classList.contains('selected')) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
};

/**
 * Pre-arm AGR's moon flag by clicking the first span.ago_shortcuts_moon inside
 * td.ago_shortcuts_own. AGR's shortcuts handler does not check isTrusted on
 * that element, so a synthetic click works and sets the internal moon type
 * before we write the actual target coords.
 *
 * Call this BEFORE fireInput when type === 3 and the moon span is not already
 * active in AGR's type row.
 *
 * @returns {void}
 */
const primeAgrMoon = () => {
  const moonSpan = /** @type {HTMLElement | null} */ (
    document.querySelector('td.ago_shortcuts_own span.ago_shortcuts_moon')
  );
  if (moonSpan) {
    moonSpan.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
};

/**
 * Pre-arm AGR's planet flag by clicking the first span.ago_shortcuts_coords inside
 * td.ago_shortcuts_own. AGR's shortcuts handler does not check isTrusted on
 * that element, so a synthetic click works and sets the internal planet type
 * before we write the actual target coords.
 *
 * Call this BEFORE fireInput when type === 1 and the planet span is not already
 * active in AGR's type row.
 *
 * @returns {void}
 */
const primeAgrPlanet = () => {
  const planetSpan = /** @type {HTMLElement | null} */ (
    document.querySelector('td.ago_shortcuts_own span.ago_shortcuts_coords')
  );
  if (planetSpan) {
    planetSpan.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
};

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
 * @returns {Promise<{ ok: boolean, data?: any }>}
 */
const runCommand = async (fd, cmd) => {
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
      // The target is set on AGR's OWN fleet1 controls, not the native
      // fleet2 inputs (AGR clobbers those). Writing #ago_galaxy/#ago_system/
      // #ago_position with the full keystroke sequence feeds AGR's
      // `ago_keys_arrows` handler, which AUTO-APPLIES the coords and triggers
      // the game's checkTarget XHR (the courier awaits the result). The type
      // span is only clicked when switching planet↔moon — see setTargetType.
      //
      // For moon targets, prime AGR's moon flag via the shortcuts panel BEFORE
      // writing coords — that element does not enforce isTrusted so a synthetic
      // click works. After priming, writing coords keeps the moon type because
      // we skip the planet-span click.
      if (type === 3) {
        primeAgrMoon();
        await new Promise((r) => setTimeout(r, 1));
        primeAgrMoon();
      } else if (type === 1) {
        primeAgrPlanet();
        await new Promise((r) => setTimeout(r, 1));
        primeAgrPlanet();
      }
      fireInput(GAME.AGO_GALAXY, galaxy);
      fireInput(GAME.AGO_SYSTEM, system);
      fireInput(GAME.AGO_POSITION, position);
      if (type != null) setTargetType(type);
      return { ok: true };
    }

    case 'setTargetType': {
      // Re-arm planet/moon type, called by the courier after continueReady()
      // clears (just before clickContinue). Two complementary paths:
      //   1. Click the AGR span — updates AGR's visual state and its internal
      //      type if AGR does NOT filter on event.isTrusted. For moon this is
      //      typically a no-op because setTarget's primeAgrMoon already set
      //      the type; the .selected guard in setTargetType() prevents a
      //      redundant re-click.
      //   2. fd.setTargetType(type) — writes directly into the game's own
      //      fleetDispatcher so the correct type reaches fleet2 even if AGR
      //      ignored the synthetic click (isTrusted === false in userscripts).
      // NOTE: do NOT call primeAgrMoon here — that click bubbles to the <a>
      // shortcut entry and overwrites AGR's coords with the shortcut's coords,
      // corrupting the target before clickContinue.
      const t = args.type != null ? Number(args.type) : null;
      if (t != null) {
        setTargetType(t);
        if (typeof fd.setTargetType === 'function') fd.setTargetType(t);
      }
      return { ok: true };
    }

    case 'selectMission': {
      const mission = Number(args.mission);
      // Select the mission by clicking the visible mission icon, NOT via
      // fd.selectMission. When the target was applied through AGR's fleet1
      // row, `fd.orders` is empty and `fd.selectMission` updates `fd.mission`
      // WITHOUT moving the UI's `.selected` marker — so the send would still
      // go as whatever icon is highlighted. The icon `.missionIcon.missionN`
      // is the source of truth: its `on` class mirrors checkTarget `orders`
      // (available), and clicking it runs the game's own mission-select
      // (updating both the `.selected` marker and `fd.mission`).
      const icon = /** @type {HTMLElement | null} */ (
        document.querySelector('.missionIcon.mission' + mission)
      );
      const available = !!icon && icon.classList.contains('on');
      if (icon && available && !icon.classList.contains('selected')) {
        icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

  onCmd = async (e) => {
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
        result = await runCommand(fd, detail);
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
