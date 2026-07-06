// @ts-check

// Who's-spying panel — an OG-E tab injected into AntiGame's sidebar
// (`.ago_panel_wrapper`, alongside Ustawienia / Konto / Loty / …) that shows
// WHO has been probing YOU. It renders the same passive proximity intel the
// dashboard surfaces in its "🛡 Who's been near you" strip, but live on the
// game page where you actually decide to react.
//
// # Data
//
// Reads `state/proximityReports.js` (the per-universe log of "foreign fleet
// spotted near your planet" alerts the player OPENED) and aggregates it with
// the pure `domain/proximityDigest.js` into one row per prober — newest and
// closest first, with the same-system (RIP-range) probers flagged hottest.
// Purely presentational: no new data is captured (fair-play GREEN, same as the
// dashboard strip).
//
// # Why we inject our OWN classes instead of AGR's tab machinery
//
// OG-E assumes AntiGameReborn is installed (see features/settingsUi), and the
// user chose to mount this in AGR's sidebar. But we do NOT wear AGR's
// `ago-data` toggle attribute (so AGR's delegated handler never tries to
// rebuild our tab) and we keep the body on our OWN class (`.oge-sp-body`, not
// `.ago_panel_tab_content`) so an AGR content-wipe can't blank it. The header
// keeps `.ago_panel_tab` purely for visual blend; a gold-free indigo accent +
// our glyph mark it as the OG-E addition, mirroring how settingsUi marks its
// menu tab. We self-wire the collapse toggle.
//
// # Lifecycle (mirrors features/settingsUi's AGR-injection model)
//
//   1. `inject()` builds + inserts the tab when `.ago_panel_wrapper` exists and
//      our tab isn't already there. It ends by rendering the current digest.
//   2. A `MutationObserver` on `document.body` re-runs `inject()` — survives
//      AGR rebuilding the sidebar, and covers the AGR-not-yet-loaded case.
//   3. `proximityReportsStore.subscribe` re-renders the content when a new
//      alert lands; a slow clock poll refreshes the relative ages.
//   4. Dispose disconnects the observer, unsubscribes, removes the tab + style.
//
// Idempotent install: a second call returns the same dispose fn.

import { proximityReportsStore } from '../state/proximityReports.js';
import { watchListStore } from '../state/watchList.js';
import { digestProximityReports } from '../domain/proximityDigest.js';
import { ingameComponentUrl } from '../domain/ogameUrl.js';
import { injectStyle } from '../lib/dom.js';
import { clock } from '../lib/clock.js';

/** AGR's sidebar container — we append our tab into it. Absent ⇒ no-op. */
const WRAPPER_SEL = '.ago_panel_wrapper';
/** Our tab wrapper id (OG-E's own — deliberately NOT an `ago_panel_*` id, so
 *  AGR's id-based tab queries skip it). */
const TAB_ID = 'oge-spying-panel';
/** Singleton style element id. */
const STYLE_ID = 'oge-spying-style';
/** Max prober rows rendered (the log is capped at 60 alerts upstream). */
const MAX_ROWS = 8;
/** Age-refresh cadence for the relative timestamps. */
const POLL_MS = 60000;

