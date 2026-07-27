// @ts-check
//
// Unit tests for the pure fleet-planning core (src/domain/fleetPlan.js):
// resolveSelection (explicit list with per-ship requirement fractions, and
// "all"), isMissionAllowed and classifyTargetError. Pure — no DOM.

import { describe, it, expect } from 'vitest';
import {
  resolveSelection,
  isMissionAllowed,
  classifyTargetError,
  isFleetCapReached,
  ERR_NO_MOON,
  ERR_NO_COLONIZER,
  ERR_RESERVED,
  ERR_TOKEN_SPENT,
} from '../../src/domain/fleetPlan.js';

/** @typedef {import('../../src/domain/fleetPlan.js').SelectionSpec} SelectionSpec */

describe('resolveSelection — list', () => {
  it('selects min(qty, have) per ship and is ok when every req is met', () => {
    const spec = /** @type {SelectionSpec} */ ({
      kind: 'list',
      ships: [
        { id: 202, qty: 10, frac: 1 },
        { id: 203, qty: 5, frac: 1 },
      ],
    });
    const r = resolveSelection(spec, { 202: 20, 203: 5 });
    expect(r.ok).toBe(true);
    expect(r.requirementsMet).toBe(true);
    expect(r.selection).toEqual([
      { id: 202, count: 10 },
      { id: 203, count: 5 },
    ]);
    expect(r.shortfalls).toEqual([]);
  });

  it('flags a shortfall (and not ok) when a frac:1 ship is short', () => {
    const spec = /** @type {SelectionSpec} */ ({
      kind: 'list',
      ships: [{ id: 203, qty: 10, frac: 1 }],
    });
    const r = resolveSelection(spec, { 203: 4 });
    expect(r.requirementsMet).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.shortfalls).toEqual([{ id: 203, want: 10, have: 4 }]);
    // We still report what COULD be selected (caller may show it).
    expect(r.selection).toEqual([{ id: 203, count: 4 }]);
  });

  it('honours a fractional requirement (Exp 51% preset)', () => {
    const spec = /** @type {SelectionSpec} */ ({
      kind: 'list',
      ships: [{ id: 202, qty: 100, frac: 0.51 }],
    });
    // 60 ≥ ceil(51) ⇒ met; selects min(100,60)=60.
    expect(resolveSelection(spec, { 202: 60 }).ok).toBe(true);
    expect(resolveSelection(spec, { 202: 60 }).selection).toEqual([
      { id: 202, count: 60 },
    ]);
    // 50 < ceil(51) ⇒ short.
    const short = resolveSelection(spec, { 202: 50 });
    expect(short.ok).toBe(false);
    expect(short.shortfalls).toEqual([{ id: 202, want: 51, have: 50 }]);
  });

  it('treats frac:0 ships as optional (met even when absent)', () => {
    const spec = /** @type {SelectionSpec} */ ({
      kind: 'list',
      ships: [
        { id: 202, qty: 5, frac: 1 },
        { id: 210, qty: 3, frac: 0 }, // optional probes
      ],
    });
    const r = resolveSelection(spec, { 202: 5 }); // no 210
    expect(r.requirementsMet).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.selection).toEqual([{ id: 202, count: 5 }]); // 210 omitted (0)
  });

  it('is not ok when requirements are met but nothing can be selected', () => {
    const spec = /** @type {SelectionSpec} */ ({
      kind: 'list',
      ships: [{ id: 210, qty: 3, frac: 0 }],
    });
    const r = resolveSelection(spec, {}); // optional ship, none present
    expect(r.requirementsMet).toBe(true);
    expect(r.ok).toBe(false); // empty selection ⇒ not ok
    expect(r.selection).toEqual([]);
  });

  it('accepts a Map availability', () => {
    const spec = /** @type {SelectionSpec} */ ({
      kind: 'list',
      ships: [{ id: 202, qty: 5, frac: 1 }],
    });
    const r = resolveSelection(spec, new Map([[202, 9]]));
    expect(r.ok).toBe(true);
    expect(r.selection).toEqual([{ id: 202, count: 5 }]);
  });
});

describe('resolveSelection — all', () => {
  it('selects every available ship at full count', () => {
    const r = resolveSelection({ kind: 'all' }, { 202: 12, 203: 4, 210: 0 });
    expect(r.ok).toBe(true);
    expect(r.requirementsMet).toBe(true);
    // id 210 has 0 → omitted.
    expect(r.selection).toEqual([
      { id: 202, count: 12 },
      { id: 203, count: 4 },
    ]);
  });

  it('is not ok when the planet is empty', () => {
    const r = resolveSelection({ kind: 'all' }, { 202: 0 });
    expect(r.ok).toBe(false);
    expect(r.selection).toEqual([]);
  });
});

describe('isMissionAllowed', () => {
  it('reads the orders map by stringified mission id', () => {
    expect(isMissionAllowed({ 7: true, 15: false }, 7)).toBe(true);
    expect(isMissionAllowed({ 7: true, 15: false }, 15)).toBe(false);
    expect(isMissionAllowed({ 7: true }, 3)).toBe(false); // absent
  });

  it('returns false for a null/absent orders map', () => {
    expect(isMissionAllowed(null, 7)).toBe(false);
    expect(isMissionAllowed(undefined, 7)).toBe(false);
  });
});

describe('classifyTargetError', () => {
  it('maps known codes', () => {
    expect(classifyTargetError(ERR_NO_MOON)).toBe('noMoon');
    expect(classifyTargetError(ERR_NO_COLONIZER)).toBe('noShip');
    expect(classifyTargetError(ERR_RESERVED)).toBe('reserved');
  });

  it('maps a spent ajax token (OGame 13.0) to retry, NOT to a target verdict', () => {
    // Error 100 = LOCA_ERROR_INQUIRY_NOT_WORKED_TRYAGAIN. Since 13.0 every
    // checkTarget spends the session token, so a replayed one is refused —
    // which says nothing about the target. It must stay separable from the
    // target-shaped tags, because those drive re-scan / blacklist decisions.
    expect(ERR_TOKEN_SPENT).toBe(100);
    expect(classifyTargetError(ERR_TOKEN_SPENT)).toBe('retry');
    expect(classifyTargetError(ERR_TOKEN_SPENT)).not.toBe('generic');
  });

  it('treats null/0 as ok and unknown non-zero as generic', () => {
    expect(classifyTargetError(null)).toBe('ok');
    expect(classifyTargetError(0)).toBe('ok');
    expect(classifyTargetError(undefined)).toBe('ok');
    expect(classifyTargetError(999999)).toBe('generic');
  });
});

describe('isFleetCapReached', () => {
  it('returns true when used slots equal the max', () => {
    expect(isFleetCapReached({ fleetCount: 18, maxFleetCount: 18 })).toBe(true);
  });

  it('returns true when used slots exceed the max', () => {
    expect(isFleetCapReached({ fleetCount: 20, maxFleetCount: 18 })).toBe(true);
  });

  it('returns false when below the cap', () => {
    expect(isFleetCapReached({ fleetCount: 17, maxFleetCount: 18 })).toBe(false);
  });

  it('returns false when maxFleetCount is 0 (game not loaded yet)', () => {
    expect(isFleetCapReached({ fleetCount: 0, maxFleetCount: 0 })).toBe(false);
  });

  it('returns false for null/undefined input', () => {
    expect(isFleetCapReached(null)).toBe(false);
    expect(isFleetCapReached(undefined)).toBe(false);
  });
});
