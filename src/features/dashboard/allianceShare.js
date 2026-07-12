// @ts-check
//
// Dashboard wiring for the alliance Spyglass share (IDEAS.md entry 2).
// Two surfaces, both in dashboard.html:
//
//   - Sync tab (#allyShareCard): the config — alliance token + gist id +
//     "Share as" name — stored via state/allianceShare.js. Config lives HERE
//     (decided 2026-07-12), next to the personal-gist controls.
//   - Spyglass tab: the small title-level #spyAllianceBtn — the ONLY trigger.
//     One click = one round: build our block from local Spyglass state, fetch
//     the shared file, replace our block, PATCH it back, cache + render the
//     union in #spyAlliancePanel. Nothing ever syncs without that click.
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
import { watchListKeyFor, normalizeWatchList } from '../../state/watchList.js';
import { targetReportsKeyFor } from '../../state/targets.js';
import { activityObsKeyFor } from '../../state/activityObs.js';
import { playersKeyFor } from '../../state/players.js';
import { ownProfileKeyFor } from '../../state/ownProfile.js';
import { fetchAllianceFile, writeAllianceFile } from '../../sync/allianceShare.js';
import {
  normalizeAllianceDoc, buildMemberBlock, mergeOwnBlock,
  summarizeAllianceIntel, memberKeyFor,
} from '../../domain/allianceIntel.js';
import { RELATIONSHIP_COLORS } from './mapPrimitives.js';

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
  const tokenInput = /** @type {HTMLInputElement | null} */ (document.getElementById('allyGistToken'));
  const tokenReveal = document.getElementById('allyRevealToken');
  const gistIdInput = /** @type {HTMLInputElement | null} */ (document.getElementById('allyGistId'));
  const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById('allyShareName'));
  const statusEl = document.getElementById('allyShareStatus');

  // ── Sync-tab config ────────────────────────────────────────────────

  const paintStatus = (/** @type {{ token: string, gistId: string }} */ cfg) => {
    if (!statusEl) return;
    const ready = Boolean(cfg.token.trim() && cfg.gistId.trim());
    statusEl.textContent = ready
      ? 'Ready — sync runs from the Alliance button on the Spyglass tab.'
      : 'Not configured.';
    statusEl.classList.toggle('ok', ready);
  };

  const populate = async () => {
    const cfg = await readAllianceShareConfig();
    const active = document.activeElement;
    if (tokenInput && tokenInput !== active) tokenInput.value = cfg.token;
    if (gistIdInput && gistIdInput !== active) gistIdInput.value = cfg.gistId;
    if (nameInput && nameInput !== active) nameInput.value = cfg.shareName;
    paintStatus(cfg);
  };
  void populate();

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

  /** @param {string} message */
  const renderNotice = (message, isError = false) => {
    if (!panel) return;
    panel.hidden = false;
    panel.textContent = '';
    panel.appendChild(el('div', isError ? 'ally-err' : 'ally-head', message));
  };

  /**
   * @param {AllianceIntelDoc} doc
   * @param {number} pulledAt  Epoch-ms of the pull that produced `doc`.
   */
  const renderDoc = (doc, pulledAt) => {
    if (!panel) return;
    panel.hidden = false;
    panel.textContent = '';
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
    panel.appendChild(head);

    if (!rows.length) {
      panel.appendChild(el('div', 'ally-empty',
        'No shared coverage yet — watch players on this tab, then sync again.'));
      return;
    }

    const scroll = el('div', 'table-scroll');
    const table = el('table', 'ally-table');
    const thead = el('thead');
    const htr = el('tr');
    for (const h of ['Player', 'Tag', 'Spied', 'Seen', 'By']) htr.appendChild(el('th', null, h));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', null, row.name || `#${row.pid}`));
      const tag = el('td', null, row.tag || '—');
      if (row.tag) tag.style.color = RELATIONSHIP_COLORS[row.tag] || '';
      tr.appendChild(tag);
      tr.appendChild(el('td', null, row.lastSpySec ? formatAge(now - row.lastSpySec * 1000) : '—'));
      tr.appendChild(el('td', null, row.lastSeenSec ? formatAge(now - row.lastSeenSec * 1000) : '—'));
      tr.appendChild(el('td', 'ally-by', row.watchers.join(', ')));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    panel.appendChild(scroll);
  };

  /** Repaint from the cached pull for the active universe (no network). */
  const refresh = () => {
    const uni = getUniverseId();
    if (!panel) return;
    if (!uni) {
      panel.hidden = true;
      return;
    }
    void readAllianceIntel(uni).then((cache) => {
      if (!cache) {
        panel.hidden = true;
        panel.textContent = '';
        return;
      }
      const doc = normalizeAllianceDoc(cache.doc, uni);
      if (doc) renderDoc(doc, cache.pulledAt);
      else panel.hidden = true;
    });
  };

  // ── The one trigger: share our block, pull everyone's ─────────────

  const run = async () => {
    const uni = getUniverseId();
    if (!uni || !btn) return;
    btn.disabled = true;
    renderNotice('Syncing…');
    try {
      const cfg = await readAllianceShareConfig();
      const token = sanitizeToken(cfg.token);
      const gistId = cfg.gistId.trim();
      if (!token || !gistId) {
        throw new Error('Not configured — set the alliance token and gist id on the Sync tab.');
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

      const [watchRaw, playersRaw, reportsRaw, activityRaw] = await Promise.all([
        chromeStore.get(watchListKeyFor(uni)),
        chromeStore.get(playersKeyFor(uni)),
        chromeStore.get(targetReportsKeyFor(uni)),
        chromeStore.get(activityObsKeyFor(uni)),
      ]);
      const watch = normalizeWatchList(watchRaw);
      /** @type {Record<string, string>} */
      const playerNames = {};
      if (playersRaw && typeof playersRaw === 'object') {
        for (const [pid, meta] of Object.entries(/** @type {Record<string, any>} */ (playersRaw))) {
          if (meta && typeof meta.name === 'string' && meta.name) playerNames[pid] = meta.name;
        }
      }
      const block = buildMemberBlock({
        watchedIds: watch.players,
        relationships: watch.relationships || {},
        playerNames,
        reports: /** @type {any} */ (reportsRaw) || {},
        activity: /** @type {any} */ (activityRaw) || {},
        nowSec: Math.floor(Date.now() / 1000),
      });

      const remoteRaw = await fetchAllianceFile(token, gistId, uni);
      const remote = normalizeAllianceDoc(remoteRaw, uni);
      if (!remote) {
        throw new Error('The alliance file uses a newer format — update OG-E first.');
      }
      const merged = mergeOwnBlock(remote, name, block);
      await writeAllianceFile(token, gistId, uni, merged);
      const pulledAt = Date.now();
      await writeAllianceIntel(uni, merged, pulledAt);
      renderDoc(merged, pulledAt);
    } catch (err) {
      renderNotice(err instanceof Error ? err.message : String(err), true);
    } finally {
      btn.disabled = false;
    }
  };

  btn?.addEventListener('click', () => { void run(); });

  return { refresh };
};
