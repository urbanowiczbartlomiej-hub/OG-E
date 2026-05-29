// @ts-check

// Event-list reminder badges — turns each fleet row's arrival-time cell
// (`td.arrivalTime`) into a compact, clickable badge. No new column, no
// extra row height: we restyle the cell OGame already renders.
//
// # Two context-determined modes (one click target per cell)
//
//   - **Wave mode.** An expedition return leg already covered by a live,
//     scheduled auto-wave reminder shows a "wave scheduled" badge; one
//     click cancels the whole wave (`cancelWave`) — the same action the
//     dashboard offers, now inline. No ad-hoc on these legs (the wave
//     already covers them).
//   - **Ad-hoc mode.** Every other leg (outbound, non-expedition, or a
//     return not covered by a scheduled wave) is an ad-hoc toggle: click
//     to arm a one-shot reminder `adhocOffsetSec` before arrival, click
//     again to cancel. Legs whose fire time is past ntfy's 3-day cap are
//     shown disabled.
//
// Picking the mode per cell keeps a single tap target — important on
// mobile, where OG-E is used most.
//
// # State, not closures
//
// The render pass writes the chosen mode + ids onto the cell (classes +
// data-* attributes) from a cached snapshot of the gist mirror; a single
// delegated click listener reads that back and dispatches. So AGR/OGame
// swapping `#eventContent` never strands a stale handler — the next
// render re-applies, and the listener lives on `document`.
//
// Writes are guarded (only when the value actually changes) so our own
// attribute edits don't re-trigger the MutationObserver into a loop —
// same net effect as the disconnect/reattach dance in `badges.js`, less
// machinery.
//
// @see ./producer.js — owns the gist writes; we only call its arm/disarm/
//   cancel API and read the mirror it publishes.

