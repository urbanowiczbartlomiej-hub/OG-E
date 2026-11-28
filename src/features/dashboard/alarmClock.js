// @ts-check

// OG-E Dashboard — Expedition AlarmClock tab.
//
// Pure observability surface: shows which expedition waves currently
// have notifications queued on ntfy.sh, plus a short explainer. The
// USER-FACING CONFIG (enable toggle + ntfy access token) lives in the
// in-game OG-E settings panel; this tab deliberately holds no inputs.
// Splitting it that way means setup happens once where every other
// preference lives, and this page becomes a read-only "what's in the
// queue right now" view.
//
// Data path: the ntfy queue is the shared reminder state
// (docs/ntfy-queue-plan.md). The game side converges it on every sync and
// mirrors what it did (per universe) into `chrome.storage.local`; this tab
// renders that mirror against a live poll of the queue. No GitHub involved.
//
// @see ../../sync/alarmClock.js — mirror keys + filename
// @see ../../sync/ntfyReconciler.js — offsetsForSchedule / DEFAULT_WAVE_OFFSETS_SEC
// @see ./index.js — installAlarmClock wired into the dashboard boot

import { chromeStore } from '../../lib/storage.js';
import {
  ALARM_CLOCK_MIRROR_KEY,
  ALARM_CLOCK_NTFY_TOKEN_KEY,
  deriveNtfyTopic,
  maskTopic,
} from '../../sync/alarmClock.js';
import {
  fetchScheduledMessages,
  cancelWaveAlarmClock,
  guardianTitleFor,
  NTFY_MAX_DELAY_SEC,
} from '../../sync/ntfyReconciler.js';
import { alarmClockBadge } from '../../domain/alarmClockBadge.js';
import { alarmClockConfigKeyFor } from '../../state/alarmClockConfig.js';
import { galaxyScanConfigKeyFor } from '../../state/galaxyScanConfig.js';
import { normalizeAlarmClockConfig } from '../../domain/alarmClockConfig.js';
import { normalizeGalaxyScanConfig } from '../../domain/galaxyScanConfig.js';

/**
 * Which kinds are switched ON for the selected server. The preview lists what
 * was DETECTED in-game, which is independent of whether reminders are set for
 * it — so a card for a switched-off kind needs to say "reminders off" rather
 * than the bare "not set" that reads as a fault in OG-E.
 *
 * @typedef {{ waveOn: boolean, fsOn: boolean }} KindFlags
 */

/**
 * Read the selected server's per-kind master switches. Defaults to ON when no
 * server is selected: claiming "reminders off" without having read the config
 * would be a lie in the one direction that matters.
 *
 * @returns {Promise<KindFlags>}
 */
const readKindFlags = async () => {
  const uni = getActiveUniverseId();
  if (!uni) return { waveOn: true, fsOn: true };
  const [rc, gs] = await Promise.all([
    chromeStore.get(alarmClockConfigKeyFor(uni)),
    chromeStore.get(galaxyScanConfigKeyFor(uni)),
  ]);
  return {
    waveOn: normalizeAlarmClockConfig(rc).alarmClockEnabled,
    fsOn: normalizeGalaxyScanConfig(gs).fsEnabled,
  };
};

/**
 * @typedef {import('../../sync/alarmClock.js').AlarmClockState} AlarmClockState
 */

/** @type {Record<string, HTMLElement | null>} */
const el = {};

/** Idempotency — the tab is wired exactly once. */
let wired = false;

/**
 * The real derived topic (a capability secret). Held here so the copy + reveal
 * controls always read the true value, never the (possibly masked or
 * "Copied!"-flashed) DOM text. `''` means "no token set yet".
 */
let currentTopic = '';

/** Whether the topic is currently shown in full (false ⇒ masked behind ••••). */
let topicRevealed = false;

/** Pending "Copied!" → "Copy" button-label restore, so re-clicks can reset it. */
let copyResetTimer = 0;

/** Unsubscribe for the chrome.storage change listener wired in installAlarmClock. */
let unsubscribeStorage = () => {};

/** Shown in the topic slot before any ntfy token is configured. */
const NO_TOPIC_TEXT = '— (set your ntfy.sh access token above first)';

/**
 * Callback handed in by the host page (`features/dashboard/index.js`)
 * so the alarmClock tab knows which universe is currently selected in
 * the page-wide universe selector. Returns `''` when no universe has
 * been resolved yet (e.g. the dashboard just booted, before
 * `discoverUniverses` ran). The alarmClock tab filters its render to
 * this universe — same UX as the other tabs.
 *
 * Defaults to a stub returning `''` so calling `installAlarmClock()`
 * without arguments stays valid for tests.
 *
 * @type {() => string}
 */
let getActiveUniverseId = () => '';

/** @param {string} id @returns {HTMLElement | null} */
const byId = (id) => document.getElementById(id);

