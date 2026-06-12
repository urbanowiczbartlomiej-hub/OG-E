// @ts-check
//
// ISOLATED-world fleet courier — the one place that drives the game's
// two-step fleetdispatch form for every button (Exp / Col / Daily), so no
// feature re-implements the select → continue → check → mission → dispatch
// choreography.
//
// Division of labour:
//   • The PURE decision (which ships, is the mission allowed, what does an
//     error mean) is domain/fleetPlan.js.
//   • The actions the isolated world CANNOT do — selecting ships and
//     setting the target via window.fleetDispatcher — are delegated to the
//     MAIN-world bridge bridges/fleetExecutor.js over the oge:fd:cmd /
//     oge:fd:res event pair (names in lib/fleetProtocol.js).
//   • The native step controls that DO work from isolated (continue,
//     load-all-resources, dispatch) are clicked here directly.
//   • Target validation is read from the game's own checkTarget XHR via
//     the existing oge:checkTargetResult bridge; ship availability + the
//     orders map come from the oge:fleetDispatcher snapshot bridge.
//
// The "two intentional player taps" model the buttons implement:
//   tap 1 → select(order): selects the fleet on step 1; if the fleet can
//           be filled, advances to step 2, sets target+mission+resources,
//           and waits until the game marks the dispatch control ready
//           (#dispatchFleet without `.off`). Returns ok / a failure reason.
//   tap 2 → dispatch(): clicks the now-ready native dispatch control.
//
// readiness is read from the game's `.off` class, NOT a timer — which is
// why a too-early "send" can't lock the button: it simply isn't ready yet.

import { resolveSelection, classifyTargetError, isMissionAllowed } from '../../domain/fleetPlan.js';
import { FD_CMD_EVENT, FD_RES_EVENT, FD_SEND_RESULT_EVENT } from '../../lib/fleetProtocol.js';
import { GAME } from '../../lib/gameDom.js';
import { safeClick, waitFor } from '../../lib/dom.js';
import {
  installFleetOwnership,
  claimFleet2,
  mayCompleteFleet2,
} from './fleetOwnership.js';

/** RPC reply timeout (MAIN executor is synchronous; this is a safety net). */
const RPC_TIMEOUT_MS = 4000;
/** How long to wait for the game's checkTarget response after setTarget. */
const CHECK_TARGET_TIMEOUT_MS = 8000;
/**
 * Short fallback for checkTarget on re-entry (back-button scenario): the game
 * deduplicates XHRs when coords are unchanged, so the event may never fire.
 * If checkTarget doesn't arrive within this window we treat the target as
 * still valid (it was validated on the previous pass) and continue.
 */
const CHECK_TARGET_REENTRY_MS = 500;
/** How long to wait for step 2 to render after "continue". */
const STEP2_TIMEOUT_MS = 8000;
/** How long to wait for the dispatch control to become ready. */
const READY_TIMEOUT_MS = 8000;
/** How long to retry arming the mission icon after checkTarget confirms it. */
const MISSION_ARM_TIMEOUT_MS = 2000;
/** How long to wait for the sendFleet result after a dispatch click. */
const SEND_RESULT_TIMEOUT_MS = 8000;
const POLL_MS = 100;

/**
 * @typedef {{ galaxy: number, system: number, position: number, type: number }} Target
 */

/**
 * A fleet order for {@link select}.
 *
 * @typedef {object} FleetOrder
 * @property {import('../../domain/fleetPlan.js').SelectionSpec} spec
 * @property {Target} target
 * @property {number} mission
 * @property {'all'} [resources]  load all resources on step 2 when set.
 * @property {string} [owner]  OWNER_* id (domain/fleetOwnership.js) of the
 *   calling button. When set, select() refuses to complete a fleet2 state
 *   the owner did not create (reason `'foreign'`) and claims the ownership
 *   session after performing the fleet1→fleet2 transition itself. Omitted
 *   ⇒ legacy behaviour with no ownership checks.
 */

/**
 * Outcome of {@link select}.
 *
 * @typedef {object} SelectResult
 * @property {boolean} ok
 * @property {'offPage'|'noShips'|'empty'|'selectFailed'|'noFleet2'|'timeout'
 *   |'noMoon'|'noShip'|'reserved'|'generic'|'mission'|'notReady'
 *   |'foreign'} [reason]
 * @property {number} [errorCode]
 * @property {Array<{ id: number, want: number, have: number }>} [shortfalls]
 */

