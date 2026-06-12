// @vitest-environment happy-dom
//
// Behavioural tests for the ISOLATED-world fleet courier. We stand up a
// fake MAIN executor (responds to oge:fd:cmd and simulates the game's
// checkTarget + dispatch-readiness) and a fake two-step fleetdispatch DOM,
// then drive the two-tap surface (select → dispatch) and assert outcomes.
//
// @ts-check
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  step,
  readyToDispatch,
  select,
  dispatch,
  installFleetCourier,
  _resetFleetCourierForTest,
} from '../../src/features/shared/fleetCourier.js';
import { _resetFleetOwnershipForTest } from '../../src/features/shared/fleetOwnership.js';
import { OWNER_COL, OWNER_FS } from '../../src/domain/fleetOwnership.js';

/** @param {string} tag @param {string} id */
const el = (tag, id) => {
  const e = document.createElement(tag);
  e.id = id;
  return e;
};

/** Coords from the most recent setTarget — used by the continue handler to
 *  fire the fleet2 checkTarget for the right target. */
let lastTarget = /** @type {any} */ (null);

/** Mount a fresh step-1 DOM. Clicking continue advances to step 2 AND fires
 *  the game's checkTarget (as it does on the fleet2 transition), carrying the
 *  `orders` map + any `errorCode`. #continueToFleet2 starts `.off`; the fake
 *  executor clears it once the target is applied (mirrors AGR).
 *  @param {{ errorCode?: number|null, orders?: Record<string,boolean>, mission?: number }} [opts] */
const buildFleet1 = (opts = {}) => {
  document.body.innerHTML = '';
  document.body.appendChild(el('div', 'fleet1'));
  document.body.appendChild(el('a', 'allresources'));
  const cont = el('a', 'continueToFleet2');
  cont.className = 'off';
  cont.addEventListener('click', () => {
    document.getElementById('fleet1')?.remove();
    const disp = el('a', 'dispatchFleet');
    disp.className = 'off'; // game not ready yet
    document.body.appendChild(disp);
    // The game fires its checkTarget as fleet2 loads.
    const t = lastTarget || {};
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: t.galaxy,
          system: t.system,
          position: t.position,
          errorCode: opts.errorCode ?? null,
          orders: opts.orders ?? { [String(opts.mission ?? 4)]: true },
        },
      }),
    );
  });
  document.body.appendChild(cont);
};

/** A fake MAIN executor. */
const fakeExecutor = (opts = /** @type {any} */ ({})) => {
  const onCmd = (/** @type {any} */ e) => {
    const { id, op, args } = /** @type {any} */ (e).detail;
    /** @type {any} */
    let res = { id, ok: true };
    if (op === 'selectShips') {
      res = { id, ok: true, data: { totalSelected: args.ships.reduce((/** @type {number} */ a, /** @type {any} */ s) => a + s.count, 0) } };
    } else if (op === 'setTarget') {
      lastTarget = args;
      res = { id, ok: true };
      // AGR enables "continue" once the target is applied.
      setTimeout(() => document.getElementById('continueToFleet2')?.classList.remove('off'), 0);
    } else if (op === 'setTargetType') {
      res = { id, ok: true };
    } else if (op === 'selectMission') {
      const ok = opts.missionOk ?? true;
      res = { id, ok, data: { available: ok } };
      if (ok) {
        setTimeout(() => document.getElementById('dispatchFleet')?.classList.remove('off'), 0);
      }
    }
    document.dispatchEvent(new CustomEvent('oge:fd:res', { detail: res }));
  };
  document.addEventListener('oge:fd:cmd', onCmd);
  return () => document.removeEventListener('oge:fd:cmd', onCmd);
};

/** Publish a ship-availability snapshot. */
const snapshot = (/** @type {any[]} */ shipsOnPlanet, orders = {}) =>
  document.dispatchEvent(
    new CustomEvent('oge:fleetDispatcher', { detail: { shipsOnPlanet, orders } }),
  );

const TARGET = { galaxy: 4, system: 472, position: 15, type: 1 };
let unhook = () => {};

beforeEach(() => {
  document.body.innerHTML = '';
  _resetFleetCourierForTest();
  _resetFleetOwnershipForTest();
  installFleetCourier();
});
afterEach(() => {
  unhook();
  _resetFleetCourierForTest();
  _resetFleetOwnershipForTest();
});

