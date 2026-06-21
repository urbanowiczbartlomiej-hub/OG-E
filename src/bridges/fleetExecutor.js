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
//   setTargetNative { galaxy, system, position } → edit the game's OWN fleet2
//                  target inputs (td.targetCoords) for an in-place retarget;
//                  fires the game's checkTarget XHR. Used on a discrete fleet2
//                  click (AGR doesn't re-clobber a settled-fleet2 edit).
//   ensureTargetType { type } → fleet2 guard: click the game's OWN target-type
//                  icon (td.targetType, 1 planet · 3 moon) iff it isn't already
//                  selected. Last resort when a fleet1 type-prime didn't take.
//   selectMission{ mission } → selectMission iff available; data { available }
//   zeroResources{} → write 0 into AGR's metal/crystal/deuterium/food cargo
//                  inputs so a micro probe carries nothing.
//   setSpeed     { step } → click the native speed `div[data-value="step"]`
//                  (10 = 100 %); data { selected }
//
// @ts-check

import { FD_CMD_EVENT as CMD_EVENT, FD_RES_EVENT as RES_EVENT } from '../lib/fleetProtocol.js';
import { GAME } from '../lib/gameDom.js';

// Priming AGR's planet/moon flag is timing-sensitive: on a fresh fleetdispatch
// page (the first tap right after navigation) AGR's shortcuts handler may not
// be wired when the first prime click fires, so it's silently dropped, and how
// long until it IS wired varies by device (worse on mobile under CPU
// contention). Observed: a fixed-delay double-tap missed the window and the
// first send went to the planet; a manual back-to-fleet1 + re-tap then worked.
// Rather than guess a delay, we re-prime on an interval and CONFIRM the flag
// landed by polling AGR's `#ago_type` span `.selected` class — self-tuning to
// device speed. POLL is the gap between attempts; TIMEOUT bounds the wait so a
// genuinely impossible target (e.g. no moon) still falls through to the later
// setTargetType / fd.setTargetType safety net instead of hanging.
const AGR_PRIME_POLL_MS = 12;
const AGR_PRIME_TIMEOUT_MS = 360;

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
  // Skip focus() on touch-primary devices — focusing a game <input> would
  // pop the virtual keyboard. The keyboard events are dispatched directly on
  // the element so AGR picks them up without the element being focused first.
  const isTouchPrimary = window.matchMedia('(pointer: coarse)').matches;
  for (const el of document.querySelectorAll(sel)) {
    const input = /** @type {HTMLInputElement} */ (el);
    if (!isTouchPrimary && typeof input.focus === 'function') input.focus();
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
 * Whether AGR's `#ago_type` row currently marks `type` as the active one.
 * AGR reflects its internal planet/moon flag in the `.selected` class on the
 * matching span — the same signal `setTargetType` guards on — so this is our
 * confirmation that a prime actually took.
 *
 * @param {number} type  1 planet · 3 moon
 * @returns {boolean}
 */
const typeFlagSelected = (type) => {
  const sel = type === 3 ? GAME.AGO_TYPE_MOON : GAME.AGO_TYPE_PLANET;
  const el = /** @type {HTMLElement | null} */ (document.querySelector(sel));
  return !!el && el.classList.contains('selected');
};

/**
 * Prime AGR's planet/moon flag and CONFIRM it landed, re-priming on an interval
 * until `#ago_type` reflects the wanted type (or {@link AGR_PRIME_TIMEOUT_MS}
 * elapses). Replaces the old blind fixed-delay double-tap: the first prime
 * right after navigation is often dropped because AGR isn't wired yet, and the
 * settle time before it is varies by device — so we verify instead of guessing.
 * Returns once selected; on timeout it returns anyway (the caller's later
 * setTargetType + fd.setTargetType remain the fallback, and checkTarget reports
 * a genuinely unusable target as noMoon).
 *
 * @param {number} type  1 planet · 3 moon
 * @returns {Promise<void>}
 */
const primeTypeConfirmed = async (type) => {
  const prime = type === 3 ? primeAgrMoon : primeAgrPlanet;
  const deadline = Date.now() + AGR_PRIME_TIMEOUT_MS;
  prime();
  while (!typeFlagSelected(type)) {
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, AGR_PRIME_POLL_MS));
    prime();
  }
};

