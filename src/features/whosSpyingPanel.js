// @ts-check

// Who's-spying-on-you panel — an OG-E table injected at the TOP of the messages
// page's spy-report tab (`?page=ingame&component=messages`, the "Szpieguj"
// sub-tab), right above AntiGame's own spy-report overview (`#agoSpyReportOverview`).
// It is the DEFENSIVE mirror of AGR's OFFENSIVE list: AGR summarises the farms
// YOU scanned; this summarises WHO has been probing YOU.
//
// # Why the messages page (this used to live in the AGR sidebar)
//
// The sidebar tab was cramped and easy to miss. The messages page is where you
// actually review espionage — the incoming "Obca flota … dostrzeżona w pobliżu
// Twojej planety" alerts that feed this panel LIVE in this very tab — and there's
// full page width for a scannable table. So we moved it here and reshaped the
// narrow stacked cards into a compact table that blends with AGR's overview
// directly below it.
//
// # Data (unchanged — fair-play GREEN)
//
// Reads `state/proximityReports.js` (the per-universe log of proximity alerts the
// player OPENED, captured by `features/targetsIngest`) and aggregates it with the
// pure `domain/proximityDigest.js` into one row per prober — newest and closest
// first, same-system (RIP-range) probers flagged 💀. Purely presentational: no new
// data is captured here.
//
// # Anchor + lifecycle (two-tier)
//
// The insertion slot is resolved per refresh, best-first:
//
//   1. Above AGR's `#agoSpyReportOverview` (the 1.39.0 placement) — AGR builds
//      it only in the spy-report tab, so it doubles as the tab signal. Newer
//      AGR builds STOPPED injecting it (observed in the wild 2026-07, confirmed
//      by a live console check), which used to make this panel silently vanish.
//   2. GAME-owned fallback: the top of `.messagesHolder` — the game's own
//      message-list container — while the espionage sub-tab is the active one
//      (`.innerTabItem.active[data-subtab-id="20"]`; the numeric sub-tab id is
//      a game constant, so the check is locale-independent). Verified against
//      a live 2026-07 messages-page dump. Works even when the tab holds no
//      messages at all.
//
// A `MutationObserver` on <body> keeps the table mounted at the slot —
// surviving OGame's AJAX sub-tab re-renders (each switch rebuilds the messages
// DOM; a holder re-render also drops our panel, and the observer simply
// re-inserts it). When no slot resolves (other sub-tab / not the messages
// page) or there are no probers, the table is removed (no clutter when
// there's nothing to show). A `proximityReportsStore` subscription repaints on
// a new alert; a slow clock poll refreshes the relative ages. A cheap render
// signature skips the rebuild when nothing changed, so the frequent <body>
// mutations OGame emits stay free.
//
// Idempotent install: a second call returns the same dispose fn.

import { proximityReportsStore } from '../state/proximityReports.js';
import { digestProximityReports } from '../domain/proximityDigest.js';
import { injectStyle } from '../lib/dom.js';
import { clock } from '../lib/clock.js';
import { parseUniverseId } from '../lib/universeId.js';

/**
 * AGR's spy-report overview on the messages page — the PREFERRED slot when
 * present (see the header: newer AGR builds no longer inject it, hence the
 * game-owned fallback below). AGR-owned, single feature ⇒ kept local rather
 * than hoisted to gameDom.js.
 */
const SPY_OVERVIEW_SEL = '#agoSpyReportOverview';
/**
 * The game's ACTIVE espionage sub-tab header on the messages page. Game-owned
 * DOM contract (single feature ⇒ local, per the gameDom.js rule): sub-tab ids
 * are numeric game constants — 20 espionage, 21 combat, 22 expeditions,
 * 23 unions/transport, 24 other — so this never depends on the locale label.
 */
const SPY_SUBTAB_ACTIVE_SEL = '.innerTabItem.active[data-subtab-id="20"]';
/** The game's message-list container (direct parent of every `.msg`). */
const MESSAGES_HOLDER_SEL = '.messagesHolder';

/**
 * Resolve where the panel mounts: insert into `parent` before `before`
 * (`before: null` = append — an empty holder). `null` when the spy tab isn't
 * open (as far as we can tell). Tier 1: right above AGR's overview. Tier 2:
 * the top of the game's own message list while the espionage sub-tab is
 * active. `before` never resolves to the panel itself, so the caller's
 * "already glued" check stays a cheap identity comparison.
 * @returns {{ parent: Element, before: Element | null } | null}
 */