describe('step / readiness (from live DOM)', () => {
  it('reports off / fleet1 / fleet2', () => {
    expect(step()).toBe('off');
    document.body.appendChild(el('div', 'fleet1'));
    expect(step()).toBe('fleet1');
    document.body.appendChild(el('a', 'dispatchFleet'));
    expect(step()).toBe('fleet2'); // dispatch present wins
  });

  it('keys off VISIBILITY so a backButton fleet2→fleet1 swap is detected', () => {
    const f1 = el('div', 'fleet1');
    const f2 = el('div', 'fleet2');
    const disp = el('a', 'dispatchFleet');
    f2.appendChild(disp);
    document.body.append(f1, f2);
    // Both present, fleet2 shown → step 2.
    expect(step()).toBe('fleet2');
    // Player taps AGR "Powrót": fleet2 hidden, fleet1 shown → back to step 1
    // even though #dispatchFleet still exists in the (hidden) DOM.
    f2.style.display = 'none';
    expect(step()).toBe('fleet1');
  });

  it('readyToDispatch tracks the .off class', () => {
    const d = el('a', 'dispatchFleet');
    d.className = 'off';
    document.body.appendChild(d);
    expect(readyToDispatch()).toBe(false);
    d.classList.remove('off');
    expect(readyToDispatch()).toBe(true);
  });
});

describe('select — happy path', () => {
  it('selects (all), advances, checks target, sets mission and reaches ready', async () => {
    buildFleet1();
    unhook = fakeExecutor({ errorCode: null, missionOk: true });
    snapshot([{ id: 203, number: 100 }], { 4: true });

    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4, resources: 'all' });
    expect(r.ok).toBe(true);
    expect(step()).toBe('fleet2');
    expect(readyToDispatch()).toBe(true);
  });

  it('sets the target on fleet1 (AGR row), BEFORE continuing to fleet2', async () => {
    buildFleet1();
    // Record whether #fleet1 was still present when setTarget arrived — the
    // target must be set on AGR's fleet1 controls, never on fleet2 (which AGR
    // clobbers). A custom hook wraps the standard fake executor's replies.
    /** @type {string[]} */ const order = [];
    let stepAtSetTarget = '';
    const onCmd = (/** @type {any} */ e) => {
      const { op } = /** @type {any} */ (e).detail;
      order.push(op);
      if (op === 'setTarget') stepAtSetTarget = step();
    };
    document.addEventListener('oge:fd:cmd', onCmd);
    const unhookExec = fakeExecutor({ errorCode: null, missionOk: true });
    unhook = () => { document.removeEventListener('oge:fd:cmd', onCmd); unhookExec(); };
    snapshot([{ id: 203, number: 100 }], { 4: true });

    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(true);
    expect(stepAtSetTarget).toBe('fleet1');
    expect(order.indexOf('setTarget')).toBeLessThan(order.indexOf('selectMission'));
    // setTargetType is called after continueReady (i.e. after setTarget, before
    // selectMission) to re-arm the type in case AGR's async keyup handler reset it.
    expect(order.indexOf('setTargetType')).toBeGreaterThan(order.indexOf('setTarget'));
    expect(order.indexOf('setTargetType')).toBeLessThan(order.indexOf('selectMission'));
  });
});

