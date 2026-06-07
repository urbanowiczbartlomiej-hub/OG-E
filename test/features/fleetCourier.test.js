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

/** @param {string} tag @param {string} id */
const el = (tag, id) => {
  const e = document.createElement(tag);
  e.id = id;
  return e;
};

/** Mount a fresh step-1 DOM. Clicking continue advances to step 2. */
const buildFleet1 = () => {
  document.body.innerHTML = '';
  document.body.appendChild(el('div', 'fleet1'));
  document.body.appendChild(el('a', 'allresources'));
  const cont = el('a', 'continueToFleet2');
  cont.addEventListener('click', () => {
    document.getElementById('fleet1')?.remove();
    const disp = el('a', 'dispatchFleet');
    disp.className = 'off'; // game not ready yet
    document.body.appendChild(disp);
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
      res = { id, ok: true };
      setTimeout(() => {
        document.dispatchEvent(
          new CustomEvent('oge:checkTargetResult', {
            detail: {
              galaxy: args.galaxy,
              system: args.system,
              position: args.position,
              errorCode: opts.errorCode ?? null,
            },
          }),
        );
      }, 0);
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
  installFleetCourier();
});
afterEach(() => {
  unhook();
  _resetFleetCourierForTest();
});

describe('step / readiness (from live DOM)', () => {
  it('reports off / fleet1 / fleet2', () => {
    expect(step()).toBe('off');
    document.body.appendChild(el('div', 'fleet1'));
    expect(step()).toBe('fleet1');
    document.body.appendChild(el('a', 'dispatchFleet'));
    expect(step()).toBe('fleet2'); // dispatch present wins
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
    buildFleet1();
    unhook = fakeExecutor({ errorCode: 140035 });
    snapshot([{ id: 203, number: 100 }]);
    const r = await select({ spec: { kind: 'all' }, target: TARGET, mission: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('noShip'); // 140035 → noShip
    expect(r.errorCode).toBe(140035);
  });

  it('returns mission when the mission is not allowed on the target', async () => {
    buildFleet1();
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