// ─── module state ────────────────────────────────────────────────────────

/** Latest fleetDispatcher snapshot (ship availability + orders). */
let snapshot = /** @type {import('../../bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot | null} */ (
  null
);
/** Monotonic RPC id. */
let rpcSeq = 0;
/** @type {((e: Event) => void) | null} */
let onSnapshot = null;
let installed = false;

/**
 * Bare fleetdispatch URL — no ship/target/mission params (the courier or the
 * player selects those in-page), optionally pinned to a planet via `cp`.
 * Base comes from `location.href` so we stay on the origin/path the game
 * served. This is also the ownership gate's escape hatch: a foreign fleet2
 * is abandoned by navigating here, restarting the form at a clean step 1.
 *
 * @param {string | number | null} [cp]
 * @returns {string}
 */
export const bareFleetdispatchUrl = (cp) =>
  location.href.split('?')[0]
  + '?page=ingame&component=fleetdispatch'
  + (cp ? `&cp=${cp}` : '');

// ─── step / readiness (pure DOM reads) ─────────────────────────────────────

/**
 * Is `el` present AND not hidden? OGame/AGR toggle between fleet1 and fleet2
 * by VISIBILITY (jQuery .show()/.hide() → inline `display`), not by adding/
 * removing nodes — and the player can hop back via AGR's `backToFleet1`
 * button. So node existence is not enough; we must honour `display:none` on
 * the element or any ancestor. (Inline-style walk is deterministic under
 * happy-dom; jQuery sets display inline, which is what OGame uses.)
 *
 * @param {Element | null} el
 * @returns {boolean}
 */
const isShown = (el) => {
  if (!el) return false;
  for (let n = /** @type {Element | null} */ (el); n && n.nodeType === 1; n = n.parentElement) {
    const style = /** @type {HTMLElement} */ (n).style;
    if (style && style.display === 'none') return false;
  }
  return true;
};

/**
 * Which step of the fleetdispatch form is VISIBLE, from live DOM — so a
 * back-button (AGR `backToFleet1`) or manual navigation is reflected
 * immediately (no internal step counter to desync). We key off visibility,
 * not existence, because both `#fleet1` and `#fleet2` stay in the DOM and are
 * shown/hidden in place.
 *
 * @returns {'off' | 'fleet1' | 'fleet2'}
 */
export const step = () => {
  if (isShown(document.querySelector(GAME.FD_FLEET2))) return 'fleet2';
  if (isShown(document.querySelector(GAME.FD_DISPATCH))) return 'fleet2';
  if (isShown(document.querySelector(GAME.FD_FLEET1))) return 'fleet1';
  return 'off';
};

/**
 * Whether AGR has enabled the "continue to step 2" control — it carries the
 * `.off` class until the selected ships + target are applied, then clears it.
 * This is the durable "ready to advance" signal under AGR (which auto-applies
 * the target straight from the fleet1 inputs), replacing a blocking wait on
 * the game's checkTarget XHR (AGR doesn't reliably fire it on fleet1).
 *
 * @returns {boolean}
 */
const continueReady = () => {
  const el = document.querySelector(GAME.FD_CONTINUE);
  return !!el && !el.classList.contains(GAME.FD_DISABLED_CLASS);
};

/**
 * Whether the native dispatch control exists AND the game has cleared its
 * not-ready `.off` class. This is the readiness signal the button gates
 * "send" on (replacing fragile timers).
 *
 * @returns {boolean}
 */
export const readyToDispatch = () => {
  const el = document.querySelector(GAME.FD_DISPATCH);
  return !!el && !el.classList.contains(GAME.FD_DISABLED_CLASS);
};

// ─── RPC to the MAIN executor ──────────────────────────────────────────────

/**
 * Make `detail` readable by the MAIN-world executor. We dispatch the command
 * event from the ISOLATED content-script world; on Firefox the page (MAIN)
 * realm cannot read properties of an isolated-world object across the Xray
 * boundary — reading `detail.id` there throws "Permission denied to access
 * property id" and the executor never replies (the RPC then times out). The
 * fix is the standard WebExtension idiom: clone the payload into the page
 * realm with `cloneInto` so it's a page-world object. Chrome has no Xray, so
 * `cloneInto` is absent there and we pass the object through unchanged.
 *
 * @template T
 * @param {T} detail
 * @returns {T}
 */