describe('select — failures', () => {
  it('returns noShips when a required ship is missing (no executor needed)', async () => {
    buildFleet1();
    unhook = fakeExecutor();
    snapshot([{ id: 203, number: 0 }]);
    const r = await select({
      spec: { kind: 'list', ships: [{ id: 202, qty: 10, frac: 1 }] },
      target: TARGET,
      mission: 4,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('noShips');
    expect(r.shortfalls).toEqual([{ id: 202, want: 10, have: 0 }]);
  });

  it('surfaces a checkTarget error (and its tag)', async () => {
    buildFleet1({ errorCode: 140035 });
    unhook = fakeExecutor({ errorCode: 140035 });
    snapshot([{ id: 203, number: 100 }]);
    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('noShip'); // 140035 → noShip
    expect(r.errorCode).toBe(140035);
  });

  it('returns mission when the mission is not allowed on the target', async () => {
    // checkTarget orders say mission 4 is NOT permitted → fast fail, no poll.
    buildFleet1({ orders: { 4: false } });
    unhook = fakeExecutor({ errorCode: null, missionOk: false });
    snapshot([{ id: 203, number: 100 }]);
    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('mission');
  });

  it('returns offPage when not on fleetdispatch', async () => {
    unhook = fakeExecutor();
    snapshot([{ id: 203, number: 100 }]);
    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offPage');
  });

  it('returns allFleets immediately when every fleet slot is in use', async () => {
    // No DOM setup needed — the fleet-cap gate fires before any DOM walk.
    unhook = fakeExecutor();
    document.dispatchEvent(
      new CustomEvent('oge:fleetDispatcher', {
        detail: { shipsOnPlanet: [{ id: 202, number: 50 }], orders: {}, fleetCount: 18, maxFleetCount: 18 },
      }),
    );
    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('allFleets');
  });
});


describe('dispatch — tap 2', () => {
  it('does not click and resolves notReady when not ready', async () => {
    const d = el('a', 'dispatchFleet');
    d.className = 'off';
    let clicks = 0;
    d.addEventListener('click', () => (clicks += 1));
    document.body.appendChild(d);
    const r = await dispatch();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('notReady');
    expect(clicks).toBe(0);
  });

  it('clicks when ready and surfaces a rejected send (e.g. no fuel)', async () => {
    const d = el('a', 'dispatchFleet'); // ready (no .off)
    let clicks = 0;
    d.addEventListener('click', () => {
      clicks += 1;
      document.dispatchEvent(
        new CustomEvent('oge:sendFleetResult', {
          detail: { success: false, errorCode: 140026, mission: 4 },
        }),
      );
    });
    document.body.appendChild(d);
    const r = await dispatch();
    expect(clicks).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(140026);
  });

  it('resolves ok on a successful send', async () => {
    const d = el('a', 'dispatchFleet');
    d.addEventListener('click', () =>
      document.dispatchEvent(
        new CustomEvent('oge:sendFleetResult', {
          detail: { success: true, errorCode: null, mission: 4 },
        }),
      ),
    );
    document.body.appendChild(d);
    const r = await dispatch();
    expect(r.ok).toBe(true);
  });
});

describe('fleet2 ownership (T5)', () => {
  /** Mount a ready, session-less fleet2 (somebody else prepared it). */
  const buildForeignFleet2 = () => {
    document.body.innerHTML = '';
    document.body.appendChild(el('a', 'dispatchFleet')); // ready (no .off)
  };

  it('select(owner) refuses a session-less fleet2 without issuing any command', async () => {
    buildForeignFleet2();
    /** @type {string[]} */ const ops = [];
    const onCmd = (/** @type {any} */ e) => ops.push(e.detail.op);
    document.addEventListener('oge:fd:cmd', onCmd);
    unhook = () => document.removeEventListener('oge:fd:cmd', onCmd);
    snapshot([{ id: 203, number: 100 }], { 4: true });

    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4, owner: OWNER_FS });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('foreign');
    expect(ops).toEqual([]);
  });

  it('select without owner keeps the legacy (ungated) fleet2 behaviour', async () => {
    buildForeignFleet2();
    unhook = fakeExecutor({ missionOk: true });
    snapshot([{ id: 203, number: 100 }], { 4: true });
    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(true);
  });

  it('claims the session on the fleet1→fleet2 transition: owner may re-enter, others may not', async () => {
    buildFleet1();
    unhook = fakeExecutor({ errorCode: null, missionOk: true });
    snapshot([{ id: 203, number: 100 }], { 4: true });

    const first = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4, owner: OWNER_COL });
    expect(first.ok).toBe(true);
    expect(step()).toBe('fleet2');

    // Same owner re-enters on fleet2 (retry path) — allowed.
    const retry = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4, owner: OWNER_COL });
    expect(retry.ok).toBe(true);

    // A different button sees the same fleet2 — refused.
    const thief = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4, owner: OWNER_FS });
    expect(thief.ok).toBe(false);
    expect(thief.reason).toBe('foreign');
  });

  it('dispatch(owner) never clicks a foreign fleet2', async () => {
    buildForeignFleet2();
    const d = document.getElementById('dispatchFleet');
    let clicks = 0;
    d?.addEventListener('click', () => (clicks += 1));
    const r = await dispatch(OWNER_COL);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('foreign');
    expect(clicks).toBe(0);
  });

  it('dispatch(owner) clicks once the owner armed the fleet itself', async () => {
    buildFleet1();
    unhook = fakeExecutor({ errorCode: null, missionOk: true });
    snapshot([{ id: 203, number: 100 }], { 4: true });
    const sel = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4, owner: OWNER_COL });
    expect(sel.ok).toBe(true);

    document.getElementById('dispatchFleet')?.addEventListener('click', () =>
      document.dispatchEvent(
        new CustomEvent('oge:sendFleetResult', {
          detail: { success: true, errorCode: null, mission: 4 },
        }),
      ),
    );
    const r = await dispatch(OWNER_COL);
    expect(r.ok).toBe(true);
  });
});
