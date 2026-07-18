// @vitest-environment happy-dom
//
// Behavioural tests for the unified FAB colony module — the state selection
// (navigate ↔ abandon ↔ none) and the abandon entry gate. (No settings gate:
// the Abandon module is event-driven — it mounts only when the page shows a
// give-up candidate, so it deliberately has no `show*Button` flag.)
// The 3-step flow itself is covered in abandon.test.js; here we assert the FAB
// surfaces the right button for the page and wires the tap.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installColonyFab, _resetColonyFabForTest } from '../../src/features/abandon/colonyFab.js';
import { _resetAbandonForTest } from '../../src/features/abandon/index.js';
import { _resetUnifiedFabForTest } from '../../src/features/shared/unifiedFab.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';
import { galaxyScanConfigStore } from '../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';

const BUTTON_ID = 'oge-colony-fab';

/** Reset every setting to its schema default. */
const setSettings = () => {
  /** @type {Record<string, unknown>} */
  const s = {};
  for (const key of /** @type {Array<keyof typeof SETTINGS_SCHEMA>} */ (Object.keys(SETTINGS_SCHEMA))) {
    s[key] = SETTINGS_SCHEMA[key].default;
  }
  settingsStore.set(/** @type {any} */ (s));
};

/** Stage the overview page of a fresh small colony. @param {string} [coords] */
const stageOverview = (coords = '[4:30:8]') => {
  location.search = '?page=ingame&component=overview&cp=12345';
  document.body.innerHTML = `
    <div id="diameterContentField">12345km (0/100)</div>
    <div id="positionContentField"><a>${coords}</a></div>
  `;
};

/** Stage a galaxy page with a fresh colony in the planet list (navigate state).
 * @param {number} [max] the colony's max fields (default below the keep threshold) */
const stageFreshElsewhere = (max = 163) => {
  location.search = '?page=ingame&component=galaxy';
  document.body.innerHTML = `
    <div id="planetList">
      <div class="smallplanet" id="planet-1002">
        <a class="planetlink" data-tooltip-title="Fresh [1:2:4] 9.000km (0/${max})">
          <span class="planet-name">Fresh</span>
        </a>
      </div>
    </div>`;
};

const labelText = () => document.getElementById(BUTTON_ID)?.textContent ?? '';

/** Stage an event list with one outbound colonization arriving `inSecs` from now. */
const stageColoLanding = (inSecs = 30) => {
  const arrival = Math.floor(Date.now() / 1000) + inSecs;
  const box = document.createElement('div');
  box.id = 'eventContent';
  box.innerHTML = `<table><tbody>
    <tr class="eventFleet" id="eventRow-0" data-mission-type="7"
        data-return-flight="false" data-arrival-time="${arrival}"></tr>
  </tbody></table>`;
  document.body.appendChild(box);
};

beforeEach(() => {
  _resetColonyFabForTest();
  _resetAbandonForTest();
  _resetUnifiedFabForTest();
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
  document.body.innerHTML = '';
  localStorage.clear(); // drop any coloArrival cache written by a prior case
  location.search = '';
  setSettings();
});

afterEach(() => {
  _resetColonyFabForTest();
  _resetUnifiedFabForTest();
  document.body.innerHTML = '';
  location.search = '';
});

describe('colony FAB — state selection', () => {
  it('mounts the NAVIGATE button (red Abandon identity) for a small fresh colony elsewhere', () => {
    stageFreshElsewhere(163);
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
    // Same look as the on-overview ABANDON state: "Abandon" + the field count.
    expect(labelText()).toMatch(/Abandon/);
    expect(labelText()).toMatch(/163 fields/);
  });

  it('does NOT flag a fresh colony that is large enough to keep', () => {
    // 400 max ≥ default colonyMinFields (320) → not a give-up candidate.
    stageFreshElsewhere(400);
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });

  it('mounts the ABANDON button on a fresh small colony overview', () => {
    stageOverview();
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
    expect(labelText()).toMatch(/Abandon/);
    expect(labelText()).toMatch(/100 fields/);
  });

  it('mounts nothing when there is neither a fresh colony nor an abandon target', () => {
    location.search = '?page=ingame&component=galaxy';
    document.body.innerHTML = '<div id="planetList"></div>';
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });

  it('mounts a landing countdown when a colonization is arriving within the window', () => {
    location.search = '?page=ingame&component=galaxy';
    document.body.innerHTML = '<div id="planetList"></div>';
    stageColoLanding(30);
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)).not.toBeNull();
    expect(labelText()).toMatch(/colo landing/);
  });

  it('prioritises abandoning a small fresh colony over a pending landing', () => {
    // Both a give-up candidate AND a colonization landing soon are present:
    // the existing abandon/navigate logic must win; the countdown never shows.
    stageFreshElsewhere(163);
    stageColoLanding(30);
    installColonyFab();
    expect(labelText()).toMatch(/Abandon/);
    expect(labelText()).not.toMatch(/colo landing/);
  });

  it('pulses the FAB while a landing countdown is running — matches Spyglass\'s "anything queued" rule', () => {
    location.search = '?page=ingame&component=galaxy';
    document.body.innerHTML = '<div id="planetList"></div>';
    stageColoLanding(30);
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)?.classList.contains('oge-fab-alert')).toBe(true);
  });

  it('does not pulse when there is nothing queued (no fresh colony, no landing)', () => {
    location.search = '?page=ingame&component=galaxy';
    document.body.innerHTML = '<div id="planetList"></div>';
    installColonyFab();
    expect(document.getElementById(BUTTON_ID)).toBeNull();
  });
});

describe('colony FAB — abandon entry gate', () => {
  it('prompts to set a password when none is configured', async () => {
    stageOverview();
    // default config has an empty colonyPassword
    installColonyFab();
    // A single-zone button IS its outer element — the click handler lives on
    // `#oge-colony-fab` itself (no separate `-go` sub-element).
    const btn = document.getElementById(BUTTON_ID);
    expect(btn).not.toBeNull();
    btn?.dispatchEvent(new Event('click', { bubbles: true }));
    // onAbandonTap now awaits whenGalaxyScanConfigHydrated() before reading the
    // password (the slow-device race fix). The store was set directly here, not
    // via init*, so the gate is the pre-resolved sentinel — one microtask flush
    // lets the handler proceed to the password check.
    await Promise.resolve();
    await Promise.resolve();
    expect(labelText()).toMatch(/Set password/);
  });
});
