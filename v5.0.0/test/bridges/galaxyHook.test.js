// @vitest-environment happy-dom
//
// Tests for the galaxy-scan bridge. We drive the bridge through its real
// public surface (`installGalaxyHook`) + a hand-rolled XHR that exercises
// the patched prototype just like `xhrObserver.test.js` does. No mocks of
// `observeXHR` or `classifyPosition`: we want the integration to break
// loudly if either contract changes.
//
// Each test captures `oge5:galaxyScanned` via a per-test listener and
// tears it down in `afterEach`. The underlying `xhrObserver` patch
// persists across cases (that's by design — production can't un-patch
// the prototype either), so we reset the observer registry and the
// hook's idempotency sentinel between tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installGalaxyHook,
  _resetGalaxyHookForTest,
} from '../../src/bridges/galaxyHook.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';

/**
 * Simulate one XHR round-trip through the patched prototype. Mirrors
 * the helper in `xhrObserver.test.js`: happy-dom's XHR never reaches
 * the network, so we fake the load side by setting `responseText` and
 * dispatching a synthetic `load` event.
 *
 * @param {string} url
 * @param {string} responseText
 * @returns {Promise<void>}
 */
const fakeXHR = async (url, responseText) => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);
  xhr.send();
  Object.defineProperty(xhr, 'responseText', {
    value: responseText,
    configurable: true,
  });
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  // Yield a microtask so `{ once: true }` load handlers fire before
  // the caller asserts.
  await Promise.resolve();
};

/**
 * @typedef {object} GalaxyCapture
 * @property {any[]} events
 * @property {() => void} cleanup
 */

/**
 * Register a one-shot listener for `oge5:galaxyScanned` and return a
 * `{ events, cleanup }` pair. Tests call `cleanup()` in `afterEach`
 * (via the capture we hand back) to avoid cross-test bleed.
 *
 * @returns {GalaxyCapture}
 */
const captureGalaxyEvents = () => {
  /** @type {any[]} */
  const events = [];
  /** @type {(e: Event) => void} */
  const listener = (e) => {
    events.push(/** @type {CustomEvent} */ (e).detail);
  };
  document.addEventListener('oge5:galaxyScanned', listener);
  return {
    events,
    cleanup: () => document.removeEventListener('oge5:galaxyScanned', listener),
  };
};

/**
 * Minimal `galaxyContent` factory. The entry shape matches what
 * `classifyPosition` actually reads; anything the classifier ignores we
 * leave off. Callers can override per-entry by spread.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
const makeEntry = (overrides) => ({
  position: 1,
  ...overrides,
});

/** Cleanup registry so each test's listener is torn down reliably. */
/** @type {Array<() => void>} */
let pendingCleanups = [];

beforeEach(() => {
  _resetObserversForTest();
  _resetGalaxyHookForTest();
  pendingCleanups = [];
});

afterEach(() => {
  for (const fn of pendingCleanups) fn();
  _resetObserversForTest();
  _resetGalaxyHookForTest();
});

/**
 * @param {GalaxyCapture} capture
 * @returns {GalaxyCapture}
 */
const trackCleanup = (capture) => {
  pendingCleanups.push(capture.cleanup);
  return capture;
};

describe('installGalaxyHook — URL matching', () => {
  it('fires handler when URL contains action=fetchGalaxyContent', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    const payload = JSON.stringify({
      system: { galaxy: 4, system: 30, galaxyContent: [] },
    });
    await fakeXHR('/game/index.php?action=fetchGalaxyContent&page=ajax', payload);

    expect(events).toHaveLength(1);
  });

  it('does NOT fire for unrelated URLs', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/game/index.php?action=somethingElse',
      JSON.stringify({ system: { galaxy: 1, system: 1, galaxyContent: [] } }),
    );

    expect(events).toHaveLength(0);
  });
});

describe('installGalaxyHook — event detail', () => {
  it('dispatches with galaxy, system, scannedAt, positions, canColonize', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    const payload = JSON.stringify({
      system: {
        galaxy: 4,
        system: 30,
        canColonize: true,
        galaxyContent: [
          makeEntry({ position: 5 }),
          makeEntry({
            position: 8,
            planets: [{}],
            player: { playerId: 42, playerName: 'Bob' },
          }),
        ],
      },
    });
    const before = Date.now();
    await fakeXHR('/x?action=fetchGalaxyContent', payload);
    const after = Date.now();

    expect(events).toHaveLength(1);
    const detail = events[0];
    expect(detail.galaxy).toBe(4);
    expect(detail.system).toBe(30);
    expect(detail.canColonize).toBe(true);
    expect(typeof detail.scannedAt).toBe('number');
    expect(detail.scannedAt).toBeGreaterThanOrEqual(before);
    expect(detail.scannedAt).toBeLessThanOrEqual(after);
    expect(detail.positions).toBeTypeOf('object');
  });

  it('produces empty positions map when galaxyContent is []', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    const payload = JSON.stringify({
      system: { galaxy: 1, system: 1, galaxyContent: [] },
    });
    await fakeXHR('/x?action=fetchGalaxyContent', payload);

    expect(events).toHaveLength(1);
    expect(events[0].positions).toEqual({});
  });

  it('classifies each entry via classifyPosition — empty + occupied', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    const payload = JSON.stringify({
      system: {
        galaxy: 2,
        system: 100,
        galaxyContent: [
          // Empty slot — no planets, no player.
          makeEntry({ position: 3 }),
          // Occupied slot — live planet owned by another player.
          makeEntry({
            position: 7,
            planets: [{ isMoon: true }],
            player: { playerId: 99, playerName: 'Alice' },
          }),
        ],
      },
    });
    await fakeXHR('/x?action=fetchGalaxyContent', payload);

    expect(events).toHaveLength(1);
    const { positions } = events[0];
    expect(positions[3]).toEqual({ status: 'empty' });
    expect(positions[7]).toEqual({
      status: 'occupied',
      player: { id: 99, name: 'Alice' },
      flags: { hasMoon: true },
    });
    // Positions only carry keys we actually observed.
    expect(Object.keys(positions).sort()).toEqual(['3', '7']);
  });

  it('drops entries with out-of-range position values', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    const payload = JSON.stringify({
      system: {
        galaxy: 1,
        system: 1,
        galaxyContent: [
          { position: 0 }, // below range
          { position: 16 }, // above range
          { position: 'x' }, // non-number
          makeEntry({ position: 5 }),
        ],
      },
    });
    await fakeXHR('/x?action=fetchGalaxyContent', payload);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0].positions)).toEqual(['5']);
  });
});

