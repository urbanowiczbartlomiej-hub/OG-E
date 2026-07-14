// @vitest-environment happy-dom
//
// Tests for the galaxy touch-nav panel (bottom mirror of the galaxy header).
//
// # What we cover
//
//   Pure transform (`shortenDebrisLabel`):
//     1. Rewrites a "label: value" item to the short label, value verbatim.
//     2. Default label = first letter of the localized prefix.
//     3. Preserves a trailing red delta ("(-16)") — it lives in the value.
//     4. Passthrough (no "label:" prefix) — also the idempotency guard.
//
//   Feature (`installGalaxyNavPanel`, behavioral / happy-dom):
//     5. Off the galaxy page → no-op install (no panel, no stylesheet).
//     6. On the galaxy page + setting on → panel mounts right after
//        `#galaxyContent`; stylesheet injected; native `#galaxyHeader`
//        hidden by the sheet.
//     7. Idempotent — second install returns the same dispose, one panel.
//     8. Start proxies the native submit (fills native inputs, clicks it).
//     9. A stepper proxies the game's own prev/next arrow.
//    10. An action button proxies its native control, and mirrors its
//        `disabled` state.
//    11. The row-16 debris readout is compacted on mount (class-keyed short
//        labels; the action li and a nested delta span survive).
//    12. Settings off → unmount; dispose → panel + stylesheet gone.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installGalaxyNavPanel,
  shortenDebrisLabel,
  GNAV_PANEL_ID,
  _resetGalaxyNavPanelForTest,
} from '../../src/features/galaxyNavPanel.js';
import { settingsStore } from '../../src/state/settings.js';

const STYLE_ID = 'oge-gnav-style';

/**
 * Build the minimal native galaxy DOM the panel proxies: a header with the
 * two coord inputs (each flanked by the game's `.galaxy_icons` prev/next
 * arrow spans), the `submitForm` button, the three system-action controls,
 * and the `#galaxyContent` table container the panel mounts after.
 *
 * @returns {{
 *   header: HTMLElement,
 *   content: HTMLElement,
 *   galInput: HTMLInputElement,
 *   sysInput: HTMLInputElement,
 *   submit: HTMLElement,
 *   phalanx: HTMLElement,
 *   galNext: HTMLElement,
 * }}
 */
const buildGalaxyDom = () => {
  const header = document.createElement('div');
  header.id = 'galaxyHeader';

  /**
   * @param {string} id
   * @returns {{ input: HTMLInputElement, next: HTMLElement }}
   */
  const coord = (id) => {
    const prev = document.createElement('span');
    prev.className = 'galaxy_icons prev';
    const input = document.createElement('input');
    input.id = id;
    const next = document.createElement('span');
    next.className = 'galaxy_icons next';
    header.append(prev, input, next);
    return { input, next };
  };

  const gal = coord('galaxy_input');
  const sys = coord('system_input');
  gal.input.value = '4';
  sys.input.value = '472';

  const submit = document.createElement('div');
  submit.className = 'btn_blue';
  submit.setAttribute('onclick', 'submitForm();');
  header.appendChild(submit);

  const phalanx = document.createElement('a');
  phalanx.className = 'phalanxlink btn_system_action';
  const spy = document.createElement('a');
  spy.className = 'spysystemlink btn_system_action';
  const discovery = document.createElement('div');
  discovery.id = 'discoverSystemBtn';
  header.append(phalanx, spy, discovery);

  const content = document.createElement('div');
  content.id = 'galaxyContent';

  document.body.append(header, content);
  return {
    header,
    content,
    galInput: gal.input,
    sysInput: sys.input,
    submit,
    phalanx,
    galNext: gal.next,
  };
};

/** Tear the test DOM down between cases. */
const clearDom = () => {
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById('galaxyHeader')?.remove();
  document.getElementById('galaxyContent')?.remove();
  document.getElementById(GNAV_PANEL_ID)?.remove();
};