const resolveSlot = () => {
  const agr = document.querySelector(SPY_OVERVIEW_SEL);
  if (agr && agr.parentElement) return { parent: agr.parentElement, before: agr };

  if (!document.querySelector(SPY_SUBTAB_ACTIVE_SEL)) return null;
  const holder = document.querySelector(MESSAGES_HOLDER_SEL);
  if (!holder) return null;
  let first = holder.firstElementChild;
  if (first && first.id === PANEL_ID) first = first.nextElementSibling;
  return { parent: holder, before: first };
};
/** Our table wrapper id (OG-E's own surface). */
const PANEL_ID = 'oge-spyback';
/** Singleton style element id. */
const STYLE_ID = 'oge-spyback-style';
/** Max prober rows rendered (the log is capped at 60 alerts upstream). */
const MAX_ROWS = 8;
/** Age-refresh cadence for the relative timestamps. */
const POLL_MS = 60000;

const CSS = [
  // --sp-accent = the Spyglass gold (sendSpy's BG_SPY_IDLE) — one spy identity
  // across the FAB, this panel and the dashboard tab it deep-links to.
  `#${PANEL_ID}{--sp-accent:#e6c054;--sp-danger:#e2726a;margin:0 0 10px;`,
  'background:#0d151d;border:1px solid #26323f;border-left:3px solid var(--sp-accent);',
  'border-radius:6px;overflow:hidden;color:#93a3b3;',
  'font-family:Verdana,"Segoe UI",Tahoma,sans-serif;}',
  `#${PANEL_ID} .oge-sb-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;`,
  'background:linear-gradient(90deg,#141d27,transparent);border-bottom:1px solid #1b2732;}',
  `#${PANEL_ID} .oge-sb-eye{font-size:14px;}`,
  `#${PANEL_ID} .oge-sb-title{font-size:12.5px;font-weight:700;color:#d8e6f4;letter-spacing:.02em;}`,
  `#${PANEL_ID} .oge-sb-sum{margin-left:auto;font:11px/1 monospace;color:#6b7987;}`,
  `#${PANEL_ID} .oge-sb-sum b{color:#c6d4e2;font-weight:700;}`,
  `#${PANEL_ID} .oge-sb-sum .hot{color:var(--sp-danger);font-weight:700;}`,
  `#${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:12px;}`,
  `#${PANEL_ID} thead th{text-align:left;font:700 10px/1 Verdana,sans-serif;`,
  'letter-spacing:.05em;text-transform:uppercase;color:#5f6b76;padding:6px 10px;',
  'border-bottom:1px solid #1b2732;white-space:nowrap;}',
  `#${PANEL_ID} th.num,#${PANEL_ID} td.num{text-align:right;}`,
  `#${PANEL_ID} tbody td{padding:6px 10px;border-top:1px solid #16212c;vertical-align:middle;}`,
  `#${PANEL_ID} tbody tr.hot{background:linear-gradient(90deg,#2a1512,transparent 70%);`,
  'box-shadow:inset 3px 0 0 var(--sp-danger);}',
  `#${PANEL_ID} .oge-sb-name{font-weight:700;color:#d8e6f4;}`,
  `#${PANEL_ID} tr.hot .oge-sb-name{color:#f4b4ad;}`,
  `#${PANEL_ID} .oge-sb-skull{margin-right:5px;cursor:help;}`,
  `#${PANEL_ID} .oge-sb-age{font:11px/1 monospace;color:#6b7987;white-space:nowrap;}`,
  `#${PANEL_ID} .coord{color:#a9c4de;font:11px/1 monospace;}`,
  // Lunar tint — a MOON body's coords (planet and moon share "g:s:p"; the
  // colour + tooltip is what tells them apart). Same hex as the dashboard's
  // proximity strip.
  `#${PANEL_ID} .coord.moon{color:#c9a9e8;cursor:help;}`,
  `#${PANEL_ID} .muted{color:#4c5763;}`,
  `#${PANEL_ID} .oge-sb-acts{display:flex;gap:6px;justify-content:flex-end;}`,
  `#${PANEL_ID} .oge-sb-btn{font:11px Verdana,sans-serif;color:#93a3b3;cursor:pointer;`,
  'background:#16212c;border:1px solid #26323f;border-radius:5px;padding:3px 9px;white-space:nowrap;}',
  `#${PANEL_ID} .oge-sb-btn:hover{border-color:var(--sp-accent);color:#d8e6f4;background:#1a2534;}`,
  `#${PANEL_ID} .oge-sb-foot{padding:5px 12px;border-top:1px solid #1b2732;font-size:10px;color:#5f6b76;}`,
  `#${PANEL_ID} .oge-sb-foot .k{color:var(--sp-danger);}`,
].join('');

/**
 * Small createElement helper.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/**
 * Relative age of an epoch-SECONDS timestamp ("12 min ago" / "2 h ago" /
 * "3 d ago"). Empty string when absent.
 * @param {number | null} tsSec
 * @returns {string}
 */
