// @vitest-environment happy-dom
//
// Unit tests for the event-menu highlight feature.
//
// # What we cover
//
//   1. Style injection — `<style id="oge-event-highlight-style">` appended.
//   2. Banner style injection — `<style id="oge-event-banner-style">` appended.
//   3. Idempotency — second install returns same dispose, no duplicate styles.
//   4. Event items get the highlight class.
//   5. Permanent items (Trader / Officers / Shop) are NOT highlighted.
//   6. Non-premium items are NOT highlighted.
//   7. Dispose removes the class from all tagged elements, the style nodes,
//      and the banner element.
//   8. CSS payload — keyframe names and animation property present.
//   9. Banner rendered in #middle when event items exist.
//  10. Banner removed from #middle when no event items exist.
//  11. Banner links point to event item hrefs with visible label text.
//  12. Banner CSS payload — keyframe and selector presence.
//  13. Banner has a close (✕) button.
//  14. Clicking close removes the banner and stores today's date in localStorage.
//  15. Banner is suppressed for the rest of the day after dismissal.
//  16. Banner reappears when the stored dismiss date is a different day.
//  17. Settings off → highlights stripped and banner removed immediately.
//  18. Settings off → applyHighlights/renderBanner are no-ops.
//  19. Settings toggled back on → highlights and banner restored.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installEventMenuHighlight,
  _resetEventMenuHighlightForTest,
  BANNER_DISMISS_KEY,
} from '../../src/features/eventMenuHighlight.js';
import { settingsStore } from '../../src/state/settings.js';

const STYLE_ID = 'oge-event-highlight-style';
const BANNER_STYLE_ID = 'oge-event-banner-style';
const HIGHLIGHT_CLASS = 'oge-event-highlight';
const BANNER_ID = 'oge-event-banner';

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

/** Ensure `#middle` div exists in the document body. */
const ensureMiddle = () => {
  if (!document.getElementById('middle')) {
    const middle = document.createElement('div');
    middle.id = 'middle';
    document.body.appendChild(middle);
  }
};

