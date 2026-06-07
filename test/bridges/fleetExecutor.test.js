// @vitest-environment happy-dom
//
// Behavioural tests for the MAIN-world fleet executor. We stand up a fake
// `window.fleetDispatcher`, drive oge:fd:cmd commands, and assert the
// oge:fd:res replies + that the right controller methods were called.
//
// @ts-check
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installFleetExecutor,
  _resetFleetExecutorForTest,
} from '../../src/bridges/fleetExecutor.js';
import { FD_CMD_EVENT, FD_RES_EVENT } from '../../src/lib/fleetProtocol.js';

/** Build a recording fake fleetDispatcher. */
const makeFakeFd = (over = /** @type {any} */ ({})) => {
  const calls = /** @type {any[]} */ ([]);
  const fd = {
    calls,
    shipsToSend: /** @type {any[]} */ ([]),
    resetShips() {
      calls.push(['resetShips']);
      fd.shipsToSend = [];
    },
    selectShip(/** @type {number} */ id, /** @type {number} */ n) {
      calls.push(['selectShip', id, n]);
      fd.shipsToSend.push({ id, number: n });
    },
    refresh() {
      calls.push(['refresh']);
    },
    getTotalNumberOfShipsSelected() {
      return fd.shipsToSend.reduce((/** @type {number} */ a, /** @type {any} */ s) => a + s.number, 0);
    },
    setTargetPlanet(/** @type {any} */ t) {
      calls.push(['setTargetPlanet', t]);
    },
    setTargetType(/** @type {any} */ t) {
      calls.push(['setTargetType', t]);
    },
    updateTarget() {
      calls.push(['updateTarget']);
    },
    isMissionAvailable(/** @type {number} */ m) {
      return m === 4;
    },
    selectMission(/** @type {number} */ m) {
      calls.push(['selectMission', m]);
    },
    ...over,
  };
  return fd;
};

/** Send a command and resolve its reply detail. */
const command = (/** @type {string} */ op, /** @type {any} */ args) =>
  new Promise((resolve) => {
    const id = Math.floor(performance.now()) + Math.random();
    const onRes = (/** @type {any} */ e) => {
      const d = /** @type {any} */ (e).detail;
      if (d && d.id === id) {
        document.removeEventListener(FD_RES_EVENT, onRes);
        resolve(d);
      }
    };
    document.addEventListener(FD_RES_EVENT, onRes);
    document.dispatchEvent(new CustomEvent(FD_CMD_EVENT, { detail: { id, op, args } }));
  });

beforeEach(() => {
  document.body.innerHTML = '';
  installFleetExecutor();
});

afterEach(() => {
  _resetFleetExecutorForTest();
  delete (/** @type {any} */ (window).fleetDispatcher);
});

describe('fleetExecutor', () => {
  it('selectShips resets, selects each, refreshes and reports the total', async () => {
    const fd = makeFakeFd();
    /** @type {any} */ (window).fleetDispatcher = fd;
    const res = await command('selectShips', {
      ships: [
        { id: 203, count: 2 },
        { id: 202, count: 5 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.data.totalSelected).toBe(7);
    expect(fd.calls[0]).toEqual(['resetShips']);
    expect(fd.calls).toContainEqual(['selectShip', 203, 2]);
    expect(fd.calls).toContainEqual(['selectShip', 202, 5]);
    expect(fd.calls).toContainEqual(['refresh']);
  });

  it('selectShips is not ok when nothing got selected', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    const res = await command('selectShips', { ships: [] });
    expect(res.ok).toBe(false);
    expect(res.data.totalSelected).toBe(0);
  });

  it('setTarget sets the planet/type and fires updateTarget', async () => {
    const fd = makeFakeFd();
    /** @type {any} */ (window).fleetDispatcher = fd;
    const res = await command('setTarget', { galaxy: 4, system: 472, position: 15, type: 1 });
    expect(res.ok).toBe(true);
    expect(fd.calls).toContainEqual(['setTargetPlanet', { galaxy: 4, system: 472, position: 15, type: 1 }]);
    expect(fd.calls).toContainEqual(['updateTarget']);
  });

  it('selectMission selects when available, reports unavailable otherwise', async () => {
    const fd = makeFakeFd();
    /** @type {any} */ (window).fleetDispatcher = fd;
    const ok = await command('selectMission', { mission: 4 });
    expect(ok.ok).toBe(true);
    expect(ok.data.available).toBe(true);
    expect(fd.calls).toContainEqual(['selectMission', 4]);

    const no = await command('selectMission', { mission: 7 });
    expect(no.ok).toBe(false);
    expect(no.data.available).toBe(false);
  });

  it('replies with an error when no fleetDispatcher is present', async () => {
    const res = await command('selectShips', { ships: [{ id: 203, count: 1 }] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('noDispatcher');
  });
});