/**
 * Wire the AlarmClock tab. Idempotent. Paints the initial topic +
 * preview, then re-renders whenever the game-origin sync writes a new
 * mirror snapshot.
 *
 * @param {{ getUniverseId?: () => string }} [opts]
 *   `getUniverseId` — host-provided getter for the current universe
 *   selected in the dashboard's selector. The alarmClock preview filters
 *   to this universe. Omit only in tests; the dashboard always passes it.
 * @returns {{ refresh: () => void }}  `refresh()` forces a re-render
 *   without re-fetching state listeners — call it from the host's
 *   universe-selector change handler.
 */
export const installAlarmClock = (opts = {}) => {
  if (opts.getUniverseId) getActiveUniverseId = opts.getUniverseId;
  if (wired) return { refresh: () => { void refreshPreview(); } };
  wired = true;

  for (const id of [
    'remTopic', 'remRevealTopic', 'remCopyTopic',
    'remPreview', 'remPreviewStatus', 'remRefresh',
  ]) {
    el[id] = byId(id);
  }

  // Reveal/hide toggle — the topic is a secret, so it renders masked by
  // default and this flips it. Copy still works while masked (it reads the
  // real value, not the display text), so revealing is purely for eyeballing.
  el.remRevealTopic?.addEventListener('click', () => {
    if (!currentTopic) return;
    topicRevealed = !topicRevealed;
    renderTopic();
  });

  el.remCopyTopic?.addEventListener('click', async () => {
    // Always copy the REAL topic, never the on-screen text — that's what made
    // a double-click stick on "Copied!" before (it re-copied the flash label).
    if (!currentTopic) return;
    const btn = /** @type {HTMLButtonElement} */ (el.remCopyTopic);
    let ok = true;
    try {
      await navigator.clipboard.writeText(currentTopic);
    } catch {
      ok = false;
    }
    // Feedback lives on the BUTTON, leaving the topic slot untouched. A single
    // shared timer means rapid clicks just reset the countdown, never corrupt
    // the label.
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    if (!ok) {
      // Clipboard blocked (denied / insecure context) — reveal so the user can
      // select the value and copy by hand.
      topicRevealed = true;
      renderTopic();
    }
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      btn.textContent = 'Copy';
      copyResetTimer = 0;
    }, 1200);
  });

  el.remRefresh?.addEventListener('click', () => { void refreshPreview(); });

  void updateTopic();
  void refreshPreview();

  unsubscribeStorage = chromeStore.onChanged((changes) => {
    if (ALARM_CLOCK_NTFY_TOKEN_KEY in changes) void updateTopic();
    if (ALARM_CLOCK_MIRROR_KEY in changes) void refreshPreview();
    // The per-kind master switches decide between the "reminders off" and
    // "not set" badges, so flipping one on the Expeditions / Fleet-save tab
    // has to repaint this list too — otherwise the preview keeps blaming
    // OG-E for a reminder the user just enabled (or vice versa).
    const uni = getActiveUniverseId();
    if (uni && (alarmClockConfigKeyFor(uni) in changes || galaxyScanConfigKeyFor(uni) in changes)) {
      void refreshPreview();
    }
  });

  return { refresh: () => { void refreshPreview(); } };
};

/**
 * Paint the topic slot + its reveal/copy buttons from {@link currentTopic} and
 * {@link topicRevealed}. The slot shows the masked form (or full, when
 * revealed); both buttons grey out until a topic exists.
 */
const renderTopic = () => {
  const has = Boolean(currentTopic);
  if (el.remTopic) {
    el.remTopic.textContent = !has
      ? NO_TOPIC_TEXT
      : topicRevealed ? currentTopic : maskTopic(currentTopic);
  }
  if (el.remRevealTopic) {
    const btn = /** @type {HTMLButtonElement} */ (el.remRevealTopic);
    btn.disabled = !has;
    btn.classList.toggle('revealed', topicRevealed);
    const action = topicRevealed ? 'Hide topic' : 'Show topic';
    btn.title = action;
    btn.setAttribute('aria-label', action);
    btn.setAttribute('aria-pressed', String(topicRevealed));
  }
  if (el.remCopyTopic) {
    /** @type {HTMLButtonElement} */ (el.remCopyTopic).disabled = !has;
  }
};

/** Recompute the derived topic from the mirrored ntfy token, then repaint. */
const updateTopic = async () => {
  const ntfyToken = await chromeStore.get(ALARM_CLOCK_NTFY_TOKEN_KEY);
  currentTopic = typeof ntfyToken === 'string' && ntfyToken
    ? await deriveNtfyTopic(ntfyToken)
    : '';
  // A token change re-masks (don't keep a previous token's value revealed).
  topicRevealed = false;
  renderTopic();
};

/**
 * Coerce whatever lives under `ALARM_CLOCK_MIRROR_KEY` into the v3 dict
 * shape `Record<universeId, AlarmClockState>`. v2 mirror was a plain
 * `AlarmClockState`; we treat that as "no data" to avoid rendering a
 * single phantom universe with the wrong id.
 *
 * @param {unknown} m
 * @returns {Record<string, AlarmClockState>}
 */