const CSS = [
  `#${TAB_ID}{--sp-indigo:#6355e6;--sp-danger:#e2726a;}`,
  `#${TAB_ID} .oge-sp-hdr{display:flex;align-items:center;gap:7px;cursor:pointer;`,
  'user-select:none;-webkit-user-select:none;}',
  `#${TAB_ID} .oge-sp-hdr .oge-sp-eye{font-size:12px;}`,
  `#${TAB_ID} .oge-sp-badge{margin-left:auto;font:700 10px/1 monospace;color:#0a0f15;`,
  'background:#5f6b76;border-radius:9px;padding:1px 7px;min-width:14px;text-align:center;}',
  `#${TAB_ID} .oge-sp-badge.hot{background:var(--sp-danger);}`,
  `#${TAB_ID} .oge-sp-badge:empty{display:none;}`,
  `#${TAB_ID} .oge-sp-body{background:#0d151d;border:1px solid #26323f;`,
  'border-left:3px solid var(--sp-indigo);border-radius:0 6px 6px 0;',
  'margin:2px 0 4px;padding:2px 0;font-family:Verdana,"Segoe UI",Tahoma,sans-serif;color:#93a3b3;}',
  `#${TAB_ID} .oge-sp-sum{font-size:10.5px;color:#6b7987;padding:6px 10px 4px;font-family:monospace;}`,
  `#${TAB_ID} .oge-sp-sum b{color:#c6d4e2;font-weight:700;}`,
  `#${TAB_ID} .oge-sp-sum .hot{color:var(--sp-danger);font-weight:700;}`,
  `#${TAB_ID} .oge-sp-row{padding:7px 10px;border-top:1px solid #1b2732;}`,
  `#${TAB_ID} .oge-sp-row.hot{background:linear-gradient(90deg,#2a1512,transparent 82%);`,
  'box-shadow:inset 3px 0 0 var(--sp-danger);}',
  `#${TAB_ID} .oge-sp-top{display:flex;align-items:baseline;gap:6px;}`,
  `#${TAB_ID} .oge-sp-name{font-size:12px;font-weight:700;color:#d8e6f4;}`,
  `#${TAB_ID} .oge-sp-row.hot .oge-sp-name{color:#f4b4ad;}`,
  `#${TAB_ID} .oge-sp-count{font:10px/1 monospace;color:#6b7987;}`,
  `#${TAB_ID} .oge-sp-age{margin-left:auto;font:10px/1 monospace;color:#6b7987;white-space:nowrap;}`,
  `#${TAB_ID} .oge-sp-tag{display:inline-flex;align-items:center;gap:4px;margin-top:4px;`,
  'font:700 9px/1.4 Verdana,sans-serif;letter-spacing:.05em;text-transform:uppercase;',
  'color:var(--sp-danger);border:1px solid #5a2b26;background:#1c0f0d;border-radius:4px;padding:2px 6px;}',
  `#${TAB_ID} .oge-sp-meta{margin-top:4px;font:11px/1.5 monospace;color:#8ea3b6;`,
  'display:flex;flex-wrap:wrap;gap:1px 10px;}',
  `#${TAB_ID} .oge-sp-meta .lbl{color:#5f6b76;}`,
  `#${TAB_ID} .oge-sp-meta .coord{color:#a9c4de;}`,
  `#${TAB_ID} .oge-sp-acts{display:flex;gap:6px;margin-top:7px;}`,
  `#${TAB_ID} .oge-sp-btn{font:10.5px Verdana,sans-serif;color:#93a3b3;cursor:pointer;`,
  'background:#16212c;border:1px solid #26323f;border-radius:5px;padding:3px 9px;}',
  `#${TAB_ID} .oge-sp-btn:hover{border-color:var(--sp-indigo);color:#d8e6f4;background:#1a2534;}`,
  `#${TAB_ID} .oge-sp-btn .g{color:var(--sp-indigo);font-weight:700;}`,
  `#${TAB_ID} .oge-sp-btn.done{color:#7fd6a8;border-color:#2f5a44;}`,
  `#${TAB_ID} .oge-sp-empty{padding:12px 10px;font-size:11.5px;color:#6b7987;text-align:center;}`,
  `#${TAB_ID} .oge-sp-foot{padding:6px 10px;border-top:1px solid #1b2732;font-size:9.5px;`,
  'color:#5f6b76;line-height:1.4;}',
  `#${TAB_ID} .oge-sp-foot .k{color:var(--sp-danger);}`,
].join('');

/** Collapse state, persisted across re-injects (AGR rebuilds recreate the tab). */
let openState = false;

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
 * Add a player to the Spyglass watch list (shared with the dashboard + the
 * in-game Spy FAB via the same per-universe store). No-op if already watched.
 * @param {number} pid
 * @returns {void}
 */
