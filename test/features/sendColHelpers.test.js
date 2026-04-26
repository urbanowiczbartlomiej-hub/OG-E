// @vitest-environment happy-dom
//
// Unit tests for sendCol's helper modules — the pure helpers in
// `pure.js` and the impure DOM/store readers in `domHelpers.js` that
// the sendCol orchestrator builds on.
//
// Coverage breakdown:
//   - findNextScanSystem — pure target picker (pure.js).
//   - findNextColonizeTarget — pure colonize picker (pure.js).
//   - pickCandidateInView — current-view priority target picker (pure.js).
//   - getColonizeWaitTime — DOM + store-aware min-gap wait (domHelpers.js).
//   - readHomePlanet — DOM coord reader (domHelpers.js).
//   - parseCurrentGalaxyView — DOM + URL coord reader (domHelpers.js).
//   - buildFleetdispatchUrl — URL builder (pure.js).
//   - buildGalaxyUrl — URL builder (pure.js).
//
// # What we do NOT cover
//
// - UI click flow, button lifecycle, reactors — those are the
//   orchestrator's job and live in sendCol.test.js.
// - `derive` / `render` from `pure.js` — also covered by sendCol.test.js
//   via the orchestrator's integration paths.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findNextScanSystem,
  findNextColonizeTarget,
  pickCandidateInView,
  buildFleetdispatchUrl,
  buildGalaxyUrl,
} from '../../src/features/sendCol/pure.js';
import {
  getColonizeWaitTime,
  readHomePlanet,
  parseCurrentGalaxyView,
} from '../../src/features/sendCol/domHelpers.js';
import {
  settingsStore,
  SETTINGS_SCHEMA,
} from '../../src/state/settings.js';
import { registryStore } from '../../src/state/registry.js';

// ── Location.href mocking ────────────────────────────────────────────

/** @type {string | null} */
let navTarget = null;

/** @type {PropertyDescriptor | undefined} */
let originalHrefDescriptor;

const mockLocationHref = () => {
  const proto = Object.getPrototypeOf(window.location);
  originalHrefDescriptor = Object.getOwnPropertyDescriptor(proto, 'href');
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get() {
      return navTarget ?? 'https://s1-en.ogame.gameforge.com/game/index.php';
    },
    set(url) {
      navTarget = String(url);
    },
  });
};

const unmockLocationHref = () => {
  delete (/** @type {any} */ (window.location)).href;
  void originalHrefDescriptor;
};

// ── Settings / store resets ─────────────────────────────────────────

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

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  registryStore.set([]);
  navTarget = null;
  mockLocationHref();
});

afterEach(() => {
  document.body.innerHTML = '';
  resetSettingsToDefaults();
  registryStore.set([]);
  unmockLocationHref();
  navTarget = null;
  location.search = '';
});

// ──────────────────────────────────────────────────────────────────
// findNextScanSystem — pure
// ──────────────────────────────────────────────────────────────────