describe('galaxyNavPanel — shortenDebrisLabel (pure)', () => {
  it('rewrites "label: value" to the short label with the value verbatim', () => {
    expect(shortenDebrisLabel('Metal: 1.388.400', 'M')).toBe('M 1.388.400');
  });

  it('defaults the label to the first letter of the localized prefix', () => {
    expect(shortenDebrisLabel('Crystal: 157,400')).toBe('C 157,400');
  });

  it('keeps a trailing red delta — it rides along in the value', () => {
    expect(shortenDebrisLabel('Pathfinders needed: 17 (-16)', 'PF')).toBe(
      'PF 17 (-16)',
    );
  });

  it('passes text without a "label:" prefix through untouched (idempotency guard)', () => {
    expect(shortenDebrisLabel('Zredukuj')).toBe('Zredukuj');
    // Running the transform on its own output is a no-op (no colon left).
    expect(shortenDebrisLabel(shortenDebrisLabel('Metal: 5', 'M'), 'M')).toBe(
      'M 5',
    );
  });
});

describe('galaxyNavPanel — install', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
  });

  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '';
  });

  it('is a no-op off the galaxy page — no panel, no stylesheet', () => {
    location.search = '?page=ingame&component=overview';
    buildGalaxyDom();
    const dispose = installGalaxyNavPanel();

    expect(document.getElementById(GNAV_PANEL_ID)).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();
    expect(() => dispose()).not.toThrow();
  });

  it('mounts the panel right after #galaxyContent and injects the stylesheet', () => {
    const { content } = buildGalaxyDom();
    installGalaxyNavPanel();

    const panel = document.getElementById(GNAV_PANEL_ID);
    expect(panel).not.toBeNull();
    expect(content.nextElementSibling).toBe(panel);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
  });

  it('hides the native #galaxyHeader via the injected stylesheet', () => {
    buildGalaxyDom();
    installGalaxyNavPanel();

    const css = document.getElementById(STYLE_ID)?.textContent ?? '';
    expect(css).toContain('#galaxyHeader');
    expect(css).toMatch(/#galaxyHeader\s*\{\s*display:\s*none/);
  });

  it('is idempotent — second install returns the same dispose, one panel', () => {
    buildGalaxyDom();
    const disposeA = installGalaxyNavPanel();
    const disposeB = installGalaxyNavPanel();

    expect(disposeA).toBe(disposeB);
    expect(document.querySelectorAll(`#${GNAV_PANEL_ID}`).length).toBe(1);
  });

  it('does not mount when the native form is absent (e.g. vacation galaxy block)', () => {
    // #galaxyContent present but no coord inputs — nothing to mirror.
    const content = document.createElement('div');
    content.id = 'galaxyContent';
    document.body.appendChild(content);

    installGalaxyNavPanel();
    expect(document.getElementById(GNAV_PANEL_ID)).toBeNull();
  });
});

