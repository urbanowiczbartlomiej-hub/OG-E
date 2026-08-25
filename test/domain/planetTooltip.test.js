// @ts-check

// Unit tests for the `#planetList` tooltip parser — the string format that is
// now OG-E's single source for per-planet field counts (the colony recorder and
// the abandon detector both read it through `features/shared/planetRows.js`).
//
// This is an EXTERNAL contract with OGame's markup, so the cases below are
// deliberately about the ways real tooltips vary (locale separators, extra
// parentheses, missing pieces) rather than about the happy path alone.

import { describe, it, expect } from 'vitest';
import { parsePlanetTooltip } from '../../src/domain/planetTooltip.js';

/** A realistic decoded tooltip, Polish client. */
const PL = '<b>Kolonia [4:9:8]</b><br/>Forma życia: Mechy'
  + '<br/>16.494km (0/235)<br/>od -165 °C do -125 °C<br/><a href="?page=x&cp=1">Podgląd</a>';

describe('parsePlanetTooltip', () => {
  it('reads coords and the field pair out of a real tooltip', () => {
    expect(parsePlanetTooltip(PL)).toEqual({
      coords: '[4:9:8]', galaxy: 4, system: 9, position: 8, used: 0, max: 235,
    });
  });

  it('accepts a comma diameter separator (locale-dependent rendering)', () => {
    const t = '<b>Colony [1:2:3]</b><br/>12,345km (7/188)<br/>';
    expect(parsePlanetTooltip(t)).toMatchObject({ used: 7, max: 188 });
  });

  it('accepts a diameter with no separator at all', () => {
    expect(parsePlanetTooltip('<b>C [1:2:3]</b><br/>9000km (1/163)'))
      .toMatchObject({ used: 1, max: 163 });
  });

  it('tolerates whitespace between the diameter and the parenthetical', () => {
    expect(parsePlanetTooltip('<b>C [1:2:3]</b><br/>16.494 km  (0/235)'))
      .toMatchObject({ used: 0, max: 235 });
  });

  it('anchors on "km" so another parenthetical pair cannot be mistaken for fields', () => {
    // The temperature line and the trailing links carry their own parentheses;
    // a bare \\((\\d+)/(\\d+)\\) would latch onto whichever came first.
    const t = '<b>C [5:6:7]</b><br/>(1/2) od -10 °C<br/>16.494km (3/240)<br/>(9/9)';
    expect(parsePlanetTooltip(t)).toMatchObject({ used: 3, max: 240 });
  });

  it('keeps used === 0 — that IS the fresh-colony signal, not a missing value', () => {
    const r = parsePlanetTooltip('<b>C [1:1:1]</b><br/>100km (0/150)');
    expect(r?.used).toBe(0);
    expect(r?.max).toBe(150);
  });

  it('renders coords in the bracketed form the game DOM uses elsewhere', () => {
    expect(parsePlanetTooltip('<b>C [9:400:15]</b><br/>100km (2/50)')?.coords)
      .toBe('[9:400:15]');
  });

  it('rejects a tooltip with no coord block', () => {
    expect(parsePlanetTooltip('<b>Colony</b><br/>16.494km (0/235)')).toBeNull();
  });

  it('rejects a tooltip with no field parenthetical', () => {
    expect(parsePlanetTooltip('<b>Colony [4:9:8]</b><br/>16.494km')).toBeNull();
  });

  it('rejects a nonsense max of zero rather than reporting a 0-field planet', () => {
    expect(parsePlanetTooltip('<b>C [1:2:3]</b><br/>100km (0/0)')).toBeNull();
  });

  it('rejects empty / missing input', () => {
    expect(parsePlanetTooltip('')).toBeNull();
    expect(parsePlanetTooltip(null)).toBeNull();
    expect(parsePlanetTooltip(undefined)).toBeNull();
  });

  it('rejects a non-string (a missing attribute read straight through)', () => {
    expect(parsePlanetTooltip(/** @type {any} */ (42))).toBeNull();
    expect(parsePlanetTooltip(/** @type {any} */ ({}))).toBeNull();
  });

  it('never returns a half-filled result', () => {
    // Every caller treats non-null as a COMPLETE observation, so a partial
    // parse must be null rather than an object with holes in it.
    const r = parsePlanetTooltip('<b>C [2:3:4]</b><br/>100km (5/60)');
    expect(Object.values(/** @type {object} */ (r)).some((v) => v === undefined || Number.isNaN(v)))
      .toBe(false);
  });
});
