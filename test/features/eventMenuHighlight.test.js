// @vitest-environment happy-dom
//
// Unit tests for the event-menu highlight feature.
//
// # What we cover
//
//   1. Style injection — `<style id="oge-event-highlight-style">` appended.
//   2. Idempotency — second install returns same dispose, no duplicate styles.
//   3. Event items get the highlight class.
//   4. Permanent items (Trader / Officers / Shop) are NOT highlighted.
//   5. Non-premium items are NOT highlighted.
//   6. Dispose removes the class from all tagged elements and the style node.
//   7. CSS payload — keyframe names and animation property present.
//   8. Settings off → highlights stripped immediately.
//   9. Settings off → applyHighlights is a no-op.
//  10. Settings toggled back on → highlights restored.
//  11. No banner is ever injected (the loud central banner was removed in v1.3.6).
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installEventMenuHighlight,
  _resetEventMenuHighlightForTest,
} from '../../src/features/eventMenuHighlight.js';
import { settingsStore } from '../../src/state/settings.js';

const STYLE_ID = 'oge-event-highlight-style';
const HIGHLIGHT_CLASS = 'oge-event-highlight';

/**
 * Build a minimal `#menuTable` `<ul>` with the given entries.
 *
 * @param {Array<{ hint: string; premium: boolean; label?: string; href?: string }>} entries
 * @returns {HTMLUListElement}
 */
const buildMenu = (entries) => {
  const ul = /** @type {HTMLUListElement} */ (document.createElement('ul'));
  ul.id = 'menuTable';
  for (const { hint, premium, label = '', href = '' } of entries) {
    const a = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
    a.className = `menubutton${premium ? ' premiumHighligt' : ''}`;
    if (hint) a.dataset.ipiHint = hint;
    if (href) a.href = href;
    const span = document.createElement('span');
    span.className = 'textlabel';
    if (label) span.textContent = label;
    a.appendChild(span);
    const li = document.createElement('li');
    li.appendChild(a);
    ul.appendChild(li);
  }
  return ul;
};

describe('eventMenuHighlight', () => {
  beforeEach(() => {
    _resetEventMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: true }));
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById('menuTable')?.remove();

    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',           premium: true,  label: 'Handlarz' },
      { hint: 'ipiToolbarOfficers',         premium: true,  label: 'Kantyna' },
      { hint: 'ipiToolbarShop',             premium: true,  label: 'Sklep' },
      { hint: 'ipiToolbarRecurringRewards', premium: true,  label: 'Nagrody', href: '/game/index.php?page=rewards' },
      { hint: 'ipiToolbarResearch',         premium: false, label: 'Badania' },
    ]);
    document.body.appendChild(menu);
  });

  afterEach(() => {
    _resetEventMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: true }));
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById('menuTable')?.remove();
  });

  it('injects <style id="oge-event-highlight-style"> into the document', () => {
    installEventMenuHighlight();
    const el = document.getElementById(STYLE_ID);
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe('STYLE');
  });

  it('is idempotent — second call returns same dispose, no duplicate <style> elements', () => {
    const disposeA = installEventMenuHighlight();
    const disposeB = installEventMenuHighlight();
    expect(disposeA).toBe(disposeB);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
  });

  it('applies the highlight class to event premiumHighligt items', () => {
    installEventMenuHighlight();
    const highlighted = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    expect(highlighted.length).toBe(1);
    expect(/** @type {HTMLElement} */ (highlighted[0]).dataset.ipiHint).toBe(
      'ipiToolbarRecurringRewards',
    );
  });

  it('does NOT apply highlight class to the three permanent premium items', () => {
    installEventMenuHighlight();
    for (const hint of ['ipiToolbarTrader', 'ipiToolbarOfficers', 'ipiToolbarShop']) {
      const el = document.querySelector(`[data-ipi-hint="${hint}"]`);
      expect(el?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
    }
  });

  it('does NOT apply highlight class to non-premium items', () => {
    installEventMenuHighlight();
    const el = document.querySelector('[data-ipi-hint="ipiToolbarResearch"]');
    expect(el?.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('CSS payload contains both keyframe names and the highlight class selector', () => {
    installEventMenuHighlight();
    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('@keyframes oge-event-bg');
    expect(css).toContain('@keyframes oge-event-text');
    expect(css).toContain(`.${HIGHLIGHT_CLASS}`);
    expect(css).toContain('animation:');
  });

  it('highlights a second event item when the menu contains two ephemeral entries', () => {
    document.getElementById('menuTable')?.remove();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',           premium: true },
      { hint: 'ipiToolbarRecurringRewards', premium: true },
      { hint: 'ipiToolbarSomeOtherEvent',   premium: true },
    ]);
    document.body.appendChild(menu);

    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(2);
  });

  it('highlights nothing when all premiumHighligt items are permanent', () => {
    document.getElementById('menuTable')?.remove();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',   premium: true },
      { hint: 'ipiToolbarOfficers', premium: true },
      { hint: 'ipiToolbarShop',     premium: true },
    ]);
    document.body.appendChild(menu);

    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
  });

  it('does NOT inject any banner element (banner feature removed in v1.3.6)', () => {
    installEventMenuHighlight();
    // No element with the historical banner id should ever exist now —
    // this is a regression guard: a reintroduction of the loud
    // central banner must be a conscious decision, not an accident.
    expect(document.getElementById('oge-event-banner')).toBeNull();
    expect(document.getElementById('oge-event-banner-style')).toBeNull();
  });

  // ── Settings toggle ────────────────────────────────────────────────

  it('setting eventMenuHighlight=false immediately removes highlights', () => {
    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBeGreaterThan(0);

    settingsStore.update((s) => ({ ...s, eventMenuHighlight: false }));

    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it('setting eventMenuHighlight=false prevents new highlights from being applied', () => {
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: false }));
    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
  });

  it('toggling eventMenuHighlight back to true restores highlights', () => {
    installEventMenuHighlight();
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: false }));
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);

    settingsStore.update((s) => ({ ...s, eventMenuHighlight: true }));

    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBeGreaterThan(0);
  });

  // ── Dispose ────────────────────────────────────────────────────────

  it('dispose removes the style element and strips the highlight class', () => {
    const dispose = installEventMenuHighlight();
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBeGreaterThan(0);

    dispose();

    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
  });
});