const coerceMirror = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  // v2 leftover detection: top-level `version` + `waves` keys.
  if ('version' in m && 'waves' in m) return {};
  return /** @type {Record<string, AlarmClockState>} */ (m);
};

/**
 * Collect every ntfy message id that belongs to a LIVE alarmClock, unioned
 * across all universes and across all three alarmClock kinds: expedition
 * waves (`notifyState`), ad-hoc fleets (`adhocNotify`) and auto-detected
 * fleet-saves (`fleetSaveNotify`).
 *
 * The orphan sweep deletes any message on the ntfy queue that is NOT in
 * this set, so EVERY kind that schedules messages must be unioned in here.
 * Omitting a kind makes the sweep treat its live pushes as phantom orphans
 * and cancel them — exactly the bug that left fleet-save pings silently
 * torn down from the dashboard side.
 *
 * @param {Record<string, AlarmClockState>} states
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
 * Whether a fleet-save is "too far out": nothing has been scheduled on ntfy
 * for it yet AND every upcoming fire time is still beyond ntfy's 3-day cap
 * ({@link NTFY_MAX_DELAY_SEC}). That's a deferred-not-failed state — the queue
 * fills automatically once the fleet comes within 3 days of landing — so the
 * badge says "> 3 days out" rather than the bare "not scheduled". Pure; the
 * `fireAts` fallback to `arrivalAt` covers pre-v5 gist files that lack it.
 *
 * @param {{ fireAts?: number[], arrivalAt?: number }} fs
 * @param {number} scheduledCount  ntfy messages already scheduled for this save.
 * @param {number} nowSec
 * @returns {boolean}
 */
export const isFleetSaveTooFarOut = (fs, scheduledCount, nowSec) => {
  if (scheduledCount > 0) return false;
  const upcoming = (Array.isArray(fs.fireAts) ? fs.fireAts : []).filter(
    (t) => Number.isFinite(t) && t > nowSec,
  );
  const earliest = upcoming.length
    ? Math.min(...upcoming)
    : (Number.isFinite(fs.arrivalAt) ? /** @type {number} */ (fs.arrivalAt) : Infinity);
  return earliest > nowSec + NTFY_MAX_DELAY_SEC;
};

/**
 * Render the per-universe reminder state the game side mirrors into
 * chrome.storage on every sync, against the live ntfy queue.
 *
 * The ntfy queue is the shared state (docs/ntfy-queue-plan.md): the game side
 * reads it, converges it and mirrors what it did here. The dashboard no longer
 * reads the GitHub gist and no longer sweeps "orphans" — any device may own a
 * queued message, and only the game side (which sees the event list) can tell
 * when one is provably over.
 */
