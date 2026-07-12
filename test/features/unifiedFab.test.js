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
  feasibleArcCenter,
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

  // Count-driven arc width: adjacent orbs keep a constant angular step instead
  // of a fixed total arc that flung 2 orbs apart and crammed 5+ together.
  // Angle of an orb about the FAB centre (unclamped geometry — measured from a
  // centred FAB with a big viewport so no clamp fires).
  /** @param {{x:number,y:number}} it_ @param {number} cx @param {number} cy */
  const angleOf = (it_, cx, cy) => Math.atan2(it_.y - cy, it_.x - cx);
  const wide = { radius: 400, orbSize: 40, vw: 4000, vh: 4000 };

  it('keeps a ~constant step between neighbours as the count grows', () => {
    /** @param {number} count */
    const step = (count) => {
      const items = orbitLayout({ ...wide, cx: 2000, cy: 2000, count });
      return Math.abs(angleOf(items[1], 2000, 2000) - angleOf(items[0], 2000, 2000));
    };
    // 2, 3, 4 orbs share the same neighbour gap (≈37°); the total span scales.
    expect(step(3)).toBeCloseTo(step(2), 3);
    expect(step(4)).toBeCloseTo(step(2), 3);
    expect(step(2)).toBeCloseTo((Math.PI * 0.62) / 3, 3);
  });

  it('a 2-orb menu hugs the aim ray instead of spanning a wide arc', () => {
    const items = orbitLayout({ ...wide, cx: 2000, cy: 2000, count: 2 });
    const span = Math.abs(angleOf(items[1], 2000, 2000) - angleOf(items[0], 2000, 2000));
    expect(span).toBeLessThan(Math.PI / 4); // < 45°, not the old ~112°
  });

  it('a single orb sits exactly on the aim ray', () => {
    const items = orbitLayout({ ...wide, cx: 2000, cy: 100, count: 1 });
    // FAB near the top, centre below → aim points straight down (+y).
    expect(items[0].x).toBeCloseTo(2000, 0);
    expect(items[0].y).toBeGreaterThan(100);
  });

  // ── Edge-aware arc rotation (feasibleArcCenter) ──────────────────────────
  // From a corner of a tall phone screen the aim ray is nearly vertical and
  // the raw arc used to run off the near edge; the per-orb XY clamp then slid
  // those orbs along the edge into each other and under the FAB. The arc now
  // rotates into the feasible window instead — verified by the invariant that
  // NO orb needed clamping (each sits exactly `radius` from the FAB) and no
  // two orbs overlap.
  /** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  it('bottom-right corner of a tall phone: whole fan rotates into free space, nothing clamps', () => {
    const phone = { radius: 140, orbSize: 80, vw: 400, vh: 800 };
    const cx = 360;
    const cy = 760;
    const items = orbitLayout({ ...phone, cx, cy, count: 3 });
    const margin = phone.orbSize / 2 + 8;
    for (const it_ of items) {
      // Unclamped ⇒ still exactly on the orbit circle.
      expect(dist(it_, { x: cx, y: cy })).toBeCloseTo(phone.radius, 6);
      expect(it_.x).toBeGreaterThanOrEqual(margin);
      expect(it_.x).toBeLessThanOrEqual(phone.vw - margin);
      expect(it_.y).toBeGreaterThanOrEqual(margin);
      expect(it_.y).toBeLessThanOrEqual(phone.vh - margin);
    }
    // No pile-ups: neighbours keep at least an orb diameter between centres.
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        expect(dist(items[a], items[b])).toBeGreaterThanOrEqual(phone.orbSize);
      }
    }
  });

  it('every corner keeps all orbs unclamped on the orbit circle', () => {
    const phone = { radius: 140, orbSize: 80, vw: 400, vh: 800 };
    const corners = [
      { cx: 40, cy: 40 }, { cx: 360, cy: 40 },
      { cx: 40, cy: 760 }, { cx: 360, cy: 760 },
    ];
    for (const c of corners) {
      const items = orbitLayout({ ...phone, ...c, count: 3 });
      for (const it_ of items) {
        expect(dist(it_, { x: c.cx, y: c.cy })).toBeCloseTo(phone.radius, 6);
      }
    }
  });

  it('an over-tight corner (window < collision floor) degrades to a sub-px clamp, never a pile-up', () => {
    // radius 120 + orb 80 in a 400px-wide corner: the collision-floor spread
    // (~86°) is wider than the feasible window (~79°) — nothing can make all
    // three orbs fit unclamped, so the arc centres on the window and accepts
    // a tiny overhang. The orbs must stay within a hair of the circle and
    // must NOT overlap (the old behaviour slid them into each other).
    const phone = { radius: 120, orbSize: 80, vw: 400, vh: 800 };
    const cx = 360;
    const cy = 760;
    const items = orbitLayout({ ...phone, cx, cy, count: 3 });
    for (const it_ of items) {
      expect(Math.abs(dist(it_, { x: cx, y: cy }) - phone.radius)).toBeLessThan(3);
    }
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        expect(dist(items[a], items[b])).toBeGreaterThanOrEqual(phone.orbSize - 4);
      }
    }
  });

  it('keeps the centred layout untouched (fully feasible window returns the aim ray)', () => {
    const r = feasibleArcCenter({
      cx: 2000, cy: 2000, radius: 400, margin: 28, vw: 4000, vh: 4000,
      base: Math.PI / 4, spread: 1.3,
    });
    expect(r.centre).toBeCloseTo(Math.PI / 4, 6);
    expect(r.spread).toBeCloseTo(1.3, 6);
  });

  it('a seam-wrapping window that CONTAINS the aim keeps the fan on the aim (regression)', () => {
    // FAB near the top edge of a wide viewport: only the top clips the orbit,
    // so the feasible window spans ~330° and wraps the scan seam while
    // containing the aim ray. The old wrap-merge mapped the aim's sample into
    // the negative-shifted half and missed the containment — flipping the fan
    // ~180° away from the free space it should open into.
    const cx = 200;
    const cy = 145;
    const vw = 1200;
    const vh = 800;
    const items = orbitLayout({ cx, cy, count: 3, radius: 120, orbSize: 56, vw, vh });
    const base = aimAngle({ cx, cy, vw, vh }); // points down-right, into free space
    for (const it_ of items) {
      // Every orb stays within a quarter-turn + half the arc of the aim ray —
      // the buggy layout put them ~180° away (top-left, x < cx).
      let d = (angleOf(it_, cx, cy) - base) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d <= -Math.PI) d += Math.PI * 2;
      expect(Math.abs(d)).toBeLessThan(Math.PI / 2);
      expect(dist(it_, { x: cx, y: cy })).toBeCloseTo(120, 6);
    }
  });

  it('the collision floor never EXPANDS the arc past the requested spread', () => {
    // 8 modules on a tiny FAB: the collision floor (step × 7) exceeds the
    // full-circle-capped request. In a narrow corner window the compressed
    // spread must stay ≤ the request — the uncapped floor used to blow the
    // arc wider than both the request and the window.
    const request = (Math.PI * 2 * 7) / 8; // full-circle cap for 8 items
    const r = feasibleArcCenter({
      cx: 40, cy: 760, radius: 52, margin: 26, vw: 400, vh: 800,
      base: -Math.PI / 4, spread: request, minSpread: 0.874 * 7,
    });
    expect(r.spread).toBeLessThanOrEqual(request + 1e-9);
  });

  it('window choice is sticky: prevCentre holds its window through an aim tie', () => {
    // Large FAB mid-width on a tall narrow viewport: the orbit pokes past
    // BOTH side edges, leaving an up-fan and a down-fan window. base = 0
    // (due right) is equidistant from both — without stickiness the pick
    // could flip frame-to-frame under drag jitter.
    const geo = {
      cx: 200, cy: 1000, radius: 250, margin: 48, vw: 400, vh: 2000,
      base: 0, spread: 1.0,
    };
    const up = feasibleArcCenter({ ...geo, prevCentre: -Math.PI / 2 });
    const down = feasibleArcCenter({ ...geo, prevCentre: Math.PI / 2 });
    expect(up.centre).toBeLessThan(0);   // stays in the up-fan window
    expect(down.centre).toBeGreaterThan(0); // stays in the down-fan window
  });

  it('degenerate: radius larger than the viewport falls back to the aim angle', () => {
    const r = feasibleArcCenter({
      cx: 50, cy: 50, radius: 5000, margin: 28, vw: 100, vh: 100,
      base: 1.0, spread: 1.0,
    });
    expect(r.centre).toBeCloseTo(1.0, 6);
    expect(r.spread).toBeCloseTo(1.0, 6);
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
