// @ts-check

// Event-list reminder badges — turns each fleet row's arrival-time cell
// (`td.arrivalTime`) into a compact, clickable badge. No new column, no
// extra row height: we restyle the cell OGame already renders.
//
// # Context-determined modes (one click target per cell)
//
//   - **Expedition wave.** When auto-wave detection is on, the legs of a
//     returning expedition wave are controlled AS A WHOLE — never per
//     mission. Only the wave's ANCHOR row (the earliest-returning leg
//     present, i.e. the one whose time matches the reminder) carries the
//     control: one click cancels the whole series, and on an
//     already-cancelled wave one click RESENDS it. Every other leg of the
//     wave shows a passive "🛰 part of a wave" marker so the grouping is
//     visible, but isn't independently armable.
//   - **Ad-hoc.** Every other leg (outbound, non-expedition, or a return
//     not part of a scheduled wave) is an ad-hoc toggle: click to arm a
//     one-shot reminder `adhocOffsetSec` before arrival, click again to
//     cancel. Legs past ntfy's 3-day cap show disabled.
//
// # Honest "syncing" state (OGame is not an SPA)
//
// Every click reloads the PHP page; our gist + ntfy round-trip takes a
// few seconds. So an action writes its intent to localStorage
// synchronously (see `./pending.js`) and the badge immediately shows a
// "syncing" state — which survives both re-renders AND the page reload —
// flipping to the confirmed state only once the gist mirror shows ntfy
// actually holds (or dropped) the message. No more "looked armed, wasn't".
//
// # Surviving AGR
//
// State is stamped on the cell (classes + data-*) from the mirror +
// pending queue; a single delegated click listener reads it back and
// dispatches. AGR/OGame swapping `#eventContent` never strands a handler.
// Writes are guarded (only when the value changes) so our own edits don't
// loop the MutationObserver.
//
// @see ./producer.js — owns gist writes; we call its arm/disarm/cancel/
//   resend API and read the mirror it publishes.
// @see ./pending.js  — the reload-safe intent queue we read for "syncing".

import { settingsStore } from '../../state/settings.js';
import { chromeStore } from '../../lib/storage.js';
import { REMINDER_MIRROR_KEY, isValidNtfyToken } from '../../sync/reminders.js';
import { NTFY_MAX_DELAY_SEC } from '../../sync/ntfyScheduler.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { fireAtFor } from '../../domain/adhoc.js';
import { injectStyle } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { readPending, lastAdhocIntent, lastWaveIntent } from './pending.js';

/** @typedef {import('../../sync/reminders.js').ReminderState} ReminderState */
/** @typedef {import('../../domain/adhoc.js').AdhocReminder} AdhocReminder */

const STYLE_ID = 'oge-eventlist-rem-style';
const BADGE_CLASS = 'oge-rem-badge';
const REFRESH_DEBOUNCE_MS = 200;

/** English mission-type names for the push label (locale-independent). */
const MISSION_NAMES = /** @type {Record<string, string>} */ ({
  1: 'Attack', 2: 'ACS attack', 3: 'Transport', 4: 'Deployment',
  5: 'ACS defend', 6: 'Espionage', 7: 'Colonisation', 8: 'Recycle',
  9: 'Moon destruction', 15: 'Expedition',
});

