// Unit tests for the shared per-system tooltip text. Pure string output
// (no DOM), so the default node env is fine. Covers the not-scanned line,
// the per-slot breakdown with flags + owner (incl. rank/ally enrichment),
// the STALE banner, and that empty slots produce no line.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { buildSystemTooltip } from '../../../src/features/dashboard/systemTooltip.js';

describe('buildSystemTooltip', () => {
  it('returns the not-scanned line for a missing or empty scan', () => {
    expect(buildSystemTooltip(4, 30, null)).toBe('[4:30] not scanned');
    expect(buildSystemTooltip(4, 30, undefined)).toBe('[4:30] not scanned');
    expect(
      buildSystemTooltip(4, 30, /** @type {any} */ ({ scannedAt: 1, positions: undefined })),
    ).toBe('[4:30] not scanned');
  });

  it('lists one line per occupied slot with status, flags and owner', () => {
    const scan = {
      scannedAt: 0,
      positions: {
        8: {
          status: 'vacation',
          flags: { hasMoon: true },
          player: { id: 1, name: 'UP4DLY', rank: 11, ally: '2040' },
        },
        10: { status: 'long_inactive', player: { id: 2, name: 'Doltra' } },
      },
    };
    const lines = buildSystemTooltip(1, 100, /** @type {any} */ (scan)).split('\n');
    expect(lines[0]).toMatch(/^\[1:100\] scanned /);
    expect(lines).toContain('   8: vacation (hasMoon) [UP4DLY #11 2040]');
    expect(lines).toContain('  10: long_inactive [Doltra]');
  });

  it('shows the owner name without rank/ally when those are absent', () => {
    const scan = {
      scannedAt: 0,
      positions: { 5: { status: 'occupied', player: { id: 3, name: 'Bob' } } },
    };
    const lines = buildSystemTooltip(1, 1, /** @type {any} */ (scan)).split('\n');
    expect(lines).toContain('   5: occupied [Bob]');
  });

  it('prepends a STALE banner when opts.stale is set', () => {
    const scan = { scannedAt: 0, positions: { 8: { status: 'empty' } } };
    const lines = buildSystemTooltip(2, 5, /** @type {any} */ (scan), { stale: true }).split('\n');
    expect(lines[0]).toBe('[2:5] STALE — rescan recommended');
    expect(lines[1]).toMatch(/^\[2:5\] scanned /);
  });

  it('skips slots with no observation', () => {
    const scan = { scannedAt: 0, positions: {} };
    expect(buildSystemTooltip(1, 1, /** @type {any} */ (scan)).split('\n')).toHaveLength(1);
  });
});
