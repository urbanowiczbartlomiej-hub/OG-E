// @ts-check

// OG-E Dashboard — Expedition Reminders tab.
//
// Pure observability surface: shows which expedition waves currently
// have notifications queued on ntfy.sh, plus a short explainer. The
// USER-FACING CONFIG (enable toggle + ntfy access token) lives in the
// in-game OG-E settings panel; this tab deliberately holds no inputs.
// Splitting it that way means setup happens once where every other
// preference lives, and this page becomes a read-only "what's in the
// queue right now" view.
//
// Data path: the game-origin sync mirrors the last-written state +
// gist id + gist token into `chrome.storage.local` on every wave push.
// We read those mirrors here and additionally do a live `fetch`
// against the gist (using the mirrored token) so the preview is fresh
// even when the game tab hasn't synced in a while. Mirror snapshot is
// the fallback when the live fetch can't run (no token yet, offline,
// rate-limited).
//
// @see ../../sync/reminders.js — mirror keys + filename
// @see ../../sync/ntfyScheduler.js — REMINDER_COUNT / REMINDER_INTERVAL_SEC
// @see ./index.js — installReminders wired into the dashboard boot

/* global fetch */

import { chromeStore } from '../../lib/storage.js';
import {
  REMINDER_MIRROR_KEY,
  REMINDER_GIST_ID_KEY,
  REMINDER_TOKEN_KEY,
  REMINDER_NTFY_TOKEN_KEY,
  REMINDER_FILENAME_RE,
  deriveNtfyTopic,
} from '../../sync/reminders.js';
import { fetchScheduledMessages, cancelWaveReminders } from '../../sync/ntfyScheduler.js';

/**
 * @typedef {import('../../sync/reminders.js').ReminderState} ReminderState
 */

/** @type {Record<string, HTMLElement | null>} */
const el = {};

/** Idempotency — the tab is wired exactly once. */
let wired = false;

/** @param {string} id @returns {HTMLElement | null} */
const byId = (id) => document.getElementById(id);

/**
 * Wire the Reminders tab. Idempotent. Paints the initial topic +
 * preview, then re-renders whenever the game-origin sync writes a new
 * mirror snapshot.
 *
 * @returns {void}
 */
export const installReminders = () => {
  if (wired) return;
  wired = true;

  for (const id of ['remTopic', 'remCopyTopic', 'remPreview', 'remPreviewStatus', 'remRefresh']) {
    el[id] = byId(id);
  }

  el.remCopyTopic?.addEventListener('click', async () => {
    const topic = el.remTopic?.textContent || '';
    if (!topic || topic === '—') return;
    try {
      await navigator.clipboard.writeText(topic);
      const orig = el.remTopic?.textContent;
      if (el.remTopic) {
        el.remTopic.textContent = 'copied!';
        setTimeout(() => { if (el.remTopic) el.remTopic.textContent = orig ?? '—'; }, 900);
      }
    } catch {
      // Clipboard denied — user can select manually.
    }
  });

  el.remRefresh?.addEventListener('click', () => { void refreshPreview(); });

  void updateTopic();
  void refreshPreview();

  chromeStore.onChanged((changes) => {
    if (REMINDER_GIST_ID_KEY in changes) void updateTopic();
    if (REMINDER_MIRROR_KEY in changes) void refreshPreview();
  });
};

/** Recompute and paint the derived topic from the mirrored gist id. */
const updateTopic = async () => {
  const gistId = await chromeStore.get(REMINDER_GIST_ID_KEY);
  if (el.remTopic) {
    el.remTopic.textContent = typeof gistId === 'string' && gistId
      ? await deriveNtfyTopic(gistId)
      : '— (enable cloud sync in OG-E settings first)';
  }
};

/**
 * Coerce whatever lives under `REMINDER_MIRROR_KEY` into the v3 dict
 * shape `Record<universeId, ReminderState>`. v2 mirror was a plain
 * `ReminderState`; we treat that as "no data" to avoid rendering a
 * single phantom universe with the wrong id.
 *
 * @param {unknown} m
 * @returns {Record<string, ReminderState>}
 */
const coerceMirror = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  // v2 leftover detection: top-level `version` + `waves` keys.
  if ('version' in m && 'waves' in m) return {};
  return /** @type {Record<string, ReminderState>} */ (m);
};

/**
 * Fetch the gist and partition reminder files by universeId.
 * Returns one `ReminderState` per universe present in the gist.
 *
 * @param {string} gistId
 * @param {string} gistToken
 * @returns {Promise<Record<string, ReminderState>>}
 */
