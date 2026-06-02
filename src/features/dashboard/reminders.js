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
// @see ../../sync/ntfyScheduler.js — offsetsForSchedule / DEFAULT_WAVE_OFFSETS_SEC
// @see ./index.js — installReminders wired into the dashboard boot

/* global fetch */

import { chromeStore } from '../../lib/storage.js';
import {
  REMINDER_MIRROR_KEY,
  REMINDER_GIST_ID_KEY,
  REMINDER_TOKEN_KEY,
  REMINDER_NTFY_TOKEN_KEY,
  REMINDER_FILENAME_RE,
  reminderFilenameFor,
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

/**
 * Callback handed in by the host page (`features/dashboard/index.js`)
 * so the reminders tab knows which universe is currently selected in
 * the page-wide universe selector. Returns `''` when no universe has
 * been resolved yet (e.g. the dashboard just booted, before
 * `discoverUniverses` ran). The reminders tab filters its render to
 * this universe — same UX as the other tabs.
 *
 * Defaults to a stub returning `''` so calling `installReminders()`
 * without arguments stays valid for tests.
 *
 * @type {() => string}
 */
let getActiveUniverseId = () => '';

/** @param {string} id @returns {HTMLElement | null} */
const byId = (id) => document.getElementById(id);

/**
 * Wire the Reminders tab. Idempotent. Paints the initial topic +
 * preview, then re-renders whenever the game-origin sync writes a new
 * mirror snapshot.
 *
 * @param {{ getUniverseId?: () => string }} [opts]
 *   `getUniverseId` — host-provided getter for the current universe
 *   selected in the dashboard's selector. The reminders preview filters
 *   to this universe. Omit only in tests; the dashboard always passes it.
 * @returns {{ refresh: () => void }}  `refresh()` forces a re-render
 *   without re-fetching state listeners — call it from the host's
 *   universe-selector change handler.
 */
export const installReminders = (opts = {}) => {
  if (opts.getUniverseId) getActiveUniverseId = opts.getUniverseId;
  if (wired) return { refresh: () => { void refreshPreview(); } };
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
    if (REMINDER_NTFY_TOKEN_KEY in changes) void updateTopic();
    if (REMINDER_MIRROR_KEY in changes) void refreshPreview();
  });

  return { refresh: () => { void refreshPreview(); } };
};

