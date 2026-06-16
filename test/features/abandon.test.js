// @vitest-environment happy-dom
//
// Unit tests for the abandon stepper (`createAbandonFlow`) + `checkAbandonState`.
//
// # What we cover
//
//   1. `checkAbandonState` — pure DOM gate (overview + used===0 + small).
//   2. `createAbandonFlow` entry gates — returns null on a bad state, a
//      missing password, malformed coords, or while another flow is active.
//   3. The 3-step flow — `advance()` walks opened → submitted → done, with the
//      coords-match safety gate aborting a mismatched popup. happy-dom can't
//      replicate OGame's jQuery UI, so we stage the popup DOM the stepper reads
//      and drive `waitFor` polls with fake timers (same approach the previous
//      injected-button flow used).
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAbandonState,
  createAbandonFlow,
  _resetAbandonForTest,
} from '../../src/features/abandon/index.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';
import { galaxyScanConfigStore } from '../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../src/domain/galaxyScanConfig.js';
import { scansStore } from '../../src/state/scans.js';

const resetSettingsToDefaults = () => {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const key of /** @type {Array<keyof typeof SETTINGS_SCHEMA>} */ (Object.keys(SETTINGS_SCHEMA))) {
    defaults[key] = SETTINGS_SCHEMA[key].default;
  }
  settingsStore.set(/** @type {any} */ (defaults));
};

/**
 * Paint the overview page bits `checkAbandonState` + the flow read on entry.
 *
 * @param {{ isOverview?: boolean, usedFields?: number, maxFields?: number, coords?: string }} [opts]
 * @returns {void}
 */
const setupOverviewScene = ({
  isOverview = true,
  usedFields = 0,
  maxFields = 100,
  coords = '[4:30:8]',
} = {}) => {
  location.search = isOverview
    ? '?page=ingame&component=overview&cp=12345'
    : '?page=ingame&component=galaxy';
  document.body.innerHTML = `
    <div id="diameterContentField">12345km (${usedFields}/${maxFields})</div>
    <div id="positionContentField"><a>${coords}</a></div>
  `;
};

/** Set the per-universe colony password. @param {string} pw */
const setPassword = (pw) =>
  galaxyScanConfigStore.set({ ...galaxyScanConfigStore.get(), colonyPassword: pw });

/**
 * Append the giveup popup scaffold (coords + #block + visible #validate with
 * password/submit inputs) the first step reads.
 *
 * @param {string} [coords]
 * @returns {void}
 */
const stageGiveupPopup = (coords = '[4:30:8]') => {
  const scaffold = document.createElement('div');
  scaffold.innerHTML = `
    <a class="openPlanetRenameGiveupBox" href="#"></a>
    <div id="abandonplanet">
      <span id="giveupCoordinates">${coords}</span>
      <button id="block"></button>
      <div id="validate">
        <input type="password" />
        <input type="submit" />
      </div>
    </div>
  `;
  document.body.appendChild(scaffold);
};

/** Append the confirm dialog the second step waits for. @param {string} [coords] */
const stageConfirmDialog = (coords = '[4:30:8]') => {
  const box = document.createElement('div');
  box.id = 'errorBoxDecision';
  box.innerHTML = `<div>Really give up ${coords}?</div><button class="yes">Yes</button>`;
  document.body.appendChild(box);
};

beforeEach(() => {
  resetSettingsToDefaults();
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
  scansStore.set({});
  document.body.innerHTML = '';
  location.search = '';
  _resetAbandonForTest();
});

afterEach(() => {
  _resetAbandonForTest();
  scansStore.set({});
  document.body.innerHTML = '';
  location.search = '';
});

describe('checkAbandonState', () => {
  it('returns the parsed triple for a fresh small colony', () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    expect(checkAbandonState()).toEqual({ used: 0, max: 100, minFields: 320 });
  });

  it('returns null when not on the overview', () => {
    setupOverviewScene({ isOverview: false });
    expect(checkAbandonState()).toBeNull();
  });

  it('returns null when max fields is at or above minFields', () => {
    setupOverviewScene({ usedFields: 0, maxFields: 350 });
    expect(checkAbandonState()).toBeNull();
  });

  it('returns null when the planet is already built (usedFields > 0)', () => {
    setupOverviewScene({ usedFields: 5, maxFields: 100 });
    expect(checkAbandonState()).toBeNull();
  });
});

describe('createAbandonFlow — entry gates', () => {
  it('returns null when checkAbandonState is invalid (not overview)', () => {
    setupOverviewScene({ isOverview: false });
    setPassword('secret');
    expect(createAbandonFlow()).toBeNull();
  });

  it('returns null when no colonyPassword is configured', () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    expect(galaxyScanConfigStore.get().colonyPassword).toBe('');
    expect(createAbandonFlow()).toBeNull();
  });

  it('returns null when the coords anchor is missing / malformed', () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100, coords: 'not coords' });
    setPassword('secret');
    expect(createAbandonFlow()).toBeNull();
  });

  it('blocks a second concurrent flow until the first is cancelled', () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100 });
    setPassword('secret');
    const first = createAbandonFlow();
    expect(first).not.toBeNull();
    expect(createAbandonFlow()).toBeNull(); // re-entry blocked
    first?.cancel();
    expect(createAbandonFlow()).not.toBeNull(); // freed
  });
});

describe('createAbandonFlow — the 3-step flow', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('walks opened → submitted → done, autofilling the password and recording the slot', async () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100, coords: '[4:30:8]' });
    setPassword('secret');
    stageGiveupPopup('[4:30:8]');
    const flow = /** @type {NonNullable<ReturnType<typeof createAbandonFlow>>} */ (createAbandonFlow());
    expect(flow).not.toBeNull();

    // Step 1 — open + autofill.
    const p1 = flow.advance();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p1).toEqual({ phase: 'opened' });
    const pw = /** @type {HTMLInputElement} */ (document.querySelector('#validate input[type="password"]'));
    expect(pw.value).toBe('secret');

    // Step 2 — submit; the confirm dialog is up.
    stageConfirmDialog('[4:30:8]');
    const p2 = flow.advance();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p2).toEqual({ phase: 'submitted' });

    // Step 3 — confirm; slot recorded as abandoned.
    const p3 = flow.advance();
    await vi.advanceTimersByTimeAsync(50);
    expect(await p3).toEqual({ phase: 'done' });
    const recorded = /** @type {any} */ (scansStore.get())['4:30'];
    expect(recorded.positions[8].status).toBe('abandoned');
  });

  it('aborts step 1 when the popup opens for a different planet (coords mismatch)', async () => {
    setupOverviewScene({ usedFields: 0, maxFields: 100, coords: '[4:30:8]' });
    setPassword('secret');
    stageGiveupPopup('[9:99:1]'); // popup lies about the planet
    const flow = /** @type {NonNullable<ReturnType<typeof createAbandonFlow>>} */ (createAbandonFlow());

    const p1 = flow.advance();
    await vi.advanceTimersByTimeAsync(200);
    expect(await p1).toEqual({ phase: 'aborted' });
    // A subsequent advance stays aborted (flow is dead).
    expect(await flow.advance()).toEqual({ phase: 'aborted' });
  });
});
