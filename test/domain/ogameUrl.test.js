// @ts-check
//
// Unit tests for the in-game URL builder — the single home for the
// `?page=ingame&component=<x>` query contract every navigation target shares.
// Pure string logic, so this runs in the default node env (no DOM).

import { describe, it, expect } from 'vitest';
import { ogameUrlBase, ingameComponentUrl } from '../../src/domain/ogameUrl.js';

const HREF = 'https://s1.ogame.gameforge.com/game/index.php?page=ingame&component=overview&cp=33';
const BASE = 'https://s1.ogame.gameforge.com/game/index.php';

describe('ogameUrlBase', () => {
  it('strips the query tail, leaving origin+path', () => {
    expect(ogameUrlBase(HREF)).toBe(BASE);
  });

  it('returns the href unchanged when there is no query', () => {
    expect(ogameUrlBase(BASE)).toBe(BASE);
  });

  it('coerces a non-string input rather than throwing', () => {
    expect(ogameUrlBase(/** @type {any} */ (undefined))).toBe('undefined');
  });
});

describe('ingameComponentUrl', () => {
  it('builds the bare component URL from the href base', () => {
    expect(ingameComponentUrl(HREF, 'fleetdispatch'))
      .toBe(`${BASE}?page=ingame&component=fleetdispatch`);
  });

  it('appends params in insertion order (canonical for the browser nav cache)', () => {
    expect(
      ingameComponentUrl(HREF, 'fleetdispatch', {
        galaxy: 4, system: 467, position: 15, type: 1, mission: 7, am208: 1,
      }),
    ).toBe(
      `${BASE}?page=ingame&component=fleetdispatch` +
        '&galaxy=4&system=467&position=15&type=1&mission=7&am208=1',
    );
  });

  it('matches the old hand-rolled fleetdispatch+cp form', () => {
    expect(ingameComponentUrl(HREF, 'fleetdispatch', { cp: 1234 }))
      .toBe(`${BASE}?page=ingame&component=fleetdispatch&cp=1234`);
  });

  it('drops the existing query so stale params do not leak into the next nav', () => {
    // HREF already carries ?page=…&cp=33 — the rebuilt URL must not inherit it.
    expect(ingameComponentUrl(HREF, 'galaxy', { galaxy: 1, system: 1 }))
      .toBe(`${BASE}?page=ingame&component=galaxy&galaxy=1&system=1`);
  });
});
