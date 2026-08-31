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
//   - isCoordsExpSkipped / isActiveBodyExpSkipped / isCpExpSkipped — the
//     standing "never send expeditions from here" exclusion.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getActivePlanetCoords,
  countActiveExpeditions,
  findPlanetWithExpSlot,
  getActiveBodyCp,
  isCpOnPlanetList,
  isCoordsExpSkipped,
  isActiveBodyExpSkipped,
  isCpExpSkipped,
} from '../../src/features/sendExpedition/domHelpers.js';
import { ACTIVE_PLANET_CLASS, ACTIVE_MOON_CLASS } from '../../src/lib/gameDom.js';
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
 * Append an `#eventContent` table of in-flight expeditions (mission type 15).
 * Each entry is the bracketed origin coords of ONE expedition, rendered the way
 * the game renders a freshly dispatched two-way mission: an outbound row AND a
 * return row, both carrying `origin = launcher`.
 *
 * @param {string[]} origins
 */
const buildEventContent = (origins) => {
  const rows = origins
    .map((o) => {
      const point = `${o.split(':').slice(0, 2).join(':')}:16`;
      return `
        <tr class="eventFleet" data-mission-type="15" data-return-flight="false">
          <td class="coordsOrigin">[${o}]</td>
          <td class="destCoords">[${point}]</td>
        </tr>
        <tr class="eventFleet" data-mission-type="15" data-return-flight="true">
          <td class="coordsOrigin">[${o}]</td>
          <td class="destCoords">[${point}]</td>
        </tr>`;
    })
    .join('');
  const table = document.createElement('table');
  table.id = 'eventContent';
  table.innerHTML = rows;
  document.body.appendChild(table);
};

/**
 * Append an `#eventContent` table of expedition LEGS, spelling out both ends and
 * the direction flag — the shape a live ticker really has (see
 * `countActiveExpeditions`). Lets a case model an outbound leg, a genuine return
 * leg, and AGR's mirror row (a "return" that kept the outbound coords).
 *
 * @param {Array<{ from: string, to: string, ret: boolean }>} legs
 */
