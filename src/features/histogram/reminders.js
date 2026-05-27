// @ts-check

// Expedition-reminders tab (histogram page, extension origin).
//
// Two jobs:
//   1. Edit the GLOBAL reminder config. The config lives in
//      chrome.storage.local (see `state/reminderConfig.js`); this form is
//      its primary editor. The game-origin content script observes the
//      same key and re-pushes config into the gist, so edits here reach
//      the Worker without the user touching the game tab.
//   2. Render a friendly, live preview of the gist's `oge-reminders.json`.
//      The game side mirrors the gist id + token into chrome.storage
//      (a deliberate, approved exception to "never mirror the token" —
//      chrome.storage is extension-private). We fetch the gist directly
//      with that token so the preview reflects the Worker's latest
//      notifyState, falling back to the mirrored snapshot if the live
//      fetch can't run.
//
// @see ../../state/reminderConfig.js
// @see ../../sync/reminders.js — the mirror keys + filename

/* global fetch, navigator */

import {
  reminderConfigStore,
  initReminderConfig,
  generateNtfyTopic,
} from '../../state/reminderConfig.js';
import { chromeStore } from '../../lib/storage.js';
import {
  REMINDER_MIRROR_KEY,
  REMINDER_GIST_ID_KEY,
  REMINDER_TOKEN_KEY,
  REMINDER_FILENAME,
} from '../../sync/reminders.js';

/**
 * @typedef {import('../../sync/reminders.js').ReminderState} ReminderState
 * @typedef {import('../../state/reminderConfig.js').ReminderConfig} ReminderConfig
 */

/** @type {Record<string, HTMLElement | null>} */
const el = {};

/** Guard: true while we're writing inputs FROM the store, so the input
 * `change` handlers don't loop a store write back. */
let writingFromStore = false;

/** Idempotency — the tab is wired exactly once. */
let wired = false;

/** @param {string} id @returns {HTMLElement | null} */
const byId = (id) => document.getElementById(id);

/**
 * Wire the reminders tab. Idempotent. Hydrates the config store, binds
 * the form both ways, hooks the buttons, and paints the first preview.
 *
 * @returns {void}
 */
export const installReminders = () => {
  if (wired) return;
  wired = true;

  initReminderConfig();

  for (const id of [
    'remEnabled', 'remEvery', 'remStart', 'remEnd', 'remMax', 'remTz',
    'remTopic', 'remGenTopic', 'remSaveStatus', 'remGistId', 'remCopyGist',
    'remTokenStatus', 'remPreview', 'remPreviewStatus', 'remRefresh',
  ]) {
    el[id] = byId(id);
  }

  syncFormFromStore(reminderConfigStore.get());
  reminderConfigStore.subscribe(syncFormFromStore);

  wireInputs();
  wireButtons();

  void updateIdentity();
  void refreshPreview();

  // React to the game side mirroring fresh state / identity.
  chromeStore.onChanged((changes) => {
    if (REMINDER_GIST_ID_KEY in changes || REMINDER_TOKEN_KEY in changes) {
      void updateIdentity();
    }
    if (REMINDER_MIRROR_KEY in changes) {
      void refreshPreview();
    }
  });
};

/**
 * Push current config values into the form inputs. Wrapped in the
 * `writingFromStore` guard so the resulting input mutations don't echo
 * back into the store.
 *
 * @param {ReminderConfig} c
 * @returns {void}
 */
const syncFormFromStore = (c) => {
  writingFromStore = true;
  try {
    if (el.remEnabled) /** @type {HTMLInputElement} */ (el.remEnabled).checked = c.enabled;
    if (el.remEvery) /** @type {HTMLInputElement} */ (el.remEvery).value = String(c.reminderEveryMinutes);
    if (el.remStart) /** @type {HTMLInputElement} */ (el.remStart).value = c.allowedHours.start;
    if (el.remEnd) /** @type {HTMLInputElement} */ (el.remEnd).value = c.allowedHours.end;
    if (el.remMax) /** @type {HTMLInputElement} */ (el.remMax).value = String(c.maxNotificationsPerWave);
    if (el.remTopic) /** @type {HTMLInputElement} */ (el.remTopic).value = c.ntfyTopic;
    if (el.remTz) el.remTz.textContent = c.timezone;
  } finally {
    writingFromStore = false;
  }
};

