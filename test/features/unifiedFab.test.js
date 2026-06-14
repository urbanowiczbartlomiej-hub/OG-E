// @vitest-environment happy-dom
//
// Tests for the unified floating button: the pure orbit geometry / active-id
// logic (unifiedFabPure.js) and the behavioural surface of the shell
// (unifiedFab.js) driven through the public entry point — `createButton`
// with `module` metadata, exactly how the four features register. We assert
// observable output (wrapper/handle DOM, per-module visibility, the orbital
// picker's orbs + captions, the persisted active id), not internals.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createButton } from '../../src/features/shared/button.js';
import {
  _resetUnifiedFabForTest,
  setActiveFabModule,
  FAB_WRAP_ID,
  FAB_HANDLE_ID,
  FAB_OVERLAY_ID,
  FAB_ORB_CLASS,
  FAB_ORB_LABEL_CLASS,
  FAB_ACTIVE_KEY,
} from '../../src/features/shared/unifiedFab.js';
import {
  resolveActiveId,
  orbitLayout,
  orbDiameter,
  orbitRadius,
  handleDiameter,
  aimAngle,
  handleOffset,
} from '../../src/features/shared/unifiedFabPure.js';
import { settingsStore } from '../../src/state/settings.js';

beforeEach(() => {
  _resetUnifiedFabForTest();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  localStorage.clear();
  settingsStore.update((s) => ({ ...s, fabMode: true, fabBtnSize: 320 }));
});

afterEach(() => {
  _resetUnifiedFabForTest();
});

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Register a module button the way the features do. `split: true` builds a
 * two-zone host (like sendColony / dailyRun).
 *
 * @param {string} id
 * @param {string} name
 * @param {{ split?: boolean }} [opts]
 * @returns {import('../../src/features/shared/button.js').Button}
 */
const makeModule = (id, name, { split = false } = {}) =>
  /** @type {any} */ (
    createButton({
      id: `oge-test-${id}`,
      title: name,
      ringId: `oge-ring-${id}`,
      size: 100,
      fontScale: 0.2,
      module: { id, name, color: '#4aa8ff', glyph: '<circle cx="32" cy="32" r="10"/>' },
      zones: split
        ? [
            { key: 'a', id: `oge-test-${id}-a`, bg: '#4aa8ff', onTap: () => {} },
            { key: 'b', id: `oge-test-${id}-b`, bg: '#13d1de', onTap: () => {} },
          ]
        : [{ key: 'main', id: `oge-test-${id}`, bg: '#4aa8ff', onTap: () => {} }],
    })
  );

const wrap = () => document.getElementById(FAB_WRAP_ID);
const handle = () => document.getElementById(FAB_HANDLE_ID);
const overlay = () => document.getElementById(FAB_OVERLAY_ID);
const orbs = () =>
  /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.' + FAB_ORB_CLASS)]);
const orbLabels = () => [...document.querySelectorAll('.' + FAB_ORB_LABEL_CLASS)];

// ─── pure: resolveActiveId ────────────────────────────────────────────────

describe('resolveActiveId', () => {
  it('returns the stored id when it is registered', () => {
    expect(resolveActiveId('col', ['exp', 'col', 'lf'])).toBe('col');
  });

  it('falls back to the first registered module on a missing/stale id', () => {
    expect(resolveActiveId(null, ['exp', 'col'])).toBe('exp');
    expect(resolveActiveId('gone', ['exp', 'col'])).toBe('exp');
  });

  it('returns null when nothing is registered', () => {
    expect(resolveActiveId('exp', [])).toBeNull();
  });
});

// ─── pure: sizes ──────────────────────────────────────────────────────────

describe('orb / handle sizing', () => {
  it('orbDiameter is proportional but clamped to [56, 150]', () => {
    expect(orbDiameter(320)).toBe(134); // 0.42 × 320
    expect(orbDiameter(40)).toBe(56); // floor
    expect(orbDiameter(560)).toBe(150); // ceiling
  });

  it('handleDiameter is proportional but clamped to [24, 48]', () => {
    expect(handleDiameter(100)).toBe(24); // floor (0.18 × 100 = 18)
    expect(handleDiameter(200)).toBe(36);
    expect(handleDiameter(560)).toBe(48); // ceiling
  });

  it('orbitRadius clears the FAB edge plus the orb radius', () => {
    const orb = orbDiameter(320);
    expect(orbitRadius(320, orb)).toBe(320 / 2 + orb / 2 + 14);
  });
});

// ─── pure: orbitLayout ────────────────────────────────────────────────────