describe('installGalaxyHook — malformed input', () => {
  it('silently drops non-JSON response', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR('/x?action=fetchGalaxyContent', 'not json');

    expect(events).toHaveLength(0);
  });

  it('silently drops response missing data.system', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR('/x?action=fetchGalaxyContent', JSON.stringify({ other: 'field' }));

    expect(events).toHaveLength(0);
  });

  it('silently drops response with data.system but no galaxyContent', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({ system: { galaxy: 1, system: 1 } }),
    );

    expect(events).toHaveLength(0);
  });
});

describe('installGalaxyHook — canColonize', () => {
  it('uses data.system.canColonize when present (true)', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: {
          galaxy: 1,
          system: 1,
          canColonize: true,
          galaxyContent: [],
        },
      }),
    );

    expect(events[0].canColonize).toBe(true);
  });

  it('uses data.system.canColonize when present (false)', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: {
          galaxy: 1,
          system: 1,
          canColonize: false,
          // Even with a colonizable-looking slot, the explicit `false`
          // field wins over the availableMissions fallback.
          galaxyContent: [
            {
              position: 3,
              availableMissions: [
                { missionType: 7, link: 'https://game/colonize?x=1' },
              ],
            },
          ],
        },
      }),
    );

    expect(events[0].canColonize).toBe(false);
  });

  it('derives canColonize=true from availableMissions when top-level field is absent', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: {
          galaxy: 1,
          system: 1,
          // canColonize omitted entirely
          galaxyContent: [
            {
              position: 3,
              availableMissions: [
                { missionType: 7, link: 'https://game/colonize?x=1' },
              ],
            },
          ],
        },
      }),
    );

    expect(events[0].canColonize).toBe(true);
  });

  it('derives canColonize=false when mission-7 link is "#"', async () => {
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: {
          galaxy: 1,
          system: 1,
          galaxyContent: [
            {
              position: 3,
              availableMissions: [{ missionType: 7, link: '#' }],
            },
          ],
        },
      }),
    );

    expect(events[0].canColonize).toBe(false);
  });
});

describe('installGalaxyHook — idempotency', () => {
  it('does not register a second observer on repeated install', async () => {
    installGalaxyHook();
    installGalaxyHook();
    installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: { galaxy: 1, system: 1, galaxyContent: [] },
      }),
    );

    // If the second install had stacked another observer, the handler
    // would have fired twice and we'd see two events with identical
    // payload.
    expect(events).toHaveLength(1);
  });

  it('returns an unsubscribe that silences further events', async () => {
    const unsubscribe = installGalaxyHook();
    const { events } = trackCleanup(captureGalaxyEvents());

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: { galaxy: 1, system: 1, galaxyContent: [] },
      }),
    );
    expect(events).toHaveLength(1);

    unsubscribe();

    await fakeXHR(
      '/x?action=fetchGalaxyContent',
      JSON.stringify({
        system: { galaxy: 1, system: 1, galaxyContent: [] },
      }),
    );
    expect(events).toHaveLength(1);
  });
});

describe('installGalaxyHook — own player detection', () => {
  it('marks slots as "mine" when entry.player.playerId matches window.playerId', async () => {
    /** @type {any} */ (window).playerId = 777;
    try {
      installGalaxyHook();
      const { events } = trackCleanup(captureGalaxyEvents());

      await fakeXHR(
        '/x?action=fetchGalaxyContent',
        JSON.stringify({
          system: {
            galaxy: 1,
            system: 1,
            galaxyContent: [
              {
                position: 6,
                planets: [{}],
                player: { playerId: 777, playerName: 'me' },
              },
              {
                position: 9,
                planets: [{}],
                player: { playerId: 42, playerName: 'stranger' },
              },
            ],
          },
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].positions[6]).toEqual({ status: 'mine' });
      expect(events[0].positions[9].status).toBe('occupied');
    } finally {
      delete /** @type {any} */ (window).playerId;
    }
  });
});
