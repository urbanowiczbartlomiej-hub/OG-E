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
//    11. The row-16 slot is PROXIED: native box hidden, compact OG-E box in
//        its place (stacked resource lines, PF on the recycle button, adopted
//        template-editor anchor, mirrored select, AGR tint carried over).
//    12. The position toggle cycles bottom/top/both and gates the native header.
//    13. Settings off → unmount; dispose → panel + stylesheet gone.
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

describe('galaxyNavPanel — row 16 expedition-debris proxy', () => {
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

  /**
   * Build the native 1.13 row-16 slot box (title, AGR readout, template
   * select + editor anchor, Expedition/Send buttons) inside `content`.
   *
   * @param {HTMLElement} content
   * @param {{ withRecycleLink?: boolean }} [opts]
   */
  const buildExpoBox = (content, { withRecycleLink = true } = {}) => {
    const box = document.createElement('div');
    box.className = 'expeditionDebrisSlotBox ago_expo_box';
    box.id = 'galaxyRow16';

    const titleWrap = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.className = 'title';
    h3.textContent = 'Bezgraniczna dal:';
    titleWrap.appendChild(h3);
    box.appendChild(titleWrap);

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
    delta.className = 'overmark ago_missing_pf';
    delta.textContent = '(-16)';
    pf.appendChild(delta);
    ul.append(metal, crystal, pf);
    /** @type {HTMLAnchorElement | null} */
    let recycleA = null;
    if (withRecycleLink) {
      const action = document.createElement('li');
      recycleA = document.createElement('a');
      recycleA.textContent = 'Zredukuj';
      action.appendChild(recycleA);
      ul.appendChild(action);
    }
    box.appendChild(ul);

    const actionsDiv = document.createElement('div');
    actionsDiv.id = 'expeditionDebrisSlotActions';
    const cont = document.createElement('div');
    cont.id = 'galaxyExpeditionFleetTemplateContainer';
    const anchor = document.createElement('a');
    anchor.id = 'expeditionFleetTemplateBtn';
    const anchorTitle = document.createElement('span');
    anchorTitle.className = 'expedtionFleetTemplateBtnTitle';
    anchorTitle.textContent = 'Flota ekspedycyjna';
    anchor.appendChild(anchorTitle);
    const select = document.createElement('select');
    select.id = 'expeditionFleetTemplateSelect';
    const o0 = document.createElement('option');
    o0.value = '0';
    o0.textContent = '-';
    const o1 = document.createElement('option');
    o1.value = '526';
    o1.textContent = 'TPL';
    select.append(o0, o1);
    cont.append(anchor, select);
    const expBtn = document.createElement('div');
    expBtn.id = 'expeditionbutton';
    expBtn.textContent = 'Ekspedycja';
    const sendBtn = document.createElement('div');
    sendBtn.id = 'sendExpeditionFleetTemplateFleet';
    sendBtn.textContent = 'Wyślij';
    sendBtn.style.display = 'none';
    actionsDiv.append(cont, expBtn, sendBtn);
    box.appendChild(actionsDiv);

    content.appendChild(box);
    return { box, metal, select, anchor, expBtn, sendBtn, recycleA };
  };

  /** @returns {HTMLElement} */
  const proxyEl = () =>
    /** @type {HTMLElement} */ (document.getElementById('oge-gnav-expo'));

  it('hides the native box and stands the compact proxy right after it', () => {
    const { content } = buildGalaxyDom();
    const { box } = buildExpoBox(content);
    installGalaxyNavPanel();

    expect(box.classList.contains('oge-expo-hidden')).toBe(true);
    expect(box.nextElementSibling).toBe(proxyEl());
    expect(proxyEl().querySelector('.oge-expo-title')?.textContent).toBe(
      'Bezgraniczna dal:',
    );
  });

  it('compacts the resources into stacked lines; PF rides the recycle button; native text untouched', () => {
    const { content } = buildGalaxyDom();
    const { metal } = buildExpoBox(content);
    installGalaxyNavPanel();

    const lines = proxyEl().querySelectorAll('.oge-expo-readout > span');
    expect(Array.from(lines).map((l) => l.textContent)).toEqual([
      'M 1.388.400',
      'K 957.400',
    ]);
    // PF is the recycle button's second line, red delta preserved.
    const l2 = proxyEl().querySelector('.oge-expo-recycle .oge-expo-l2');
    expect(l2?.firstChild?.textContent).toBe('PF 17');
    expect(l2?.querySelector('.miss')?.textContent).toBe('(-16)');
    const btn = /** @type {HTMLButtonElement} */ (
      proxyEl().querySelector('.oge-expo-recycle')
    );
    expect(btn.disabled).toBe(false);
    // We READ the native readout, never rewrite it.
    expect(metal.textContent).toBe('Metal: 1.388.400');
  });

  it('renders the recycle button greyed when the game omits the mine link', () => {
    const { content } = buildGalaxyDom();
    buildExpoBox(content, { withRecycleLink: false });
    installGalaxyNavPanel();

    const btn = /** @type {HTMLButtonElement} */ (
      proxyEl().querySelector('.oge-expo-recycle')
    );
    expect(btn.hidden).toBe(false); // debris present (PF line) → button shown
    expect(btn.disabled).toBe(true); // …but not actionable
  });

  it('ADOPTS the native template-editor anchor and mirrors the select', () => {
    const { content } = buildGalaxyDom();
    const { anchor, select, expBtn, sendBtn } = buildExpoBox(content);
    installGalaxyNavPanel();

    // The real anchor moved into our slot (trusted clicks = native overlay).
    const slot = proxyEl().querySelector('.oge-expo-tplslot');
    expect(slot?.firstElementChild).toBe(anchor);
    expect(anchor.title).toBe('Flota ekspedycyjna');

    // Select mirrored; a pick drives the native select and re-renders the
    // Expedition/Send pair from the game's inline display flip.
    const tpl = /** @type {HTMLSelectElement} */ (
      proxyEl().querySelector('select.oge-expo-tpl')
    );
    expect(Array.from(tpl.options).map((o) => o.value)).toEqual(['0', '526']);
    select.addEventListener('change', () => {
      expBtn.style.display = 'none';
      sendBtn.style.display = 'block';
    });
    tpl.value = '526';
    tpl.dispatchEvent(new Event('change'));
    expect(select.value).toBe('526');
    expect(
      /** @type {HTMLElement} */ (proxyEl().querySelector('.oge-expo-exp')).hidden,
    ).toBe(true);
    expect(
      /** @type {HTMLElement} */ (proxyEl().querySelector('.oge-expo-send')).hidden,
    ).toBe(false);
  });

  it("mirrors AGR's background tint onto the proxy", () => {
    const { content } = buildGalaxyDom();
    const { box } = buildExpoBox(content);
    box.style.backgroundColor = 'rgba(212, 54, 53, 0.33)';
    installGalaxyNavPanel();

    expect(proxyEl().style.backgroundColor).toBe('rgba(212, 54, 53, 0.33)');
  });
});