const toPageRealm = (detail) => {
  const fn = /** @type {any} */ (globalThis).cloneInto;
  return typeof fn === 'function' ? fn(detail, window) : detail;
};

/**
 * Send one command to the MAIN executor and await its reply. Resolves the
 * reply detail, or `null` on timeout.
 *
 * @param {string} op
 * @param {Record<string, any>} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, data?: any, error?: string } | null>}
 */
const rpc = (op, args = {}, timeoutMs = RPC_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const id = ++rpcSeq;
    let done = false;
    /** @param {{ ok: boolean, data?: any, error?: string } | null} val */
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener(FD_RES_EVENT, onRes);
      clearTimeout(timer);
      resolve(val);
    };
    /** @param {Event} e */
    const onRes = (e) => {
      const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
      if (d && d.id === id) finish(d);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    document.addEventListener(FD_RES_EVENT, onRes);
    document.dispatchEvent(
      new CustomEvent(FD_CMD_EVENT, { detail: toPageRealm({ id, op, args }) }),
    );
  });

/**
 * Await the game's checkTarget result for `target`, ignoring stale results
 * for other coords. Resolves the detail or `null` on timeout.
 *
 * @param {Target} target
 * @returns {Promise<{ errorCode: number | null, orders: Record<string, boolean> | null } | null>}
 */
const awaitCheckTarget = (target) =>
  new Promise((resolve) => {
    let done = false;
    /** @param {any} val */
    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('oge:checkTargetResult', onCt);
      clearTimeout(timer);
      resolve(val);
    };
    /** @param {Event} e */
    const onCt = (e) => {
      const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
      if (
        d &&
        d.galaxy === target.galaxy &&
        d.system === target.system &&
        d.position === target.position
      ) {
        finish(d);
      }
    };
    const timer = setTimeout(() => finish(null), CHECK_TARGET_TIMEOUT_MS);
    document.addEventListener('oge:checkTargetResult', onCt);
  });

// ─── native step clicks (work from isolated) ───────────────────────────────

const clickContinue = () => safeClick(document.querySelector(GAME.FD_CONTINUE));
const clickAllResources = () =>
  safeClick(document.querySelector(GAME.FD_ALL_RESOURCES));

/**
 * Build an id→count availability map from the cached snapshot.
 *
 * @returns {Record<number, number>}
 */
const availability = () => {
  /** @type {Record<number, number>} */
  const map = {};
  const ships = snapshot && Array.isArray(snapshot.shipsOnPlanet)
    ? snapshot.shipsOnPlanet
    : [];
  for (const s of ships) {
    if (s && typeof s.id === 'number') map[s.id] = s.number || 0;
  }
  return map;
};

/**
 * Read-only ship availability from the latest fleetDispatcher snapshot —
 * `null` until a snapshot has been captured (off the fleetdispatch page, or
 * before the bridge fires), so callers can tell "unknown" apart from "the
 * planet is empty". Lets a button paint a truthful "not enough ships" /
 * "nothing here" state BEFORE the player taps, instead of discovering it
 * via a failed select().
 *
 * @returns {Record<number, number> | null}
 */
export const shipAvailability = () => (snapshot ? availability() : null);

// ─── the two-tap surface ───────────────────────────────────────────────────

/**
 * Tap 1 — "Wybór". Select the fleet on step 1 and, if it can be filled,
 * walk through to a ready-to-send step 2. Pure decisions go through
 * domain/fleetPlan; ship/target setting goes through the MAIN executor;
 * validation is read from the game's own checkTarget.
 *
 * @param {FleetOrder} order
 * @returns {Promise<SelectResult>}
 */