/**
 * Read the form back into the config store. No-op while
 * `writingFromStore` is set. Non-positive / unparseable numbers fall
 * back to the store's current value so a half-typed field doesn't reset
 * to a default mid-edit.
 *
 * @returns {void}
 */
const readFormToStore = () => {
  if (writingFromStore) return;
  const prev = reminderConfigStore.get();
  /** @param {HTMLElement | null} node @param {number} fallback @returns {number} */
  const intOr = (node, fallback) => {
    const n = parseInt(/** @type {HTMLInputElement} */ (node)?.value ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  reminderConfigStore.set({
    ...prev,
    enabled: /** @type {HTMLInputElement} */ (el.remEnabled)?.checked ?? prev.enabled,
    reminderEveryMinutes: intOr(el.remEvery, prev.reminderEveryMinutes),
    maxNotificationsPerWave: intOr(el.remMax, prev.maxNotificationsPerWave),
    allowedHours: {
      start: /** @type {HTMLInputElement} */ (el.remStart)?.value || prev.allowedHours.start,
      end: /** @type {HTMLInputElement} */ (el.remEnd)?.value || prev.allowedHours.end,
    },
    ntfyTopic: /** @type {HTMLInputElement} */ (el.remTopic)?.value ?? prev.ntfyTopic,
  });
  flashSaved();
};

/** Briefly show a "Saved" confirmation next to the enable toggle. */
const flashSaved = () => {
  if (!el.remSaveStatus) return;
  el.remSaveStatus.textContent = 'Saved';
  el.remSaveStatus.className = 'rem-status ok';
  setTimeout(() => { if (el.remSaveStatus) el.remSaveStatus.textContent = ''; }, 1200);
};

/** Attach change/input listeners to every form control. */
const wireInputs = () => {
  for (const id of ['remEnabled', 'remEvery', 'remStart', 'remEnd', 'remMax', 'remTopic']) {
    el[id]?.addEventListener('change', readFormToStore);
  }
};

/** Hook the action buttons (generate topic, copy gist id, refresh). */
const wireButtons = () => {
  el.remGenTopic?.addEventListener('click', () => {
    reminderConfigStore.set({ ...reminderConfigStore.get(), ntfyTopic: generateNtfyTopic() });
    flashSaved();
  });

  el.remCopyGist?.addEventListener('click', async () => {
    const id = el.remGistId?.textContent || '';
    if (!id || id === '—') return;
    try {
      await navigator.clipboard.writeText(id);
      if (el.remGistId) {
        const orig = el.remGistId.textContent;
        el.remGistId.textContent = 'copied!';
        setTimeout(() => { if (el.remGistId) el.remGistId.textContent = orig; }, 900);
      }
    } catch {
      // Clipboard denied (focus / permissions) — user can select manually.
    }
  });

  el.remRefresh?.addEventListener('click', () => { void refreshPreview(); });
};

/**
 * Read the mirrored gist id + token (written by the game side on its
 * first wave push) and reflect them in the identity rows.
 *
 * @returns {Promise<void>}
 */
const updateIdentity = async () => {
  const [id, token] = await Promise.all([
    chromeStore.get(REMINDER_GIST_ID_KEY),
    chromeStore.get(REMINDER_TOKEN_KEY),
  ]);
  if (el.remGistId) el.remGistId.textContent = (typeof id === 'string' && id) ? id : '—';
  if (el.remTokenStatus) {
    const ok = typeof token === 'string' && token.length > 0;
    el.remTokenStatus.textContent = ok ? 'yes' : 'not yet — run a sync from the game tab';
    el.remTokenStatus.className = 'rem-status ' + (ok ? 'ok' : 'warn');
  }
};

/**
 * Fetch the gist live (via the mirrored token) and render its
 * `oge-reminders.json`. Falls back to the mirrored snapshot when the
 * live fetch can't run (no token yet, offline, rate-limited).
 *
 * @returns {Promise<void>}
 */
const refreshPreview = async () => {
  setPreviewStatus('loading…', 'warn');
  const [id, token, mirror] = await Promise.all([
    chromeStore.get(REMINDER_GIST_ID_KEY),
    chromeStore.get(REMINDER_TOKEN_KEY),
    chromeStore.get(REMINDER_MIRROR_KEY),
  ]);

  if (!id || !token) {
    renderPreview(/** @type {ReminderState | null} */ (mirror ?? null));
    setPreviewStatus(mirror ? 'from last mirror (no token yet)' : 'no data yet', 'warn');
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/gists/${id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const gist = await res.json();
    const file = gist?.files?.[REMINDER_FILENAME];
    const state = file && file.content ? JSON.parse(file.content) : null;
    renderPreview(state);
    setPreviewStatus('live · ' + new Date().toLocaleTimeString(), 'ok');
  } catch (err) {
    renderPreview(/** @type {ReminderState | null} */ (mirror ?? null));
    setPreviewStatus('live fetch failed (' + /** @type {Error} */ (err).message + ') — showing mirror', 'err');
  }
};

/** @param {string} text @param {'ok'|'warn'|'err'} kind */
const setPreviewStatus = (text, kind) => {
  if (!el.remPreviewStatus) return;
  el.remPreviewStatus.textContent = text;
  el.remPreviewStatus.className = 'rem-status ' + kind;
};

/** @param {string} s */
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

/**
 * Render the reminder state into the preview panel. Shows the config
 * block as last written, then each wave with its return time, fleet
 * count, origins, overdue badge, and the Worker's notify counters.
 *
 * @param {ReminderState | null} state
 * @returns {void}
 */
const renderPreview = (state) => {
  if (!el.remPreview) return;
  if (!state || !Array.isArray(state.waves)) {
    el.remPreview.innerHTML =
      '<p style="color:#888">No reminder data in the gist yet. Set a GitHub token + cloud sync in the game, then send your expeditions — they will appear here.</p>';
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cfg = state.config || /** @type {ReminderConfig} */ ({});
  const notify = state.notifyState || {};

  const configHtml = `
    <p style="color:#888;margin-bottom:12px">
      Config (as last written by the game tab):
      <strong style="color:${cfg.enabled ? '#5fd08a' : '#ff8888'}">${cfg.enabled ? 'enabled' : 'disabled'}</strong>,
      every ${esc(String(cfg.reminderEveryMinutes ?? '?'))} min,
      ${esc(cfg.allowedHours?.start ?? '?')}–${esc(cfg.allowedHours?.end ?? '?')} (${esc(cfg.timezone ?? '?')}),
      cap ${esc(String(cfg.maxNotificationsPerWave ?? '?'))},
      topic <code>${cfg.ntfyTopic ? esc(cfg.ntfyTopic) : '<em>not set</em>'}</code>.
    </p>`;

  if (state.waves.length === 0) {
    el.remPreview.innerHTML = configHtml +
      '<p style="color:#888">No outstanding waves right now. Send an expedition burst to create one.</p>';
    return;
  }

  const wavesHtml = state.waves
    .slice()
    .sort((a, b) => a.nextWaveAt - b.nextWaveAt)
    .map((w) => {
      const due = nowSec >= w.nextWaveAt;
      const when = new Date(w.nextWaveAt * 1000).toLocaleString();
      const ns = notify[w.id] || { notifyCount: 0, lastNotifiedAt: null };
      const last = ns.lastNotifiedAt ? new Date(ns.lastNotifiedAt * 1000).toLocaleTimeString() : '—';
      const originsShort = (w.origins || []).join(', ');
      return `
        <div class="rem-wave ${due ? 'due' : ''}">
          <div class="wave-head">
            <span class="wave-when">${esc(when)}</span>
            <span class="rem-badge ${due ? 'due' : ''}">${due ? 'overdue — re-send' : 'in flight'}</span>
          </div>
          <div class="wave-meta">${esc(String(w.fleetCount))} expeditions · pushes sent: ${esc(String(ns.notifyCount))} · last: ${esc(last)}</div>
          <div class="wave-origins">${esc(originsShort)}</div>
        </div>`;
    })
    .join('');

  el.remPreview.innerHTML = configHtml + wavesHtml;
};