const refreshPreview = async () => {
  setPreviewStatus('loading…', 'warn');
  const [ntfyToken, mirrorRaw, flags] = await Promise.all([
    chromeStore.get(ALARM_CLOCK_NTFY_TOKEN_KEY),
    chromeStore.get(ALARM_CLOCK_MIRROR_KEY),
    readKindFlags(),
  ]);
  const states = coerceMirror(mirrorRaw);
  if (typeof ntfyToken !== 'string' || !ntfyToken) {
    renderPreviewMulti(states, new Map(), flags);
    setPreviewStatus(
      Object.keys(states).length > 0 ? 'from last mirror (no ntfy token yet)' : 'no data yet — set the ntfy token and open the game',
      'warn',
    );
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const topic = await deriveNtfyTopic(ntfyToken);
    /** @type {Map<string, { id: string, time: number, message?: string, title?: string }>} */
    const ntfyMap = new Map();
    if (topic) {
      const msgs = await fetchScheduledMessages({ topic, token: ntfyToken, now: nowSec });
      for (const m of msgs) ntfyMap.set(m.id, m);
    }
    renderPreviewMulti(states, ntfyMap, flags);
    // Scope the count to the SELECTED server (which is all the preview shows).
    // The ntfy topic is shared across the account's universes, so the whole
    // queue size would over-report what THIS server actually has pending.
    const active = getActiveUniverseId();
    const activeState = active ? states[active] : null;
    let queued = 0;
    if (activeState) {
      const ids = collectOurMessageIds({ [active]: activeState });
      for (const id of ids) if (ntfyMap.has(id)) queued += 1;
    }
    setPreviewStatus(`as of ${new Date().toLocaleTimeString()} · ${queued} reminder${queued === 1 ? '' : 's'} set`, 'ok');
  } catch (err) {
    renderPreviewMulti(states, new Map(), flags);
    setPreviewStatus(`couldn't refresh (${/** @type {Error} */ (err).message}) — showing last known`, 'err');
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
 * Render the active universe's alarmClock state into the preview panel.
 * The dashboard's universe selector controls which universe is
 * "active" via {@link getActiveUniverseId}; everything else lives in
 * the gist but is hidden here, matching how the colony / galaxy /
 * free-positions tabs only show data for the selected server.
 *
 * Built entirely with `document.createElement` + `textContent` — no
 * `innerHTML`.
 *
 * @param {Record<string, AlarmClockState>} states
 * @param {Map<string, { id: string, time: number, message?: string }>} ntfyMap
 * @param {KindFlags} [flags]  Per-kind master switches for the selected server
 *   (defaults to all-on, so a caller that can't read them never claims "off").
 * @returns {void}
 */
const renderPreviewMulti = (states, ntfyMap, flags = { waveOn: true, fsOn: true }) => {
  if (!el.remPreview) return;
  const root = el.remPreview;
  root.textContent = '';

  const active = getActiveUniverseId();
  const universesInGist = Object.keys(states);

  if (universesInGist.length === 0) {
    const p = node('p', {
      text: 'No reminders yet. Turn on the alarm clock, set the ntfy token and open the game.',
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
      text: `No reminders for ${active} yet. Send an expedition burst in-game to set reminders.`,
    });
    p.style.color = '#888';
    root.appendChild(p);
    return;
  }

  const section = node('section', { class: 'rem-universe' });
  // Server name intentionally omitted — it's already shown (and chosen) in the
  // page-wide Server selector at the top of the page; repeating it is noise.
  renderWavesInto(section, active, state, ntfyMap, flags.waveOn);
  renderAdhocInto(section, active, state, ntfyMap);
  renderFleetSavesInto(section, state, ntfyMap, flags.fsOn);
  renderGuardianInto(section, active, ntfyMap);

  // ONE list: every kind's cards in the order the phone will ring, each
  // tagged with its kind. The per-kind renderers above still build the cards
  // (and their headings / notes, which the single list has no use for).
  const cards = /** @type {HTMLElement[]} */ ([...section.querySelectorAll('.rem-wave')]);
  cards.sort((a, b) => Number(a.dataset.when) - Number(b.dataset.when));
  paintKindCounts(cards);
  if (cards.length === 0) {
    const p = node('p', { text: 'Nothing set. Reminders appear here as fleets fly.' });
    p.style.color = '#888';
    root.appendChild(p);
    return;
  }
  const list = node('div', { class: 'rem-list' });
  list.append(...cards);
  root.appendChild(list);
};

/**
 * Stamp "N set" onto each kind's tile (`[data-kind-count]` in the top block).
 * Landed-fleet pushes count under Fleet-save — that is where their settings
 * live. Cancelled / nothing-queued cards don't count.
 *
 * @param {HTMLElement[]} cards
 * @returns {void}
 */
const paintKindCounts = (cards) => {
  const n = { adhoc: 0, fs: 0, expo: 0 };
  for (const c of cards) {
    if (c.classList.contains('cancelled')) continue;
    const k = c.dataset.kind;
    if (k === 'ad') n.adhoc++;
    else if (k === 'wv') n.expo++;
    else n.fs++;
  }
  for (const [kind, count] of Object.entries(n)) {
    const slot = document.querySelector(`[data-kind-count="${kind}"]`);
    if (slot) slot.textContent = count ? `${count} set` : '';
  }
};

/**
 * Apply a dashboard-side cancel: DELETE the given ntfy messages, then update
 * this universe's entry in the chrome.storage mirror — which is also the game
 * side's device-local alarm-clock state (`sync/alarmClock.readLocalAlarmClock`),
 * so the change sticks on THIS device. The ntfy queue is the shared state
 * (docs/ntfy-queue-plan.md); another device that still sees a reason for the
 * series may re-create it (accepted: better a ring too many than none).
 *
 * @param {string} universeId
 * @param {string[]} ids  ntfy message ids to cancel.
 * @param {(state: AlarmClockState) => AlarmClockState} mutate  Mirror update.
 * @returns {Promise<void>}
 */
const cancelInQueueAndMirror = async (universeId, ids, mutate) => {
  const [ntfyToken, mirrorRaw] = await Promise.all([
    chromeStore.get(ALARM_CLOCK_NTFY_TOKEN_KEY),
    chromeStore.get(ALARM_CLOCK_MIRROR_KEY),
  ]);
  if (typeof ntfyToken === 'string' && ntfyToken && ids.length > 0) {
    const topic = await deriveNtfyTopic(ntfyToken);
    if (topic) {
      try {
        await cancelWaveAlarmClock({ ids, topic, token: ntfyToken });
      } catch {
        // Per-message DELETE failures are swallowed inside the helper.
      }
    }
  }
  const dict = coerceMirror(mirrorRaw);
  const state = dict[universeId];
  if (state) {
    try {
      await chromeStore.set(ALARM_CLOCK_MIRROR_KEY, { ...dict, [universeId]: mutate(state) });
    } catch (err) {
      setPreviewStatus('cancel failed: ' + /** @type {Error} */ (err).message, 'err');
    }
  }
  void refreshPreview();
};

/**
 * Dashboard-side cancel of one expedition wave: DELETE its queued ntfy
 * messages and TOMBSTONE the wave (`cancelled: true`) in this device's local
 * state, so the game side's `reconcileWaves` carries the flag forward instead
 * of re-scheduling the wave while its rows are still in the event list.
 *
 * @param {string} universeId
 * @param {string} waveId
 * @returns {Promise<void>}
 */
const cancelWaveFromDashboard = async (universeId, waveId) => {
  const dict = coerceMirror(await chromeStore.get(ALARM_CLOCK_MIRROR_KEY));
  const state = dict[universeId];
  if (!state?.waves?.some((w) => w.id === waveId)) {
    setPreviewStatus('cancel failed: wave already gone', 'warn');
    void refreshPreview();
    return;
  }
  const ids = state.notifyState?.[waveId]?.scheduledMessageIds ?? [];
  await cancelInQueueAndMirror(universeId, ids, (st) => ({
    ...st,
    updatedAt: new Date().toISOString(),
    waves: st.waves.map((w) => (w.id === waveId ? { ...w, cancelled: true } : w)),
    notifyState: { ...st.notifyState, [waveId]: { ...(st.notifyState?.[waveId] || {}), scheduledMessageIds: [] } },
  }));
};

/** Short kind tag shown on every card of the unified list. */
const KIND_LABEL = { wv: 'Expedition', ad: 'Ad-hoc', fs: 'Fleet-save', fr: 'Landed fleet' };

/**
 * Build the shared alarmClock-card shell: a `rem-wave` card plus its head with
 * the formatted arrival/fire time. Each render function appends its own badge,
 * cancel button, and meta after this.
 *
 * @param {number} whenSec  Epoch-seconds shown as the card's "when".
 * @param {string} cardClass  Full class string (callers vary the modifier).
 * @param {'wv' | 'ad' | 'fs' | 'fr'} kind  Which reminder kind — the card's tag,
 *   and what the unified list sorts / counts by.
 * @returns {{ card: HTMLElement, head: HTMLElement }}
 */
const buildAlarmClockCard = (whenSec, cardClass, kind) => {
  const card = node('div', { class: cardClass });
  card.dataset.when = String(whenSec);
  card.dataset.kind = kind;
  const head = node('div', { class: 'wave-head' });
  head.appendChild(node('span', { class: `rem-kind ${kind}`, text: KIND_LABEL[kind] }));
  head.appendChild(node('span', {
    class: 'wave-when',
    text: new Date(whenSec * 1000).toLocaleString(),
  }));
  return { card, head };
};

/**
 * Append the "Fires at" line listing every still-queued ping in chronological
 * order. No-op when nothing is queued (shared by all three alarmClock lists).
 *
 * When ntfy hands back the message body for the queued slots (it does for
 * scheduled-but-unfired pushes — see {@link fetchScheduledMessages}) we render
 * one `hh:mm — <exact message>` row per ping, so the user sees the precise text
 * that was registered (and how it differs slot-to-slot via `{index}`/`{offset}`
 * wildcards). With no bodies available (already fired / queued elsewhere) we
 * fall back to the compact comma-joined times.
 *
 * @param {HTMLElement} card
 * @param {Array<{ id: string, time: number, message?: string }>} stillQueued
 * @returns {void}
 */
const appendFiresAtLine = (card, stillQueued) => {
  if (stillQueued.length === 0) return;
  const firesAt = node('div', { class: 'wave-fires' });

  const haveMessages = stillQueued.some((m) => Boolean(m.message));
  if (!haveMessages) {
    firesAt.appendChild(node('span', { text: 'Rings at: ' }));
    firesAt.appendChild(node('span', {
      class: 'wave-times',
      text: stillQueued.map((m) => new Date(m.time * 1000).toLocaleTimeString()).join(', '),
    }));
    card.appendChild(firesAt);
    return;
  }

  firesAt.appendChild(node('span', { text: 'Rings at:' }));
  const list = node('ul', { class: 'wave-msg-list' });
  for (const m of stillQueued) {
    const li = node('li', { class: 'wave-msg-row' });
    li.appendChild(node('span', {
      class: 'wave-times',
      text: new Date(m.time * 1000).toLocaleTimeString(),
    }));
    if (m.message) li.appendChild(node('span', { class: 'wave-msg', text: ' — ' + m.message }));
    list.appendChild(li);
  }
  firesAt.appendChild(list);
  card.appendChild(firesAt);
};

/**
 * Shared open for every per-universe alarmClock list (waves / ad-hoc / fleet-save
 * / guardian). They all start the same way: bail when there are no items —
 * appending a muted note first when one is given — otherwise append the
 * standard `rem-universe-head` heading. Each list then loops `items` itself, as
 * the per-item card differs by kind.
 *
 * @param {HTMLElement} section
 * @param {readonly unknown[]} items   Already-sorted entries for this list.
 * @param {string} title               Heading text.
 * @param {string} [emptyMessage]      Muted note shown when there are no items (omit for a silent skip).
 * @param {string} [offNote]           Muted note under the heading, explaining
 *   ONCE that this kind is switched off — the per-card "reminders off" badges
 *   say WHAT, this says where to fix it, without repeating itself per card.
 * @returns {boolean}  `true` when the heading was appended and the caller should render `items`.
 */
const beginAlarmClockSection = (section, items, title, emptyMessage, offNote) => {
  if (items.length === 0) {
    if (emptyMessage) {
      const p = node('p', { text: emptyMessage });
      p.style.color = '#888';
      section.appendChild(p);
    }
    return false;
  }
  section.appendChild(node('h4', { class: 'rem-universe-head', text: title }));
  if (offNote) {
    const p = node('p', { class: 'rem-off-note', text: offNote });
    section.appendChild(p);
  }
  return true;
};

/**
 * Render one universe's wave cards into `section`. Extracted from the
 * old renderPreview so the multi-universe wrapper can call it once per
 * universe with no duplication.
 *
 * @param {HTMLElement} section
 * @param {string} universeId  Which universe these waves belong to —
 *   needed so the per-card cancel button knows which gist file to PATCH.
 * @param {AlarmClockState} state
 * @param {Map<string, { id: string, time: number, message?: string }>} ntfyMap
 * @param {boolean} [kindOn]  Whether expedition reminders are switched on for
 *   this server — a detected wave with nothing set reads very differently
 *   depending on the answer.
 * @returns {void}
 */
const renderWavesInto = (section, universeId, state, ntfyMap, kindOn = true) => {
  const sorted = (Array.isArray(state?.waves) ? state.waves : [])
    .slice()
    .sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  if (!beginAlarmClockSection(section, sorted, 'Expedition waves',
    'No reminders set. Send an expedition burst in-game to set reminders.',
    kindOn ? undefined : 'Expedition reminders are switched off (Expeditions tab). These waves were detected in-game — nothing will ring for them.')) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const notify = state.notifyState || {};
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
      .filter(/** @returns {m is { id: string, time: number, message?: string }} */ (m) => Boolean(m))
      .sort((a, b) => a.time - b.time);

    const cardClass = 'rem-wave' + (cancelled ? ' cancelled' : due ? ' due' : '');
    const { card, head } = buildAlarmClockCard(w.nextWaveAt, cardClass, 'wv');
    const badge = alarmClockBadge({
      cancelled,
      scheduledCount: totalScheduled,
      pendingCount: stillQueued.length,
      hasNtfyData: ntfyMap.size > 0,
      kindOff: !kindOn,
    });
    head.appendChild(node('span', { class: 'rem-badge ' + badge.cls, text: badge.text }));

    // Cancel button: only useful while the wave still has something to
    // tear down (pending ntfy ids the user actually wants killed). Hide
    // once it's already cancelled or no longer holds a queue.
    if (!cancelled && stillQueued.length > 0) {
      const btn = node('button', { class: 'rem-cancel', text: '×' });
      btn.setAttribute('type', 'button');
      btn.setAttribute('title', 'Cancel this wave (turn off the reminders you set)');
      btn.addEventListener('click', () => {
        btn.setAttribute('disabled', '');
        void cancelWaveFromDashboard(universeId, w.id);
      });
      head.appendChild(btn);
    }
    card.appendChild(head);

    /** @param {number} n */
    const plural = (n) => (n === 1 ? '' : 's');
    let metaText = `${w.fleetCount} expedition${plural(w.fleetCount)} · ${totalScheduled} reminder${plural(totalScheduled)} set`;
    if (ntfyMap.size > 0 && totalScheduled > 0) {
      const rang = totalScheduled - stillQueued.length;
      if (rang > 0) metaText += ` (${rang} rang · ${stillQueued.length} to go)`;
      else metaText += ` (none rung yet)`;
    }
    card.appendChild(node('div', { class: 'wave-meta', text: metaText }));

    appendFiresAtLine(card, stillQueued);

    card.appendChild(node('div', {
      class: 'wave-origins',
      text: (w.origins || []).join(', '),
    }));

    section.appendChild(card);
  }
};

/**
 * Render one universe's AD-HOC fleet alarmClock into `section`, below the
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
 * @param {AlarmClockState} state
 * @param {Map<string, { id: string, time: number, message?: string }>} ntfyMap
 * @returns {void}
 */
const renderAdhocInto = (section, universeId, state, ntfyMap) => {
  // Sort by arrival — ad-hoc entries no longer carry a single fireAt (the
  // schedule is a live multi-slot series); each card's "fires at" list comes
  // from the still-queued ntfy slots below.
  const sorted = (Array.isArray(state?.adhoc) ? state.adhoc : [])
    .slice()
    .sort((a, b) => a.arrivalAt - b.arrivalAt);
  if (!beginAlarmClockSection(section, sorted, 'Ad-hoc fleet reminders')) return;

  const notify = state.adhocNotify || {};
  for (const e of sorted) {
    const ids = notify[e.id]?.scheduledMessageIds ?? [];
    const stillQueued = ids
      .map((id) => ntfyMap.get(id))
      .filter(/** @returns {m is { id: string, time: number, message?: string }} */ (m) => Boolean(m));
    const queued = stillQueued.length > 0;

    const { card, head } = buildAlarmClockCard(e.arrivalAt, 'rem-wave' + (queued ? '' : ' cancelled'), 'ad');
    const badge = alarmClockBadge({
      scheduledCount: ids.length,
      pendingCount: stillQueued.length,
      hasNtfyData: ntfyMap.size > 0,
    });
    head.appendChild(node('span', { class: 'rem-badge ' + badge.cls, text: badge.text }));

    // Cancel only while something is still queued to tear down. Unlike a
    // wave (DOM-derived, so tombstoned), an ad-hoc entry is intent-only and
    // never re-created from the event list, so we delete it outright.
    if (queued) {
      const btn = node('button', { class: 'rem-cancel', text: '×' });
      btn.setAttribute('type', 'button');
      btn.setAttribute('title', 'Cancel this reminder (turn it off)');
      btn.addEventListener('click', () => {
        btn.setAttribute('disabled', '');
        void cancelAdhocFromDashboard(universeId, e.id);
      });
      head.appendChild(btn);
    }
    card.appendChild(head);

    card.appendChild(node('div', { class: 'wave-meta', text: e.label || 'Fleet reminder' }));

    appendFiresAtLine(card, stillQueued);

    section.appendChild(card);
  }
};

/**
 * Render one universe's auto-detected FLEET-SAVE alarmClock into `section`,
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
 * @param {AlarmClockState} state
 * @param {Map<string, { id: string, time: number, message?: string }>} ntfyMap
 * @param {boolean} [kindOn]  Whether fleet-save reminders are switched on for
 *   this server (see {@link renderWavesInto}).
 * @returns {void}
 */
const renderFleetSavesInto = (section, state, ntfyMap, kindOn = true) => {
  const sorted = (Array.isArray(state?.fleetSave) ? state.fleetSave : [])
    .slice()
    .sort((a, b) => a.arrivalAt - b.arrivalAt);
  if (!beginAlarmClockSection(section, sorted, 'Fleet-save reminders', undefined,
    kindOn ? undefined : 'Fleet-save reminders are switched off (Fleet-save tab). These were detected in-game — nothing will ring for them.')) return;

  const notify = state.fleetSaveNotify || {};
  const nowSec = Math.floor(Date.now() / 1000);
  for (const e of sorted) {
    const ids = notify[e.id]?.scheduledMessageIds ?? [];
    const totalScheduled = ids.length;
    const stillQueued = ids
      .map((id) => ntfyMap.get(id))
      .filter(/** @returns {m is { id: string, time: number, message?: string }} */ (m) => Boolean(m))
      .sort((a, b) => a.time - b.time);
    const queued = stillQueued.length > 0;

    // Detected but the queue is deferred until the fleet is within ntfy's
    // 3-day cap — distinguish that from a plain "not scheduled" (no token /
    // sync pending) so the badge explains the wait.
    const tooFar = isFleetSaveTooFarOut(e, totalScheduled, nowSec);

    const { card, head } = buildAlarmClockCard(e.arrivalAt, 'rem-wave' + (queued ? '' : ' cancelled'), 'fs');
    const badge = alarmClockBadge({
      scheduledCount: totalScheduled,
      pendingCount: stillQueued.length,
      hasNtfyData: ntfyMap.size > 0,
      tooFar,
      kindOff: !kindOn,
    });
    head.appendChild(node('span', { class: 'rem-badge ' + badge.cls, text: badge.text }));
    card.appendChild(head);

    /** @param {number} n */
    const plural = (n) => (n === 1 ? '' : 's');
    let metaText = e.label || 'Fleet save';
    if (Number.isFinite(e.shipCount)) metaText += ` · ${e.shipCount} ship${plural(e.shipCount)}`;
    if (totalScheduled > 0) {
      metaText += ` · ${totalScheduled} reminder${plural(totalScheduled)} set`;
      if (ntfyMap.size > 0) {
        const rang = totalScheduled - stillQueued.length;
        metaText += rang > 0 ? ` (${rang} rang · ${stillQueued.length} to go)` : ' (none rung yet)';
      }
    }
    card.appendChild(node('div', { class: 'wave-meta', text: metaText }));

    if (tooFar) {
      const note = node('div', {
        class: 'wave-meta',
        text: 'ntfy delivers at most 3 days ahead — the reminder is set automatically once this is within 3 days of landing.',
      });
      note.style.color = '#888';
      card.appendChild(note);
    }

    appendFiresAtLine(card, stillQueued);

    section.appendChild(card);
  }
};

/**
 * Select THIS universe's queued FLEET-GUARDIAN pushes from the ntfy queue map,
 * sorted by fire time. Guardian pushes are state-free in the gist (the in-game
 * `reconcileGuardianQueue` owns their lifecycle by title), so the ntfy queue is
 * their only source of truth — there's no gist list to walk. We match by EXACT
 * per-server title (`[<universeId>] Bare fleet`, via {@link guardianTitleFor})
 * so a sibling server's pushes on the shared ntfy topic stay out. Exported and
 * pure so it's unit-testable without a DOM (the render below is integration-level).
 *
 * @param {string} universeId
 * @param {Map<string, { id: string, time: number, message?: string, title?: string }>} ntfyMap
 * @returns {Array<{ id: string, time: number, message?: string, title?: string }>}
 */
export const guardianMessagesFor = (universeId, ntfyMap) => {
  const wanted = guardianTitleFor(universeId);
  /** @type {Array<{ id: string, time: number, message?: string, title?: string }>} */
  const out = [];
  for (const msg of ntfyMap.values()) {
    if (msg.title === wanted) out.push(msg);
  }
  return out.sort((a, b) => a.time - b.time);
};

/**
 * Render this universe's FLEET-GUARDIAN pushes into `section`, below the
 * fleet-saves. Read-only BY DESIGN, and — unlike every other list here — NOT
 * backed by gist state (see {@link guardianMessagesFor}): the queued ntfy
 * messages ARE the source of truth. No cancel button: a dashboard delete would
 * just be re-posted on the next in-game guardian reconcile while the fleet is
 * still exposed. The orphan sweep deliberately leaves these in `ntfyMap` (it
 * skips guardian titles), so they survive to here.
 *
 * @param {HTMLElement} section
 * @param {string} universeId
 * @param {Map<string, { id: string, time: number, message?: string, title?: string }>} ntfyMap
 * @returns {void}
 */
const renderGuardianInto = (section, universeId, ntfyMap) => {
  const mine = guardianMessagesFor(universeId, ntfyMap);
  if (!beginAlarmClockSection(section, mine, 'Landed-fleet reminders')) return;

  for (const m of mine) {
    const { card, head } = buildAlarmClockCard(m.time, 'rem-wave', 'fr');
    const badge = alarmClockBadge({
      scheduledCount: 1,
      pendingCount: 1,
      hasNtfyData: ntfyMap.size > 0,
    });
    head.appendChild(node('span', { class: 'rem-badge ' + badge.cls, text: badge.text }));
    card.appendChild(head);
    // The body carries the exposed-fleet coords ("Bare fleet exposed at
    // [g:s:p] — re-save it."); show it verbatim as the card's meta.
    card.appendChild(node('div', {
      class: 'wave-meta',
      text: m.message || 'Bare fleet exposed — re-save it.',
    }));
    section.appendChild(card);
  }
};

/**
 * Dashboard-side cancel of one ad-hoc reminder: DELETE its queued ntfy
 * messages. Armed = "its series is on the queue", so once they are gone every
 * device sees it disarmed; the entry also leaves this device's local mirror.
 *
 * @param {string} universeId
 * @param {string} entryId
 * @returns {Promise<void>}
 */
const cancelAdhocFromDashboard = async (universeId, entryId) => {
  const dict = coerceMirror(await chromeStore.get(ALARM_CLOCK_MIRROR_KEY));
  const state = dict[universeId];
  if (!state?.adhoc?.some((e) => e.id === entryId)) {
    setPreviewStatus('cancel failed: reminder already gone', 'warn');
    void refreshPreview();
    return;
  }
  const ids = state.adhocNotify?.[entryId]?.scheduledMessageIds ?? [];
  await cancelInQueueAndMirror(universeId, ids, (st) => {
    const nextNotify = { ...st.adhocNotify };
    delete nextNotify[entryId];
    return {
      ...st,
      updatedAt: new Date().toISOString(),
      adhoc: st.adhoc.filter((e) => e.id !== entryId),
      adhocNotify: nextNotify,
    };
  });
};

/**
 * Test-only reset: undo the one-time wiring so a fresh {@link installAlarmClock}
 * in a new test starts clean instead of short-circuiting on the `wired` guard
 * (which would otherwise make a second install a silent no-op). Clears the
 * cached element refs and the universe getter too. `_`-prefixed: not for
 * production.
 *
 * @returns {void}
 */
export const _resetAlarmClockForTest = () => {
  wired = false;
  getActiveUniverseId = () => '';
  currentTopic = '';
  topicRevealed = false;
  if (copyResetTimer) { clearTimeout(copyResetTimer); copyResetTimer = 0; }
  unsubscribeStorage(); unsubscribeStorage = () => {};
  for (const k of Object.keys(el)) delete el[k];
};
