// @vitest-environment happy-dom
//
// Unit tests for sendExpedition's impure DOM readers (`domHelpers.js`) — the
// expedition-cap walk over the planet list + event box. Mirrors
// `sendColonyHelpers.test.js`: the orchestrator's click flow / lifecycle is
// covered by `sendExpedition.test.js`; here we drive the readers directly against
// hand-built fixtures.
//
// Coverage:
//   - getActivePlanetCoords — active-planet coord reader.
//   - countActiveExpeditions — in-flight expedition count (per-origin + global).
//   - findPlanetWithExpSlot — wrap-around walk for the next free planet.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getActivePlanetCoords,
  countActiveExpeditions,
  findPlanetWithExpSlot,
} from '../../src/features/sendExpedition/domHelpers.js';
import { ACTIVE_PLANET_CLASS } from '../../src/lib/gameDom.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';

// ── Settings reset ──────────────────────────────────────────────────

const resetSettingsToDefaults = () => {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const key of /** @type {Array<keyof typeof SETTINGS_SCHEMA>} */ (
    Object.keys(SETTINGS_SCHEMA)
  )) {
    defaults[key] = SETTINGS_SCHEMA[key].default;
  }
  settingsStore.set(
    /** @type {import('../../src/state/settings.js').Settings} */ (
      /** @type {unknown} */ (defaults)
    ),
  );
};

/** @param {number} n */
const setMaxExpPerPlanet = (n) => {
  settingsStore.set({ ...settingsStore.get(), maxExpeditionsPerPlanet: n });
};

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * Build a `#planetList` whose rows are `[cp, "g:s:p", isActive]` tuples.
 * Coords are rendered bracketed (`[1:2:3]`) the way the game writes them,
 * so the readers' `stripBrackets` is exercised end-to-end.
 *
 * @param {Array<[number, string, boolean?]>} rows
 */
const buildPlanetList = (rows) => {
  const items = rows
    .map(([cp, coords, active]) => {
      const cls = active ? `smallplanet ${ACTIVE_PLANET_CLASS}` : 'smallplanet';
      return `
        <div id="planet-${cp}" class="${cls}">
          <span class="planet-koords">[${coords}]</span>
        </div>`;
    })
    .join('');
  document.body.innerHTML = `<div id="planetList">${items}</div>`;
};

/**
 * Append an `#eventContent` table of in-flight expedition rows (mission
 * type 15). Each entry is the bracketed origin coords of one expedition.
 *
 * @param {string[]} origins
 */
const buildEventContent = (origins) => {
  const rows = origins
    .map(
      (o) => `
        <tr class="eventFleet" data-mission-type="15">
          <td class="coordsOrigin">[${o}]</td>
        </tr>`,
    )
    .join('');
  const table = document.createElement('table');
  table.id = 'eventContent';
  table.innerHTML = rows;
  document.body.appendChild(table);
};

beforeEach(() => {
  document.body.innerHTML = '';
  resetSettingsToDefaults();
});

afterEach(() => {
  document.body.innerHTML = '';
  resetSettingsToDefaults();
});

// ──────────────────────────────────────────────────────────────────
// getActivePlanetCoords
// ──────────────────────────────────────────────────────────────────

describe('getActivePlanetCoords', () => {
  it('returns the active planet coords without brackets', () => {
    buildPlanetList([
      [1, '1:2:3', false],
      [2, '4:5:6', true],
    ]);
    expect(getActivePlanetCoords()).toBe('4:5:6');
  });

  it('returns null when no planet is highlighted', () => {
    buildPlanetList([[1, '1:2:3', false]]);
    expect(getActivePlanetCoords()).toBeNull();
  });

  it('returns null with no planet list at all', () => {
    expect(getActivePlanetCoords()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// countActiveExpeditions
// ──────────────────────────────────────────────────────────────────

describe('countActiveExpeditions', () => {
  it('counts only expeditions matching the given origin', () => {
    buildEventContent(['1:2:3', '1:2:3', '4:5:6']);
    expect(countActiveExpeditions('1:2:3')).toBe(2);
    expect(countActiveExpeditions('4:5:6')).toBe(1);
    expect(countActiveExpeditions('9:9:9')).toBe(0);
  });

  it('counts every expedition globally when origin is null', () => {
    buildEventContent(['1:2:3', '4:5:6', '7:8:9']);
    expect(countActiveExpeditions(null)).toBe(3);
  });

  it('returns 0 when there are no expedition rows', () => {
    expect(countActiveExpeditions('1:2:3')).toBe(0);
    expect(countActiveExpeditions(null)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// findPlanetWithExpSlot
// ──────────────────────────────────────────────────────────────────

describe('findPlanetWithExpSlot', () => {
  it('returns the active planet first when it has room (skipCurrent=false)', () => {
    setMaxExpPerPlanet(1);
    buildPlanetList([
      [1, '1:1:1', false],
      [2, '2:2:2', true],
    ]);
    // No expeditions in flight → active planet has room.
    expect(findPlanetWithExpSlot(false)).toBe(2);
  });

  it('skips the active planet when skipCurrent=true', () => {
    setMaxExpPerPlanet(1);
    buildPlanetList([
      [1, '1:1:1', false],
      [2, '2:2:2', true],
    ]);
    expect(findPlanetWithExpSlot(true)).toBe(1);
  });

  it('wraps around past the active planet to an earlier free one', () => {
    setMaxExpPerPlanet(1);
    buildPlanetList([
      [1, '1:1:1', false],
      [2, '2:2:2', false],
      [3, '3:3:3', true], // active is last
    ]);
    // Active (3:3:3) is full; wrap to the first free planet (cp 1).
    buildEventContent(['3:3:3']);
    expect(findPlanetWithExpSlot(true)).toBe(1);
  });

  it('skips planets at or above the cap', () => {
    setMaxExpPerPlanet(2);
    buildPlanetList([
      [1, '1:1:1', true],
      [2, '2:2:2', false],
    ]);
    // Active planet already has 2 expeditions (== cap) → skip to cp 2.
    buildEventContent(['1:1:1', '1:1:1']);
    expect(findPlanetWithExpSlot(false)).toBe(2);
  });

  it('returns null when every planet is maxed', () => {
    setMaxExpPerPlanet(1);
    buildPlanetList([
      [1, '1:1:1', true],
      [2, '2:2:2', false],
    ]);
    buildEventContent(['1:1:1', '2:2:2']);
    expect(findPlanetWithExpSlot(false)).toBeNull();
  });

  it('returns null with no planet list', () => {
    setMaxExpPerPlanet(1);
    expect(findPlanetWithExpSlot(false)).toBeNull();
  });
});
