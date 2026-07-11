// @vitest-environment happy-dom
//
// Focused DOM-reader tests for `features/dailyRun/domHelpers.js` — the
// planet-vs-moon distinctions the collect walk depends on:
//
//   - findNextCollectSourceCp: the TYPE-aware target skip (a collect target
//     on moon A must NOT skip the PLANET at A — it sends "up" to its own
//     moon) and the moon→moon walk (source kind follows the run's origin;
//     the moon's cp comes from its moonlink href).
//   - bodyNameByCoord: a moon target resolves the MOON's own name (the
//     moonlink icon's alt — the img carries no class), not the planet's.
//   - readInboundLegs: origin carries its body TYPE (from the originFleet
//     figure), so "already collected" can tell moon A from planet A.
//
// The orchestrator-level behaviour (taps, redirect stash) lives in
// `dailyRun.test.js`; here we isolate the readers.
//
// @ts-check

import { describe, it, expect, beforeEach } from 'vitest';
import {
  findNextCollectSourceCp,
  bodyNameByCoord,
  readInboundLegs,
} from '../../src/features/dailyRun/domHelpers.js';
import { coordTypeKey } from '../../src/features/dailyRun/pure.js';
import { TARGET_PLANET, TARGET_MOON } from '../../src/domain/rules.js';

/**
 * Build a `#planetList` row. `moonCp` adds a moonlink (with the moon icon
 * <img alt> when `moonName` is given); `active` marks the row highlighted.
 *
 * @param {{ cp: string, coords: string, name?: string, active?: boolean,
 *   moonCp?: string, moonName?: string }} r
 * @returns {string}
 */
const row = (r) => `
  <div id="planet-${r.cp}" class="smallplanet${r.active ? ' hightlightPlanet' : ''}">
    <a class="planetlink">
      <span class="planet-name">${r.name ?? `P${r.cp}`}</span>
      <span class="planet-koords">[${r.coords}]</span>
    </a>
    ${r.moonCp
    ? `<a class="moonlink" href="?page=ingame&component=overview&cp=${r.moonCp}">
         <img src="moon.gif" alt="${r.moonName ?? ''}">
       </a>`
    : ''}
  </div>`;

/** @param {string[]} rows */
const setPlanetList = (rows) => {
  document.body.innerHTML = `<div id="planetList">${rows.join('')}</div>`;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findNextCollectSourceCp — planet walk (type-aware target skip)', () => {
  const list = () => setPlanetList([
    row({ cp: '11', coords: '1:1:1', active: true }),
    row({ cp: '22', coords: '1:1:2', moonCp: '922' }),
    row({ cp: '33', coords: '1:1:3' }),
  ]);

  it('a collect target on MOON A does not skip the PLANET at A (it sends up to its own moon)', () => {
    list();
    const targetMoonAt2 = { galaxy: 1, system: 1, position: 2, type: TARGET_MOON };
    expect(findNextCollectSourceCp(new Set(), coordTypeKey(targetMoonAt2), TARGET_PLANET))
      .toBe('22');
  });

  it('a collect target on the PLANET at A does skip it', () => {
    list();
    const targetPlanetAt2 = { galaxy: 1, system: 1, position: 2, type: TARGET_PLANET };
    expect(findNextCollectSourceCp(new Set(), coordTypeKey(targetPlanetAt2), TARGET_PLANET))
      .toBe('33');
  });

  it('the collected-origins guard is type-aware: a MOON origin does not mark its planet', () => {
    list();
    const target = { galaxy: 9, system: 9, position: 9, type: TARGET_MOON };
    // Moon at 1:1:2 already deployed to the target — its PLANET still counts.
    const collected = new Set([
      coordTypeKey({ galaxy: 1, system: 1, position: 2, type: TARGET_MOON }),
    ]);
    expect(findNextCollectSourceCp(collected, coordTypeKey(target), TARGET_PLANET))
      .toBe('22');
    // The planet itself collected → walk moves on.
    collected.add(coordTypeKey({ galaxy: 1, system: 1, position: 2, type: TARGET_PLANET }));
    expect(findNextCollectSourceCp(collected, coordTypeKey(target), TARGET_PLANET))
      .toBe('33');
  });
});

