// @vitest-environment happy-dom
//
// DOM tests for the event-list reminder badges. Regression-locks the bug
// where stamping a cell overwrote its className wholesale and stripped
// OGame's `arrivalTime` class — after which `render` could no longer find
// the cell (`td.arrivalTime`), so clicks only showed up after a reload.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';
import { parseUniverseId } from '../../src/lib/universeId.js';
import { writePending } from '../../src/features/reminders/pending.js';
import {
  installEventListReminders, _resetEventListRemindersForTest,
} from '../../src/features/reminders/eventList.js';

const VALID_TOKEN = 'tk_tbqdljrkz4ivlgagxwewjz17k26gw';
const tick = () => new Promise((r) => setTimeout(r, 0));

/** @param {Partial<import('../../src/state/settings.js').Settings>} [over] */
const setSettings = (over = {}) => {
  /** @type {Record<string, unknown>} */
  const d = {};
  for (const k of Object.keys(SETTINGS_SCHEMA)) d[k] = SETTINGS_SCHEMA[/** @type {keyof typeof SETTINGS_SCHEMA} */ (k)].default;
  settingsStore.set(/** @type {any} */ ({ ...d, ...over }));
};

/** Paint one outbound fleet row with a real arrivalTime cell. @param {number} arrival */
const paintRow = (arrival) => {
  document.body.innerHTML = `
    <table id="eventContent"><tbody>
      <tr class="eventFleet" id="eventRow-42" data-mission-type="15" data-return-flight="false" data-arrival-time="${arrival}">
        <td class="arrivalTime" original="x">20:23:20</td>
        <td class="destCoords"><a>[4:467:16]</a></td>
      </tr>
    </tbody></table>`;
  return /** @type {HTMLElement} */ (document.querySelector('td.arrivalTime'));
};

const stubApi = () => ({
  armAdhoc: vi.fn((entry) => writePending(parseUniverseId(location.host), [{ kind: 'arm', entry }])),
  disarmAdhoc: vi.fn(),
  cancelWave: vi.fn(),
  resendWave: vi.fn(),
});

beforeEach(() => {
  _resetEventListRemindersForTest();
  localStorage.clear();
  document.body.innerHTML = '';
  setSettings({ remindersMasterEnabled: true, adhocEnabled: true, reminderEnabled: false, reminderNtfyToken: VALID_TOKEN, adhocOffsetSec: 60 });
});

afterEach(() => {
  _resetEventListRemindersForTest();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('event-list badges', () => {
  it('stamps an idle ad-hoc badge while KEEPING the arrivalTime class', async () => {
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600); // 1h ahead, schedulable
    installEventListReminders(stubApi());
    await tick();

    expect(cell.classList.contains('arrivalTime')).toBe(true); // foreign class survives
    expect(cell.classList.contains('oge-rem-badge')).toBe(true);
    expect(cell.classList.contains('idle')).toBe(true);
    expect(cell.classList.contains('act')).toBe(true);
    expect(cell.getAttribute('data-oge-act')).toBe('arm');
  });

  it('a click arms and the SAME cell flips to armed on the next render (regression)', async () => {
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600);
    const api = stubApi();
    installEventListReminders(api);
    await tick();

    cell.click();

    expect(api.armAdhoc).toHaveBeenCalledTimes(1);
    expect(api.armAdhoc.mock.calls[0][0]).toMatchObject({ id: 'eventRow-42', offsetSec: 60 });
    // render() ran inside the click handler, re-found the cell (arrivalTime
    // intact) and reflected the queued intent.
    expect(cell.classList.contains('arrivalTime')).toBe(true);
    expect(cell.classList.contains('armed')).toBe(true);
    expect(cell.classList.contains('syncing')).toBe(true);
    expect(cell.getAttribute('data-oge-act')).toBe('disarm');
  });

  it('disables a leg whose fire time is past the 3-day cap', async () => {
    const cell = paintRow(Math.floor(Date.now() / 1000) + 10 * 24 * 3600); // 10 days
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('disabled')).toBe(true);
    expect(cell.getAttribute('data-oge-act')).toBeNull();
  });

  it('shows no badge when the ntfy token is missing', async () => {
    setSettings({ remindersMasterEnabled: true, adhocEnabled: true, reminderEnabled: false, reminderNtfyToken: '', adhocOffsetSec: 60 });
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('oge-rem-badge')).toBe(false);
    expect(cell.classList.contains('arrivalTime')).toBe(true);
  });

  it('shows no badge when the master switch is off (token present)', async () => {
    setSettings({ remindersMasterEnabled: false, adhocEnabled: true, reminderEnabled: false, reminderNtfyToken: VALID_TOKEN, adhocOffsetSec: 60 });
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('oge-rem-badge')).toBe(false);
    expect(cell.classList.contains('arrivalTime')).toBe(true);
  });
});
