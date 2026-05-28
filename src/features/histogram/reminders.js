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
  REMINDER_FILENAME,
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
 * Fetch both the gist (waves + per-wave message ids) and the ntfy.sh
 * queue (currently undelivered scheduled pushes) in parallel, then
 * cross-reference: each wave's `scheduledMessageIds` are looked up in
 * the ntfy queue so we can render exact upcoming push times. Falls
 * back to the mirrored snapshot when the live gist fetch can't run;
 * ntfy queue is best-effort (missing → "fires at —" line is omitted).
 */
const refreshPreview = async () => {
  setPreviewStatus('loading…', 'warn');
  const [gistId, gistToken, ntfyToken, mirror] = await Promise.all([
    chromeStore.get(REMINDER_GIST_ID_KEY),
    chromeStore.get(REMINDER_TOKEN_KEY),
    chromeStore.get(REMINDER_NTFY_TOKEN_KEY),
    chromeStore.get(REMINDER_MIRROR_KEY),
  ]);

  if (!gistId || !gistToken) {
    renderPreview(/** @type {ReminderState | null} */ (mirror ?? null), new Map());
    setPreviewStatus(mirror ? 'from last mirror (no token yet)' : 'no data yet', 'warn');
    return;
  }

  /** @type {Promise<ReminderState | null>} */
  const gistP = (async () => {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        Authorization: `Bearer ${gistToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const gist = await res.json();
    const file = gist?.files?.[REMINDER_FILENAME];
    return file && file.content ? JSON.parse(file.content) : null;
  })();

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
    const [state, ntfyMap] = await Promise.all([gistP, ntfyP]);

    // Orphan sweep from the dashboard side. The game-side
    // `syncReminderWaves` does the same on every wave push, but if the
    // user only ever opens the dashboard (game tab closed) the orphans
    // never get cleaned up there. So we also sweep here on Refresh.
    let orphansCancelled = 0;
    if (typeof ntfyToken === 'string' && ntfyToken && ntfyMap.size > 0 && state) {
      const topic = await deriveNtfyTopic(typeof gistId === 'string' ? gistId : '');
      if (topic) {
        const ours = new Set();
        for (const e of Object.values(state.notifyState || {})) {
          if (e.scheduledMessageIds) for (const id of e.scheduledMessageIds) ours.add(id);
        }
        const orphanIds = [];
        for (const id of ntfyMap.keys()) if (!ours.has(id)) orphanIds.push(id);
        if (orphanIds.length > 0) {
          orphansCancelled = await cancelWaveReminders({ ids: orphanIds, topic, token: ntfyToken });
          for (const id of orphanIds) ntfyMap.delete(id);
        }
      }
    }

    renderPreview(state, ntfyMap);
    const queued = ntfyMap.size;
    const sweepNote = orphansCancelled > 0 ? ` · cleaned ${orphansCancelled} orphan${orphansCancelled === 1 ? '' : 's'}` : '';
    setPreviewStatus(
      `live · ${new Date().toLocaleTimeString()} · ${queued} message${queued === 1 ? '' : 's'} queued on ntfy${sweepNote}`,
      'ok',
    );
  } catch (err) {
    renderPreview(/** @type {ReminderState | null} */ (mirror ?? null), new Map());
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
 * Render the reminder state into the preview panel. Each wave gets one
 * card: return time + queued-count badge + origins + concrete upcoming
 * push times from ntfy. Built entirely with `document.createElement` +
 * `textContent` — no `innerHTML`, so untrusted gist/ntfy content can
 * never be interpreted as markup.
 *
 * @param {ReminderState | null} state
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 *   ntfy message id → ntfy queue entry. Empty when the ntfy fetch
 *   couldn't run (no token, network error). The per-wave "Fires at:"
 *   line is omitted in that case.
 * @returns {void}
 */
const renderPreview = (state, ntfyMap) => {
  if (!el.remPreview) return;
  const root = el.remPreview;
  root.textContent = ''; // clear safely

  if (!state || !Array.isArray(state.waves) || state.waves.length === 0) {
    const p = node('p', {
      text: state
        ? 'No outstanding waves. Send an expedition burst in-game to queue reminders.'
        : 'No data yet. Enable cloud sync + reminders in OG-E settings and send an expedition.',
    });
    p.style.color = '#888';
    root.appendChild(p);
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

    root.appendChild(card);
  }
};