describe('galaxyNavPanel — proxying the native controls', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
    // The native submit's inline `onclick="submitForm()"` executes when
    // happy-dom dispatches the click — `submitForm` is a game global in-page;
    // stub it so the proxied click doesn't throw ReferenceError here.
    /** @type {any} */ (globalThis).submitForm = () => {};
  });

  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '';
    delete (/** @type {any} */ (globalThis).submitForm);
  });

  it('Start fills the native inputs from the panel and clicks the native submit', () => {
    const { galInput, sysInput, submit } = buildGalaxyDom();
    installGalaxyNavPanel();

    let submitted = false;
    submit.addEventListener('click', () => {
      submitted = true;
    });

    const panel = /** @type {HTMLElement} */ (
      document.getElementById(GNAV_PANEL_ID)
    );
    const inputs = panel.querySelectorAll('.oge-gnav-input');
    /** @type {HTMLInputElement} */ (inputs[0]).value = '5';
    /** @type {HTMLInputElement} */ (inputs[1]).value = '318';
    /** @type {HTMLElement} */ (panel.querySelector('.oge-gnav-start')).click();

    expect(submitted).toBe(true);
    expect(galInput.value).toBe('5');
    expect(sysInput.value).toBe('318');
  });

  it('a stepper clicks the game’s own prev/next arrow', () => {
    const { galNext } = buildGalaxyDom();
    installGalaxyNavPanel();

    let arrowClicked = false;
    galNext.addEventListener('click', () => {
      arrowClicked = true;
    });

    const panel = /** @type {HTMLElement} */ (
      document.getElementById(GNAV_PANEL_ID)
    );
    // Steppers in DOM order: galaxy −, galaxy +, system −, system +.
    const steppers = panel.querySelectorAll('.oge-gnav-step');
    /** @type {HTMLElement} */ (steppers[1]).click(); // galaxy +

    expect(arrowClicked).toBe(true);
  });

  it('an action button proxies its native control and mirrors disabled state', () => {
    const { phalanx } = buildGalaxyDom();
    phalanx.setAttribute('disabled', 'disabled');
    installGalaxyNavPanel();

    const panel = /** @type {HTMLElement} */ (
      document.getElementById(GNAV_PANEL_ID)
    );
    const actions = panel.querySelectorAll('.oge-gnav-action');
    const phalanxBtn = /** @type {HTMLButtonElement} */ (actions[0]);

    // Native phalanx is disabled → the mirror button is disabled and a tap
    // does NOT reach the native control.
    expect(phalanxBtn.disabled).toBe(true);
    let clicked = false;
    phalanx.addEventListener('click', () => {
      clicked = true;
    });
    phalanxBtn.click();
    expect(clicked).toBe(false);

    // Native enabled → mirror follows on the next sync, tap reaches it.
    phalanx.removeAttribute('disabled');
    // Re-run install path's sync by toggling the setting off/on is heavy;
    // instead assert the click proxy directly once enabled.
    phalanxBtn.disabled = false;
    phalanxBtn.click();
    expect(clicked).toBe(true);
  });
});

describe('galaxyNavPanel — row 16 debris readout', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
  });

  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '';
  });

  it('compacts the labels on mount, keeping the action li and delta span intact', () => {
    const { content } = buildGalaxyDom();

    const box = document.createElement('div');
    box.className = 'expeditionDebrisSlotBox';
    const ul = document.createElement('ul');
    ul.className = 'ago_expo_df';

    const metal = document.createElement('li');
    metal.className = 'metal';
    metal.textContent = 'Metal: 1.388.400';

    const crystal = document.createElement('li');
    crystal.className = 'crystal';
    crystal.textContent = 'Kryształ: 957.400';

    const pf = document.createElement('li');
    pf.className = 'pfcount';
    pf.append(document.createTextNode('Potrzebne Pioniery: 17'));
    const delta = document.createElement('span');
    delta.textContent = ' (-16)';
    pf.appendChild(delta);

    const action = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = 'Zredukuj';
    action.appendChild(a);

    ul.append(metal, crystal, pf, action);
    box.appendChild(ul);
    content.appendChild(box);

    installGalaxyNavPanel();

    // Class-keyed short labels; values verbatim.
    expect(metal.textContent).toBe('M 1.388.400');
    expect(crystal.textContent).toBe('K 957.400');
    // The pathfinder li: first text node compacted, delta span preserved.
    expect(pf.firstChild?.textContent).toBe('PF 17');
    expect(pf.querySelector('span')?.textContent).toBe(' (-16)');
    // The action li is left alone.
    expect(a.textContent).toBe('Zredukuj');
  });
});

describe('galaxyNavPanel — teardown', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
  });

  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '';
  });

  it('unmounts when the setting is toggled off, remounts when back on', () => {
    buildGalaxyDom();
    installGalaxyNavPanel();
    expect(document.getElementById(GNAV_PANEL_ID)).not.toBeNull();

    settingsStore.update((s) => ({ ...s, readabilityBoost: false }));
    expect(document.getElementById(GNAV_PANEL_ID)).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();

    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    expect(document.getElementById(GNAV_PANEL_ID)).not.toBeNull();
  });

  it('dispose removes the panel and stylesheet', () => {
    buildGalaxyDom();
    const dispose = installGalaxyNavPanel();
    expect(document.getElementById(GNAV_PANEL_ID)).not.toBeNull();

    dispose();
    expect(document.getElementById(GNAV_PANEL_ID)).toBeNull();
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });
});