const CSS = `
.${BADGE_CLASS} { border-radius: 3px; transition: box-shadow .12s, background-color .12s; }
.${BADGE_CLASS}.act { cursor: pointer; }
.${BADGE_CLASS}.idle::before { content: '🔔'; opacity: 0; margin-right: 2px; font-size: 0.85em; }
.${BADGE_CLASS}.idle:hover::before { opacity: 0.6; }
.${BADGE_CLASS}.idle:hover { box-shadow: inset 0 0 0 1px rgba(120, 200, 255, 0.6); }
.${BADGE_CLASS}.armed { background: rgba(0, 200, 90, 0.22); box-shadow: inset 0 0 0 1px rgba(0, 220, 110, 0.7); }
.${BADGE_CLASS}.armed::before { content: '🔔'; margin-right: 2px; font-size: 0.85em; }
.${BADGE_CLASS}.wave { background: rgba(70, 150, 255, 0.20); box-shadow: inset 0 0 0 1px rgba(90, 170, 255, 0.7); }
.${BADGE_CLASS}.wave::before { content: '🛰'; margin-right: 2px; font-size: 0.85em; }
.${BADGE_CLASS}.wave-off { box-shadow: inset 0 0 0 1px rgba(150, 150, 150, 0.6); opacity: 0.75; }
.${BADGE_CLASS}.wave-off::before { content: '🛰'; margin-right: 2px; font-size: 0.85em; opacity: 0.6; }
.${BADGE_CLASS}.member { box-shadow: inset 2px 0 0 0 rgba(90, 170, 255, 0.6); }
.${BADGE_CLASS}.member::before { content: '🛰'; margin-right: 2px; font-size: 0.7em; opacity: 0.5; }
.${BADGE_CLASS}.member-off { box-shadow: inset 2px 0 0 0 rgba(150, 150, 150, 0.5); opacity: 0.7; }
.${BADGE_CLASS}.disabled { opacity: 0.5; }
.${BADGE_CLASS}.syncing { animation: oge-rem-pulse 1s ease-in-out infinite; }
.${BADGE_CLASS}.syncing::after { content: '⏳'; margin-left: 2px; font-size: 0.8em; }
@keyframes oge-rem-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
`;

// ── Mirror snapshot ─────────────────────────────────────────────────────

/**
 * Cached reminder state for THIS universe (the slice of the gist mirror
 * the producer publishes), refreshed on install + on every mirror change.
 *
 * @type {ReminderState | null}
 */
let snapshot = null;

/** @returns {Promise<void>} */
const refreshSnapshot = async () => {
  try {
    const dict = await chromeStore.get(REMINDER_MIRROR_KEY);
    const universeId = parseUniverseId(location.host);
    snapshot = (dict && typeof dict === 'object' && !Array.isArray(dict))
      ? /** @type {Record<string, ReminderState>} */ (dict)[universeId] ?? null
      : null;
  } catch {
    snapshot = null;
  }
};

// ── Helpers ───────────────────────────────────────────────────────────

/** @param {string | null | undefined} s @returns {string} dense `g:s:p` */
const denseCoords = (s) => (s || '').replace(/[\s[\]]/g, '');

/** @param {Element} row @returns {string} push label, e.g. "Expedition → [4:467:16]" */
const labelFor = (row) => {
  const mt = row.getAttribute('data-mission-type') || '';
  const mission = MISSION_NAMES[mt] || 'Fleet';
  const dest = denseCoords(row.querySelector('.destCoords')?.textContent);
  return dest ? `${mission} → [${dest}]` : mission;
};

/**
 * Every class we own. We toggle ONLY these via classList so OGame's own
 * cell classes (notably `arrivalTime`, which `render` selects on) survive
 * — overwriting `className` wholesale used to strip `arrivalTime`, after
 * which the cell could never be found (or updated) again.
 */
const OWNED_CLASSES = [
  BADGE_CLASS, 'act', 'idle', 'armed', 'wave', 'wave-off', 'member', 'member-off', 'disabled', 'syncing',
];

/** @param {Element} el @param {string} attr @param {string | null} val */
const setAttr = (el, attr, val) => {
  const cur = el.getAttribute(attr);
  if (val === null) { if (cur !== null) el.removeAttribute(attr); }
  else if (cur !== val) el.setAttribute(attr, val);
};

/**
 * Stamp a cell's badge: add the wanted owned-classes, remove the rest,
 * leave every foreign (OGame/AGR) class untouched. classList add/remove of
 * an already-(absent|present) class is a no-op, so this stays idempotent.
 *
 * @param {HTMLElement} cell
 * @param {string} classes  Space-separated state classes (without BADGE_CLASS).
 * @param {string} act      Click action ('' = inert).
 * @param {string} waveId   Wave id for wave actions ('' = none).
 * @param {string} title
 */
const stamp = (cell, classes, act, waveId, title) => {
  const want = new Set([BADGE_CLASS, ...classes.split(' ').filter(Boolean), ...(act ? ['act'] : [])]);
  for (const c of OWNED_CLASSES) cell.classList.toggle(c, want.has(c));
  setAttr(cell, 'data-oge-act', act || null);
  setAttr(cell, 'data-oge-wave', waveId || null);
  setAttr(cell, 'title', title);
};