const watchPlayer = (pid) => {
  const id = String(pid);
  watchListStore.update((cfg) =>
    cfg.players.includes(id) ? cfg : { ...cfg, players: [...cfg.players, id] });
};

/**
 * Navigate to galaxy view at a `"g:s:p"` coord (a deliberate user tap → one
 * navigation). Malformed coord = no-op.
 * @param {string | null} coords
 * @returns {void}
 */
const gotoGalaxy = (coords) => {
  const m = /^(\d+):(\d+):(\d+)$/.exec(coords ?? '');
  if (!m) return;
  location.href = ingameComponentUrl(location.href, 'galaxy', {
    galaxy: m[1], system: m[2], position: m[3],
  });
};

/**
 * Build one prober row from a digest entry.
 * @param {import('../domain/proximityDigest.js').ProximityDigestEntry} p
 * @returns {HTMLElement}
 */
const buildRow = (p) => {
  const row = el('div', `oge-sp-row${p.sameSystem ? ' hot' : ''}`);

  const top = el('div', 'oge-sp-top');
  top.appendChild(el('span', 'oge-sp-name', p.name || `#${p.byPlayerId}`));
  top.appendChild(el('span', 'oge-sp-count', `${p.count}×`));
  const age = ageStr(p.lastTs);
  if (age) top.appendChild(el('span', 'oge-sp-age', age));
  row.appendChild(top);

  if (p.sameSystem) row.appendChild(el('div', 'oge-sp-tag', '💀 in your system · RIP-range'));

  const meta = el('div', 'oge-sp-meta');
  if (p.fromCoords) {
    const from = el('span');
    from.appendChild(el('span', 'lbl', 'from '));
    from.appendChild(el('span', 'coord', p.fromCoords));
    meta.appendChild(from);
  }
  if (p.atCoords.length) {
    const at = el('span');
    at.appendChild(el('span', 'lbl', 'at '));
    at.appendChild(el('span', 'coord', p.atCoords.join(', ')));
    meta.appendChild(at);
  }
  if (meta.childElementCount) row.appendChild(meta);

  const acts = el('div', 'oge-sp-acts');
  const already = watchListStore.get().players.includes(String(p.byPlayerId));
  const watchBtn = el('button', `oge-sp-btn${already ? ' done' : ''}`);
  watchBtn.innerHTML = '<span class="g">★</span> ';
  watchBtn.appendChild(document.createTextNode(already ? 'watched' : 'watch'));
  watchBtn.addEventListener('click', () => {
    watchPlayer(p.byPlayerId);
    watchBtn.classList.add('done');
    watchBtn.textContent = '';
    watchBtn.innerHTML = '<span class="g">★</span> ';
    watchBtn.appendChild(document.createTextNode('watched'));
  });
  acts.appendChild(watchBtn);

  const gotoTarget = p.fromCoords || p.atCoords[0] || null;
  if (gotoTarget) {
    const galBtn = el('button', 'oge-sp-btn');
    galBtn.innerHTML = '<span class="g">↗</span> ';
    galBtn.appendChild(document.createTextNode('galaxy'));
    galBtn.addEventListener('click', () => gotoGalaxy(gotoTarget));
    acts.appendChild(galBtn);
  }
  row.appendChild(acts);

  return row;
};

/**
 * Paint the content body + header badge from the current proximity digest.
 * Reads the live tab from the DOM (it may have been re-injected), so it is safe
 * to call after an AGR rebuild.
 * @returns {void}
 */
