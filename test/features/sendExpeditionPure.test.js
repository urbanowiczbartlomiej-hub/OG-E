// Unit tests for sendExpedition's pure helpers — currently the shipless-planet
// detector added for the OGame 1.13 AGR change (with no fleet on the planet AGR
// omits its Expeditions routine entirely, so the click handler must recognise
// "no ships" from the fleetDispatcher snapshot and hop onward instead of
// waiting out the routine timeout and painting a spurious "AGR exp off").
//
// @ts-check

import { describe, it, expect } from 'vitest';

import {
  isPlanetShipless,
  isCycleStart,
  chooseExpeditionStartCp,
} from '../../src/features/sendExpedition/pure.js';

/**
 * Minimal snapshot factory — only the field under test varies; the cap
 * counters are irrelevant to shiplessness.
 *
 * @param {Array<{ id: number, number: number }>} ships
 * @returns {import('../../src/bridges/fleetDispatcherSnapshot.js').FleetDispatcherSnapshot}
 */
const snap = (ships) => ({
  currentPlanet: { galaxy: 4, system: 473, position: 15 },
  targetPlanet: null,
  orders: null,
  shipsOnPlanet: ships,
  expeditionCount: 0,
  maxExpeditionCount: 14,
  fleetCount: 0,
  maxFleetCount: 37,
});

describe('sendExpedition — isPlanetShipless (pure)', () => {
  it('reports shipless for an empty shipsOnPlanet', () => {
    expect(isPlanetShipless(snap([]))).toBe(true);
  });

  it('reports NOT shipless when any ship is present', () => {
    expect(isPlanetShipless(snap([{ id: 204, number: 100 }]))).toBe(false);
  });

  it('a null snapshot is unknown — do not short-circuit', () => {
    expect(isPlanetShipless(null)).toBe(false);
  });
});

describe('sendExpedition — isCycleStart (pure)', () => {
  it('is true only when nothing is in flight', () => {
    expect(isCycleStart(0)).toBe(true);
    expect(isCycleStart(1)).toBe(false);
    expect(isCycleStart(5)).toBe(false);
  });
});

describe('sendExpedition — chooseExpeditionStartCp (pure)', () => {
  it('picks the anchor at a fresh cycle when it is still on the list', () => {
    expect(
      chooseExpeditionStartCp({
        inFlight: 0,
        startCp: 42,
        startCpOnList: true,
        fallbackCp: 7,
      }),
    ).toBe(42);
  });

  it('falls back mid-cycle even with a remembered anchor', () => {
    expect(
      chooseExpeditionStartCp({
        inFlight: 1,
        startCp: 42,
        startCpOnList: true,
        fallbackCp: 7,
      }),
    ).toBe(7);
  });

  it('falls back when nothing is remembered yet', () => {
    expect(
      chooseExpeditionStartCp({
        inFlight: 0,
        startCp: 0,
        startCpOnList: false,
        fallbackCp: 7,
      }),
    ).toBe(7);
  });

  it('falls back when the remembered anchor is no longer on the planet list', () => {
    expect(
      chooseExpeditionStartCp({
        inFlight: 0,
        startCp: 42,
        startCpOnList: false,
        fallbackCp: 7,
      }),
    ).toBe(7);
  });

  it('propagates a null fallback (nowhere to go) unchanged', () => {
    expect(
      chooseExpeditionStartCp({
        inFlight: 1,
        startCp: 0,
        startCpOnList: false,
        fallbackCp: null,
      }),
    ).toBeNull();
  });
});
