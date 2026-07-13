// @ts-check
//
// Dashboard wiring for the alliance Spyglass share (IDEAS.md entry 2).
// Surfaces, all in dashboard.html:
//
//   - Sync tab (#allyShareCard): the config — alliance token + gist id +
//     "Share as" name — stored via state/allianceShare.js. Config lives HERE
//     (decided 2026-07-12), next to the personal-gist controls. Since the
//     2026-07-13 declutter the card also owns the UNION TABLE
//     (#allySharePanel, scroll-capped — it can run to hundreds of rows) and
//     its own #allySyncBtn trigger.
//   - Spyglass tab: the title-level #spyAllianceBtn (second trigger) and
//     #spyAlliancePanel, which since the declutter shows only a ONE-LINE
//     summary (members · players · synced age) — the tab must not drown in
//     a giant table it can't close; the full list lives on the Sync tab.
//
// One click = one round: build our block from local Spyglass state, fetch
// the shared file, UNION it into our block (per-player field-wise max —
// multi-device-safe, see domain/allianceIntel.mergeOwnBlock), PATCH it back,
// cache + render both surfaces. Nothing ever syncs without that click.
//
// Pulled intel is DISPLAY-ONLY: it renders in the panel and feeds nothing —
// not the danger score, not the scan plan (domain/allianceIntel.js header).
//
// All remote-sourced strings (member names, player names) render via
// textContent — never innerHTML — so a malicious alliance-mate can't inject
// markup into the dashboard.

import { chromeStore } from '../../lib/storage.js';
import {
  readAllianceShareConfig, writeAllianceShareConfig,
  readAllianceIntel, writeAllianceIntel,
  ALLIANCE_SHARE_CONFIG_KEY,
} from '../../state/allianceShare.js';
import { targetReportsKeyFor } from '../../state/targets.js';
import { activityObsKeyFor } from '../../state/activityObs.js';
import { presenceLedgerKeyFor } from '../../state/presenceLedger.js';
import { playersKeyFor } from '../../state/players.js';
import { ownProfileKeyFor } from '../../state/ownProfile.js';
import { fetchAllianceFile, writeAllianceFile, ensureAllianceGist } from '../../sync/allianceShare.js';
import {
  normalizeAllianceDoc, buildMemberBlock, mergeOwnBlock,
  summarizeAllianceIntel, memberKeyFor,
} from '../../domain/allianceIntel.js';
import { setToggleChip, wireToggleChip } from './chips.js';

/** @typedef {import('../../domain/allianceIntel.js').AllianceIntelDoc} AllianceIntelDoc */

/**
 * Element factory (textContent-only — see file header).
 * @param {string} tag
 * @param {string | null} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Compact "just now" / "5m ago" / "3h ago" / "2d ago" (module-local by
 * convention — every dashboard module keeps its own).
 * @param {number} ms  Positive age.
 * @returns {string}
 */
const formatAge = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/**
 * Same invisible-byte strip the personal token gets (gist.js sanitizeToken).
 * @param {string} raw
 * @returns {string}
 */
const sanitizeToken = (raw) => String(raw || '').replace(/[^\x21-\x7e]/g, '');

/**
 * Wire both surfaces. Call once at dashboard boot; repaint the panel for the
 * active universe via the returned `refresh` (boot + universe switch), same
 * contract as the sibling tabs.
 *
 * @param {{ getUniverseId: () => string }} host
 * @returns {{ refresh: () => void }}
 */