describe('findNextScanSystem', () => {
  const home = { galaxy: 4, system: 30 };

  it('returns home+1 when scans is empty and no currentView', () => {
    expect(findNextScanSystem({}, home, null)).toEqual({
      galaxy: 4,
      system: 31,
    });
  });

  it('continues past currentView when on galaxy view', () => {
    expect(findNextScanSystem({}, home, { galaxy: 4, system: 100 })).toEqual({
      galaxy: 4,
      system: 101,
    });
  });

  it('skips a fresh scan at home+1 and returns home+2', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:31': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    expect(findNextScanSystem(scans, home, null)).toEqual({
      galaxy: 4,
      system: 32,
    });
  });

  it('returns a stale scan position (does not skip it)', () => {
    // 72h ago is past any day's 3 AM regardless of current wall-clock,
    // so `abandoned` is always stale at that age.
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:31': {
        scannedAt: Date.now() - 72 * 3600_000,
        positions: { 8: { status: 'abandoned' } },
      },
    };
    expect(findNextScanSystem(scans, home, null)).toEqual({
      galaxy: 4,
      system: 31,
    });
  });

  it('wraps within the same galaxy when starting near the top', () => {
    expect(findNextScanSystem({}, home, { galaxy: 4, system: 499 })).toEqual({
      galaxy: 4,
      system: 1,
    });
  });

  it('advances to the next galaxy when the home galaxy is all fresh', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {};
    for (let s = 1; s <= 499; s++) {
      scans[/** @type {`${number}:${number}`} */ (`4:${s}`)] = {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      };
    }
    const next = findNextScanSystem(scans, home, null);
    // Next galaxy in `buildGalaxyOrder(4)` is 5.
    expect(next).toEqual({ galaxy: 5, system: 1 });
  });

  it('returns null when every galaxy is fresh', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {};
    for (let g = 1; g <= 7; g++) {
      for (let s = 1; s <= 499; s++) {
        scans[/** @type {`${number}:${number}`} */ (`${g}:${s}`)] = {
          scannedAt: Date.now(),
          positions: { 8: { status: 'empty' } },
        };
      }
    }
    expect(findNextScanSystem(scans, home, null)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// findNextColonizeTarget — pure
// ──────────────────────────────────────────────────────────────────

describe('findNextColonizeTarget', () => {
  const home = { galaxy: 4, system: 30 };

  beforeEach(() => {
    location.search = '';
  });

  it('returns null when targets is empty', () => {
    expect(findNextColonizeTarget({}, [], home, [], false)).toBeNull();
  });

  it('returns null when scans is empty', () => {
    expect(findNextColonizeTarget({}, [], home, [8], false)).toBeNull();
  });

  it('returns a match for an empty slot at a target position', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    const t = findNextColonizeTarget(scans, [], home, [8], false);
    expect(t).not.toBeNull();
    expect(t?.galaxy).toBe(4);
    expect(t?.system).toBe(30);
    expect(t?.position).toBe(8);
    expect(t?.link).toContain('galaxy=4');
    expect(t?.link).toContain('system=30');
    expect(t?.link).toContain('position=8');
    expect(t?.link).toContain('mission=7');
  });

  it('skips positions not in the user targets list', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 9: { status: 'empty' } },
      },
    };
    expect(findNextColonizeTarget(scans, [], home, [8], false)).toBeNull();
  });

  it('skips empty_sent (we dispatched already)', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty_sent' } },
      },
    };
    expect(findNextColonizeTarget(scans, [], home, [8], false)).toBeNull();
  });

  it('skips a slot with a pending in-flight fleet in the registry', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    /** @type {import('../../src/domain/registry.js').RegistryEntry[]} */
    const registry = [
      {
        coords: '4:30:8',
        sentAt: Date.now(),
        arrivalAt: Date.now() + 10 * 60_000,
      },
    ];
    expect(findNextColonizeTarget(scans, registry, home, [8], false)).toBeNull();
  });

  it('with preferOther=true, skips home galaxy first and finds in galaxy 5', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:30': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
      '5:1': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    const t = findNextColonizeTarget(scans, [], home, [8], true);
    expect(t?.galaxy).toBe(5);
    expect(t?.system).toBe(1);
  });

  it('home galaxy systems are searched farthest-first', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:31': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
      '4:250': {
        scannedAt: Date.now(),
        positions: { 8: { status: 'empty' } },
      },
    };
    const t = findNextColonizeTarget(scans, [], home, [8], false);
    // sysDist(250, 30) = 220 > sysDist(31, 30) = 1 → farthest wins.
    expect(t?.system).toBe(250);
  });
});

// ──────────────────────────────────────────────────────────────────
// pickCandidateInView — pure (NEW)
// ──────────────────────────────────────────────────────────────────