export const select = async (order) => {
  if (step() === 'off') return { ok: false, reason: 'offPage' };

  // Ownership gate (T5): entering at fleet2 means this call would skip the
  // fleet1 block below and complete a fleet2 state somebody else prepared —
  // legitimate ONLY when that somebody is the same owner (re-entry retry
  // after e.g. a mission rejection). A foreign fleet2 (another button, AGR's
  // routine, the player's manual send) must not be touched: arming our
  // mission on it would dispatch a fleet we are not responsible for.
  if (order.owner && step() === 'fleet2') {
    const own = mayCompleteFleet2(order.owner);
    if (!own.allowed) return { ok: false, reason: 'foreign' };
  }

  const sel = resolveSelection(order.spec, availability());
  if (!sel.ok) {
    return {
      ok: false,
      reason: sel.requirementsMet ? 'empty' : 'noShips',
      shortfalls: sel.shortfalls,
    };
  }

  // Step 1: select ships, set the target on AGR's OWN fleet1 controls, then
  // click "continue" once AGR marks it ready. The target MUST be set here, on
  // fleet1 — on fleet2 AGR overwrites the native coord inputs with its own,
  // so fleet1's AGR row is the only durable way to aim. (A fleet2 re-entry —
  // e.g. retry after a mission rejection — skips this block and relies on the
  // target AGR is already holding from the prior fleet1 pass.)
  //
  // We do NOT block on checkTarget here on fleet1: AGR auto-applies the coords
  // and the game fires its checkTarget on the fleet1→fleet2 transition, not on
  // the fleet1 inputs. So we gate fleet1 on AGR clearing the `.off` class on
  // #continueToFleet2 (its "applied & valid" signal), arm the checkTarget
  // listener just before continuing, and read the result on fleet2 below.
  /** @type {Promise<{ errorCode: number|null, orders: Record<string,boolean>|null } | null> | null} */
  let ctPromise = null;
  if (step() === 'fleet1') {
    const r = await rpc('selectShips', { ships: sel.selection });
    if (!r || !r.ok) return { ok: false, reason: 'selectFailed' };

    await rpc('setTarget', order.target);

    const cont = await waitFor(() => (continueReady() ? true : null), {
      timeoutMs: STEP2_TIMEOUT_MS,
      intervalMs: POLL_MS,
    });
    if (!cont) return { ok: false, reason: 'notReady' };

    // Re-arm the planet/moon type AFTER AGR finishes processing the coords.
    // AGR's ago_keys_arrows handler can reset the type to planet asynchronously
    // after our initial setTarget — re-clicking here, once continueReady()
    // signals AGR is done, ensures the type is correct before we continue.
    if (order.target.type != null) {
      await rpc('setTargetType', { type: order.target.type });
    }

    // Arm checkTarget listener here — just before clickContinue — so it
    // catches the fleet1→fleet2 transition XHR. Arming earlier (before
    // setTarget) would cause it to resolve from primeAgrMoon's K1 XHR or
    // fireInput's fleet1 XHR, which carry different orders than the
    // authoritative fleet2 transition response.
    ctPromise = awaitCheckTarget(order.target);
    clickContinue();
    const onF2 = await waitFor(() => (step() === 'fleet2' ? true : null), {
      timeoutMs: STEP2_TIMEOUT_MS,
      intervalMs: POLL_MS,
    });
    if (!onF2) return { ok: false, reason: 'noFleet2' };
    // We just performed the fleet1→fleet2 transition — claim it, so foreign
    // buttons are locked out and our own re-entry (retry) stays permitted.
    if (order.owner) claimFleet2(order.owner);
  }

  // Step 2: read the game's checkTarget for this target (fired on the fleet2
  // transition). Its `errorCode` flags an unusable target (noMoon/reserved/
  // noShip → the feature marks the slot for re-scan); its `orders` map says
  // whether the mission is permitted — authoritative even though fd.orders is
  // empty when AGR applied the target. Gating here is a fast pass/fail; no
  // blind polling.
  if (ctPromise) {
    // Race checkTarget against a short fallback: on re-entry after the game's
    // back-button the game deduplicates XHRs for unchanged coords and never
    // fires, so awaitCheckTarget would block until CHECK_TARGET_TIMEOUT_MS.
    // CHECK_TARGET_REENTRY_MS (500ms) is well above the normal XHR RTT (~50ms)
    // so the race is transparent for first-pass flows.
    const ct = await Promise.race([
      ctPromise,
      new Promise((r) => setTimeout(() => r(null), CHECK_TARGET_REENTRY_MS)),
    ]);
    if (ct) {
      const tag = classifyTargetError(ct.errorCode);
      if (tag !== 'ok') {
        return { ok: false, reason: tag, ...(ct.errorCode != null ? { errorCode: ct.errorCode } : {}) };
      }
      if (ct.orders && !isMissionAllowed(ct.orders, order.mission)) {
        return { ok: false, reason: 'mission' };
      }
    }
  }

  // Arm the mission by clicking its icon (via the executor). checkTarget has
  // confirmed it's allowed, so the icon is `on`; a short retry covers the
  // brief render lag between the XHR landing and AGR painting the icon.
  /** @type {{ ok: boolean, data?: any, error?: string } | null} */
  let m = null;
  const missionTries = Math.max(1, Math.ceil(MISSION_ARM_TIMEOUT_MS / POLL_MS));
  for (let i = 0; i < missionTries; i += 1) {
    m = await rpc('selectMission', { mission: order.mission });
    if (m && m.ok) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!m || !m.ok) return { ok: false, reason: 'mission' };

  if (order.resources === 'all') clickAllResources();

  const ready = await waitFor(() => (readyToDispatch() ? true : null), {
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: POLL_MS,
  });
  if (!ready) return { ok: false, reason: 'notReady' };

  return { ok: true };
};