/** Recompute and paint the derived topic from the mirrored ntfy token. */
const updateTopic = async () => {
  const ntfyToken = await chromeStore.get(REMINDER_NTFY_TOKEN_KEY);
  if (el.remTopic) {
    el.remTopic.textContent = typeof ntfyToken === 'string' && ntfyToken
      ? await deriveNtfyTopic(ntfyToken)
      : '— (set your ntfy.sh access token in OG-E settings first)';
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
 * Collect every ntfy message id that belongs to a LIVE reminder, unioned
 * across all universes and across all three reminder kinds: expedition
 * waves (`notifyState`), ad-hoc fleets (`adhocNotify`) and auto-detected
 * fleet-saves (`fleetSaveNotify`).
 *
 * The orphan sweep deletes any message on the ntfy queue that is NOT in
 * this set, so EVERY kind that schedules messages must be unioned in here.
 * Omitting a kind makes the sweep treat its live pushes as phantom orphans
 * and cancel them — exactly the bug that left fleet-save pings silently
 * torn down from the dashboard side.
 *
 * @param {Record<string, ReminderState>} states
 * @returns {Set<string>}
 */
export const collectOurMessageIds = (states) => {
  /** @type {Set<string>} */
  const ours = new Set();
  for (const state of Object.values(states)) {
    const maps = [state.notifyState, state.adhocNotify, state.fleetSaveNotify];
    for (const map of maps) {
      for (const e of Object.values(map || {})) {
        if (e?.scheduledMessageIds) for (const id of e.scheduledMessageIds) ours.add(id);
      }
    }
  }
  return ours;
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
    const topic = await deriveNtfyTopic(typeof ntfyToken === 'string' ? ntfyToken : '');
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
    const ours = collectOurMessageIds(states);
    let freshestAge = Infinity;
    for (const state of Object.values(states)) {
      if (state.updatedAt) {
        const age = nowSec - Math.floor(new Date(state.updatedAt).getTime() / 1000);
        if (age < freshestAge) freshestAge = age;
      }
    }
    if (
      typeof ntfyToken === 'string' && ntfyToken && ntfyMap.size > 0 &&
      Object.keys(states).length > 0 && freshestAge > 120
    ) {
      const topic = await deriveNtfyTopic(typeof ntfyToken === 'string' ? ntfyToken : '');
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
 * Render the active universe's reminder state into the preview panel.
 * The dashboard's universe selector controls which universe is
 * "active" via {@link getActiveUniverseId}; everything else lives in
 * the gist but is hidden here, matching how the colony / galaxy /
 * free-positions tabs only show data for the selected server.
 *
 * Built entirely with `document.createElement` + `textContent` — no
 * `innerHTML`.
 *
 * @param {Record<string, ReminderState>} states
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 * @returns {void}
 */
const renderPreviewMulti = (states, ntfyMap) => {
  if (!el.remPreview) return;
  const root = el.remPreview;
  root.textContent = '';

  const active = getActiveUniverseId();
  const universesInGist = Object.keys(states);

  if (universesInGist.length === 0) {
    const p = node('p', {
      text: 'No data yet. Enable cloud sync + reminders in OG-E settings and send an expedition.',
    });
    p.style.color = '#888';
    root.appendChild(p);
    return;
  }

  if (!active) {
    const p = node('p', {
      text: 'Pick a server in the selector above to see its expedition reminders.',
    });
    p.style.color = '#888';
    root.appendChild(p);
    return;
  }

  const state = states[active];
  if (!state) {
    const p = node('p', {
      text: `No reminder data for ${active} yet. Send an expedition burst in-game to queue reminders.`,
    });
    p.style.color = '#888';
    root.appendChild(p);
    return;
  }

  const section = node('section', { class: 'rem-universe' });
  section.appendChild(node('h3', { class: 'rem-universe-head', text: active }));
  renderWavesInto(section, active, state, ntfyMap);
  renderAdhocInto(section, active, state, ntfyMap);
  renderFleetSavesInto(section, state, ntfyMap);
  root.appendChild(section);
};

/**
 * Dashboard-side cancel of one wave: DELETE its pending ntfy messages,
 * mark the wave `cancelled: true` and zero its `scheduledMessageIds` in
 * the gist file, then re-render. Tombstone the wave (rather than removing
 * it) so the game-side `reconcileWaves` matches it across subsequent
 * scans and the cancelled flag carries forward — without it, the wave
 * would look brand-new again on the next game-side sync while its DOM
 * rows are still in the eventList, and a fresh schedule would land.
 *
 * Direct GitHub PATCH from the extension origin: we already have the
 * mirrored gist token in `chrome.storage` (same one the live preview
 * fetch uses), so we don't route through `writeReminderState` (which
 * reads the token from the game-origin `localStorage`).
 *
 * Best-effort: every failure mode is shown in the preview status line
 * and the dashboard re-renders so the user sees the current truth.
 *
 * @param {string} universeId
 * @param {string} waveId
 * @returns {Promise<void>}
 */
const cancelWaveFromDashboard = async (universeId, waveId) => {
  const [gistId, gistToken, ntfyToken] = await Promise.all([
    chromeStore.get(REMINDER_GIST_ID_KEY),
    chromeStore.get(REMINDER_TOKEN_KEY),
    chromeStore.get(REMINDER_NTFY_TOKEN_KEY),
  ]);
  if (typeof gistId !== 'string' || !gistId || typeof gistToken !== 'string' || !gistToken) {
    setPreviewStatus('cancel failed: gist not configured yet', 'err');
    return;
  }

  /** @type {Record<string, ReminderState>} */
  let states;
  try {
    states = await fetchAllReminderStates(gistId, gistToken);
  } catch (err) {
    setPreviewStatus('cancel failed: ' + /** @type {Error} */ (err).message, 'err');
    return;
  }
  const state = states[universeId];
  const wave = state?.waves?.find((w) => w.id === waveId);
  if (!state || !wave) {
    setPreviewStatus('cancel failed: wave already gone', 'warn');
    void refreshPreview();
    return;
  }

  const notify = state.notifyState || {};
  const entry = notify[waveId] || {};
  const ids = entry.scheduledMessageIds ?? [];

  if (typeof ntfyToken === 'string' && ntfyToken && ids.length > 0) {
    const topic = await deriveNtfyTopic(ntfyToken);
    if (topic) {
      try {
        await cancelWaveReminders({ ids, topic, token: ntfyToken });
      } catch {
        // Per-message DELETE failures are already swallowed inside the
        // helper; this catch is for the rare "whole call threw" path.
      }
    }
  }

  /** @type {ReminderState} */
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    waves: state.waves.map((w) => (w.id === waveId ? { ...w, cancelled: true } : w)),
    notifyState: { ...notify, [waveId]: { ...(notify[waveId] || {}), scheduledMessageIds: [] } },
  };

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${gistToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [reminderFilenameFor(universeId)]: { content: JSON.stringify(next, null, 2) },
      },
    }),
  });
  if (!res.ok) {
    setPreviewStatus(`cancel failed: gist PATCH ${res.status}`, 'err');
    void refreshPreview();
    return;
  }
  void refreshPreview();
};