const buildLegRows = (legs) => {
  const rows = legs
    .map(
      (l) => `
        <tr class="eventFleet" data-mission-type="15" data-return-flight="${l.ret}">
          <td class="coordsOrigin">[${l.from}]</td>
          <td class="destCoords">[${l.to}]</td>
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

  // On a moon page the game swaps the highlight class. Missing that read left
  // the caller with `null`, which it treats as "count globally" — so the
  // per-planet cap was compared against the ACCOUNT-wide expedition count and
  // any two expeditions anywhere made every moon look full.
  it('reads the coords off a MOON-highlighted row too', () => {
    document.body.innerHTML = `<div id="planetList">
      <div id="planet-1" class="smallplanet">
        <span class="planet-koords">[1:2:3]</span>
      </div>
      <div id="planet-2" class="smallplanet ${ACTIVE_MOON_CLASS}">
        <span class="planet-koords">[4:5:6]</span>
      </div>
    </div>`;
    expect(getActivePlanetCoords()).toBe('4:5:6');
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

  // The regression that made the button paint "All sent" after one round-robin
  // pass. A freshly dispatched expedition puts TWO rows in the ticker — the game
  // writes both legs of a two-way mission at send time — so counting rows read
  // one expedition as two, and a cap of 2 was "full" after a single send.
  it('counts a freshly sent expedition once, not once per leg', () => {
    buildLegRows([
      { from: '1:2:3', to: '1:2:16', ret: false },
      { from: '1:2:3', to: '1:2:16', ret: true },
    ]);
    expect(countActiveExpeditions('1:2:3')).toBe(1);
    expect(countActiveExpeditions(null)).toBe(1);
  });

  // The phase the "attribute each leg to its home end" model got wrong: once the
  // fleet reaches the point, the outbound row is gone and only the return row is
  // left — still carrying `origin = launcher`, because the coords never swap. The
  // slot is still taken, so the planet must still count 1.
  it('still counts an expedition holding at the point (outbound row gone)', () => {
    buildLegRows([{ from: '1:2:3', to: '1:2:16', ret: true }]);
    expect(countActiveExpeditions('1:2:3')).toBe(1);
    // Never against the expedition point — nobody owns position 16.
    expect(countActiveExpeditions('1:2:16')).toBe(0);
    expect(countActiveExpeditions(null)).toBe(1);
  });

  it('counts a planet at its cap across mixed phases (one flying out, one holding)', () => {
    buildLegRows([
      { from: '1:2:3', to: '1:2:16', ret: false },
      { from: '1:2:3', to: '1:2:16', ret: true },
      { from: '1:2:3', to: '1:2:16', ret: true },
    ]);
    expect(countActiveExpeditions('1:2:3')).toBe(2);
    expect(countActiveExpeditions(null)).toBe(2);
  });

  // Straight off a live ticker: 6 planets, 2 expeditions each, 18 rows (6 still
  // outbound + 12 return rows) — the account's 12 expedition slots, all used.
  it('reproduces the live 18-row / 12-expedition ticker', () => {
    const planets = ['1:90:9', '1:92:7', '1:93:9', '1:94:6', '1:95:9', '1:96:9'];
    /** @type {Array<{ from: string, to: string, ret: boolean }>} */
    const legs = [];
    planets.forEach((p, i) => {
      const point = `${p.split(':').slice(0, 2).join(':')}:16`;
      legs.push({ from: p, to: point, ret: true });
      legs.push({ from: p, to: point, ret: true });
      if (i === 0 || i % 2 === 0) legs.push({ from: p, to: point, ret: false });
    });
    buildLegRows(legs);
    for (const p of planets) expect(countActiveExpeditions(p)).toBe(2);
    expect(countActiveExpeditions(null)).toBe(12);
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

// ──────────────────────────────────────────────────────────────────
// getActiveBodyCp / isCpOnPlanetList (expedition cycle-anchor memory)
// ──────────────────────────────────────────────────────────────────

describe('getActiveBodyCp', () => {
  it('reads the active PLANET row id', () => {
    buildPlanetList([
      [1, '1:2:3', false],
      [2, '4:5:6', true],
    ]);
    expect(getActiveBodyCp()).toBe(2);
  });

  it('reads the moonlink cp on a MOON page (hightlightMoon row)', () => {
    document.body.innerHTML = `<div id="planetList">
      <div id="planet-1" class="smallplanet"></div>
      <div id="planet-2" class="smallplanet ${ACTIVE_MOON_CLASS}">
        <a class="moonlink" href="?page=ingame&component=overview&cp=99"></a>
      </div>
    </div>`;
    expect(getActiveBodyCp()).toBe(99);
  });

  it('returns 0 when nothing is highlighted', () => {
    buildPlanetList([[1, '1:2:3', false]]);
    expect(getActiveBodyCp()).toBe(0);
  });

  it('returns 0 with no planet list at all', () => {
    expect(getActiveBodyCp()).toBe(0);
  });
});

describe('isCpOnPlanetList', () => {
  it('is true for a planet row id on the list', () => {
    buildPlanetList([
      [1, '1:2:3', false],
      [2, '4:5:6', true],
    ]);
    expect(isCpOnPlanetList(1)).toBe(true);
    expect(isCpOnPlanetList(2)).toBe(true);
  });

  it('is true for a moonlink cp on the list', () => {
    document.body.innerHTML = `<div id="planetList">
      <div id="planet-1" class="smallplanet">
        <a class="moonlink" href="?page=ingame&component=overview&cp=99"></a>
      </div>
    </div>`;
    expect(isCpOnPlanetList(99)).toBe(true);
  });

  it('is false for a cp that is neither a planet nor a moon on the list', () => {
    buildPlanetList([[1, '1:2:3', true]]);
    expect(isCpOnPlanetList(404)).toBe(false);
  });

  it('is false for 0 / non-positive input', () => {
    buildPlanetList([[1, '1:2:3', true]]);
    expect(isCpOnPlanetList(0)).toBe(false);
    expect(isCpOnPlanetList(-1)).toBe(false);
  });
});

// ── Standing skip list ──────────────────────────────────────────────

/** @param {string} raw */
const setSkip = (raw) => {
  settingsStore.set({ ...settingsStore.get(), expSkipCoords: raw });
};

describe('the standing skip list', () => {
  it('keeps the walk off an excluded planet even though it is under the cap', () => {
    // The reported bug, in miniature: with the cap at 2 and one expedition on
    // each of A and B, planet C is under the cap all day — it is a colony kept
    // for something else. Before the skip list the walk parked there, the send
    // was refused, and the second pass over A and B never happened.
    setMaxExpPerPlanet(2);
    buildPlanetList([
      [1, '1:1:1', false],
      [2, '1:2:2', true],
      [3, '1:3:3', false],
    ]);
    buildEventContent(['1:1:1', '1:2:2']);
    expect(findPlanetWithExpSlot(true)).toBe(3);

    setSkip('1:3:3');
    expect(findPlanetWithExpSlot(true)).toBe(1);
  });

  it('reports nowhere to go when every planet that flies is maxed', () => {
    setMaxExpPerPlanet(1);
    buildPlanetList([
      [1, '1:1:1', true],
      [2, '1:2:2', false],
      [3, '1:3:3', false],
    ]);
    buildEventContent(['1:1:1', '1:2:2']);
    setSkip('1:3:3');
    expect(findPlanetWithExpSlot(true)).toBe(null);
  });

  it('excludes nothing when the setting is empty — the pre-existing behaviour', () => {
    setMaxExpPerPlanet(1);
    buildPlanetList([
      [1, '1:1:1', true],
      [2, '1:2:2', false],
    ]);
    expect(findPlanetWithExpSlot(true)).toBe(2);
  });

  it('matches a body regardless of how the stored coord was written', () => {
    setSkip(' [1:2:2] ');
    expect(isCoordsExpSkipped('1:2:2')).toBe(true);
    expect(isCoordsExpSkipped('1:2:3')).toBe(false);
  });

  it('treats unreadable coords as NOT excluded', () => {
    // `getActivePlanetCoords` returns null when the highlight marker is
    // missing. Blocking a send on an unknown position would be the wrong
    // default — the walk falls through to its normal gates instead.
    setSkip('1:2:2');
    expect(isCoordsExpSkipped(null)).toBe(false);
  });

  it('answers for the body the page is on', () => {
    buildPlanetList([
      [1, '1:1:1', false],
      [2, '1:2:2', true],
    ]);
    setSkip('1:2:2');
    expect(isActiveBodyExpSkipped()).toBe(true);
    setSkip('1:1:1');
    expect(isActiveBodyExpSkipped()).toBe(false);
  });

  it('answers for a remembered cycle anchor, by planet cp', () => {
    buildPlanetList([
      [1, '1:1:1', true],
      [2, '1:2:2', false],
    ]);
    setSkip('1:2:2');
    expect(isCpExpSkipped(2)).toBe(true);
    expect(isCpExpSkipped(1)).toBe(false);
  });

  it('answers for a MOON cp via its row — a position covers planet and moon', () => {
    // Exclusion is coords-keyed, the same granularity the per-planet cap
    // counts at, so excluding a position takes its moon with it.
    document.body.innerHTML = `<div id="planetList">
      <div id="planet-1" class="smallplanet">
        <span class="planet-koords">[1:2:2]</span>
        <a class="moonlink" href="?page=ingame&component=overview&cp=99"></a>
      </div>
    </div>`;
    setSkip('1:2:2');
    expect(isCpExpSkipped(99)).toBe(true);
  });

  it('is false for a cp the player no longer owns', () => {
    buildPlanetList([[1, '1:1:1', true]]);
    setSkip('1:2:2');
    expect(isCpExpSkipped(404)).toBe(false);
  });
});