describe('orbitLayout', () => {
  const base = { radius: 120, orbSize: 80, labelGap: 12, vw: 1000, vh: 800 };

  it('returns an empty array for count 0', () => {
    expect(orbitLayout({ ...base, cx: 100, cy: 100, count: 0 })).toEqual([]);
  });

  it('fans the arc toward the viewport centre', () => {
    // FAB sits on the left edge at mid-height → the viewport centre is due
    // east, so every orb must land to the RIGHT of the FAB.
    const items = orbitLayout({ ...base, cx: 50, cy: 400, count: 4 });
    expect(items).toHaveLength(4);
    for (const it_ of items) expect(it_.x).toBeGreaterThan(50);
  });

  it('places captions further out than their orbs along the same ray', () => {
    const items = orbitLayout({ ...base, cx: 500, cy: 400, count: 3 });
    for (const it_ of items) {
      const dOrb = Math.hypot(it_.x - 500, it_.y - 400);
      const dLabel = Math.hypot(it_.labelX - 500, it_.labelY - 400);
      expect(dLabel).toBeGreaterThan(dOrb);
    }
  });

  it('clamps every orb inside the viewport even from a corner', () => {
    const items = orbitLayout({ ...base, cx: 5, cy: 5, count: 4 });
    const margin = base.orbSize / 2 + 8;
    for (const it_ of items) {
      expect(it_.x).toBeGreaterThanOrEqual(margin);
      expect(it_.x).toBeLessThanOrEqual(base.vw - margin);
      expect(it_.y).toBeGreaterThanOrEqual(margin);
      expect(it_.y).toBeLessThanOrEqual(base.vh - margin);
    }
  });
});

// ─── pure: aimAngle + handleOffset ────────────────────────────────────────

describe('aimAngle', () => {
  const vp = { vw: 1000, vh: 1000 };

  it('points from the FAB toward the viewport centre', () => {
    // FAB on the left edge, mid-height → centre is due east → ~0 rad.
    expect(aimAngle({ ...vp, cx: 0, cy: 500 })).toBeCloseTo(0);
    // FAB on the right edge → centre is due west → ±π rad.
    expect(Math.abs(aimAngle({ ...vp, cx: 1000, cy: 500 }))).toBeCloseTo(Math.PI);
    // FAB top-centre → centre is due south (y grows down) → +π/2.
    expect(aimAngle({ ...vp, cx: 500, cy: 0 })).toBeCloseTo(Math.PI / 2);
  });

  it('falls back to the down-right diagonal at the exact centre', () => {
    expect(aimAngle({ ...vp, cx: 500, cy: 500 })).toBeCloseTo(Math.PI / 4);
  });
});

describe('handleOffset', () => {
  const common = { fabSize: 100, handleSize: 20, vw: 1000, vh: 1000 };
  // The FAB centre's local coord is fabSize/2 (50); a centred handle would
  // sit at 50 - handleSize/2 = 40. Past-centre FABs push the handle below
  // that line, before-centre FABs above it.
  const CENTRE_LINE = 40;

  it('rides the FAB edge on the side facing the viewport centre', () => {
    // FAB well past centre (bottom-right) → handle on its top-left edge.
    const br = handleOffset({ ...common, cx: 900, cy: 900 });
    expect(br.left).toBeLessThan(CENTRE_LINE);
    expect(br.top).toBeLessThan(CENTRE_LINE);
    // FAB before centre (top-left) → handle on its bottom-right edge.
    const tl = handleOffset({ ...common, cx: 100, cy: 100 });
    expect(tl.left).toBeGreaterThan(CENTRE_LINE);
    expect(tl.top).toBeGreaterThan(CENTRE_LINE);
  });

  it('keeps the handle centre exactly on the FAB edge (radius = fabSize/2)', () => {
    const { left, top } = handleOffset({ ...common, cx: 100, cy: 500 });
    // Re-add handleSize/2 to recover the handle centre, then measure its
    // distance from the FAB centre (50,50) — must equal the FAB radius.
    const dx = left + common.handleSize / 2 - common.fabSize / 2;
    const dy = top + common.handleSize / 2 - common.fabSize / 2;
    expect(Math.hypot(dx, dy)).toBeCloseTo(common.fabSize / 2);
  });
});

// ─── shell: wrapper + visibility ──────────────────────────────────────────

