// @vitest-environment happy-dom
//
// Regression: a colonize decision recorded BEFORE its store finished hydrating
// used to erase itself — and take the whole stored log with it.
//
// The sequence that bit us in a live universe:
//   1. a fleetdispatch page loads; `initColonizeDecisionsStore()` kicks off the
//      async chrome.storage read;
//   2. ~244 ms in, the game fires its OWN checkTarget for the pre-filled target
//      (see docs/ogame-fleet-mechanics.md) and it comes back refused;
//   3. the old `recordDecision` wrote into the still-EMPTY initial map and
//      flushed THAT map onto the storage key — dropping every decision the key
//      already held;
//   4. the hydrate then resolved with the value it had read in step 1 and
//      `set` it back, so the decision from step 3 vanished for good.
//
// Net effect: that one slot was never blocked, so every colonize run re-proposed
// the exact coords it had just skipped. `recordDecision` now parks the write on
// `whenColonizeDecisionsHydrated()`.
//
// Storage is mocked wholesale here (the real `chromeStore` resolves instantly in
// happy-dom, which is precisely the race we must NOT have), with an in-memory
// `safeLS` so the rest of the state layer keeps working.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/storage.js', () => {
  /** @type {Map<string, string>} */
  const mem = new Map();
  const safeLS = {
    get: (/** @type {string} */ k) => (mem.has(k) ? /** @type {string} */ (mem.get(k)) : null),
    set: (/** @type {string} */ k, /** @type {unknown} */ v) => void mem.set(k, String(v)),
    remove: (/** @type {string} */ k) => void mem.delete(k),
    bool: (/** @type {string} */ k, /** @type {boolean} */ d = false) =>
      (mem.has(k) ? mem.get(k) === 'true' : d),
    int: (/** @type {string} */ k, /** @type {number} */ d = 0) => {
      const n = parseInt(/** @type {string} */ (mem.get(k)), 10);
      return Number.isFinite(n) ? n : d;
    },
    json: (/** @type {string} */ k, /** @type {unknown} */ d = null) => {
      try {
        const raw = mem.get(k);
        return raw == null ? d : JSON.parse(raw);
      } catch {
        return d;
      }
    },
    setJSON: (/** @type {string} */ k, /** @type {unknown} */ v) => {
      try {
        mem.set(k, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
  };
  return {
    safeLS,
    chromeStore: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), onChanged: vi.fn() },
    isExtensionContextAlive: () => true,
    isExtensionContextInvalidatedError: () => false,
  };
});

import { chromeStore } from '../../src/lib/storage.js';
import {
  installSendColony,
  _resetSendColonyForTest,
} from '../../src/features/sendColony/index.js';
import { settingsStore } from '../../src/state/settings.js';
import {
  colonizeDecisionsStore,
  initColonizeDecisionsStore,
  disposeColonizeDecisionsStore,
} from '../../src/state/colonizeDecisions.js';
import { DEC_MINE, DEC_RESERVED } from '../../src/domain/colonizeDecisions.js';

/** @type {{ get: import('vitest').Mock, set: import('vitest').Mock }} */
const mock = /** @type {any} */ (chromeStore);

/** Drain enough microtasks for the hydrate `.then` chain AND the parked write. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** The decision the previous page view had already persisted. */
const STORED = { '9:9:9': { s: DEC_MINE, ts: 1 } };

beforeEach(() => {
  disposeColonizeDecisionsStore();
  colonizeDecisionsStore.set({});
  mock.get.mockReset();
  mock.set.mockReset();
  mock.set.mockResolvedValue(undefined);
  window.location.href = 'https://s163-pl.ogame.gameforge.com/game/index.php?page=ingame&component=fleetdispatch';
  document.body.innerHTML = `
    <div id="planetList">
      <div class="smallplanet hightlightPlanet" id="planet-1">
        <span class="planet-koords">[4:30:8]</span>
      </div>
    </div>
  `;
  settingsStore.set({ ...settingsStore.get(), showColonizeButton: true });
});

afterEach(() => {
  _resetSendColonyForTest();
  disposeColonizeDecisionsStore();
  colonizeDecisionsStore.set({});
});

describe('a decision recorded mid-hydration', () => {
  it('waits for the hydrate, then lands ON TOP of the stored log', async () => {
    /** @type {(v: unknown) => void} */
    let resolveLoad = () => {};
    mock.get.mockReturnValue(new Promise((r) => { resolveLoad = r; }));
    initColonizeDecisionsStore(); // hydrate now IN FLIGHT
    installSendColony();

    // The game's own init-time checkTarget: our colony ship is aboard, the slot
    // is refused for a planet move (140016). No scan entry exists for it — the
    // API-breadth case, where the decision log is the only thing that can block.
    document.dispatchEvent(
      new CustomEvent('oge:checkTargetResult', {
        detail: {
          galaxy: 4, system: 30, position: 8,
          errorCode: 140016, orders: null, ships: { 208: 1 },
        },
      }),
    );
    await flushMicrotasks();

    // Parked, not applied — and crucially nothing was written to the key yet,
    // so the stored log is still intact at this instant.
    expect(colonizeDecisionsStore.get()['4:30:8']).toBeUndefined();
    expect(mock.set).not.toHaveBeenCalled();

    resolveLoad(STORED);
    await flushMicrotasks();

    // Both survive: the refusal we just learned AND everything the key held.
    expect(colonizeDecisionsStore.get()['4:30:8']?.s).toBe(DEC_RESERVED);
    expect(colonizeDecisionsStore.get()['9:9:9']?.s).toBe(DEC_MINE);

    // And that union is what actually reached storage — the flush is what has
    // to survive the game's post-send reload.
    const written = mock.set.mock.calls.at(-1)?.[1];
    expect(Object.keys(/** @type {object} */ (written)).sort()).toEqual(['4:30:8', '9:9:9']);
  });
});