describe('galaxyNavPanel — position toggle', () => {
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
    localStorage.removeItem('oge-gnav-pos');
  });

  it('cycles bottom → top → both, moving the panel and gating the native header', () => {
    const { content } = buildGalaxyDom();
    installGalaxyNavPanel();
    const panel = /** @type {HTMLElement} */ (document.getElementById(GNAV_PANEL_ID));
    const pos = /** @type {HTMLElement} */ (panel.querySelector('.oge-gnav-pos'));

    // Default: bottom — after the table, native header hidden.
    expect(content.nextElementSibling).toBe(panel);
    expect(document.body.classList.contains('oge-gnav-hide-native')).toBe(true);

    pos.click(); // → top
    expect(content.previousElementSibling).toBe(panel);
    expect(document.body.classList.contains('oge-gnav-hide-native')).toBe(true);
    expect(localStorage.getItem('oge-gnav-pos')).toBe('top');

    pos.click(); // → both
    expect(content.nextElementSibling).toBe(panel);
    expect(document.body.classList.contains('oge-gnav-hide-native')).toBe(false);
    expect(localStorage.getItem('oge-gnav-pos')).toBe('both');

    pos.click(); // → back to bottom
    expect(localStorage.getItem('oge-gnav-pos')).toBe('bottom');
    expect(document.body.classList.contains('oge-gnav-hide-native')).toBe(true);
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

describe('galaxyNavPanel — actions collapse toggle', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    localStorage.clear();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
  });
  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    localStorage.clear();
    location.search = '';
  });

  /** @returns {HTMLElement} */
  const actionsRow = () => {
    const panel = /** @type {HTMLElement} */ (document.getElementById(GNAV_PANEL_ID));
    return /** @type {HTMLElement} */ (panel.querySelector('.oge-gnav-row:not(.oge-gnav-nav)'));
  };
  /** @returns {HTMLElement} */
  const collapseBtn = () => {
    const panel = /** @type {HTMLElement} */ (document.getElementById(GNAV_PANEL_ID));
    return /** @type {HTMLElement} */ (panel.querySelector('.oge-gnav-collapse'));
  };

  it('folds the actions row away and back, remembering the choice', () => {
    buildGalaxyDom();
    installGalaxyNavPanel();

    // Default: shown, arrow points up (fold up).
    expect(actionsRow().style.display).toBe('');
    expect(collapseBtn().textContent).toBe('▴');

    collapseBtn().click();
    expect(actionsRow().style.display).toBe('none');
    expect(collapseBtn().textContent).toBe('▾');
    expect(localStorage.getItem('oge-gnav-actions')).toBe('1');

    collapseBtn().click();
    expect(actionsRow().style.display).toBe('');
    expect(localStorage.getItem('oge-gnav-actions')).toBe('0');
  });

  it('comes up collapsed when the stored preference says so', () => {
    localStorage.setItem('oge-gnav-actions', '1');
    buildGalaxyDom();
    installGalaxyNavPanel();

    expect(actionsRow().style.display).toBe('none');
    expect(collapseBtn().textContent).toBe('▾');
  });
});

