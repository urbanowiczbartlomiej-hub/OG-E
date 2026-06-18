// @vitest-environment happy-dom
//
// Behavioural tests for the MAIN-world fleet executor. We stand up a fake
// `window.fleetDispatcher`, drive oge:fd:cmd commands, and assert the
// oge:fd:res replies + that the right controller methods were called.
//
// @ts-check

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

  /** Build AGR's fleet1 coord row (#ago_galaxy/system/position + #ago_type spans). */
  const buildAgoRow = () => {
    document.body.innerHTML = `
      <td class="ago_coords">
        <input id="ago_galaxy" type="text" value="">
        <input id="ago_system" type="text" value="">
        <input id="ago_position" type="text" value="">
        <a id="ago_type" href="#">
          <span class="planet"></span>
          <span class="moon"></span>
        </a>
      </td>`;
  };

  it('setTarget writes AGR fleet1 coord inputs and clicks the moon span for type 3', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    let moonClicked = 0;
    let planetClicked = 0;
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon')).addEventListener(
      'click', () => { moonClicked += 1; });
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .planet')).addEventListener(
      'click', () => { planetClicked += 1; });

    const res = await command('setTarget', { galaxy: 4, system: 472, position: 15, type: 3 });
    expect(res.ok).toBe(true);
    expect(/** @type {HTMLInputElement} */ (document.getElementById('ago_galaxy')).value).toBe('4');
    expect(/** @type {HTMLInputElement} */ (document.getElementById('ago_system')).value).toBe('472');
    expect(/** @type {HTMLInputElement} */ (document.getElementById('ago_position')).value).toBe('15');
    expect(moonClicked).toBe(1);
    expect(planetClicked).toBe(0);
  });

  it('setTarget re-primes the moon flag until AGR marks #ago_type .moon selected', async () => {
    // Models the mobile first-load race: AGR's shortcuts handler isn't wired
    // for the first prime click (dropped), then wires up — the SECOND prime
    // is what flips the moon flag. primeTypeConfirmed must re-prime, not give
    // up after one try, so the send is aimed at the moon (not the planet).
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    const moonTypeSpan = /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon'));
    // Add the shortcuts panel the primer clicks; AGR reflects the flag in
    // #ago_type only from the 2nd prime onward.
    const shortcuts = document.createElement('td');
    shortcuts.className = 'ago_shortcuts_own';
    shortcuts.innerHTML = '<span class="ago_shortcuts_moon"></span>';
    document.body.appendChild(shortcuts);
    let primeClicks = 0;
    /** @type {HTMLElement} */ (shortcuts.querySelector('.ago_shortcuts_moon')).addEventListener(
      'click', () => {
        primeClicks += 1;
        if (primeClicks >= 2) moonTypeSpan.classList.add('selected');
      });

    const res = await command('setTarget', { galaxy: 4, system: 472, position: 15, type: 3 });
    expect(res.ok).toBe(true);
    expect(primeClicks).toBeGreaterThanOrEqual(2);
    expect(moonTypeSpan.classList.contains('selected')).toBe(true);
  });

  it('setTarget clicks the planet span for type 1 when planet is not already selected', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    let moonClicked = 0;
    let planetClicked = 0;
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon')).addEventListener(
      'click', () => { moonClicked += 1; });
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .planet')).addEventListener(
      'click', () => { planetClicked += 1; });

    const res = await command('setTarget', { galaxy: 1, system: 2, position: 3, type: 1 });
    expect(res.ok).toBe(true);
    expect(planetClicked).toBe(1);
    expect(moonClicked).toBe(0);
  });

  it('setTarget re-primes the planet flag until AGR marks #ago_type .planet selected', async () => {
    // Inverse of the moon race: AGR boots with moon selected by default but we
    // want a planet target. Same mechanism — re-prime until #ago_type reflects
    // planet — so the send isn't aimed at the moon. The flag only flips on the
    // 2nd prime here, modelling the first dropped click.
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    const planetTypeSpan = /** @type {HTMLElement} */ (document.querySelector('#ago_type .planet'));
    const moonTypeSpan = /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon'));
    moonTypeSpan.classList.add('selected'); // AGR default: moon active.
    const shortcuts = document.createElement('td');
    shortcuts.className = 'ago_shortcuts_own';
    shortcuts.innerHTML = '<span class="ago_shortcuts_coords"></span>';
    document.body.appendChild(shortcuts);
    let primeClicks = 0;
    /** @type {HTMLElement} */ (shortcuts.querySelector('.ago_shortcuts_coords')).addEventListener(
      'click', () => {
        primeClicks += 1;
        if (primeClicks >= 2) {
          moonTypeSpan.classList.remove('selected');
          planetTypeSpan.classList.add('selected');
        }
      });

    const res = await command('setTarget', { galaxy: 1, system: 2, position: 3, type: 1 });
    expect(res.ok).toBe(true);
    expect(primeClicks).toBeGreaterThanOrEqual(2);
    expect(planetTypeSpan.classList.contains('selected')).toBe(true);
    expect(moonTypeSpan.classList.contains('selected')).toBe(false);
  });

  it('setTarget does NOT re-click the type span when the wanted type is already selected', async () => {
    // AGR auto-applies coords from the inputs; re-clicking the already-active
    // type span re-fires action:42 and can stomp the just-applied target.
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    // Planet is the default-selected type in AGR's row.
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .planet')).classList.add('selected');
    let planetClicked = 0;
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .planet')).addEventListener(
      'click', () => { planetClicked += 1; });

    const res = await command('setTarget', { galaxy: 4, system: 5, position: 6, type: 1 });
    expect(res.ok).toBe(true);
    expect(/** @type {HTMLInputElement} */ (document.getElementById('ago_galaxy')).value).toBe('4');
    expect(planetClicked).toBe(0);
  });

  it('setTargetNative writes the native fleet2 coord inputs and nudges updateTarget', async () => {
    // The in-place retarget path: edit the game's OWN target row (td.targetCoords),
    // not AGR's fleet1 controls. fireInput drives the keystroke sequence the game
    // listens to; fd.updateTarget is the guarded re-validate nudge.
    const fd = makeFakeFd();
    /** @type {any} */ (window).fleetDispatcher = fd;
    document.body.innerHTML = `
      <td class="targetCoords">
        <input name="galaxy" id="galaxy" type="text" value="">
        <input name="system" id="system" type="text" value="">
        <input name="position" id="position" type="text" value="">
      </td>`;

    const res = await command('setTargetNative', { galaxy: 3, system: 265, position: 9 });
    expect(res.ok).toBe(true);
    expect(/** @type {HTMLInputElement} */ (document.getElementById('galaxy')).value).toBe('3');
    expect(/** @type {HTMLInputElement} */ (document.getElementById('system')).value).toBe('265');
    expect(/** @type {HTMLInputElement} */ (document.getElementById('position')).value).toBe('9');
    expect(fd.calls).toContainEqual(['updateTarget']);
  });

  it('setTargetNative tolerates a fleetDispatcher without updateTarget', async () => {
    // The nudge is guarded — a build lacking the method must not throw; the
    // input events alone trigger the game's re-check.
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd({ updateTarget: undefined });
    document.body.innerHTML = `
      <td class="targetCoords">
        <input id="galaxy" value=""><input id="system" value=""><input id="position" value="">
      </td>`;
    const res = await command('setTargetNative', { galaxy: 1, system: 2, position: 3 });
    expect(res.ok).toBe(true);
    expect(/** @type {HTMLInputElement} */ (document.getElementById('position')).value).toBe('3');
  });

  it('setTargetType clicks the moon span and is independent of setTarget', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    let moonClicked = 0;
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon')).addEventListener(
      'click', () => { moonClicked += 1; });

    const res = await command('setTargetType', { type: 3 });
    expect(res.ok).toBe(true);
    expect(moonClicked).toBe(1);
  });

  it('setTargetType skips the click when the span is already selected', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    buildAgoRow();
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon')).classList.add('selected');
    let moonClicked = 0;
    /** @type {HTMLElement} */ (document.querySelector('#ago_type .moon')).addEventListener(
      'click', () => { moonClicked += 1; });

    const res = await command('setTargetType', { type: 3 });
    expect(res.ok).toBe(true);
    expect(moonClicked).toBe(0);
  });

  it('selectMission clicks the available mission icon, reports unavailable otherwise', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    // mission4 is available ("on"); mission7 is present but not allowed.
    document.body.innerHTML = `
      <table class="missionSelection">
        <a class="missionIcon mission4 on" ago-data='{"mission":4}'></a>
        <a class="missionIcon mission7" ago-data='{"mission":7}'></a>
      </table>`;
    let m4Clicks = 0;
    /** @type {HTMLElement} */ (document.querySelector('.missionIcon.mission4'))
      .addEventListener('click', () => { m4Clicks += 1; });

    const ok = await command('selectMission', { mission: 4 });
    expect(ok.ok).toBe(true);
    expect(ok.data.available).toBe(true);
    expect(m4Clicks).toBe(1);

    const no = await command('selectMission', { mission: 7 });
    expect(no.ok).toBe(false);
    expect(no.data.available).toBe(false);
  });

  it('selectMission does NOT re-click an already-selected mission icon', async () => {
    /** @type {any} */ (window).fleetDispatcher = makeFakeFd();
    document.body.innerHTML = `
      <a class="missionIcon mission4 on selected" ago-data='{"mission":4}'></a>`;
    let clicks = 0;
    /** @type {HTMLElement} */ (document.querySelector('.missionIcon.mission4'))
      .addEventListener('click', () => { clicks += 1; });

    const res = await command('selectMission', { mission: 4 });
    expect(res.ok).toBe(true);
    expect(clicks).toBe(0);
  });

  it('replies with an error when no fleetDispatcher is present', async () => {
    const res = await command('selectShips', { ships: [{ id: 203, count: 1 }] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('noDispatcher');
  });
});