export const installAllianceShare = ({ getUniverseId }) => {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('spyAllianceBtn'));
  const panel = document.getElementById('spyAlliancePanel');
  const syncBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('allySyncBtn'));
  const syncPanel = document.getElementById('allySharePanel');
  const shareToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('allyShareToggle'));
  const shareBody = document.getElementById('allyShareBody');

  // Mirrors config.enabled (kept in a closure var so visibility/refresh need
  // no async read). The master toggle-chip gates EVERY surface: the Sync
  // card's body collapses and the Spyglass button + summary hide — same
  // grammar as the personal card's "Sync across devices" switch.
  let shareEnabled = false;
  const applyEnabledVisibility = () => {
    if (shareBody) shareBody.style.display = shareEnabled ? '' : 'none';
    if (btn) btn.style.display = shareEnabled ? '' : 'none';
    if (shareEnabled) {
      refresh(); // repaint both panels from cache on (re)enable
    } else {
      if (panel) { panel.hidden = true; panel.textContent = ''; }
      if (syncPanel) { syncPanel.hidden = true; syncPanel.textContent = ''; }
    }
  };
  const tokenInput = /** @type {HTMLInputElement | null} */ (document.getElementById('allyGistToken'));
  const tokenReveal = document.getElementById('allyRevealToken');
  const gistIdInput = /** @type {HTMLInputElement | null} */ (document.getElementById('allyGistId'));
  const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById('allyShareName'));
  const statusEl = document.getElementById('allyShareStatus');

  // ── Sync-tab config ────────────────────────────────────────────────

  const paintStatus = (/** @type {{ token: string, gistId: string }} */ cfg) => {
    if (!statusEl) return;
    // The token is the only REQUIRED secret — with the id blank, the first
    // Alliance click discovers the token account's alliance gist (or creates
    // one) and fills the id in itself (sync/allianceShare.ensureAllianceGist).
    const hasToken = Boolean(cfg.token.trim());
    const hasId = Boolean(cfg.gistId.trim());
    statusEl.textContent = hasToken && hasId
      ? 'Ready — sync runs from the Alliance button on the Spyglass tab.'
      : hasToken
        ? 'Ready — the first Alliance sync finds (or creates) the alliance gist and fills the id in.'
        : 'Not configured.';
    statusEl.classList.toggle('ok', hasToken);
  };

  const populate = async () => {
    const cfg = await readAllianceShareConfig();
    const active = document.activeElement;
    if (tokenInput && tokenInput !== active) tokenInput.value = cfg.token;
    if (gistIdInput && gistIdInput !== active) gistIdInput.value = cfg.gistId;
    if (nameInput && nameInput !== active) nameInput.value = cfg.shareName;
    paintStatus(cfg);
    setToggleChip(shareToggle, cfg.enabled);
    shareEnabled = cfg.enabled;
    applyEnabledVisibility();
  };
  void populate();

  wireToggleChip(shareToggle, (on) => {
    shareEnabled = on;
    void writeAllianceShareConfig({ enabled: on });
    applyEnabledVisibility();
  });

  tokenInput?.addEventListener('change', () => {
    const t = sanitizeToken(tokenInput.value.trim());
    tokenInput.value = t;
    void writeAllianceShareConfig({ token: t }).then(populate);
  });
  gistIdInput?.addEventListener('change', () => {
    const v = gistIdInput.value.trim();
    gistIdInput.value = v;
    void writeAllianceShareConfig({ gistId: v }).then(populate);
  });
  nameInput?.addEventListener('change', () => {
    const v = memberKeyFor(nameInput.value);
    nameInput.value = v;
    void writeAllianceShareConfig({ shareName: v });
  });

  // Token reveal (password ↔ text), mirroring the personal-gist eye.
  tokenReveal?.addEventListener('click', () => {
    if (!tokenInput) return;
    const reveal = tokenInput.type === 'password';
    tokenInput.type = reveal ? 'text' : 'password';
    tokenReveal.classList.toggle('revealed', reveal);
    tokenReveal.setAttribute('aria-pressed', String(reveal));
  });

  // Reflect edits made from another dashboard tab.
  chromeStore.onChanged((changes) => {
    if (ALLIANCE_SHARE_CONFIG_KEY in changes) void populate();
  });

  // ── Spyglass panel ─────────────────────────────────────────────────

  /**
   * Paint a one-line notice into the SYNC panel (progress / errors).
   * @param {HTMLElement | null} host
   * @param {string} message
   */
  const paintNotice = (host, message, isError = false) => {
    if (!host) return;
    host.hidden = false;
    host.textContent = '';
    host.appendChild(el('div', isError ? 'ally-err' : 'ally-head', message));
  };

  /**
   * Paint the Spyglass TITLE-LINE slot (.spy-ally-line rides the h1, so it's
   * plain inline text — no inner blocks). Long text ellipsizes in CSS; the
   * title attribute keeps the full sentence reachable, and the Sync panel
   * always carries the same message in full.
   * @param {string} message
   */
  const paintSpyLine = (message, isError = false) => {
    if (!panel) return;
    panel.hidden = false;
    panel.textContent = message;
    panel.title = message;
    panel.classList.toggle('err', isError);
  };

  /** @param {string} message */
  const renderNotice = (message, isError = false) => {
    paintSpyLine(message, isError);
    paintNotice(syncPanel, message, isError);
  };

  /**
   * Spyglass surface — the ONE-LINE summary on the title line (the tab must
   * not drown in a table it can't close): members · players · synced age,
   * and where the full list lives.
   * @param {AllianceIntelDoc} doc
   * @param {number} pulledAt
   */
  const renderSummary = (doc, pulledAt) => {
    const rows = summarizeAllianceIntel(doc);
    const members = Object.keys(doc.members).length;
    paintSpyLine(
      `${members} member${members === 1 ? '' : 's'} · `
      + `${rows.length} player${rows.length === 1 ? '' : 's'} · `
      + `synced ${formatAge(Date.now() - pulledAt)} · full list → Sync tab`,
    );
  };

  /**
   * Sync-tab surface — the full union table (scroll-capped in CSS; the
   * observations union can run to hundreds of rows).
   * @param {AllianceIntelDoc} doc
   * @param {number} pulledAt
   */
  const renderTable = (doc, pulledAt) => {
    if (!syncPanel) return;
    syncPanel.hidden = false;
    syncPanel.textContent = '';
    const now = Date.now();
    const rows = summarizeAllianceIntel(doc);
    const memberNames = Object.keys(doc.members).sort((a, b) => a.localeCompare(b));

    const head = el('div', 'ally-head');
    head.appendChild(el('span', null,
      `${memberNames.length} member${memberNames.length === 1 ? '' : 's'} · `
      + `${rows.length} player${rows.length === 1 ? '' : 's'} · synced ${formatAge(now - pulledAt)}`));
    // Per-member share freshness — who last contributed when.
    for (const m of memberNames) {
      const atSec = doc.members[m].updatedAtSec;
      head.appendChild(el('span', 'ally-member',
        `${m} ${atSec ? formatAge(now - atSec * 1000) : '—'}`));
    }
    syncPanel.appendChild(head);

    if (!rows.length) {
      syncPanel.appendChild(el('div', 'ally-empty',
        'No shared coverage yet — spy someone or browse their systems, then sync again.'));
      return;
    }

    const scroll = el('div', 'table-scroll');
    const table = el('table', 'ally-table');
    const thead = el('thead');
    const htr = el('tr');
    for (const h of ['Player', 'Spied', 'Seen', 'By']) htr.appendChild(el('th', null, h));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', null, row.name || `#${row.pid}`));
      tr.appendChild(el('td', null, row.lastSpySec ? formatAge(now - row.lastSpySec * 1000) : '—'));
      tr.appendChild(el('td', null, row.lastSeenSec ? formatAge(now - row.lastSeenSec * 1000) : '—'));
      tr.appendChild(el('td', 'ally-by', row.watchers.join(', ')));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    syncPanel.appendChild(scroll);
  };

  /**
   * @param {AllianceIntelDoc} doc
   * @param {number} pulledAt  Epoch-ms of the pull that produced `doc`.
   */
  const renderDoc = (doc, pulledAt) => {
    renderSummary(doc, pulledAt);
    renderTable(doc, pulledAt);
  };

  /** Repaint from the cached pull for the active universe (no network). */
  const refresh = () => {
    const uni = getUniverseId();
    const hide = () => {
      if (panel) { panel.hidden = true; panel.textContent = ''; }
      if (syncPanel) { syncPanel.hidden = true; syncPanel.textContent = ''; }
    };
    if (!uni || !shareEnabled) {
      hide();
      return;
    }
    void readAllianceIntel(uni).then((cache) => {
      if (!cache) {
        hide();
        return;
      }
      const doc = normalizeAllianceDoc(cache.doc, uni);
      if (doc) renderDoc(doc, cache.pulledAt);
      else hide();
    });
  };

  // ── The one trigger: share our block, pull everyone's ─────────────

  /** Disable/enable both triggers while a round runs. */
  const setBusy = (/** @type {boolean} */ busy) => {
    if (btn) btn.disabled = busy;
    if (syncBtn) syncBtn.disabled = busy;
  };

  const run = async () => {
    const uni = getUniverseId();
    // Disabled section → both triggers are hidden; the guard just covers a
    // stale click racing the collapse.
    if (!uni || !shareEnabled) return;
    setBusy(true);
    renderNotice('Syncing…');
    try {
      const cfg = await readAllianceShareConfig();
      const token = sanitizeToken(cfg.token);
      let gistId = cfg.gistId.trim();
      if (!token) {
        throw new Error('Not configured — set the alliance token on the Sync tab.');
      }
      let name = memberKeyFor(cfg.shareName);
      if (!name) {
        const prof = /** @type {any} */ (await chromeStore.get(ownProfileKeyFor(uni)));
        name = memberKeyFor(prof?.name);
      }
      if (!name) {
        throw new Error('No share name — set "Share as" on the Sync tab '
          + '(or open the game once so OG-E learns your player name).');
      }

      // Observations only (2026-07): the block is built from spy reports +
      // galaxy-activity rings + the long-horizon presence ledger — the watch
      // list and every Spyglass setting stay on this device
      // (domain/allianceIntel.js "privacy floor").
      const [playersRaw, reportsRaw, activityRaw, ledgersRaw] = await Promise.all([
        chromeStore.get(playersKeyFor(uni)),
        chromeStore.get(targetReportsKeyFor(uni)),
        chromeStore.get(activityObsKeyFor(uni)),
        chromeStore.get(presenceLedgerKeyFor(uni)),
      ]);
      /** @type {Record<string, string>} */
      const playerNames = {};
      if (playersRaw && typeof playersRaw === 'object') {
        for (const [pid, meta] of Object.entries(/** @type {Record<string, any>} */ (playersRaw))) {
          if (meta && typeof meta.name === 'string' && meta.name) playerNames[pid] = meta.name;
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const block = buildMemberBlock({
        playerNames,
        reports: /** @type {any} */ (reportsRaw) || {},
        activity: /** @type {any} */ (activityRaw) || {},
        ledgers: /** @type {any} */ (ledgersRaw) || {},
        nowSec,
      });

      // Blank id → discover the token account's alliance gist, or create one
      // (the id then persists to the config; `populate` mirrors it into the
      // Sync-tab input via the storage listener).
      if (!gistId) {
        renderNotice('No gist id yet — finding or creating the alliance gist…');
        const ensured = await ensureAllianceGist(token, uni);
        gistId = ensured.id;
        await writeAllianceShareConfig({ gistId });
        void populate();
      }

      /** @type {unknown} */
      let remoteRaw;
      try {
        remoteRaw = await fetchAllianceFile(token, gistId, uni);
      } catch (err) {
        // A 404 here means the EXPLICIT id is wrong (a typo, or the gist was
        // deleted). Deliberately no auto-create on this path — a mistyped id
        // must not silently fork the alliance's real file into a fresh one.
        if (err instanceof Error && /^HTTP 404\b/.test(err.message)) {
          throw new Error('Alliance gist not found (404) — fix the gist id on the Sync tab, '
            + 'or clear it and sync again to find/create one automatically.');
        }
        throw err;
      }
      const remote = normalizeAllianceDoc(remoteRaw, uni);
      if (!remote) {
        throw new Error('The alliance file uses a newer format — update OG-E first.');
      }
      const merged = mergeOwnBlock(remote, name, block, nowSec);
      await writeAllianceFile(token, gistId, uni, merged);
      const pulledAt = Date.now();
      await writeAllianceIntel(uni, merged, pulledAt);
      renderDoc(merged, pulledAt);
    } catch (err) {
      renderNotice(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  btn?.addEventListener('click', () => { void run(); });
  syncBtn?.addEventListener('click', () => { void run(); });

  return { refresh };
};