const render = () => {
  const tab = document.getElementById(TAB_ID);
  if (!tab) return;
  const body = tab.querySelector('.oge-sp-body');
  const badge = tab.querySelector('.oge-sp-badge');
  if (!body || !badge) return;

  const digest = digestProximityReports(proximityReportsStore.get());
  body.textContent = '';

  // Badge: same-system count in danger colour, else prober count, else nothing.
  if (digest.sameSystemCount > 0) {
    badge.textContent = String(digest.sameSystemCount);
    badge.classList.add('hot');
  } else if (digest.playerCount > 0) {
    badge.textContent = String(digest.playerCount);
    badge.classList.remove('hot');
  } else {
    badge.textContent = '';
    badge.classList.remove('hot');
  }

  if (!digest.playerCount) {
    body.appendChild(el('div', 'oge-sp-empty', 'No probes detected near your planets. 🛡'));
    return;
  }

  const sum = el('div', 'oge-sp-sum');
  const s = document.createElement('span');
  s.innerHTML = `<b>${digest.playerCount}</b> spy${digest.playerCount === 1 ? '' : ' ·'} `
    + `<b>${digest.totalReports}</b> alert${digest.totalReports === 1 ? '' : 's'}`;
  sum.appendChild(s);
  if (digest.sameSystemCount > 0) {
    sum.appendChild(document.createTextNode(' · '));
    sum.appendChild(el('span', 'hot', `${digest.sameSystemCount} in your system`));
  }
  body.appendChild(sum);

  for (const p of digest.players.slice(0, MAX_ROWS)) body.appendChild(buildRow(p));

  const foot = el('div', 'oge-sp-foot');
  foot.appendChild(el('span', 'k', '💀'));
  foot.appendChild(document.createTextNode(
    ' = a scout with a body in your system — can strike at moon/RIP speed. From alerts you opened.'));
  body.appendChild(foot);
};

/**
 * Apply the collapse state to a tab's body (display toggle).
 * @param {HTMLElement} tab
 * @returns {void}
 */
const applyOpen = (tab) => {
  const body = /** @type {HTMLElement | null} */ (tab.querySelector('.oge-sp-body'));
  if (body) body.style.display = openState ? '' : 'none';
};

/**
 * Build the tab wrapper (header strip + body). The header self-wires the
 * collapse toggle — we do NOT emit AGR's `ago-data`, so AGR never rebinds it.
 * @returns {HTMLElement}
 */
const buildTab = () => {
  const tab = el('div', undefined);
  tab.id = TAB_ID;

  const hdr = el('div', 'ago_panel_tab oge-sp-hdr');
  hdr.appendChild(el('span', 'oge-sp-eye', '👁'));
  hdr.appendChild(document.createTextNode("Who's spying"));
  hdr.appendChild(el('span', 'ago_panel_tab_info oge-sp-badge'));
  hdr.addEventListener('click', () => {
    openState = !openState;
    applyOpen(tab);
  });
  tab.appendChild(hdr);

  tab.appendChild(el('div', 'oge-sp-body'));
  applyOpen(tab);
  return tab;
};

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the Who's-spying sidebar tab. Idempotent — a second call returns the
 * same dispose fn. No-op in practice until AGR's `.ago_panel_wrapper` exists
 * (the observer picks it up when it appears).
 * @returns {() => void}
 */
export const installWhosSpyingPanel = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);

  /**
   * Build + insert the tab (before the sidebar's trailing arrow) when the
   * wrapper is present and our tab isn't already there, then render. Cheap
   * early-return when already mounted — safe to call on every body mutation.
   * @returns {void}
   */
  const inject = () => {
    if (document.getElementById(TAB_ID)) return;
    const wrapper = document.querySelector(WRAPPER_SEL);
    if (!wrapper) return;
    const tab = buildTab();
    // Slot before the trailing `.ago_panel_arrow` span (the wrapper's last
    // child); fall back to append if the arrow isn't there.
    const last = wrapper.lastElementChild;
    if (last && last.classList.contains('ago_panel_arrow')) wrapper.insertBefore(tab, last);
    else wrapper.appendChild(tab);
    render();
  };

  inject();

  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });

  // A landed alert repaints the digest; the slow poll refreshes relative ages
  // (and re-injects as a backstop if a mutation was missed).
  const unsub = proximityReportsStore.subscribe(render);
  const unsubPoll = clock.subscribe(() => {
    inject();
    render();
  }, { everyMs: POLL_MS });

  installed = {
    dispose: () => {
      observer.disconnect();
      unsub();
      unsubPoll();
      const live = document.getElementById(TAB_ID);
      if (live) live.remove();
      const style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
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
  openState = false;
};