/** Strip every badge marking we may have applied, keeping foreign classes. @param {HTMLElement} cell */
const clearCell = (cell) => {
  if (!cell.classList.contains(BADGE_CLASS)) return;
  cell.classList.remove(...OWNED_CLASSES);
  setAttr(cell, 'data-oge-act', null);
  setAttr(cell, 'data-oge-wave', null);
  setAttr(cell, 'title', null);
};

// ── Render ──────────────────────────────────────────────────────────────

/**
 * One render pass: stamp every fleet row's arrival cell from settings +
 * mirror snapshot + the pending-intent queue. Pure-ish (reads DOM +
 * snapshot + localStorage; writes only guarded classes/attrs).
 *
 * @returns {void}
 */
const render = () => {
  const s = settingsStore.get();
  const tokenOk = isValidNtfyToken(s.reminderNtfyToken);
  const adhocOn = s.adhocEnabled && tokenOk;
  const waveOn = s.reminderEnabled && tokenOk;
  const now = Math.floor(Date.now() / 1000);
  const universeId = parseUniverseId(location.host);
  const pending = readPending(universeId);

  const rows = [.../** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('#eventContent tr.eventFleet[id^="eventRow-"]')
  )];

  // Pre-pass: map each row to its wave (if any) and find each wave's
  // anchor — the earliest-returning leg currently present.
  /** @type {Map<HTMLElement, import('../../domain/waves.js').Wave>} */
  const waveOf = new Map();
  /** @type {Map<string, { arrivalAt: number, rowId: string }>} */
  const anchor = new Map();
  if (waveOn && snapshot?.waves) {
    for (const row of rows) {
      const arrivalAt = parseInt(row.getAttribute('data-arrival-time') || '', 10);
      if (!Number.isFinite(arrivalAt)) continue;
      const w = snapshot.waves.find((x) => (x.returnAts || []).includes(arrivalAt));
      if (!w) continue;
      waveOf.set(row, w);
      const cur = anchor.get(w.id);
      if (!cur || arrivalAt < cur.arrivalAt) anchor.set(w.id, { arrivalAt, rowId: row.id });
    }
  }

  const armedSet = new Set((snapshot?.adhoc || []).map((e) => e.id));

  for (const row of rows) {
    const cell = /** @type {HTMLElement | null} */ (row.querySelector('td.arrivalTime'));
    if (!cell) continue;
    const id = row.id;
    const arrivalAt = parseInt(row.getAttribute('data-arrival-time') || '', 10);

    const w = waveOf.get(row);
    if (w) {
      const pw = lastWaveIntent(pending, w.id);
      const cancelled = pw ? pw === 'cancelWave' : Boolean(w.cancelled);
      const syncing = pw !== null ? ' syncing' : '';
      const isAnchor = anchor.get(w.id)?.rowId === id;
      if (isAnchor) {
        if (cancelled) {
          stamp(cell, `wave-off${syncing}`, 'resendWave', w.id,
            'Wave reminder cancelled — click to resend the whole series');
        } else {
          stamp(cell, `wave${syncing}`, 'cancelWave', w.id,
            'Auto expedition-wave reminder scheduled — click to cancel the whole wave');
        }
      } else {
        stamp(cell, cancelled ? 'member-off' : 'member', '', '',
          'Part of an expedition-wave reminder');
      }
      continue;
    }

    if (adhocOn && Number.isFinite(arrivalAt)) {
      const pa = lastAdhocIntent(pending, id);
      const armed = pa ? pa === 'arm' : armedSet.has(id);
      const syncing = pa !== null ? ' syncing' : '';
      if (armed) {
        stamp(cell, `armed${syncing}`, 'disarm', '', 'Reminder armed — click to cancel');
      } else {
        const fireAt = fireAtFor(arrivalAt, s.adhocOffsetSec);
        if (fireAt - now > NTFY_MAX_DELAY_SEC) {
          stamp(cell, 'disabled', '', '', 'Too far ahead to remind (ntfy limit is 3 days)');
        } else {
          stamp(cell, `idle${syncing}`, 'arm', '', 'Click to get a push reminder before this arrives');
        }
      }
      continue;
    }

    clearCell(cell);
  }
};

// ── Install / dispose ─────────────────────────────────────────────────────

/** @type {{ dispose: () => void, refresh: () => void } | null} */
let installed = null;

/**
 * Install the event-list reminder badges.
 *
 * @param {object} api  Producer actions (see `./producer.js`).
 * @param {(entry: AdhocReminder) => void} api.armAdhoc
 * @param {(id: string) => void} api.disarmAdhoc
 * @param {(waveId: string) => void} api.cancelWave
 * @param {(waveId: string) => void} api.resendWave
 * @returns {{ dispose: () => void, refresh: () => void }}
 *   `refresh` re-reads the gist mirror and re-renders — call it after a
 *   sync so confirmed state appears without waiting on a storage event.
 */
export const installEventListReminders = ({ armAdhoc, disarmAdhoc, cancelWave, resendWave }) => {
  if (installed) return installed;

  injectStyle(STYLE_ID, CSS);

  const scheduleRender = debounce(() => { if (installed) render(); }, REFRESH_DEBOUNCE_MS);

  /** @param {MouseEvent} ev */
  const onClick = (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const cell = target?.closest?.(`.${BADGE_CLASS}.act`);
    if (!cell) return;
    const act = cell.getAttribute('data-oge-act');
    const row = cell.closest('tr.eventFleet');
    if (!act || !row) return;
    ev.preventDefault();
    ev.stopPropagation();

    const id = /** @type {HTMLElement} */ (row).id;
    const waveId = cell.getAttribute('data-oge-wave') || '';
    if (act === 'cancelWave' && waveId) cancelWave(waveId);
    else if (act === 'resendWave' && waveId) resendWave(waveId);
    else if (act === 'disarm') disarmAdhoc(id);
    else if (act === 'arm') {
      const arrivalAt = parseInt(row.getAttribute('data-arrival-time') || '', 10);
      if (!Number.isFinite(arrivalAt)) return;
      const offsetSec = settingsStore.get().adhocOffsetSec;
      const fleetId = row.querySelector('.recallFleet')?.getAttribute('data-fleet-id') || undefined;
      armAdhoc({
        id, arrivalAt, offsetSec, fireAt: fireAtFor(arrivalAt, offsetSec),
        label: labelFor(row),
        ...(fleetId ? { fleetId } : {}),
        createdAt: Math.floor(Date.now() / 1000),
      });
    }
    // Reflect the just-queued intent immediately (render reads the pending
    // queue we just wrote) — shows the "syncing" state without waiting for
    // the sync round-trip.
    render();
  };
  document.addEventListener('click', onClick, true);

  const observer = new MutationObserver(scheduleRender);
  observer.observe(document.body, { childList: true, subtree: true });

  const onMirror = (/** @type {Record<string, unknown>} */ changes) => {
    if (REMINDER_MIRROR_KEY in changes) void refreshSnapshot().then(() => scheduleRender());
  };
  chromeStore.onChanged(onMirror);

  let prevSig = pickSig(settingsStore.get());
  const unsubSettings = settingsStore.subscribe((next) => {
    const sig = pickSig(next);
    if (sig === prevSig) return;
    prevSig = sig;
    scheduleRender();
  });

  // Re-read the mirror + render. The poll refreshes the SNAPSHOT (not just
  // re-render) so a confirmed state can't get stuck behind a stale snapshot
  // if a storage event is missed.
  const refresh = () => { void refreshSnapshot().then(() => { if (installed) render(); }); };

  const safetyPoll = setInterval(refresh, 3000);

  refresh();

  installed = {
    dispose: () => {
      document.removeEventListener('click', onClick, true);
      observer.disconnect();
      clearInterval(safetyPoll);
      unsubSettings();
      document.getElementById(STYLE_ID)?.remove();
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => clearCell(/** @type {HTMLElement} */ (el)));
      installed = null;
    },
    refresh,
  };
  return installed;
};

/** @param {ReturnType<typeof settingsStore.get>} s @returns {string} */
const pickSig = (s) =>
  JSON.stringify({ a: s.adhocEnabled, t: s.reminderNtfyToken, o: s.adhocOffsetSec, e: s.reminderEnabled });

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetEventListRemindersForTest = () => {
  if (installed) installed.dispose();
  installed = null;
  snapshot = null;
};