describe('unified FAB shell', () => {
  it('creates the wrapper + handle on first registration and mounts the host inside', () => {
    const b = makeModule('exp', 'Expeditions');
    const w = wrap();
    expect(w).not.toBeNull();
    expect(handle()).not.toBeNull();
    expect(b.el.parentElement).toBe(w);
    expect(b.el.style.display).not.toBe('none');
    // Wrapper takes the shared size from settings.
    expect(w?.style.width).toBe('320px');
  });

  it('shows only the active module (first registered by default)', () => {
    const exp = makeModule('exp', 'Expeditions');
    const col = makeModule('col', 'Colonization', { split: true });
    expect(exp.el.style.display).not.toBe('none');
    expect(col.el.style.display).toBe('none');
  });

  it('honours a persisted active id from a previous session', () => {
    localStorage.setItem(FAB_ACTIVE_KEY, 'col');
    const exp = makeModule('exp', 'Expeditions');
    const col = makeModule('col', 'Colonization');
    expect(exp.el.style.display).toBe('none');
    expect(col.el.style.display).not.toBe('none');
  });

  it('falls back to the first module when the persisted id is stale', () => {
    localStorage.setItem(FAB_ACTIVE_KEY, 'does-not-exist');
    const exp = makeModule('exp', 'Expeditions');
    makeModule('col', 'Colonization');
    expect(exp.el.style.display).not.toBe('none');
  });

  it('setActiveFabModule switches visibility and persists the id', () => {
    const exp = makeModule('exp', 'Expeditions');
    const col = makeModule('col', 'Colonization');
    setActiveFabModule('col');
    expect(localStorage.getItem(FAB_ACTIVE_KEY)).toBe('col');
    expect(exp.el.style.display).toBe('none');
    expect(col.el.style.display).not.toBe('none');
  });

  it('resizes the wrapper live on fabBtnSize changes', () => {
    makeModule('exp', 'Expeditions');
    settingsStore.update((s) => ({ ...s, fabBtnSize: 200 }));
    expect(wrap()?.style.width).toBe('200px');
    expect(wrap()?.style.height).toBe('200px');
  });

  it('positions the +/× handle inline so it rides the FAB edge (not a fixed corner)', () => {
    makeModule('exp', 'Expeditions');
    // The handle no longer hard-codes right/bottom; positionHandle() writes
    // explicit left/top derived from the FAB's position toward screen centre.
    expect(handle()?.style.left).not.toBe('');
    expect(handle()?.style.top).not.toBe('');
    expect(handle()?.style.right).toBe('');
    expect(handle()?.style.bottom).toBe('');
  });

  it('tears the shell down when the last module unregisters', () => {
    const exp = makeModule('exp', 'Expeditions');
    const col = makeModule('col', 'Colonization');
    exp.dispose();
    expect(wrap()).not.toBeNull(); // col still registered
    col.dispose();
    expect(wrap()).toBeNull();
  });
});

// ─── shell: orbital picker ────────────────────────────────────────────────

describe('orbital picker', () => {
  it('handle click opens one single-piece orb + caption per module', () => {
    makeModule('exp', 'Expeditions');
    makeModule('col', 'Colonization', { split: true });
    handle()?.click();

    expect(overlay()).not.toBeNull();
    expect(handle()?.getAttribute('aria-expanded')).toBe('true');
    const os = orbs();
    expect(os).toHaveLength(2);
    // Split modules render single-piece in the picker: no nested zones,
    // just the identity glyph.
    for (const orb of os) {
      expect(orb.querySelector('.zone')).toBeNull();
      expect(orb.querySelector('.oge-art svg')).not.toBeNull();
    }
    expect(orbLabels().map((l) => l.textContent)).toEqual([
      'Expeditions',
      'Colonization',
    ]);
    // The active module's orb is highlighted.
    expect(os[0].classList.contains('is-active')).toBe(true);
    expect(os[1].classList.contains('is-active')).toBe(false);
  });

  it('tapping an orb only SWITCHES the module (persist + swap + close), never fires its action', () => {
    let tapped = 0;
    createButton({
      id: 'oge-test-exp',
      title: 'Expeditions',
      ringId: 'oge-ring-exp',
      size: 100,
      fontScale: 0.2,
      module: { id: 'exp', name: 'Expeditions', color: '#4aa8ff', glyph: '<circle r="1"/>' },
      zones: [{ key: 'main', id: 'oge-test-exp', bg: '#4aa8ff', onTap: () => { tapped += 1; } }],
    });
    const col = makeModule('col', 'Colonization');
    handle()?.click();

    const colOrb = orbs()[1];
    colOrb.click();

    expect(localStorage.getItem(FAB_ACTIVE_KEY)).toBe('col');
    expect(col.el.style.display).not.toBe('none');
    expect(tapped).toBe(0);
    // Picker is gone.
    expect(overlay()).toBeNull();
    expect(orbs()).toHaveLength(0);
    expect(handle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('handle click toggles the picker closed again', () => {
    makeModule('exp', 'Expeditions');
    handle()?.click();
    expect(overlay()).not.toBeNull();
    handle()?.click();
    expect(overlay()).toBeNull();
  });

  it('overlay click and Escape both dismiss the picker', () => {
    makeModule('exp', 'Expeditions');
    makeModule('col', 'Colonization');

    handle()?.click();
    overlay()?.click();
    expect(overlay()).toBeNull();

    handle()?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay()).toBeNull();
  });

  it('touching the FAB host dismisses an open picker (user is acting on the module)', () => {
    const exp = makeModule('exp', 'Expeditions');
    makeModule('col', 'Colonization');
    handle()?.click();
    expect(overlay()).not.toBeNull();
    exp.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(overlay()).toBeNull();
  });
});