import { settingsStore } from '../../state/settings.js';
import { chromeStore } from '../../lib/storage.js';
import { REMINDER_MIRROR_KEY, isValidNtfyToken } from '../../sync/reminders.js';
import { NTFY_MAX_DELAY_SEC } from '../../sync/ntfyScheduler.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { fireAtFor } from '../../domain/adhoc.js';
import { injectStyle } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';

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
.${BADGE_CLASS} {
  cursor: pointer;
  border-radius: 3px;
  transition: box-shadow .12s, background-color .12s;
}
.${BADGE_CLASS}.idle:hover {
  box-shadow: inset 0 0 0 1px rgba(120, 200, 255, 0.6);
}
.${BADGE_CLASS}.idle::before {
  content: '🔔';
  opacity: 0;
  margin-right: 2px;
  font-size: 0.85em;
}
.${BADGE_CLASS}.idle:hover::before { opacity: 0.6; }
.${BADGE_CLASS}.armed {
  background: rgba(0, 200, 90, 0.22);
  box-shadow: inset 0 0 0 1px rgba(0, 220, 110, 0.7);
}
.${BADGE_CLASS}.armed::before {
  content: '🔔';
  margin-right: 2px;
  font-size: 0.85em;
}
.${BADGE_CLASS}.wave {
  background: rgba(70, 150, 255, 0.20);
  box-shadow: inset 0 0 0 1px rgba(90, 170, 255, 0.7);
  cursor: pointer;
}
.${BADGE_CLASS}.wave::before {
  content: '🛰';
  margin-right: 2px;
  font-size: 0.85em;
}
.${BADGE_CLASS}.disabled {
  cursor: default;
  opacity: 0.5;
}
`;

// ── Mirror snapshot ─────────────────────────────────────────────────────

/**
 * Cached reminder state for THIS universe (the slice of the gist mirror
 * the producer publishes). Refreshed on install and whenever the mirror
 * changes; the render pass reads it synchronously.
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

/**
 * Build the ad-hoc push label for a row: mission name + destination
 * coords (where the leg arrives). The body adds the clock time later.
 *
 * @param {Element} row
 * @returns {string}
 */
const labelFor = (row) => {
  const mt = row.getAttribute('data-mission-type') || '';
  const mission = MISSION_NAMES[mt] || 'Fleet';
  const dest = denseCoords(row.querySelector('.destCoords')?.textContent);
  return dest ? `${mission} → [${dest}]` : mission;
};

/**
 * Resolve which scheduled wave (if any) covers a return leg arriving at
 * `arrivalAt`. A wave covers it when the leg's arrival is one of the
 * wave's return times, the wave isn't cancelled, and it actually has
 * messages queued (so a disabled / swept wave doesn't claim the cell).
 *
 * @param {number} arrivalAt
 * @returns {string | null}  wave id, or null when not covered.
 */
const waveCovering = (arrivalAt) => {
  if (!snapshot?.waves) return null;
  const notify = snapshot.notifyState || {};
  for (const w of snapshot.waves) {
    if (w.cancelled) continue;
    if (!(w.returnAts || []).includes(arrivalAt)) continue;
    if ((notify[w.id]?.scheduledMessageIds || []).length === 0) continue;
    return w.id;
  }
  return null;
};

/** @returns {Set<string>} armed ad-hoc event-row ids for this universe. */
const armedIds = () => new Set((snapshot?.adhoc || []).map((e) => e.id));

/**
 * Idempotent attribute write — only touches the DOM when the value
 * actually changes, so our edits don't feed the MutationObserver a loop.
 *
 * @param {Element} el @param {string} attr @param {string | null} val
 */
const setAttr = (el, attr, val) => {
  const cur = el.getAttribute(attr);
  if (val === null) { if (cur !== null) el.removeAttribute(attr); }
  else if (cur !== val) el.setAttribute(attr, val);
};

/** @param {HTMLElement} el @param {string} cls */
const setClass = (el, cls) => { if (el.className !== cls) el.className = cls; };

// ── Render ──────────────────────────────────────────────────────────────

/**
 * One render pass: walk every fleet row and set its arrival-time cell's
 * badge mode from the current settings + mirror snapshot. Pure-ish: reads
 * the DOM + snapshot, writes only classes / data-* / title (guarded).
 *
 * @returns {void}
 */
const render = () => {
  const s = settingsStore.get();
  const adhocOn = s.adhocEnabled && isValidNtfyToken(s.reminderNtfyToken);
  const now = Math.floor(Date.now() / 1000);
  const armed = armedIds();

  const rows = document.querySelectorAll('#eventContent tr.eventFleet[id^="eventRow-"]');
  for (const row of rows) {
    const cell = /** @type {HTMLElement | null} */ (row.querySelector('td.arrivalTime'));
    if (!cell) continue;
    const id = /** @type {HTMLElement} */ (row).id;
    const arrivalAttr = row.getAttribute('data-arrival-time');
    const arrivalAt = arrivalAttr ? parseInt(arrivalAttr, 10) : NaN;

    // Decide the mode for this cell.
    let mode = 'none';
    let title = '';
    let waveId = '';
    if (Number.isFinite(arrivalAt)) {
      const cover = waveCovering(arrivalAt);
      if (cover) {
        mode = 'wave';
        waveId = cover;
        title = 'Auto expedition reminder scheduled — click to cancel it';
      } else if (adhocOn) {
        if (armed.has(id)) {
          mode = 'armed';
          title = 'Reminder armed — click to cancel';
        } else {
          const fireAt = fireAtFor(arrivalAt, s.adhocOffsetSec);
          if (fireAt - now > NTFY_MAX_DELAY_SEC) {
            mode = 'disabled';
            title = 'Too far ahead to remind (ntfy limit is 3 days)';
          } else {
            mode = 'idle';
            title = 'Click to get a push reminder before this arrives';
          }
        }
      }
    }

    if (mode === 'none') {
      // Strip any badge we previously applied (e.g. token cleared).
      if (cell.classList.contains(BADGE_CLASS)) setClass(cell, cell.className.replace(/\boge-rem-[\w-]+\b/g, '').trim());
      setAttr(cell, 'data-oge-rem', null);
      setAttr(cell, 'data-oge-wave', null);
      setAttr(cell, 'title', null);
      continue;
    }

    setClass(cell, `${BADGE_CLASS} ${mode}`);
    setAttr(cell, 'data-oge-rem', mode);
    setAttr(cell, 'data-oge-wave', waveId || null);
    setAttr(cell, 'title', title);
  }
};

// ── Install / dispose ─────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the event-list reminder badges.
 *
 * @param {object} api  Producer actions (see {@link './producer.js'}).
 * @param {(entry: AdhocReminder) => void} api.armAdhoc
 * @param {(id: string) => void} api.disarmAdhoc
 * @param {(waveId: string) => void} api.cancelWave
 * @returns {() => void} dispose
 */
export const installEventListReminders = ({ armAdhoc, disarmAdhoc, cancelWave }) => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);

  const scheduleRender = debounce(() => { if (installed) render(); }, REFRESH_DEBOUNCE_MS);

  // Delegated click — survives AGR swapping #eventContent. Reads the mode
  // the render pass stamped on the cell, flips it optimistically for snap,
  // and dispatches; the next mirror update re-renders the truth.
  /** @param {MouseEvent} ev */
  const onClick = (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const cell = target?.closest?.(`.${BADGE_CLASS}`);
    if (!cell) return;
    const mode = cell.getAttribute('data-oge-rem');
    if (!mode || mode === 'disabled') return;
    const row = cell.closest('tr.eventFleet');
    if (!row) return;
    ev.preventDefault();
    ev.stopPropagation();

    const id = /** @type {HTMLElement} */ (row).id;
    if (mode === 'wave') {
      const waveId = cell.getAttribute('data-oge-wave');
      if (waveId) { cancelWave(waveId); setClass(/** @type {HTMLElement} */ (cell), `${BADGE_CLASS} idle`); }
      return;
    }
    if (mode === 'armed') {
      disarmAdhoc(id);
      setClass(/** @type {HTMLElement} */ (cell), `${BADGE_CLASS} idle`);
      return;
    }
    // idle → arm
    const arrivalAttr = row.getAttribute('data-arrival-time');
    const arrivalAt = arrivalAttr ? parseInt(arrivalAttr, 10) : NaN;
    if (!Number.isFinite(arrivalAt)) return;
    const offsetSec = settingsStore.get().adhocOffsetSec;
    const fleetId = row.querySelector('.recallFleet')?.getAttribute('data-fleet-id') || undefined;
    armAdhoc({
      id,
      arrivalAt,
      offsetSec,
      fireAt: fireAtFor(arrivalAt, offsetSec),
      label: labelFor(row),
      ...(fleetId ? { fleetId } : {}),
      createdAt: Math.floor(Date.now() / 1000),
    });
    setClass(/** @type {HTMLElement} */ (cell), `${BADGE_CLASS} armed`);
  };
  document.addEventListener('click', onClick, true);

  // Re-render on event-box churn (observe body — OGame swaps #eventContent
  // wholesale on its AJAX tick, same as badges.js).
  const observer = new MutationObserver(scheduleRender);
  observer.observe(document.body, { childList: true, subtree: true });

  // Re-render on mirror change (arm/disarm/cancel landed, or another
  // device synced) and on the relevant settings toggles.
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

  // Safety poll (OGame dodges scoped observers historically — same net as
  // badges.js). Cheap: render is guarded, so a no-change tick costs almost
  // nothing.
  const safetyPoll = setInterval(() => { if (installed) render(); }, 3000);

  void refreshSnapshot().then(() => render());

  installed = {
    dispose: () => {
      document.removeEventListener('click', onClick, true);
      observer.disconnect();
      clearInterval(safetyPoll);
      unsubSettings();
      document.getElementById(STYLE_ID)?.remove();
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => {
        el.classList.remove(BADGE_CLASS, 'idle', 'armed', 'wave', 'disabled');
        el.removeAttribute('data-oge-rem');
        el.removeAttribute('data-oge-wave');
      });
      installed = null;
    },
  };
  return installed.dispose;
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
