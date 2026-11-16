// @vitest-environment happy-dom
//
// The territory = own bodies minus the colony the abandon FAB proposes to
// delete. Regression: colonizing a small planet used to raise "Abandon" AND a
// Spyglass "Look · neighbours" for the same system at once.
//
// @ts-check

import { describe, it, expect, afterEach } from 'vitest';
import { territoryBodies } from '../../../src/features/shared/territoryBodies.js';
import { bodiesStore } from '../../../src/state/bodies.js';
import { galaxyScanConfigStore } from '../../../src/state/galaxyScanConfig.js';
import { defaultGalaxyScanConfig } from '../../../src/domain/galaxyScanConfig.js';

/** @param {number} cp @param {string} coords @param {number} used @param {number} max */
const row = (cp, coords, used, max) => `<div class="smallplanet" id="planet-${cp}">
  <a class="planetlink" data-tooltip-title="<b>P ${coords}</b><br/>12.000km (${used}/${max})<br/>x">
  <span class="planet-name">P</span></a></div>`;

/** @param {number} cp @param {number} g @param {number} s @param {number} p @param {number} [type] */
const body = (cp, g, s, p, type = 1) => ({ cp, name: 'P', galaxy: g, system: s, position: p, type });

const home = body(1, 1, 100, 8);
const fresh = body(2, 3, 300, 4);

afterEach(() => {
  document.body.innerHTML = '';
  bodiesStore.set({ bodies: [], capturedAt: 0 });
  galaxyScanConfigStore.set(defaultGalaxyScanConfig());
});

describe('territoryBodies', () => {
  it('leaves out a fresh colony below colonyMinFields', () => {
    bodiesStore.set({ bodies: [home, fresh], capturedAt: 1 });
    document.body.innerHTML = `<div id="planetList">${row(1, '[1:100:8]', 250, 300)}${row(2, '[3:300:4]', 0, 180)}</div>`;
    expect(territoryBodies()).toEqual([home]);
  });

  it('keeps it once it is big enough to keep, or once a field is built', () => {
    bodiesStore.set({ bodies: [home, fresh], capturedAt: 1 });
    document.body.innerHTML = `<div id="planetList">${row(1, '[1:100:8]', 250, 300)}${row(2, '[3:300:4]', 0, 180)}</div>`;
    galaxyScanConfigStore.set({ ...defaultGalaxyScanConfig(), colonyMinFields: 150 });
    expect(territoryBodies()).toEqual([home, fresh]);
    galaxyScanConfigStore.set(defaultGalaxyScanConfig());
    document.body.innerHTML = `<div id="planetList">${row(1, '[1:100:8]', 250, 300)}${row(2, '[3:300:4]', 1, 180)}</div>`;
    expect(territoryBodies()).toEqual([home, fresh]);
  });

  it('returns the whole inventory off-game (no planet list)', () => {
    bodiesStore.set({ bodies: [home, fresh], capturedAt: 1 });
    expect(territoryBodies()).toEqual([home, fresh]);
  });
});
