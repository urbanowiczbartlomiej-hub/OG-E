// @vitest-environment happy-dom
//
// Tests for the unified floating button: the pure orbit geometry / active-id
// logic (unifiedFabPure.js) and the behavioural surface of the shell
// (unifiedFab.js) driven through the public entry point — `createButton`
// with `module` metadata, exactly how the four features register. We assert
// observable output (wrapper DOM, per-module visibility, the always-visible
// satellite orbs, the persisted active id), not internals.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createButton } from '../../src/features/shared/button.js';
import {
  _resetUnifiedFabForTest,
  setActiveFabModule,
  FAB_WRAP_ID,
  FAB_ORB_CLASS,
  FAB_ACTIVE_KEY,
} from '../../src/features/shared/unifiedFab.js';
import {
  resolveActiveId,
  orbitLayout,
  orbDiameter,
  orbitRadius,
  aimAngle,
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
 * @param {{ split?: boolean, onTap?: () => void }} [opts]
 * @returns {import('../../src/features/shared/button.js').Button}
 */
const makeModule = (id, name, { split = false, onTap = () => {} } = {}) =>
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
            { key: 'a', id: `oge-test-${id}-a`, bg: '#4aa8ff', onTap },
            { key: 'b', id: `oge-test-${id}-b`, bg: '#13d1de', onTap: () => {} },
          ]
        : [{ key: 'main', id: `oge-test-${id}`, bg: '#4aa8ff', onTap }],
    })
  );

const wrap = () => document.getElementById(FAB_WRAP_ID);
const orbs = () =>
  /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.' + FAB_ORB_CLASS)]);

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

describe('orb sizing', () => {
  it('orbDiameter stays proportional across the whole fabBtnSize range', () => {
    expect(orbDiameter(320)).toBe(134); // 0.42 × 320 (the default)
    expect(orbDiameter(560)).toBe(235); // 0.42 × 560 — no 150 ceiling any more
    expect(orbDiameter(100)).toBe(42); // 0.42 × 100
    expect(orbDiameter(40)).toBe(36); // floor — 0.42 × 40 ≈ 17 is too small to tap
  });

  it('orbitRadius clears the FAB edge plus the orb radius', () => {
    const orb = orbDiameter(320);
    expect(orbitRadius(320, orb)).toBe(320 / 2 + orb / 2 + 14);
  });
});

// ─── pure: orbitLayout ────────────────────────────────────────────────────

describe('orbitLayout', () => {
  const base = { radius: 120, orbSize: 80, vw: 1000, vh: 800 };

  it('returns an empty array for count 0', () => {
    expect(orbitLayout({ ...base, cx: 100, cy: 100, count: 0 })).toEqual([]);
  });

  it('fans the arc toward the viewport centre', () => {
    // FAB sits on the left edge at mid-height → the viewport centre is due
    // east, so every orb must land to the RIGHT of the FAB.
    const items = orbitLayout({ ...base, cx: 50, cy: 400, count: 3 });
    expect(items).toHaveLength(3);
    for (const it_ of items) expect(it_.x).toBeGreaterThan(50);
  });

  it('clamps every orb inside the viewport even from a corner', () => {
    const items = orbitLayout({ ...base, cx: 5, cy: 5, count: 3 });
    const margin = base.orbSize / 2 + 8;
    for (const it_ of items) {
      expect(it_.x).toBeGreaterThanOrEqual(margin);
      expect(it_.x).toBeLessThanOrEqual(base.vw - margin);
      expect(it_.y).toBeGreaterThanOrEqual(margin);
      expect(it_.y).toBeLessThanOrEqual(base.vh - margin);
    }
  });
});

// ─── pure: aimAngle ───────────────────────────────────────────────────────

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

// ─── shell: wrapper + visibility ──────────────────────────────────────────

describe('unified FAB shell', () => {
  it('creates the wrapper on first registration and mounts the host inside', () => {
    const b = makeModule('exp', 'Expeditions');
    const w = wrap();
    expect(w).not.toBeNull();
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

  it('tears the shell down when the last module unregisters', () => {
    const exp = makeModule('exp', 'Expeditions');
    const col = makeModule('col', 'Colonization');
    exp.dispose();
    expect(wrap()).not.toBeNull(); // col still registered
    col.dispose();
    expect(wrap()).toBeNull();
  });
});

// ─── shell: always-visible satellite menu ──────────────────────────────────

describe('satellite menu', () => {
  it('renders one orb per NON-active module (the active one lives in the FAB)', () => {
    makeModule('exp', 'Expeditions'); // active by default
    makeModule('col', 'Colonization', { split: true });
    makeModule('lf', 'Lifeforms');

    const os = orbs();
    expect(os).toHaveLength(2); // 3 modules − 1 active
    // Orbs are single-piece identity nodes — no nested split zones, just the glyph.
    for (const orb of os) {
      expect(orb.querySelector('.zone')).toBeNull();
      expect(orb.querySelector('.oge-art svg')).not.toBeNull();
      expect(orb.classList.contains('oge-node')).toBe(true);
    }
    // The active module ('exp') has no orb; the others do.
    const labels = os.map((o) => o.getAttribute('aria-label'));
    expect(labels).toEqual(['Switch to Colonization', 'Switch to Lifeforms']);
  });

  it('shows the menu immediately with a single registered module (no orbs yet)', () => {
    makeModule('exp', 'Expeditions');
    expect(orbs()).toHaveLength(0); // only module is active ⇒ nothing to orbit
  });

  it('tapping an orb SWITCHES the module (persist + swap) without firing its action', () => {
    let tapped = 0;
    makeModule('exp', 'Expeditions', { onTap: () => { tapped += 1; } });
    const col = makeModule('col', 'Colonization');

    // 'exp' is active ⇒ the only orb is 'col'.
    const colOrb = orbs()[0];
    expect(colOrb.getAttribute('aria-label')).toBe('Switch to Colonization');
    colOrb.click();

    expect(localStorage.getItem(FAB_ACTIVE_KEY)).toBe('col');
    expect(col.el.style.display).not.toBe('none');
    expect(tapped).toBe(0);
    // The menu now orbits the previously active module instead.
    const os = orbs();
    expect(os).toHaveLength(1);
    expect(os[0].getAttribute('aria-label')).toBe('Switch to Expeditions');
  });

  it('rebuilds the menu when a module unregisters', () => {
    makeModule('exp', 'Expeditions');
    makeModule('col', 'Colonization');
    const lf = makeModule('lf', 'Lifeforms');
    expect(orbs()).toHaveLength(2);
    lf.dispose();
    expect(orbs()).toHaveLength(1);
  });
});
