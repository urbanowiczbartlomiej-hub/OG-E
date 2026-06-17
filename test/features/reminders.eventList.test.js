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
import { galaxyScanConfigStore } from '../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';
import { reminderConfigStore } from '../../src/state/reminderConfig.js';
import { defaultReminderConfig } from '../../src/domain/reminderConfig.js';
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

/**
 * Fleet-save enable is per-universe (B3) — it lives in the galaxyScanConfig
 * store, not Settings. Set it (resetting the rest of the config to defaults).
 *
 * @param {boolean} on
 */
const setFsEnabled = (on) => galaxyScanConfigStore.set({ ...defaultGalaxyScanConfig(), fsEnabled: on });

/**
 * Wave enable + ad-hoc lead time are per-universe — they live in the
 * reminderConfig store, not Settings. Set them (defaulting the rest).
 *
 * @param {Partial<import('../../src/domain/reminderConfig.js').ReminderConfig>} [over]
 */
const setGlobalConfig = (over = {}) =>
  reminderConfigStore.set({ ...defaultReminderConfig(), ...over });

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
  setSettings({ remindersMasterEnabled: true, reminderNtfyToken: VALID_TOKEN });
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
  setGlobalConfig();
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
    setSettings({ remindersMasterEnabled: true, reminderNtfyToken: '' });
    const cell = paintRow(Math.floor(Date.now() / 1000) + 3600);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('oge-rem-badge')).toBe(false);
    expect(cell.classList.contains('arrivalTime')).toBe(true);
  });

  it('shows no badge when the master switch is off (token present)', async () => {
    setSettings({ remindersMasterEnabled: false, reminderNtfyToken: VALID_TOKEN });
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
      remindersMasterEnabled: true, reminderNtfyToken: VALID_TOKEN,
    });
    setFsEnabled(true);
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
    // Far from any slot's window → passive, but the tooltip now advertises the
    // last-3-min cancel affordance (T4: FS_CANCEL_WINDOW_SEC 120 → 180)
    // instead of the old "can't be cancelled".
    expect(title).toContain('final 3 min');
    // Outside the window the cancellable pulse class must NOT be present.
    expect(cell.classList.contains('fs-cancel')).toBe(false);
    expect(title).not.toContain('Deployment');
    expect(title).not.toContain('ships');
  });

  it('dims the 🛡 badge and explains the wait for a fleet-save still beyond the 3-day cap', async () => {
    setSettings({
      remindersMasterEnabled: true, reminderNtfyToken: VALID_TOKEN,
    });
    setFsEnabled(true);
    const far = Math.floor(Date.now() / 1000) + 5 * 24 * 3600; // 5 days out
    seedMirror([{
      id: 'eventRow-42', arrivalAt: far, shipCount: 8256872, label: 'Deployment → [4:478:14]',
      offsetsSec: [-600, 0, 600], fireAts: [far - 600, far, far + 600],
    }]);
    const cell = paintRow(far);
    installEventListReminders(stubApi());
    await tick();
    expect(cell.classList.contains('fs')).toBe(true);
    // Nothing is queued yet → dimmed, and the tooltip says why instead of the
    // old misleading "Set automatically".
    expect(cell.classList.contains('disabled')).toBe(true);
    const title = cell.getAttribute('title') || '';
    expect(title).toContain('Too far out');
    expect(title).toContain('within 3 days');
    expect(title).not.toContain('Fleet-save reminders at:'); // no times — none scheduled
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
      remindersMasterEnabled: true, reminderNtfyToken: VALID_TOKEN,
    });
    setFsEnabled(true);
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

  // ── Fleet-save slot cancellation (within the final 2-min window) ──────

  /** Settings with FS on, plus a click-capable api carrying cancelFsSlot. */
  const fsApi = () => ({ ...stubApi(), cancelFsSlot: vi.fn() });
  const enableFs = () => {
    setSettings({
      remindersMasterEnabled: true, reminderNtfyToken: VALID_TOKEN,
    });
    setFsEnabled(true);
  };

  it('makes the 🛡 badge clickable inside a slot\'s final 3 min and cancels just that slot', async () => {
    enableFs();
    const now = Math.floor(Date.now() / 1000);
    // Nearest upcoming slot fires in 20 s (inside the 3-min window) and is NOT
    // the last pre-landing one (−60 still follows), so only it is cancelled.
    const arrivalAt = now + 200;
    seedMirror([{
      id: 'eventRow-42', arrivalAt, shipCount: 8256872, label: 'Deployment → [4:478:14]',
      offsetsSec: [-180, -60, 0], fireAts: [arrivalAt - 180, arrivalAt - 60, arrivalAt],
    }]);
    const cell = paintRow(arrivalAt);
    const api = fsApi();
    installEventListReminders(api);
    await tick();

    expect(cell.classList.contains('fs')).toBe(true);
    expect(cell.classList.contains('act')).toBe(true);
    expect(cell.getAttribute('data-oge-act')).toBe('cancelFs');
    // T4: the cancellable state now carries the pulsing `fs-cancel` class
    // and the tooltip leads with "Cancellable now".
    expect(cell.classList.contains('fs-cancel')).toBe(true);
    expect(cell.getAttribute('title') || '').toContain(
      'Cancellable now — click to cancel this reminder',
    );

    cell.click();
    expect(api.cancelFsSlot).toHaveBeenCalledTimes(1);
    expect(api.cancelFsSlot.mock.calls[0][0]).toBe('eventRow-42');
    expect(api.cancelFsSlot.mock.calls[0][1]).toEqual([-180]); // just the nearest slot
  });

  it('cancelling the LAST pre-landing slot collapses the landing/after slots too', async () => {
    enableFs();
    const now = Math.floor(Date.now() / 1000);
    // Nearest upcoming (−60, fires in 20 s) IS the last pre-landing slot, so
    // the click also drops the at-landing (0) and after (+600) reminders.
    const arrivalAt = now + 80;
    seedMirror([{
      id: 'eventRow-42', arrivalAt, shipCount: 8256872, label: 'Deployment → [4:478:14]',
      offsetsSec: [-60, 0, 600], fireAts: [arrivalAt - 60, arrivalAt, arrivalAt + 600],
    }]);
    const cell = paintRow(arrivalAt);
    const api = fsApi();
    installEventListReminders(api);
    await tick();

    expect(cell.getAttribute('data-oge-act')).toBe('cancelFs');
    expect(cell.getAttribute('title') || '').toContain('landing/after');

    cell.click();
    expect(api.cancelFsSlot).toHaveBeenCalledTimes(1);
    expect(api.cancelFsSlot.mock.calls[0][1]).toEqual([-60, 0, 600]);
  });

  it('keeps the 🛡 badge passive when the nearest slot is still beyond its 2-min window', async () => {
    enableFs();
    const now = Math.floor(Date.now() / 1000);
    const arrivalAt = now + 3600; // nearest slot ~50 min out → not yet cancellable
    seedMirror([{
      id: 'eventRow-42', arrivalAt, shipCount: 8256872, label: 'Deployment → [4:478:14]',
      offsetsSec: [-600, 0, 600], fireAts: [arrivalAt - 600, arrivalAt, arrivalAt + 600],
    }]);
    const cell = paintRow(arrivalAt);
    const api = fsApi();
    installEventListReminders(api);
    await tick();

    expect(cell.classList.contains('fs')).toBe(true);
    expect(cell.classList.contains('act')).toBe(false);
    expect(cell.getAttribute('data-oge-act')).toBeNull();
    cell.click();
    expect(api.cancelFsSlot).not.toHaveBeenCalled();
  });
});
