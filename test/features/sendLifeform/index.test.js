// @vitest-environment happy-dom
//
// Behavioural tests for the Lifeforms orchestrator's result reactor
// (src/features/sendLifeform/index.js) — the part that marks scansStore
// from an `oge:systemDiscoveryResult`. We drive the reactor directly via
// the test-only export rather than mounting the whole button.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scansStore } from '../../../src/state/scans.js';
import {
  _onDiscoveryResultForTest,
  _resetSendLifeformForTest,
} from '../../../src/features/sendLifeform/index.js';

/**
 * Fire a synthetic discovery-result detail through the reactor.
 * @param {any} detail
 */
const fire = (detail) =>
  _onDiscoveryResultForTest(
    /** @type {any} */ (new CustomEvent('oge:systemDiscoveryResult', { detail })),
  );

beforeEach(() => {
  _resetSendLifeformForTest();
  scansStore.set({});
});
afterEach(() => {
  _resetSendLifeformForTest();
  scansStore.set({});
});

describe('Lifeforms result reactor → scansStore', () => {
  it('marks lfScannedAt + lfPositions on a successful discovery', () => {
    fire({
      success: true,
      message: 'ok',
      shipsSent: 15,
      sentToCoordinates: Array.from({ length: 15 }, (_, i) => ({ galaxy: 4, system: 472, position: i + 1 })),
      canSendDiscovery: true,
      galaxy: 4,
      system: 472,
    });
    const sys = /** @type {any} */ (scansStore.get())['4:472'];
    expect(sys).toBeDefined();
    expect(typeof sys.lfScannedAt).toBe('number');
    expect(Object.keys(sys.lfPositions)).toHaveLength(15);
    expect(sys.lfPositions[1]).toBe(sys.lfScannedAt);
  });

  it('still marks lfScannedAt on a shipsSent:0 success (so the button advances)', () => {
    fire({
      success: true,
      message: '',
      shipsSent: 0,
      sentToCoordinates: [],
      canSendDiscovery: true,
      galaxy: 4,
      system: 472,
    });
    const sys = /** @type {any} */ (scansStore.get())['4:472'];
    expect(typeof sys.lfScannedAt).toBe('number');
    expect(sys.lfPositions).toEqual({});
  });

  it('does NOT mark anything on a fleet-cap rejection', () => {
    fire({
      success: false,
      message: 'Maksymalna liczba flot osiągnięta',
      shipsSent: 0,
      sentToCoordinates: [],
      canSendDiscovery: null,
      galaxy: 4,
      system: 472,
    });
    expect(/** @type {any} */ (scansStore.get())['4:472']).toBeUndefined();
  });

  it('preserves existing colonization fields when marking', () => {
    scansStore.set(
      /** @type {any} */ ({ '4:472': { scannedAt: 111, positions: { 8: { status: 'occupied' } } } }),
    );
    fire({
      success: true,
      message: 'ok',
      shipsSent: 1,
      sentToCoordinates: [{ galaxy: 4, system: 472, position: 3 }],
      canSendDiscovery: true,
      galaxy: 4,
      system: 472,
    });
    const sys = /** @type {any} */ (scansStore.get())['4:472'];
    expect(sys.scannedAt).toBe(111);
    expect(sys.positions[8].status).toBe('occupied');
    expect(sys.lfPositions[3]).toBe(sys.lfScannedAt);
  });
});