/**
 * Await the game's own sendFleet result (published by
 * bridges/sendFleetResultHook.js). Resolves `{ ok, errorCode }` — `ok` is
 * the server's `success` flag, so a 200-but-rejected send (e.g. no fuel)
 * resolves `{ ok:false, errorCode:140026 }`. Times out to `notReady`-style
 * `{ ok:false, reason:'timeout' }`.
 *
 * @returns {Promise<{ ok: boolean, errorCode?: number | null, reason?: string }>}
 */
const awaitSendResult = () =>
  new Promise((resolve) => {
    let done = false;
    /** @param {{ ok: boolean, errorCode?: number | null, reason?: string }} v */
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener(FD_SEND_RESULT_EVENT, onRes);
      clearTimeout(timer);
      resolve(v);
    };
    /** @param {Event} e */
    const onRes = (e) => {
      const d = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
      finish({ ok: !!(d && d.success), errorCode: d ? d.errorCode : null });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), SEND_RESULT_TIMEOUT_MS);
    document.addEventListener(FD_SEND_RESULT_EVENT, onRes);
  });

/**
 * Tap 2 — "Wysłanie". Click the now-ready native dispatch control and await
 * the game's sendFleet result. Resolves `{ ok:false, reason:'notReady' }`
 * without clicking when not ready, so an early tap can never fire a send.
 *
 * @param {string} [owner] OWNER_* id of the calling button. When set, the
 *   click is refused (`reason:'foreign'`) unless the current fleet2 state
 *   belongs to this owner — the last line of defence should a foreign state
 *   appear between the owner's select() and its dispatch tap.
 * @returns {Promise<{ ok: boolean, errorCode?: number | null, reason?: string }>}
 */
export const dispatch = (owner) => {
  if (owner && !mayCompleteFleet2(owner).allowed) {
    return Promise.resolve({ ok: false, reason: 'foreign' });
  }
  if (!readyToDispatch()) return Promise.resolve({ ok: false, reason: 'notReady' });
  const result = awaitSendResult();
  safeClick(document.querySelector(GAME.FD_DISPATCH));
  return result;
};

// ─── lifecycle ─────────────────────────────────────────────────────────────

/**
 * Install the courier's snapshot listener. Idempotent. Most consumers just
 * import {@link select}/{@link dispatch}/{@link step}; calling this ensures
 * the ship-availability snapshot is cached.
 *
 * @returns {void}
 */
export const installFleetCourier = () => {
  if (installed) return;
  installed = true;
  installFleetOwnership();
  onSnapshot = (e) => {
    snapshot = /** @type {any} */ (/** @type {CustomEvent} */ (e).detail);
  };
  document.addEventListener('oge:fleetDispatcher', onSnapshot);
  // Seed from a live fleetDispatcher if readable (tests / Firefox Xray).
  if (!snapshot) {
    const fd = /** @type {any} */ (window).fleetDispatcher;
    if (fd && Array.isArray(fd.shipsOnPlanet)) {
      snapshot = /** @type {any} */ ({
        shipsOnPlanet: fd.shipsOnPlanet,
        orders: fd.orders || null,
        currentPlanet: fd.currentPlanet || null,
        targetPlanet: fd.targetPlanet || null,
      });
    }
  }
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetFleetCourierForTest = () => {
  if (onSnapshot) document.removeEventListener('oge:fleetDispatcher', onSnapshot);
  onSnapshot = null;
  snapshot = null;
  installed = false;
  rpcSeq = 0;
};