describe('pickCandidateInView', () => {
  const view = { galaxy: 4, system: 42 };
  const now = Date.now();

  it('returns null when targets is empty', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: { 8: { status: 'empty' } },
      },
    };
    expect(pickCandidateInView(scans, [], [], view, now)).toBeNull();
  });

  it('returns null when view system is not in scans', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:43': {
        scannedAt: now,
        positions: { 8: { status: 'empty' } },
      },
    };
    expect(pickCandidateInView(scans, [], [8], view, now)).toBeNull();
  });

  it('returns null when view system has no positions record', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: /** @type {any} */ (null),
      },
    };
    expect(pickCandidateInView(scans, [], [8], view, now)).toBeNull();
  });

  it('returns null when view system has no target positions empty', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: { 8: { status: 'occupied' } },
      },
    };
    expect(pickCandidateInView(scans, [], [8], view, now)).toBeNull();
  });

  it('returns null when target position has empty_sent status', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: { 8: { status: 'empty_sent' } },
      },
    };
    expect(pickCandidateInView(scans, [], [8], view, now)).toBeNull();
  });

  it('returns null when every target position is inFlight', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: {
          8: { status: 'empty' },
          10: { status: 'empty' },
        },
      },
    };
    /** @type {import('../../src/domain/registry.js').RegistryEntry[]} */
    const registry = [
      { coords: '4:42:8', sentAt: now, arrivalAt: now + 600_000 },
      { coords: '4:42:10', sentAt: now, arrivalAt: now + 600_000 },
    ];
    expect(pickCandidateInView(scans, registry, [8, 10], view, now)).toBeNull();
  });

  it('returns the first empty target position in targets[] order', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: {
          8: { status: 'empty' },
          10: { status: 'empty' },
          12: { status: 'empty' },
        },
      },
    };
    // User prefers 10 first — picker should honour that.
    const r = pickCandidateInView(scans, [], [10, 8, 12], view, now);
    expect(r).toEqual({ galaxy: 4, system: 42, position: 10 });
  });

  it('respects targets[] order strictly (priority, not numeric)', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: {
          8: { status: 'empty' },
          12: { status: 'empty' },
        },
      },
    };
    const r = pickCandidateInView(scans, [], [12, 8], view, now);
    expect(r?.position).toBe(12);
  });

  it('skips inFlight slot and falls through to the next target', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: {
          8: { status: 'empty' },
          10: { status: 'empty' },
        },
      },
    };
    /** @type {import('../../src/domain/registry.js').RegistryEntry[]} */
    const registry = [
      // 8 is inFlight — should be skipped so 10 wins.
      { coords: '4:42:8', sentAt: now, arrivalAt: now + 600_000 },
    ];
    const r = pickCandidateInView(scans, registry, [8, 10], view, now);
    expect(r?.position).toBe(10);
  });

  it('ignores an inFlight entry for a different coord', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: { 8: { status: 'empty' } },
      },
    };
    /** @type {import('../../src/domain/registry.js').RegistryEntry[]} */
    const registry = [
      { coords: '5:99:8', sentAt: now, arrivalAt: now + 600_000 },
    ];
    const r = pickCandidateInView(scans, registry, [8], view, now);
    expect(r).toEqual({ galaxy: 4, system: 42, position: 8 });
  });

  it('ignores registry entries that have already arrived', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '4:42': {
        scannedAt: now,
        positions: { 8: { status: 'empty' } },
      },
    };
    /** @type {import('../../src/domain/registry.js').RegistryEntry[]} */
    const registry = [
      { coords: '4:42:8', sentAt: now - 60_000, arrivalAt: now - 1 },
    ];
    const r = pickCandidateInView(scans, registry, [8], view, now);
    expect(r).toEqual({ galaxy: 4, system: 42, position: 8 });
  });

  it('returns null when view.galaxy/system do not match any scan key', () => {
    /** @type {import('../../src/state/scans.js').GalaxyScans} */
    const scans = {
      '1:1': {
        scannedAt: now,
        positions: { 8: { status: 'empty' } },
      },
      '7:500': /** @type {any} */ ({
        scannedAt: now,
        positions: { 8: { status: 'empty' } },
      }),
    };
    expect(
      pickCandidateInView(scans, [], [8], { galaxy: 4, system: 42 }, now),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// getColonizeWaitTime — DOM + store aware
// ──────────────────────────────────────────────────────────────────

describe('getColonizeWaitTime', () => {
  /**
   * Paint a `#durationOneWay` element with the given text.
   *
   * @param {string} durationText  e.g. "0:01:00" or "1:0:0:0"
   */
  const paintDuration = (durationText) => {
    document.body.innerHTML = '';
    const dur = document.createElement('div');
    dur.id = 'durationOneWay';
    dur.textContent = durationText;
    document.body.appendChild(dur);
  };

  it('returns 0 when #durationOneWay is missing', () => {
    expect(getColonizeWaitTime()).toBe(0);
  });

  it('returns 0 when duration text parses to zero', () => {
    paintDuration('0:0:0');
    expect(getColonizeWaitTime()).toBe(0);
  });

  it('returns 0 when duration text is malformed (non-numeric)', () => {
    paintDuration('abc');
    expect(getColonizeWaitTime()).toBe(0);
  });

  it('returns 0 when no conflict in registry (empty)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('0:01:00');
    registryStore.set([]);
    expect(getColonizeWaitTime()).toBe(0);
    vi.useRealTimers();
  });

  it('returns >0 when a registry entry conflicts within minGap (3-part duration)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('0:01:00'); // 60s flight.
    const now = Date.now();
    // gap of 10s < default minGap (15s) → conflict.
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 60_000 + 10_000,
      },
    ]);
    const wait = getColonizeWaitTime();
    expect(wait).toBeGreaterThan(0);
    // minGap 15s - gap 10s = 5s wait.
    expect(wait).toBe(5);
    vi.useRealTimers();
  });

  it('returns 0 when gap equals minGap exactly (strict <, boundary is safe)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('0:01:00');
    const now = Date.now();
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 60_000 + 15_000,
      },
    ]);
    expect(getColonizeWaitTime()).toBe(0);
    vi.useRealTimers();
  });

  it('accepts 4-part duration (d:h:m:s)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('1:0:0:0'); // 1 day = 86400s.
    const now = Date.now();
    // Arriving 5s after ours → conflict.
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 86_400_000 + 5_000,
      },
    ]);
    const wait = getColonizeWaitTime();
    expect(wait).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('custom colMinGap overrides the default for conflict detection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('0:01:00');
    settingsStore.set({ ...settingsStore.get(), colMinGap: 60 });
    const now = Date.now();
    // gap 30s → with minGap 60s → conflict, wait = 30s.
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 60_000 + 30_000,
      },
    ]);
    expect(getColonizeWaitTime()).toBe(30);
    vi.useRealTimers();
  });

  it('ignores already-arrived registry entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('0:01:00');
    const now = Date.now();
    // Entry in the past → no conflict.
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now - 300_000,
        arrivalAt: now - 1_000,
      },
    ]);
    expect(getColonizeWaitTime()).toBe(0);
    vi.useRealTimers();
  });

  it('debug diagnostic logs when oge_debugMinGap=true', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    paintDuration('0:01:00');
    localStorage.setItem('oge_debugMinGap', 'true');
    const now = Date.now();
    registryStore.set([
      {
        coords: '4:40:8',
        sentAt: now,
        arrivalAt: now + 60_000 + 10_000,
      },
    ]);
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    getColonizeWaitTime();
    expect(spy).toHaveBeenCalled();
    const [label, payload] = spy.mock.calls[0];
    expect(label).toBe('[OG-E min-gap]');
    expect(payload).toMatchObject({ durationSec: 60 });
    spy.mockRestore();
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// readHomePlanet
// ──────────────────────────────────────────────────────────────────

describe('readHomePlanet', () => {
  it('returns null when #planetList is missing', () => {
    expect(readHomePlanet()).toBeNull();
  });

  it('returns null when no active planet has .hightlightPlanet', () => {
    document.body.innerHTML = `
      <div id="planetList">
        <div class="smallplanet" id="planet-1">
          <span class="planet-koords">[4:30:8]</span>
        </div>
      </div>
    `;
    expect(readHomePlanet()).toBeNull();
  });

  it('returns null when coords span is present but malformed', () => {
    document.body.innerHTML = `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-1">
          <span class="planet-koords">not a coord</span>
        </div>
      </div>
    `;
    expect(readHomePlanet()).toBeNull();
  });

  it('reads galaxy + system from the highlighted planet', () => {
    document.body.innerHTML = `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-1">
          <span class="planet-koords">[4:30:8]</span>
        </div>
      </div>
    `;
    expect(readHomePlanet()).toEqual({ galaxy: 4, system: 30 });
  });

  it('handles surrounding whitespace in the coords text', () => {
    document.body.innerHTML = `
      <div id="planetList">
        <div class="smallplanet hightlightPlanet" id="planet-1">
          <span class="planet-koords">   [2:150:12]   </span>
        </div>
      </div>
    `;
    expect(readHomePlanet()).toEqual({ galaxy: 2, system: 150 });
  });
});

// ──────────────────────────────────────────────────────────────────
// parseCurrentGalaxyView
// ──────────────────────────────────────────────────────────────────

describe('parseCurrentGalaxyView', () => {
  it('returns null when not on galaxy view', () => {
    location.search = '?page=ingame&component=overview';
    expect(parseCurrentGalaxyView()).toBeNull();
  });

  it('reads from #galaxy_input / #system_input when present', () => {
    location.search = '?page=ingame&component=galaxy&galaxy=1&system=1';
    document.body.innerHTML = `
      <input id="galaxy_input" value="5" />
      <input id="system_input" value="42" />
    `;
    // Inputs override URL — this is the AGR in-page submit fix.
    expect(parseCurrentGalaxyView()).toEqual({ galaxy: 5, system: 42 });
  });

  it('falls back to URL params when inputs are missing', () => {
    location.search = '?page=ingame&component=galaxy&galaxy=3&system=77';
    expect(parseCurrentGalaxyView()).toEqual({ galaxy: 3, system: 77 });
  });

  it('falls back to URL when input values are non-numeric', () => {
    location.search = '?page=ingame&component=galaxy&galaxy=3&system=77';
    document.body.innerHTML = `
      <input id="galaxy_input" value="abc" />
      <input id="system_input" value="" />
    `;
    expect(parseCurrentGalaxyView()).toEqual({ galaxy: 3, system: 77 });
  });

  it('returns null when neither inputs nor URL supply coords', () => {
    location.search = '?page=ingame&component=galaxy';
    expect(parseCurrentGalaxyView()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// buildFleetdispatchUrl
// ──────────────────────────────────────────────────────────────────

describe('buildFleetdispatchUrl', () => {
  it('builds the expected URL with all params', () => {
    // navTarget null → getter returns the default base.
    const url = buildFleetdispatchUrl({ galaxy: 4, system: 30, position: 8 });
    expect(url).toContain('page=ingame');
    expect(url).toContain('component=fleetdispatch');
    expect(url).toContain('galaxy=4');
    expect(url).toContain('system=30');
    expect(url).toContain('position=8');
    expect(url).toContain('type=1');
    expect(url).toContain('mission=7');
    expect(url).toContain('am208=1');
  });

  it('preserves origin from location.href', () => {
    navTarget = 'https://s2-pl.ogame.gameforge.com/game/index.php?old=1';
    const url = buildFleetdispatchUrl({ galaxy: 1, system: 2, position: 3 });
    expect(url.startsWith('https://s2-pl.ogame.gameforge.com/game/index.php?')).toBe(true);
  });

  it('produces the exact format of the design spec', () => {
    navTarget = 'https://example.com/game/index.php';
    const url = buildFleetdispatchUrl({ galaxy: 1, system: 2, position: 3 });
    expect(url).toBe(
      'https://example.com/game/index.php?page=ingame&component=fleetdispatch' +
        '&galaxy=1&system=2&position=3' +
        '&type=1&mission=7&am208=1',
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// buildGalaxyUrl
// ──────────────────────────────────────────────────────────────────

describe('buildGalaxyUrl', () => {
  it('builds the expected URL with galaxy + system', () => {
    const url = buildGalaxyUrl({ galaxy: 4, system: 30 });
    expect(url).toContain('page=ingame');
    expect(url).toContain('component=galaxy');
    expect(url).toContain('galaxy=4');
    expect(url).toContain('system=30');
  });

  it('does not include position / mission params', () => {
    const url = buildGalaxyUrl({ galaxy: 4, system: 30 });
    expect(url).not.toContain('position=');
    expect(url).not.toContain('mission=');
    expect(url).not.toContain('type=');
    expect(url).not.toContain('am208=');
  });

  it('produces the exact format of the design spec', () => {
    navTarget = 'https://example.com/game/index.php';
    const url = buildGalaxyUrl({ galaxy: 2, system: 77 });
    expect(url).toBe(
      'https://example.com/game/index.php?page=ingame&component=galaxy' +
        '&galaxy=2&system=77',
    );
  });

  it('preserves origin from location.href', () => {
    navTarget = 'https://s2-pl.ogame.gameforge.com/game/index.php';
    const url = buildGalaxyUrl({ galaxy: 1, system: 1 });
    expect(url.startsWith('https://s2-pl.ogame.gameforge.com/game/index.php?')).toBe(true);
  });
});