describe('findNextCollectSourceCp — moon walk', () => {
  it('hops moon→moon: rows without a moon are skipped and the cp comes from the moonlink', () => {
    setPlanetList([
      row({ cp: '11', coords: '1:1:1', active: true, moonCp: '911' }),
      row({ cp: '22', coords: '1:1:2' }), // no moon → not a source
      row({ cp: '33', coords: '1:1:3', moonCp: '933' }),
    ]);
    const target = { galaxy: 9, system: 9, position: 9, type: TARGET_MOON };
    expect(findNextCollectSourceCp(new Set(), coordTypeKey(target), TARGET_MOON))
      .toBe('933');
  });

  it('skips the target moon itself and already-collected moons', () => {
    setPlanetList([
      row({ cp: '11', coords: '1:1:1', active: true, moonCp: '911' }),
      row({ cp: '22', coords: '1:1:2', moonCp: '922' }),
      row({ cp: '33', coords: '1:1:3', moonCp: '933' }),
    ]);
    const target = { galaxy: 1, system: 1, position: 2, type: TARGET_MOON };
    const collected = new Set([
      coordTypeKey({ galaxy: 1, system: 1, position: 3, type: TARGET_MOON }),
    ]);
    // 1:1:2 is the target, 1:1:3 collected → wrap lands on the active row's own moon.
    expect(findNextCollectSourceCp(collected, coordTypeKey(target), TARGET_MOON))
      .toBe('911');
  });
});

describe('bodyNameByCoord', () => {
  beforeEach(() => {
    setPlanetList([
      row({ cp: '11', coords: '2:3:4', name: 'Homeworld', moonCp: '911', moonName: 'K1' }),
    ]);
  });

  it("a MOON target resolves the moon's own name (the moonlink img alt)", () => {
    expect(bodyNameByCoord({ galaxy: 2, system: 3, position: 4, type: TARGET_MOON }))
      .toBe('K1');
  });

  it('a planet target resolves the planet name', () => {
    expect(bodyNameByCoord({ galaxy: 2, system: 3, position: 4, type: TARGET_PLANET }))
      .toBe('Homeworld');
  });

  it('falls back to the planet name when the moon icon carries no alt', () => {
    setPlanetList([
      row({ cp: '11', coords: '2:3:4', name: 'Homeworld', moonCp: '911' }),
    ]);
    expect(bodyNameByCoord({ galaxy: 2, system: 3, position: 4, type: TARGET_MOON }))
      .toBe('Homeworld');
  });
});

describe('readInboundLegs — origin body type', () => {
  it('reads the origin type from the originFleet figure (moon vs planet)', () => {
    document.body.innerHTML = `
      <div id="eventContent"><table>
        <tr class="eventFleet" data-return-flight="false" data-mission-type="4">
          <td class="originFleet"><figure class="planetIcon moon"></figure></td>
          <td class="coordsOrigin">[1:1:2]</td>
          <td class="destFleet"><figure class="planetIcon moon"></figure></td>
          <td class="destCoords">[9:9:9]</td>
        </tr>
        <tr class="eventFleet" data-return-flight="false" data-mission-type="4">
          <td class="originFleet"><figure class="planetIcon planet"></figure></td>
          <td class="coordsOrigin">[1:1:3]</td>
          <td class="destFleet"><figure class="planetIcon planet"></figure></td>
          <td class="destCoords">[9:9:9]</td>
        </tr>
      </table></div>`;
    const legs = readInboundLegs();
    expect(legs).toHaveLength(2);
    expect(legs[0].origin).toMatchObject({ position: 2, type: TARGET_MOON });
    expect(legs[0].dest).toMatchObject({ position: 9, type: TARGET_MOON });
    expect(legs[1].origin).toMatchObject({ position: 3, type: TARGET_PLANET });
    expect(legs[1].dest).toMatchObject({ position: 9, type: TARGET_PLANET });
  });
});
