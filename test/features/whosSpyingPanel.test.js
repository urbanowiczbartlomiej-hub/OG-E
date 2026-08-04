// @vitest-environment happy-dom
// @ts-check

// Who's-spying-on-you panel — behavioral coverage for the two-tier insertion
// slot (the 1.40.2 fix: newer AGR builds stopped injecting
// `#agoSpyReportOverview`, the panel's original sole anchor):
//
//   tier 1 — right above AGR's overview when it exists;
//   tier 2 — top of the game's own `.messagesHolder` while the espionage
//            sub-tab (`data-subtab-id="20"`) is the active one.
//
// The DOM fixtures mirror a live 2026-07 messages-page dump: `.innerTabItem`
// tab headers under `.tabsWrapper`, messages as `.msg` children of
// `.messagesHolder`. Driven through the store subscription (synchronous) so
// no test waits on the panel's MutationObserver.

import { describe, it, expect, afterEach } from 'vitest';
import {
  installWhosSpyingPanel,
  _resetWhosSpyingPanelForTest,
} from '../../src/features/whosSpyingPanel.js';
import { proximityReportsStore } from '../../src/state/proximityReports.js';

const PANEL_ID = 'oge-spyback';

/** One prober alert (epoch-seconds ts, the store's shape). */
const report = () => ({
  byPlayerId: 116337,
  byPlayerName: 'GumkaVIP',
  atCoords: '4:471:15',
  atPlanetType: 3,
  fromCoords: '4:431:9',
  fromPlanetType: 3,
  ts: Math.floor(Date.now() / 1000) - 60,
});

/**
 * Build the messages-page skeleton. Returns the message holder.
 * @param {{ activeSubtab?: string, messages?: number, withAgr?: boolean, withHeaders?: boolean }} [o]
 */
const buildMessagesDom = ({
  activeSubtab = '20', messages = 2, withAgr = false, withHeaders = false,
} = {}) => {
  document.body.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.id = 'messagewrapper';
  const tabs = document.createElement('div');
  tabs.className = 'tabsWrapper';
  for (const id of ['20', '21', '22']) {
    const tab = document.createElement('div');
    tab.className = 'innerTabItem' + (id === activeSubtab ? ' active' : '');
    tab.dataset.subtabId = id;
    tabs.appendChild(tab);
  }
  wrapper.appendChild(tabs);
  if (withAgr) {
    const agr = document.createElement('div');
    agr.id = 'agoSpyReportOverview';
    wrapper.appendChild(agr);
  }
  if (withHeaders) {
    const headers = document.createElement('div');
    headers.id = 'filteredHeadersRow';
    for (const label of ['Data/godzina', 'Ranking', 'Nazwa gracza']) {
      const cell = document.createElement('div');
      cell.className = 'filteredHeaderCell';
      cell.textContent = label;
      headers.appendChild(cell);
    }
    wrapper.appendChild(headers);
  }
  const holder = document.createElement('div');
  holder.className = 'messagesHolder';
  for (let i = 0; i < messages; i++) {
    const m = document.createElement('div');
    m.className = 'msg';
    holder.appendChild(m);
  }
  wrapper.appendChild(holder);
  document.body.appendChild(wrapper);
  return holder;
};

/** Force a refresh through the store subscription (new array identity). */
const poke = () => proximityReportsStore.set([...proximityReportsStore.get()]);

const panel = () => document.getElementById(PANEL_ID);

afterEach(() => {
  _resetWhosSpyingPanelForTest();
  proximityReportsStore.set([]);
  document.body.innerHTML = '';
});