/** ISO date string for today (YYYY-MM-DD). */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** ISO date string for yesterday (YYYY-MM-DD). */
const yesterdayIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('eventMenuHighlight', () => {
  beforeEach(() => {
    _resetEventMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: true }));
    localStorage.removeItem(BANNER_DISMISS_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(BANNER_STYLE_ID)?.remove();
    document.getElementById(BANNER_ID)?.remove();
    document.getElementById('menuTable')?.remove();
    document.getElementById('middle')?.remove();

    ensureMiddle();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',           premium: true,  label: 'Handlarz' },
      { hint: 'ipiToolbarOfficers',          premium: true,  label: 'Kantyna' },
      { hint: 'ipiToolbarShop',             premium: true,  label: 'Sklep' },
      { hint: 'ipiToolbarRecurringRewards', premium: true,  label: 'Nagrody', href: '/game/index.php?page=rewards' },
      { hint: 'ipiToolbarResearch',         premium: false, label: 'Badania' },
    ]);
    document.body.appendChild(menu);
  });

  afterEach(() => {
    _resetEventMenuHighlightForTest();
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: true }));
    localStorage.removeItem(BANNER_DISMISS_KEY);
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(BANNER_STYLE_ID)?.remove();
    document.getElementById(BANNER_ID)?.remove();
    document.getElementById('menuTable')?.remove();
    document.getElementById('middle')?.remove();
  });

  // ── Menu highlight CSS ──────────────────────────────────────────────

  it('injects <style id="oge-event-highlight-style"> into the document', () => {
    installEventMenuHighlight();
    const el = document.getElementById(STYLE_ID);
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe('STYLE');
    expect(document.contains(el)).toBe(true);
  });

  it('injects <style id="oge-event-banner-style"> into the document', () => {
    installEventMenuHighlight();
    const el = document.getElementById(BANNER_STYLE_ID);
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe('STYLE');
    expect(document.contains(el)).toBe(true);
  });

  it('is idempotent — second call returns same dispose, no duplicate <style> elements', () => {
    const disposeA = installEventMenuHighlight();
    const disposeB = installEventMenuHighlight();
    expect(disposeA).toBe(disposeB);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
    expect(document.querySelectorAll(`#${BANNER_STYLE_ID}`).length).toBe(1);
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

  // ── Banner ─────────────────────────────────────────────────────────

  it('renders #oge-event-banner inside #middle when event items exist', () => {
    installEventMenuHighlight();
    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    const middle = document.getElementById('middle');
    expect(middle?.contains(banner)).toBe(true);
    expect(middle?.firstElementChild?.id).toBe(BANNER_ID);
  });

  it('banner contains a link for each event item', () => {
    installEventMenuHighlight();
    const links = document.querySelectorAll(`#${BANNER_ID} .oge-banner-link`);
    expect(links.length).toBe(1);
    expect(/** @type {HTMLAnchorElement} */ (links[0]).textContent?.trim()).toBe('Nagrody');
  });

  it('banner link href matches the menu anchor href', () => {
    installEventMenuHighlight();
    const link = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`#${BANNER_ID} .oge-banner-link`)
    );
    expect(link?.href).toContain('rewards');
  });

  it('does NOT copy a javascript: href onto the banner link (CSP guard)', () => {
    // Some OGame premium-menu items ship as
    // `<a href="javascript:return false;">` and rely on an attached
    // onclick listener for the navigation. Copying that href onto our
    // banner link triggers a `script-src` violation on click because
    // the page's CSP does not allow `javascript:` navigations. The
    // feature must strip the href and delegate the click to the
    // original anchor (which `safeClick` handles for us).
    document.getElementById('menuTable')?.remove();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',           premium: true, label: 'Handlarz' },
      { hint: 'ipiToolbarOfficers',         premium: true, label: 'Kantyna' },
      { hint: 'ipiToolbarShop',             premium: true, label: 'Sklep' },
      {
        hint: 'ipiToolbarRecurringRewards',
        premium: true,
        label: 'Nagrody',
        href: 'javascript:doNavigate(); return false;',
      },
    ]);
    document.body.appendChild(menu);

    installEventMenuHighlight();
    const link = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`#${BANNER_ID} .oge-banner-link`)
    );
    const rawHref = link?.getAttribute('href') ?? '';
    expect(rawHref.startsWith('javascript:')).toBe(false);
  });

  it('clicking a banner link with a javascript: source delegates to the original anchor (safeClick)', () => {
    // Companion to the CSP guard above: the original anchor's
    // onclick listener still has to fire when the player clicks the
    // banner link — otherwise the feature would be a dead end.
    document.getElementById('menuTable')?.remove();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',           premium: true, label: 'Handlarz' },
      { hint: 'ipiToolbarOfficers',         premium: true, label: 'Kantyna' },
      { hint: 'ipiToolbarShop',             premium: true, label: 'Sklep' },
      {
        hint: 'ipiToolbarRecurringRewards',
        premium: true,
        label: 'Nagrody',
        href: 'javascript:doNavigate(); return false;',
      },
    ]);
    document.body.appendChild(menu);

    // Hook a click listener on the original event anchor — this is the
    // shape OGame uses in practice (the real behavior is attached via
    // listeners, not just via the javascript: URL itself).
    const eventAnchor = /** @type {HTMLAnchorElement} */ (
      document.querySelector('a[data-ipi-hint="ipiToolbarRecurringRewards"]')
    );
    let clickedOriginal = 0;
    eventAnchor.addEventListener('click', () => { clickedOriginal += 1; });

    installEventMenuHighlight();
    const link = /** @type {HTMLAnchorElement} */ (
      document.querySelector(`#${BANNER_ID} .oge-banner-link`)
    );
    link.click();
    expect(clickedOriginal).toBe(1);
  });

  it('does NOT render #oge-event-banner when all premium items are permanent', () => {
    document.getElementById('menuTable')?.remove();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',   premium: true },
      { hint: 'ipiToolbarOfficers', premium: true },
      { hint: 'ipiToolbarShop',     premium: true },
    ]);
    document.body.appendChild(menu);

    installEventMenuHighlight();
    expect(document.getElementById(BANNER_ID)).toBeNull();
  });

  it('banner shows multiple links when multiple event items exist', () => {
    document.getElementById('menuTable')?.remove();
    const menu = buildMenu([
      { hint: 'ipiToolbarTrader',           premium: true, label: 'Handlarz' },
      { hint: 'ipiToolbarRecurringRewards', premium: true, label: 'Nagrody' },
      { hint: 'ipiToolbarSomeOtherEvent',   premium: true, label: 'Konkurs' },
    ]);
    document.body.appendChild(menu);

    installEventMenuHighlight();
    const links = document.querySelectorAll(`#${BANNER_ID} .oge-banner-link`);
    expect(links.length).toBe(2);
  });

  it('banner CSS payload contains keyframes and selector', () => {
    installEventMenuHighlight();
    const css = document.getElementById(BANNER_STYLE_ID)?.textContent ?? '';
    expect(css).toContain('@keyframes oge-banner-flash');
    expect(css).toContain('@keyframes oge-banner-text-flash');
    expect(css).toContain(`#${BANNER_ID}`);
    expect(css).toContain('animation:');
  });

  it('banner has an ✕ close button', () => {
    installEventMenuHighlight();
    const btn = document.querySelector(`#${BANNER_ID} .oge-banner-close`);
    expect(btn).not.toBeNull();
    expect(btn?.tagName).toBe('BUTTON');
    expect(btn?.textContent).toContain('✕');
  });

  // ── Dismiss ────────────────────────────────────────────────────────

  it('clicking close removes the banner from DOM', () => {
    installEventMenuHighlight();
    expect(document.getElementById(BANNER_ID)).not.toBeNull();

    const btn = /** @type {HTMLButtonElement} */ (
      document.querySelector(`#${BANNER_ID} .oge-banner-close`)
    );
    btn.click();

    expect(document.getElementById(BANNER_ID)).toBeNull();
  });

  it("clicking close stores today's ISO date in localStorage", () => {
    installEventMenuHighlight();
    const btn = /** @type {HTMLButtonElement} */ (
      document.querySelector(`#${BANNER_ID} .oge-banner-close`)
    );
    btn.click();

    expect(localStorage.getItem(BANNER_DISMISS_KEY)).toBe(todayIso());
  });

  it('banner is not rendered when dismissed today (flag set before install)', () => {
    localStorage.setItem(BANNER_DISMISS_KEY, todayIso());
    installEventMenuHighlight();
    expect(document.getElementById(BANNER_ID)).toBeNull();
  });

  it('menu highlight still applies even when banner is dismissed today', () => {
    localStorage.setItem(BANNER_DISMISS_KEY, todayIso());
    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(1);
  });

  it('banner reappears when dismiss date is from a previous day', () => {
    localStorage.setItem(BANNER_DISMISS_KEY, yesterdayIso());
    installEventMenuHighlight();
    expect(document.getElementById(BANNER_ID)).not.toBeNull();
  });

  // ── Settings toggle ────────────────────────────────────────────────

  it('setting eventMenuHighlight=false immediately removes highlights and banner', () => {
    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBeGreaterThan(0);
    expect(document.getElementById(BANNER_ID)).not.toBeNull();

    settingsStore.update((s) => ({ ...s, eventMenuHighlight: false }));

    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
    expect(document.getElementById(BANNER_ID)).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).toBeNull();
  });

  it('setting eventMenuHighlight=false prevents new highlights from being applied', () => {
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: false }));
    installEventMenuHighlight();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
    expect(document.getElementById(BANNER_ID)).toBeNull();
  });

  it('toggling eventMenuHighlight back to true restores highlights and banner', () => {
    installEventMenuHighlight();
    settingsStore.update((s) => ({ ...s, eventMenuHighlight: false }));
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);

    settingsStore.update((s) => ({ ...s, eventMenuHighlight: true }));

    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBeGreaterThan(0);
    expect(document.getElementById(BANNER_ID)).not.toBeNull();
  });

  // ── Dispose ────────────────────────────────────────────────────────

  it('dispose removes both style elements, highlight class, and banner', () => {
    const dispose = installEventMenuHighlight();
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).not.toBeNull();
    expect(document.getElementById(BANNER_ID)).not.toBeNull();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBeGreaterThan(0);

    dispose();

    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(document.getElementById(BANNER_STYLE_ID)).toBeNull();
    expect(document.getElementById(BANNER_ID)).toBeNull();
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
  });

  it('dispose does NOT clear the localStorage dismiss flag', () => {
    localStorage.setItem(BANNER_DISMISS_KEY, todayIso());
    const dispose = installEventMenuHighlight();
    dispose();
    expect(localStorage.getItem(BANNER_DISMISS_KEY)).toBe(todayIso());
  });
});