const fetchAllReminderStates = async (gistId, gistToken) => {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Authorization: `Bearer ${gistToken}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const gist = await res.json();
  const files = gist?.files ?? {};
  /** @type {Record<string, ReminderState>} */
  const out = {};
  for (const [filename, file] of Object.entries(files)) {
    const m = REMINDER_FILENAME_RE.exec(filename);
    if (!m) continue;
    const f = /** @type {{ content?: string }} */ (file);
    if (!f?.content) continue;
    try {
      const parsed = /** @type {ReminderState} */ (JSON.parse(f.content));
      out[m[1]] = parsed;
    } catch {
      // Skip corrupt file; next write rebuilds it.
    }
  }
  return out;
};

/**
 * Fetch all per-universe gist states + the ntfy.sh queue in parallel,
 * then render one section per universe with the same per-wave card
 * layout as before. Falls back to the chrome.storage mirror dict when
 * the live gist fetch can't run.
 */
const refreshPreview = async () => {
  setPreviewStatus('loading…', 'warn');
  const [gistId, gistToken, ntfyToken, mirrorRaw] = await Promise.all([
    chromeStore.get(REMINDER_GIST_ID_KEY),
    chromeStore.get(REMINDER_TOKEN_KEY),
    chromeStore.get(REMINDER_NTFY_TOKEN_KEY),
    chromeStore.get(REMINDER_MIRROR_KEY),
  ]);
  const mirror = coerceMirror(mirrorRaw);

  if (!gistId || !gistToken) {
    renderPreviewMulti(mirror, new Map());
    setPreviewStatus(
      Object.keys(mirror).length > 0 ? 'from last mirror (no token yet)' : 'no data yet',
      'warn',
    );
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  /** @type {Promise<Map<string, { id: string, time: number }>>} */
  const ntfyP = (async () => {
    if (typeof ntfyToken !== 'string' || !ntfyToken) return new Map();
    const topic = await deriveNtfyTopic(typeof gistId === 'string' ? gistId : '');
    if (!topic) return new Map();
    try {
      const msgs = await fetchScheduledMessages({ topic, token: ntfyToken, now: nowSec });
      return new Map(msgs.map((m) => [m.id, m]));
    } catch {
      // ntfy fetch failed (network, 401) — preview just hides the
      // "fires at" line for each wave. Not fatal.
      return new Map();
    }
  })();

  try {
    const [states, ntfyMap] = await Promise.all([
      fetchAllReminderStates(/** @type {string} */ (gistId), /** @type {string} */ (gistToken)),
      ntfyP,
    ]);

    // Orphan sweep: cancel ntfy messages that aren't claimed by ANY
    // universe in the gist. Guard skips the sweep when every universe
    // file is fresh (< 120 s old) to avoid cancelling messages that
    // were just posted but not yet PATCHed.
    let orphansCancelled = 0;
    /** @type {Set<string>} */
    const ours = new Set();
    let freshestAge = Infinity;
    for (const state of Object.values(states)) {
      for (const e of Object.values(state.notifyState || {})) {
        if (e.scheduledMessageIds) for (const id of e.scheduledMessageIds) ours.add(id);
      }
      if (state.updatedAt) {
        const age = nowSec - Math.floor(new Date(state.updatedAt).getTime() / 1000);
        if (age < freshestAge) freshestAge = age;
      }
    }
    if (
      typeof ntfyToken === 'string' && ntfyToken && ntfyMap.size > 0 &&
      Object.keys(states).length > 0 && freshestAge > 120
    ) {
      const topic = await deriveNtfyTopic(typeof gistId === 'string' ? gistId : '');
      if (topic) {
        const orphanIds = [];
        for (const id of ntfyMap.keys()) if (!ours.has(id)) orphanIds.push(id);
        if (orphanIds.length > 0) {
          orphansCancelled = await cancelWaveReminders({ ids: orphanIds, topic, token: ntfyToken });
          for (const id of orphanIds) ntfyMap.delete(id);
        }
      }
    }

    renderPreviewMulti(states, ntfyMap);
    const queued = ntfyMap.size;
    const sweepNote = orphansCancelled > 0
      ? ` · cleaned ${orphansCancelled} orphan${orphansCancelled === 1 ? '' : 's'}`
      : '';
    const universes = Object.keys(states).length;
    setPreviewStatus(
      `live · ${new Date().toLocaleTimeString()} · ${universes} universe${universes === 1 ? '' : 's'} · ${queued} message${queued === 1 ? '' : 's'} queued on ntfy${sweepNote}`,
      'ok',
    );
  } catch (err) {
    renderPreviewMulti(mirror, new Map());
    setPreviewStatus('live fetch failed (' + /** @type {Error} */ (err).message + ') — showing mirror', 'err');
  }
};

/** @param {string} text @param {'ok'|'warn'|'err'} kind */
const setPreviewStatus = (text, kind) => {
  if (!el.remPreviewStatus) return;
  el.remPreviewStatus.textContent = text;
  el.remPreviewStatus.className = 'rem-status ' + kind;
};

/**
 * Create an element with an optional class and text. All dynamic values
 * flow in through `textContent`, never markup — preview is built
 * entirely from DOM nodes with no `innerHTML` assignment (avoids the
 * AMO "unsafe innerHTML" warning).
 *
 * @param {string} tag
 * @param {{ class?: string, text?: string }} [o]
 * @returns {HTMLElement}
 */
const node = (tag, o = {}) => {
  const n = document.createElement(tag);
  if (o.class) n.className = o.class;
  if (o.text != null) n.textContent = o.text;
  return n;
};

/**
 * Render every universe's reminder state into the preview panel. One
 * section per universe (header with universeId), each containing the
 * per-wave cards. Built entirely with `document.createElement` +
 * `textContent` — no `innerHTML`.
 *
 * @param {Record<string, ReminderState>} states
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 * @returns {void}
 */
const renderPreviewMulti = (states, ntfyMap) => {
  if (!el.remPreview) return;
  const root = el.remPreview;
  root.textContent = '';

  const universeIds = Object.keys(states).sort();
  if (universeIds.length === 0) {
    const p = node('p', {
      text: 'No data yet. Enable cloud sync + reminders in OG-E settings and send an expedition.',
    });
    p.style.color = '#888';
    root.appendChild(p);
    return;
  }

  for (const universeId of universeIds) {
    const section = node('section', { class: 'rem-universe' });
    section.appendChild(node('h3', { class: 'rem-universe-head', text: universeId }));
    renderWavesInto(section, states[universeId], ntfyMap);
    root.appendChild(section);
  }
};

/**
 * Render one universe's wave cards into `section`. Extracted from the
 * old renderPreview so the multi-universe wrapper can call it once per
 * universe with no duplication.
 *
 * @param {HTMLElement} section
 * @param {ReminderState} state
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 * @returns {void}
 */
const renderWavesInto = (section, state, ntfyMap) => {
  if (!state || !Array.isArray(state.waves) || state.waves.length === 0) {
    const p = node('p', {
      text: 'No outstanding waves. Send an expedition burst in-game to queue reminders.',
    });
    p.style.color = '#888';
    section.appendChild(p);
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const notify = state.notifyState || {};
  const sorted = state.waves.slice().sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  for (const w of sorted) {
    const due = nowSec >= w.nextWaveAt;
    const ns = notify[w.id] || {};
    const ids = ns.scheduledMessageIds ?? [];
    const totalScheduled = ids.length;
    // Resolve ids → ntfy entries in the order they were scheduled (so
    // "fires at: 12:22, 12:32, ..." reads chronologically). Filter to
    // the ones ntfy still has queued — already-fired messages drop out
    // of the queue endpoint, so this count shrinks over time.
    const stillQueued = ids
      .map((id) => ntfyMap.get(id))
      .filter(/** @returns {m is { id: string, time: number }} */ (m) => Boolean(m))
      .sort((a, b) => a.time - b.time);

    const card = node('div', { class: 'rem-wave' + (due ? ' due' : '') });

    const head = node('div', { class: 'wave-head' });
    head.appendChild(node('span', {
      class: 'wave-when',
      text: new Date(w.nextWaveAt * 1000).toLocaleString(),
    }));
    head.appendChild(node('span', {
      class: 'rem-badge' + (due ? ' due' : ''),
      text: due ? 'overdue' : 'in flight',
    }));
    card.appendChild(head);

    /** @param {number} n */
    const plural = (n) => (n === 1 ? '' : 's');
    let metaText = `${w.fleetCount} expedition${plural(w.fleetCount)} · ${totalScheduled} reminder${plural(totalScheduled)} scheduled`;
    if (ntfyMap.size > 0 && totalScheduled > 0) {
      const fired = totalScheduled - stillQueued.length;
      if (fired > 0) metaText += ` (${fired} fired, ${stillQueued.length} pending)`;
      else metaText += ` (all pending)`;
    }
    card.appendChild(node('div', { class: 'wave-meta', text: metaText }));

    if (stillQueued.length > 0) {
      const timesText = stillQueued
        .map((m) => new Date(m.time * 1000).toLocaleTimeString())
        .join(', ');
      const firesAt = node('div', { class: 'wave-fires' });
      firesAt.appendChild(node('span', { text: 'Fires at: ' }));
      firesAt.appendChild(node('span', { class: 'wave-times', text: timesText }));
      card.appendChild(firesAt);
    }

    card.appendChild(node('div', {
      class: 'wave-origins',
      text: (w.origins || []).join(', '),
    }));

    section.appendChild(card);
  }
};