describe('installWhosSpyingPanel — game-owned slot (AGR overview absent)', () => {
  it('mounts at the TOP of .messagesHolder while the spy sub-tab is active', () => {
    const holder = buildMessagesDom();
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();

    const p = panel();
    expect(p).not.toBeNull();
    expect(p?.parentElement).toBe(holder);
    expect(holder.firstElementChild).toBe(p);
    // The first game message follows the panel.
    expect(p?.nextElementSibling?.className).toContain('msg');
    // And the digest actually rendered the prober.
    expect(p?.textContent).toContain('GumkaVIP');
  });

  it('mounts even when the tab holds no messages (empty holder appends)', () => {
    const holder = buildMessagesDom({ messages: 0 });
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();
    expect(panel()?.parentElement).toBe(holder);
  });

  it('does NOT mount on another sub-tab, and unmounts when the tab flips away', () => {
    // Another tab active → no slot.
    buildMessagesDom({ activeSubtab: '21' });
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();
    expect(panel()).toBeNull();

    // Spy tab becomes active → mounts on the next refresh.
    document.querySelector('.innerTabItem[data-subtab-id="21"]')?.classList.remove('active');
    document.querySelector('.innerTabItem[data-subtab-id="20"]')?.classList.add('active');
    poke();
    expect(panel()).not.toBeNull();

    // …and away again → removed.
    document.querySelector('.innerTabItem[data-subtab-id="20"]')?.classList.remove('active');
    document.querySelector('.innerTabItem[data-subtab-id="22"]')?.classList.add('active');
    poke();
    expect(panel()).toBeNull();
  });

  it('does not mount with an empty alert log', () => {
    buildMessagesDom();
    proximityReportsStore.set([]);
    installWhosSpyingPanel();
    expect(panel()).toBeNull();
  });

  it('re-mounts after the game re-renders the holder (panel dropped with it)', () => {
    const holder = buildMessagesDom();
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();
    expect(panel()).not.toBeNull();

    // OGame replaces the list wholesale on pagination/sub-tab reload.
    holder.textContent = '';
    const m = document.createElement('div');
    m.className = 'msg';
    holder.appendChild(m);
    expect(panel()).toBeNull();

    poke();
    expect(holder.firstElementChild).toBe(panel());
  });
});

describe('installWhosSpyingPanel — above the column headers (tier 2)', () => {
  it('mounts ABOVE #filteredHeadersRow, not between the headers and the rows', () => {
    // The 1.56 fix: injected at the top of the holder, our ~200px table pushed
    // the message rows away from the column labels that name them.
    const holder = buildMessagesDom({ withHeaders: true });
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();

    const p = panel();
    const headers = document.getElementById('filteredHeadersRow');
    expect(p).not.toBeNull();
    expect(p?.nextElementSibling).toBe(headers);
    expect(headers?.nextElementSibling).toBe(holder);
    // Nothing of ours sits inside the list itself any more.
    expect(holder.querySelector(`#${PANEL_ID}`)).toBeNull();
  });

  it('falls back to the top of the holder when the build has no header strip', () => {
    const holder = buildMessagesDom({ withHeaders: false });
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();
    expect(panel()?.parentElement).toBe(holder);
  });
});

describe('installWhosSpyingPanel — AGR overview present (tier 1)', () => {
  it('prefers the spot directly ABOVE #agoSpyReportOverview', () => {
    buildMessagesDom({ withAgr: true });
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();

    const p = panel();
    expect(p).not.toBeNull();
    expect(p?.nextElementSibling?.id).toBe('agoSpyReportOverview');
  });

  it('works even off the spy sub-tab (AGR node doubles as the tab signal)', () => {
    // AGR injects its overview only in the spy tab — when it exists, it IS the
    // signal, regardless of what our own tab check would say.
    buildMessagesDom({ activeSubtab: '21', withAgr: true });
    proximityReportsStore.set([report()]);
    installWhosSpyingPanel();
    expect(panel()?.nextElementSibling?.id).toBe('agoSpyReportOverview');
  });
});

describe('installWhosSpyingPanel — lifecycle', () => {
  it('is idempotent and dispose removes the panel + style', () => {
    buildMessagesDom();
    proximityReportsStore.set([report()]);
    const dispose = installWhosSpyingPanel();
    expect(installWhosSpyingPanel()).toBe(dispose);

    dispose();
    expect(panel()).toBeNull();
    expect(document.getElementById('oge-spyback-style')).toBeNull();
  });
});