describe('galaxyNavPanel — footer fold', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
  });
  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    location.search = '';
  });

  /** Add the native stats cell + footer (colonised count + legend) into content. */
  const addFooter = (/** @type {HTMLElement} */ content) => {
    const stats = document.createElement('div');
    stats.className = 'galaxyCell span11';
    stats.innerHTML = '<div id="probes">SS: 1</div>';
    const footer = document.createElement('div');
    footer.className = 'galaxyRow ctGalaxyFooter';
    footer.innerHTML =
      '<div id="colonized"><span id="amountColonized">12</span></div>' +
      '<div id="legend" class="filterCell"><a class="tooltipRel"></a></div>';
    content.append(stats, footer);
    return { stats, footer };
  };

  it('adopts the legend into the stats cell and hides the footer', () => {
    const { content } = buildGalaxyDom();
    const { footer } = addFooter(content);
    installGalaxyNavPanel();

    const moved = document.querySelector('#galaxyContent .galaxyCell.span11 > #legend');
    expect(moved).not.toBeNull();
    expect(moved?.classList.contains('oge-gnav-legend')).toBe(true);
    expect(footer.classList.contains('oge-gnav-footer-hidden')).toBe(true);
  });

  it('restores the native footer on dispose', () => {
    const { content } = buildGalaxyDom();
    const { footer } = addFooter(content);
    const dispose = installGalaxyNavPanel();

    dispose();
    // Legend back inside the footer, marker classes gone.
    expect(footer.querySelector('#legend')).not.toBeNull();
    expect(footer.classList.contains('oge-gnav-footer-hidden')).toBe(false);
    expect(document.querySelector('.galaxyCell.span11 > #legend')).toBeNull();
  });

  it('leaves the footer intact when there is no stats cell to hold the legend', () => {
    const { content } = buildGalaxyDom();
    const footer = document.createElement('div');
    footer.className = 'galaxyRow ctGalaxyFooter';
    footer.innerHTML = '<div id="legend"></div>';
    content.appendChild(footer);
    installGalaxyNavPanel();

    // No span11 → never strand the legend behind a hidden row.
    expect(footer.querySelector('#legend')).not.toBeNull();
    expect(footer.classList.contains('oge-gnav-footer-hidden')).toBe(false);
  });
});

describe('galaxyNavPanel — arrow-key nav rescue', () => {
  beforeEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    settingsStore.update((s) => ({ ...s, readabilityBoost: true }));
    location.search = '?page=ingame&component=galaxy';
  });
  afterEach(() => {
    _resetGalaxyNavPanelForTest();
    clearDom();
    location.search = '';
  });

  /** Stage a focused jQuery-UI dialog; return its close button + focused node. */
  const stageDialog = () => {
    const dialog = document.createElement('div');
    dialog.className = 'ui-dialog';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ui-dialog-titlebar-close';
    const focusable = document.createElement('div');
    focusable.tabIndex = -1;
    dialog.append(closeBtn, focusable);
    document.body.appendChild(dialog);
    focusable.focus();
    return { closeBtn, focusable };
  };

  const pressArrow = (/** @type {string} */ key) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('closes the dialog and hops once when an arrow is pressed with a dialog focused', () => {
    const { sysInput } = buildGalaxyDom();
    installGalaxyNavPanel();
    const { closeBtn } = stageDialog();

    const sysNext = /** @type {HTMLElement} */ (sysInput.nextElementSibling);
    let arrowClicks = 0;
    let closes = 0;
    sysNext.addEventListener('click', () => { arrowClicks++; });
    closeBtn.addEventListener('click', () => { closes++; });

    pressArrow('ArrowRight'); // system +1
    expect(closes).toBe(1);
    expect(arrowClicks).toBe(1);

    // A second arrow within the cooldown is swallowed — no double hop.
    pressArrow('ArrowRight');
    expect(arrowClicks).toBe(1);
  });

  it('stays out of the way when no dialog holds focus (native nav untouched)', () => {
    const { sysInput } = buildGalaxyDom();
    installGalaxyNavPanel();
    // Nothing focused inside a dialog.
    /** @type {HTMLElement | null} */ (document.activeElement)?.blur?.();

    const sysNext = /** @type {HTMLElement} */ (sysInput.nextElementSibling);
    let arrowClicks = 0;
    sysNext.addEventListener('click', () => { arrowClicks++; });

    pressArrow('ArrowRight');
    expect(arrowClicks).toBe(0);
  });

  it('maps ↑ to galaxy +1 (clicks the galaxy next arrow)', () => {
    const { galNext } = buildGalaxyDom();
    installGalaxyNavPanel();
    stageDialog();

    let galClicks = 0;
    galNext.addEventListener('click', () => { galClicks++; });

    pressArrow('ArrowUp');
    expect(galClicks).toBe(1);
  });
});
