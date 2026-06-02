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
import { REMINDER_MIRROR_KEY } from '../../src/sync/reminders.js';
import {
  installEventListReminders, _resetEventListRemindersForTest,
} from '../../src/features/reminders/eventList.js';

const VALID_TOKEN = 'tk_tbqdljrkz4ivlgagxwewjz17k26gw';
const tick = () => new Promise((r) => setTimeout(r, 0));

// In-memory chrome.storage.local stub — the event-list badge reads the
// reminder mirror from it (fleet-save badges are mirror-driven). Empty by
// default ⇒ snapshot is null ⇒ behaves exactly as "no extension API".
/** @type {Record<string, unknown>} */
let chromeStoreData = {};
const installChromeStub = () => {
  chromeStoreData = {};
  /** @type {any} */ (globalThis).chrome = {
    storage: {
      local: {
        get: (/** @type {string} */ key, /** @type {Function} */ cb) => cb({ [key]: chromeStoreData[key] }),
        set: (/** @type {Record<string, unknown>} */ items, /** @type {Function} */ cb) => { Object.assign(chromeStoreData, items); cb && cb(); },
        remove: (/** @type {string} */ key, /** @type {Function} */ cb) => { delete chromeStoreData[key]; cb && cb(); },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
};

/** Seed this universe's mirror slice with a fleet-save set. @param {object[]} fleetSave */
const seedMirror = (fleetSave) => {
  chromeStoreData[REMINDER_MIRROR_KEY] = {
    [parseUniverseId(location.host)]: {
      version: 5, waves: [], notifyState: {}, adhoc: [], adhocNotify: {},
      fleetSave, fleetSaveNotify: {},
    },
  };
};

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
  installChromeStub();
  localStorage.clear();
  document.body.innerHTML = '';
  setSettings({ remindersMasterEnabled: true, adhocEnabled: true, reminderEnabled: false, reminderNtfyToken: VALID_TOKEN, adhocOffsetSec: 60 });
});

afterEach(() => {
  _resetEventListRemindersForTest();
  delete (/** @type {any} */ (globalThis).chrome);
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

  it('labels an outbound leg with its DESTINATION coords', async () => {
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600);
    const api = stubApi();
    installEventListReminders(api);
    await tick();
    cell.click();
    expect(api.armAdhoc.mock.calls[0][0].label).toBe('Expedition → [4:467:16]');
  });

  it('stamps a passive, non-clickable 🛡 badge for a leg the mirror marks as a fleet-save', async () => {
    setSettings({
      remindersMasterEnabled: true, adhocEnabled: true, reminderEnabled: false,
      reminderNtfyToken: VALID_TOKEN, fsEnabled: true,
    });
    const base = Math.floor(Date.now() / 1000) + 3600;
    seedMirror([{
      id: 'eventRow-42', arrivalAt: base, shipCount: 8256872, label: 'Deployment → [4:478:14]',
      offsetsSec: [-600, 0, 600], fireAts: [base - 600, base, base + 600],
    }]);
    const cell = paintRow(base);
    installEventListReminders(stubApi());
    await tick();

    expect(cell.classList.contains('arrivalTime')).toBe(true); // foreign class survives
    expect(cell.classList.contains('fs')).toBe(true);
    expect(cell.classList.contains('act')).toBe(false); // non-clickable
    expect(cell.getAttribute('data-oge-act')).toBeNull();
    // FS outranks the ad-hoc idle badge on the same row.
    expect(cell.classList.contains('idle')).toBe(false);
    // Tooltip lists the registered ntfy times + the auto hint, and drops the
    // redundant mission / coords / ship-count the player already sees.
    const title = cell.getAttribute('title') || '';
    expect(title.startsWith('Fleet-save reminders at:')).toBe(true);
    expect(title).toContain("can't be cancelled");
    expect(title).not.toContain('Deployment');
    expect(title).not.toContain('ships');
  });

  it('shows the bare auto hint (no times) for a fleet-save still beyond the 3-day cap', async () => {
    setSettings({
      remindersMasterEnabled: true, adhocEnabled: true, reminderEnabled: false,
      reminderNtfyToken: VALID_TOKEN, fsEnabled: true,
    });
    const far = Math.floor(Date.now() / 1000) + 5 * 24 * 3600; // 5 days out
    seedMirror([{
      id: 'eventRow-42', arrivalAt: far, shipCount: 8256872, label: 'Deployment → [4:478:14]',
      offsetsSec: [-600, 0, 600], fireAts: [far - 600, far, far + 600],
    }]);
    const cell = paintRow(far);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('fs')).toBe(true);
    expect(cell.getAttribute('title')).toBe("Fleet-save reminder set automatically (can't be cancelled)");
  });

  it('shows the fire time on an armed ad-hoc badge', async () => {
    const base = Math.floor(Date.now() / 1000) + 3600;
    chromeStoreData[REMINDER_MIRROR_KEY] = {
      [parseUniverseId(location.host)]: {
        version: 5, waves: [], notifyState: {},
        adhoc: [{ id: 'eventRow-42', arrivalAt: base, offsetSec: 60, fireAt: base - 60 }],
        adhocNotify: {}, fleetSave: [], fleetSaveNotify: {},
      },
    };
    const cell = paintRow(base);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('armed')).toBe(true);
    const title = cell.getAttribute('title') || '';
    expect(title.startsWith('Reminder at ')).toBe(true);
    expect(title).toContain('click to cancel');
  });

  it('does NOT flag a leg the mirror omits (stays an ad-hoc idle badge — short hops never get a 🛡)', async () => {
    setSettings({
      remindersMasterEnabled: true, adhocEnabled: true, reminderEnabled: false,
      reminderNtfyToken: VALID_TOKEN, fsEnabled: true, adhocOffsetSec: 60,
    });
    seedMirror([]); // producer classified nothing as a save (e.g. a short hop)
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('fs')).toBe(false);
    expect(cell.classList.contains('idle')).toBe(true);
    expect(cell.getAttribute('data-oge-act')).toBe('arm');
  });

  it('labels a RETURN leg with its ORIGIN coords (where it actually lands)', async () => {
    // A returning fleet lands at its home/start position (`.coordsOrigin`),
    // NOT the target it is leaving (`.destCoords`). Regression-locks the bug
    // where every return was labelled with the destination it flew away from.
    const arrival = Math.floor(Date.now() / 1000) + 3600;
    document.body.innerHTML = `
      <table id="eventContent"><tbody>
        <tr class="eventFleet" id="eventRow-7" data-mission-type="15" data-return-flight="true" data-arrival-time="${arrival}">
          <td class="arrivalTime" original="x">20:23:20</td>
          <td class="coordsOrigin"><a>[1:22:3]</a></td>
          <td class="destCoords"><a>[4:467:16]</a></td>
        </tr>
      </tbody></table>`;
    const cell = /** @type {HTMLElement} */ (document.querySelector('td.arrivalTime'));
    const api = stubApi();
    installEventListReminders(api);
    await tick();
    cell.click();
    expect(api.armAdhoc.mock.calls[0][0].label).toBe('Expedition → [1:22:3]');
  });
});