/**
 * Render one universe's wave cards into `section`. Extracted from the
 * old renderPreview so the multi-universe wrapper can call it once per
 * universe with no duplication.
 *
 * @param {HTMLElement} section
 * @param {string} universeId  Which universe these waves belong to —
 *   needed so the per-card cancel button knows which gist file to PATCH.
 * @param {ReminderState} state
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 * @returns {void}
 */
const renderWavesInto = (section, universeId, state, ntfyMap) => {
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
    const cancelled = w.cancelled === true;
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

    const cardClass = 'rem-wave' + (cancelled ? ' cancelled' : due ? ' due' : '');
    const card = node('div', { class: cardClass });

    const head = node('div', { class: 'wave-head' });
    head.appendChild(node('span', {
      class: 'wave-when',
      text: new Date(w.nextWaveAt * 1000).toLocaleString(),
    }));
    const badgeText = cancelled ? 'cancelled' : due ? 'overdue' : 'in flight';
    const badgeClass = 'rem-badge' + (cancelled ? ' cancelled' : due ? ' due' : '');
    head.appendChild(node('span', { class: badgeClass, text: badgeText }));

    // Cancel button: only useful while the wave still has something to
    // tear down (pending ntfy ids the user actually wants killed). Hide
    // once it's already cancelled or no longer holds a queue.
    if (!cancelled && stillQueued.length > 0) {
      const btn = node('button', { class: 'rem-cancel', text: '×' });
      btn.setAttribute('type', 'button');
      btn.setAttribute('title', 'Cancel this wave (delete pending ntfy reminders)');
      btn.addEventListener('click', () => {
        btn.setAttribute('disabled', '');
        void cancelWaveFromDashboard(universeId, w.id);
      });
      head.appendChild(btn);
    }
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

/**
 * Render one universe's AD-HOC fleet reminders into `section`, below the
 * waves. Read-only: the cancel path lives in-game on the event-list badge
 * (a single game-side writer — a dashboard remove could be resurrected by
 * a concurrent game sync that still sees the entry, the same reason wave
 * cancel tombstones rather than deletes). Here we just surface what's
 * armed and whether ntfy still holds each ping.
 *
 * Reuses the wave card classes so the two lists look of a piece.
 *
 * @param {HTMLElement} section
 * @param {string} universeId
 * @param {ReminderState} state
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 * @returns {void}
 */
const renderAdhocInto = (section, universeId, state, ntfyMap) => {
  const entries = Array.isArray(state?.adhoc) ? state.adhoc : [];
  if (entries.length === 0) return;

  section.appendChild(node('h4', { class: 'rem-universe-head', text: 'Ad-hoc fleet reminders' }));

  const notify = state.adhocNotify || {};
  const sorted = entries.slice().sort((a, b) => a.fireAt - b.fireAt);
  for (const e of sorted) {
    const ids = notify[e.id]?.scheduledMessageIds ?? [];
    const stillQueued = ids
      .map((id) => ntfyMap.get(id))
      .filter(/** @returns {m is { id: string, time: number }} */ (m) => Boolean(m));
    const queued = stillQueued.length > 0;

    const card = node('div', { class: 'rem-wave' + (queued ? '' : ' cancelled') });

    const head = node('div', { class: 'wave-head' });
    head.appendChild(node('span', {
      class: 'wave-when',
      text: new Date(e.arrivalAt * 1000).toLocaleString(),
    }));
    const badgeText = queued ? 'queued' : (ids.length > 0 ? 'fired' : 'not scheduled');
    head.appendChild(node('span', { class: 'rem-badge' + (queued ? '' : ' cancelled'), text: badgeText }));

    // Cancel only while something is still queued to tear down. Unlike a
    // wave (DOM-derived, so tombstoned), an ad-hoc entry is intent-only and
    // never re-created from the event list, so we delete it outright.
    if (queued) {
      const btn = node('button', { class: 'rem-cancel', text: '×' });
      btn.setAttribute('type', 'button');
      btn.setAttribute('title', 'Cancel this reminder (delete the pending ntfy push)');
      btn.addEventListener('click', () => {
        btn.setAttribute('disabled', '');
        void cancelAdhocFromDashboard(universeId, e.id);
      });
      head.appendChild(btn);
    }
    card.appendChild(head);

    card.appendChild(node('div', { class: 'wave-meta', text: e.label || 'Fleet reminder' }));

    if (queued) {
      const firesAt = node('div', { class: 'wave-fires' });
      firesAt.appendChild(node('span', { text: 'Fires at: ' }));
      firesAt.appendChild(node('span', {
        class: 'wave-times',
        text: stillQueued.map((m) => new Date(m.time * 1000).toLocaleTimeString()).join(', '),
      }));
      card.appendChild(firesAt);
    }

    section.appendChild(card);
  }
};

/**
 * Render one universe's auto-detected FLEET-SAVE reminders into `section`,
 * below the ad-hoc list. Read-only BY DESIGN: a fleet-save is never armed
 * or cancelled by the player — it is auto-detected from a large outbound/
 * return leg and self-cleans the moment its event row vanishes (the fleet
 * lands or is recalled). See `domain/fleetSave.js`. So, unlike waves and
 * ad-hoc, there is deliberately NO cancel button here; the tab only
 * surfaces what's been detected and which pings ntfy still holds.
 *
 * Each fleet-save schedules a SERIES of pings (offsets relative to arrival),
 * so the card mirrors the wave layout: a "fires at" line lists every
 * still-queued slot chronologically.
 *
 * Guards on `Array.isArray(state.fleetSave)` because the dashboard's live
 * gist fetch parses files raw (no forward-normalisation), so a pre-v5 file
 * legitimately has no fleet-save block.
 *
 * @param {HTMLElement} section
 * @param {ReminderState} state
 * @param {Map<string, { id: string, time: number }>} ntfyMap
 * @returns {void}
 */
const renderFleetSavesInto = (section, state, ntfyMap) => {
  const entries = Array.isArray(state?.fleetSave) ? state.fleetSave : [];
  if (entries.length === 0) return;

  section.appendChild(node('h4', { class: 'rem-universe-head', text: 'Fleet-save reminders' }));

  const notify = state.fleetSaveNotify || {};
  const sorted = entries.slice().sort((a, b) => a.arrivalAt - b.arrivalAt);
  for (const e of sorted) {
    const ids = notify[e.id]?.scheduledMessageIds ?? [];
    const totalScheduled = ids.length;
    const stillQueued = ids
      .map((id) => ntfyMap.get(id))
      .filter(/** @returns {m is { id: string, time: number }} */ (m) => Boolean(m))
      .sort((a, b) => a.time - b.time);
    const queued = stillQueued.length > 0;

    const card = node('div', { class: 'rem-wave' + (queued ? '' : ' cancelled') });

    const head = node('div', { class: 'wave-head' });
    head.appendChild(node('span', {
      class: 'wave-when',
      text: new Date(e.arrivalAt * 1000).toLocaleString(),
    }));
    const badgeText = queued ? 'queued' : (totalScheduled > 0 ? 'fired' : 'not scheduled');
    head.appendChild(node('span', { class: 'rem-badge' + (queued ? '' : ' cancelled'), text: badgeText }));
    card.appendChild(head);

    /** @param {number} n */
    const plural = (n) => (n === 1 ? '' : 's');
    let metaText = e.label || 'Fleet save';
    if (Number.isFinite(e.shipCount)) metaText += ` · ${e.shipCount} ship${plural(e.shipCount)}`;
    if (totalScheduled > 0) {
      metaText += ` · ${totalScheduled} reminder${plural(totalScheduled)} scheduled`;
      if (ntfyMap.size > 0) {
        const fired = totalScheduled - stillQueued.length;
        metaText += fired > 0 ? ` (${fired} fired, ${stillQueued.length} pending)` : ' (all pending)';
      }
    }
    card.appendChild(node('div', { class: 'wave-meta', text: metaText }));

    if (queued) {
      const firesAt = node('div', { class: 'wave-fires' });
      firesAt.appendChild(node('span', { text: 'Fires at: ' }));
      firesAt.appendChild(node('span', {
        class: 'wave-times',
        text: stillQueued.map((m) => new Date(m.time * 1000).toLocaleTimeString()).join(', '),
      }));
      card.appendChild(firesAt);
    }

    section.appendChild(card);
  }
};

/**
 * Dashboard-side cancel of one ad-hoc reminder: DELETE its pending ntfy
 * messages, then REMOVE the entry from `adhoc` + `adhocNotify` and PATCH
 * the gist. Unlike a wave we delete rather than tombstone — an ad-hoc
 * entry is only ever created by an explicit in-game arm (never derived
 * from the event list), so a concurrent game-side sync won't re-create it.
 *
 * @param {string} universeId
 * @param {string} entryId
 * @returns {Promise<void>}
 */
const cancelAdhocFromDashboard = async (universeId, entryId) => {
  const [gistId, gistToken, ntfyToken] = await Promise.all([
    chromeStore.get(REMINDER_GIST_ID_KEY),
    chromeStore.get(REMINDER_TOKEN_KEY),
    chromeStore.get(REMINDER_NTFY_TOKEN_KEY),
  ]);
  if (typeof gistId !== 'string' || !gistId || typeof gistToken !== 'string' || !gistToken) {
    setPreviewStatus('cancel failed: gist not configured yet', 'err');
    return;
  }

  /** @type {Record<string, ReminderState>} */
  let states;
  try {
    states = await fetchAllReminderStates(gistId, gistToken);
  } catch (err) {
    setPreviewStatus('cancel failed: ' + /** @type {Error} */ (err).message, 'err');
    return;
  }
  const state = states[universeId];
  const entry = state?.adhoc?.find((e) => e.id === entryId);
  if (!state || !entry) {
    setPreviewStatus('cancel failed: reminder already gone', 'warn');
    void refreshPreview();
    return;
  }

  const notify = state.adhocNotify || {};
  const ids = notify[entryId]?.scheduledMessageIds ?? [];
  if (typeof ntfyToken === 'string' && ntfyToken && ids.length > 0) {
    const topic = await deriveNtfyTopic(ntfyToken);
    if (topic) {
      try {
        await cancelWaveReminders({ ids, topic, token: ntfyToken });
      } catch {
        // Per-message DELETE failures are swallowed inside the helper.
      }
    }
  }

  const nextNotify = { ...notify };
  delete nextNotify[entryId];
  /** @type {ReminderState} */
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    adhoc: state.adhoc.filter((e) => e.id !== entryId),
    adhocNotify: nextNotify,
  };

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${gistToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [reminderFilenameFor(universeId)]: { content: JSON.stringify(next, null, 2) },
      },
    }),
  });
  if (!res.ok) {
    setPreviewStatus(`cancel failed: gist PATCH ${res.status}`, 'err');
    void refreshPreview();
    return;
  }
  void refreshPreview();
};
