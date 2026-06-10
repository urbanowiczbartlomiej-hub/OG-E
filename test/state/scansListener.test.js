// @vitest-environment happy-dom
//
// Tests the `oge:galaxyScanned` → scansStore listener wiring
// (`installScansListener` in src/state/scans.js), focusing on the lifeform
// carry-forward: a colonization rescan must preserve `lfScannedAt` /
// `lfPositions` (owned by features/sendLifeform), which the galaxy XHR
// never observes.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scansStore,
  installScansListener,
  disposeScansListener,
} from '../../src/state/scans.js';

/**
 * Dispatch a galaxy-scanned event the way bridges/galaxyHook.js would.
 * @param {number} galaxy @param {number} system @param {any} positions
 */
const fireGalaxyScanned = (galaxy, system, positions) => {
  document.dispatchEvent(
    new CustomEvent('oge:galaxyScanned', {
      detail: { galaxy, system, positions, scannedAt: Date.now() },
    }),
  );
};

beforeEach(() => {
  disposeScansListener();
  scansStore.set({});
  installScansListener();
});
afterEach(() => {
  disposeScansListener();
  scansStore.set({});
});

describe('installScansListener — lifeform carry-forward', () => {
  it('preserves lfScannedAt / lfPositions across a colonization rescan', () => {
    // Seed a system that the Lifeforms button already discovered.
    scansStore.set(
      /** @type {any} */ ({
        '4:472': {
          scannedAt: 1000,
          positions: { 8: { status: 'occupied' } },
          lfScannedAt: 5000,
          lfPositions: { 1: 5000, 2: 5000 },
        },
      }),
    );

    // A fresh galaxy scan arrives (colonization) — it knows nothing about lf.
    fireGalaxyScanned(4, 472, { 8: { status: 'empty' } });

    const sys = /** @type {any} */ (scansStore.get())['4:472'];
    // Colonization fields refreshed…
    expect(sys.positions[8].status).toBe('empty');
    // …lifeform markers survived.
    expect(sys.lfScannedAt).toBe(5000);
    expect(sys.lfPositions).toEqual({ 1: 5000, 2: 5000 });
  });

  it('leaves lf fields absent on a first scan of a never-discovered system', () => {
    fireGalaxyScanned(1, 5, { 1: { status: 'empty' } });
    const sys = /** @type {any} */ (scansStore.get())['1:5'];
    expect(sys.lfScannedAt).toBeUndefined();
    expect(sys.lfPositions).toBeUndefined();
  });
});