const ageStr = (tsSec) => {
  if (!tsSec) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/**
 * The dashboard's extension URL, resolved once via `browser/chrome.runtime`.
 * Empty string when the WebExtension runtime isn't present (test envs) —
 * {@link openSpyglass} no-ops then. Kept local (a feature must not import
 * another feature); mirrors the resolver in features/dailyRun.
 * @type {string}
 */
const DASHBOARD_URL = (() => {
  try {
    const g = /** @type {any} */ (/** @type {unknown} */ (globalThis));
    const ns = g.browser ?? g.chrome;
    const url = ns?.runtime?.getURL?.('dashboard.html');
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
})();

/**
 * Open the OG-E dashboard on the Spyglass tab, deep-linked to this prober's
 * dossier (`?spy=<pid>` — the dashboard expands + scrolls to the player) and
 * pre-selecting the current universe (`?host=`). A deliberate user tap → one
 * new tab. No-op when the runtime URL is unavailable.
 * @param {number} pid
 * @returns {void}
 */
const openSpyglass = (pid) => {
  if (!DASHBOARD_URL) return;
  const universeId = parseUniverseId(location.host);
  const url = DASHBOARD_URL
    + `?${universeId ? `host=${encodeURIComponent(universeId)}&` : ''}tab=spyglass&spy=${pid}`;
  window.open(url, '_blank');
};

/**
 * One coord span. A MOON body renders in the lunar tint (`.coord.moon`) with a
 * tooltip saying so — a planet and its moon share `"g:s:p"`, so the colour is
 * the only thing telling you which body the alert was actually about.
 * @param {string} coords
 * @param {boolean} moon
 * @returns {HTMLElement}
 */
const bodyEl = (coords, moon) => {
  const s = el('span', moon ? 'coord moon' : 'coord', coords);
  if (moon) s.title = 'This coordinate is the slot’s MOON, not the planet';
  return s;
};

/**
 * Build one prober `<tr>` from a digest entry.
 * @param {import('../domain/proximityDigest.js').ProximityDigestEntry} p
 * @returns {HTMLElement}
 */
const buildRow = (p) => {
  const tr = el('tr', p.sameSystem ? 'hot' : undefined);

  const nameTd = el('td');
  if (p.sameSystem) {
    const skull = el('span', 'oge-sb-skull', '💀');
    skull.title = 'In your system — can strike at moon/RIP speed';
    nameTd.appendChild(skull);
  }
  nameTd.appendChild(el('span', 'oge-sb-name', p.name || `#${p.byPlayerId}`));
  tr.appendChild(nameTd);

  tr.appendChild(el('td', 'oge-sb-age', ageStr(p.lastTs) || '—'));
  tr.appendChild(el('td', 'num', String(p.count)));

  const fromTd = el('td');
  fromTd.appendChild(p.fromCoords ? bodyEl(p.fromCoords, p.fromMoon) : el('span', 'muted', '—'));
  tr.appendChild(fromTd);

  const nearTd = el('td');
  if (p.atBodies.length) {
    p.atBodies.forEach((b, i) => {
      if (i) nearTd.appendChild(el('span', 'coord', ', '));
      nearTd.appendChild(bodyEl(b.coords, b.moon));
    });
  } else {
    nearTd.appendChild(el('span', 'muted', '—'));
  }
  tr.appendChild(nearTd);

  // One action: jump to this prober's full dossier in the dashboard's Spyglass
  // tab (which owns watch/relationship/scan tooling — no point duplicating a
  // thinner copy of it here).
  const actTd = el('td');
  const acts = el('div', 'oge-sb-acts');
  const dossierBtn = el('button', 'oge-sb-btn', 'Spyglass');
  dossierBtn.title = "Open this player's dossier in the OG-E dashboard (Spyglass tab)";
  dossierBtn.addEventListener('click', () => openSpyglass(p.byPlayerId));
  acts.appendChild(dossierBtn);
  actTd.appendChild(acts);
  tr.appendChild(actTd);

  return tr;
};

/**
 * Build the empty panel shell (header strip + table skeleton + footnote slot).
 * `renderInto` fills it.
 * @returns {HTMLElement}
 */
const buildShell = () => {
  const panel = el('div');
  panel.id = PANEL_ID;

  const hdr = el('div', 'oge-sb-hdr');
  hdr.appendChild(el('span', 'oge-sb-eye', '👁'));
  hdr.appendChild(el('span', 'oge-sb-title', "Who's spying on you"));
  hdr.appendChild(el('span', 'oge-sb-sum'));
  panel.appendChild(hdr);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = el('tr');
  /** @type {Array<[string, string]>} label + optional class */
  const cols = [
    ['Prober', ''], ['Seen', ''], ['Alerts', 'num'], ['From', ''], ['Near you', ''], ['', ''],
  ];
  for (const [label, cls] of cols) {
    const th = document.createElement('th');
    if (cls) th.className = cls;
    th.textContent = label;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  table.appendChild(document.createElement('tbody'));
  panel.appendChild(table);

  panel.appendChild(el('div', 'oge-sb-foot'));
  return panel;
};

/**
 * Paint the summary line, rows and footnote from a digest.
 * @param {HTMLElement} panel
 * @param {ReturnType<typeof digestProximityReports>} digest
 * @returns {void}
 */
const renderInto = (panel, digest) => {
  const sum = panel.querySelector('.oge-sb-sum');
  if (sum) {
    sum.textContent = '';
    const pc = el('b', undefined, String(digest.playerCount));
    sum.appendChild(pc);
    sum.appendChild(document.createTextNode(` prober${digest.playerCount === 1 ? '' : 's'} · `));
    sum.appendChild(el('b', undefined, String(digest.totalReports)));
    sum.appendChild(document.createTextNode(` alert${digest.totalReports === 1 ? '' : 's'}`));
    if (digest.sameSystemCount > 0) {
      sum.appendChild(document.createTextNode(' · '));
      sum.appendChild(el('span', 'hot', `${digest.sameSystemCount} in your system`));
    }
  }

  const tbody = panel.querySelector('tbody');
  if (tbody) {
    tbody.textContent = '';
    for (const p of digest.players.slice(0, MAX_ROWS)) tbody.appendChild(buildRow(p));
  }

  // Footnote only when there's actually a 💀 to explain — no same-system prober
  // ⇒ no legend (a legend for a glyph that isn't on screen is pure clutter).
  const foot = /** @type {HTMLElement | null} */ (panel.querySelector('.oge-sb-foot'));
  if (foot) {
    foot.textContent = '';
    if (digest.sameSystemCount > 0) {
      foot.appendChild(el('span', 'k', '💀'));
      foot.appendChild(document.createTextNode(
        ' = a scout with a body in your system — can strike at moon/RIP speed. From alerts you opened.'));
      foot.style.display = '';
    } else {
      foot.style.display = 'none';
    }
  }
};

/** Last painted render signature — skips no-op rebuilds on idle <body> churn. */
let lastSig = '';

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the Who's-spying-on-you table. Idempotent — a second call returns the
 * same dispose fn. No-op until the messages page's spy-report tab is open (the
 * observer picks up AGR's `#agoSpyReportOverview` when it appears).
 * @returns {() => void}
 */
export const installWhosSpyingPanel = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);

  /**
   * Mount/remove + repaint the table to match the current tab + digest. Cheap
   * on the common "nothing to do / unchanged" paths so it's safe on every
   * <body> mutation: bails immediately off the spy tab, and a render signature
   * skips the rebuild when the digest hasn't moved.
   * @param {{ force?: boolean }} [opts] force ⇒ repaint even if unchanged (age refresh).
   * @returns {void}
   */
  const refresh = ({ force = false } = {}) => {
    const reports = proximityReportsStore.get();
    let panel = document.getElementById(PANEL_ID);
    // Empty log first — a cheap store read before any DOM queries.
    if (reports.length === 0) {
      if (panel) panel.remove();
      lastSig = '';
      return;
    }
    const slot = resolveSlot();
    if (!slot) {
      if (panel) panel.remove();
      lastSig = '';
      return;
    }
    const digest = digestProximityReports(reports);
    if (!panel) {
      panel = buildShell();
      lastSig = '';
    }
    // Keep it glued in the slot — AGR may have re-injected its overview, and a
    // holder re-render both drops our panel and mints a new first message (the
    // observer lands here again either way).
    if (panel.parentNode !== slot.parent || panel.nextElementSibling !== slot.before) {
      slot.parent.insertBefore(panel, slot.before);
    }
    const shown = digest.players.slice(0, MAX_ROWS);
    const sig = `${digest.playerCount}|${digest.totalReports}|${digest.sameSystemCount}|`
      + shown.map((p) => `${p.byPlayerId}:${p.count}:${p.lastTs}`).join(',');
    if (force || sig !== lastSig) {
      renderInto(panel, digest);
      lastSig = sig;
    }
  };

  refresh();

  const observer = new MutationObserver(() => refresh());
  observer.observe(document.body, { childList: true, subtree: true });

  // A landed alert repaints the digest; the slow poll refreshes relative ages
  // (and re-mounts as a backstop if a mutation was missed).
  const unsub = proximityReportsStore.subscribe(() => refresh());
  const unsubPoll = clock.subscribe(() => refresh({ force: true }), { everyMs: POLL_MS });

  installed = {
    dispose: () => {
      observer.disconnect();
      unsub();
      unsubPoll();
      const live = document.getElementById(PANEL_ID);
      if (live) live.remove();
      const style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
      lastSig = '';
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset.
 * @returns {void}
 */
export const _resetWhosSpyingPanelForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  lastSig = '';
};