/**
 * Fleet2 native target-type safety net. Unlike {@link setTargetType} (which
 * drives AGR's fleet1 `#ago_type` spans), this acts on the game's OWN
 * `td.targetType` icons — the authoritative planet/moon selector once on
 * fleet2. AGR's fleet1 priming + setTargetType usually lands the right body,
 * but a dropped synthetic click can leave fleet2 still showing the wrong one,
 * and the send would then go to the planet instead of the moon. We click the
 * wanted icon ONLY when it isn't already `.selected`; clicking it runs the
 * game's own handler (which re-fires checkTarget and moves the marker), exactly
 * like the mission-icon path — so we do NOT also poke `fd.setTargetType` (that
 * updates the controller without moving the visible selection). A no-op when
 * the icon is absent (off fleet2) or already correct.
 *
 * @param {number} type  1 planet · 3 moon
 * @returns {void}
 */
const ensureNativeTargetType = (type) => {
  const icon = /** @type {HTMLElement | null} */ (
    document.querySelector(`${GAME.FD_TARGET_TYPE_ICON}[data-type="${type}"]`)
  );
  if (icon && !icon.classList.contains('selected')) {
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
      // Prime AGR's planet/moon flag via the shortcuts panel BEFORE writing
      // coords — that element does not enforce isTrusted so a synthetic click
      // works, and writing coords afterwards keeps the type because we never
      // click the opposite span. primeTypeConfirmed re-primes until AGR's
      // #ago_type row reflects the wanted type, so a dropped first click on a
      // freshly-loaded page no longer leaves the send aimed at the planet.
      if (type === 3 || type === 1) {
        await primeTypeConfirmed(type);
      }
      fireInput(GAME.AGO_GALAXY, galaxy);
      fireInput(GAME.AGO_SYSTEM, system);
      fireInput(GAME.AGO_POSITION, position);
      if (type != null) setTargetType(type);
      return { ok: true };
    }

    case 'setTargetNative': {
      const { galaxy, system, position } = args;
      // Edit the game's OWN fleet2 target inputs (td.targetCoords), NOT AGR's
      // fleet1 row. This is the in-place retarget path: the colonize button
      // calls it on a discrete user click while already on fleet2, where AGR
      // no longer re-applies its own target — so the edit sticks. The full
      // keystroke sequence (fireInput) drives the game's own coord handler,
      // which fires the checkTarget XHR the courier awaits. `fd.updateTarget`
      // is a guarded nudge for builds that debounce programmatic input edits;
      // absent on others, where the events above already trigger the re-check.
      fireInput(GAME.FD_TARGET_GALAXY, galaxy);
      fireInput(GAME.FD_TARGET_SYSTEM, system);
      fireInput(GAME.FD_TARGET_POSITION, position);
      if (typeof fd.updateTarget === 'function') fd.updateTarget();
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

    case 'ensureTargetType': {
      // Fleet2 last-resort guard: verify the game's OWN target-type icon and
      // click the correct one if it disagrees. Called by the courier after
      // checkTarget settles on fleet2, covering the rare case where the fleet1
      // prime + setTargetType didn't take. See {@link ensureNativeTargetType}.
      const t = args.type != null ? Number(args.type) : null;
      if (t === 1 || t === 3) ensureNativeTargetType(t);
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

    case 'zeroResources': {
      // Micro probe: carry nothing. Write 0 into AGR's cargo inputs with the
      // full keystroke sequence so AGR's reactivity registers the change.
      // #ago_food only exists on lifeform universes — fireInput no-ops if absent.
      fireInput(GAME.AGO_METAL, 0);
      fireInput(GAME.AGO_CRYSTAL, 0);
      fireInput(GAME.AGO_DEUTERIUM, 0);
      fireInput(GAME.AGO_FOOD, 0);
      return { ok: true };
    }

    case 'setSpeed': {
      // Force fleet speed by clicking the native speed selector's value div
      // (10 = 100 %). The active div carries `.selected`; report whether the
      // wanted one exists so the courier can tell "set" from "not found".
      const step = args.step != null ? Number(args.step) : 10;
      const link = /** @type {HTMLElement | null} */ (
        document.querySelector(`${GAME.FD_SPEED_LINKS} div[data-value="${step}"]`)
      );
      if (link) {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return { ok: !!link, data: { selected: !!link } };
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
