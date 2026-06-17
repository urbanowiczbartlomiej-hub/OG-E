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
//   - **Fleet-save.** A leg the producer classified as a fleet-save (big own
//     fleet on a long-enough flight) shows a 🛡 marker (amber). It is
//     auto-detected and auto-scheduled; the player can't arm it, and can
//     cancel a slot only inside its final cancel window
//     (`FS_CANCEL_WINDOW_SEC` before it fires). The badge visibly FLIPS when
//     that window opens — brighter, pulsing, with a ✕ affordance — on an
//     exact timer armed for the next state transition (no polling lag). A
//     save whose every slot has fired or been cancelled is SPENT: the row is
//     released back to the ad-hoc toggle below, which is safe because the
//     persisted entry survives as an empty-series lock and can never be
//     re-auto-classified (see `domain/fleetSave.reconcileFleetSaves`).
//     Driven by the mirror's `fleetSave` set (not a local DOM guess) so it
//     matches what's actually scheduled — short planet⇄moon hops never get
//     flagged. Takes precedence over the ad-hoc toggle on the same row
//     (wave > fleet-save > ad-hoc).
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
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { reminderConfigStore } from '../../state/reminderConfig.js';
import { chromeStore } from '../../lib/storage.js';
import { REMINDER_MIRROR_KEY, isValidNtfyToken } from '../../sync/reminders.js';
import { NTFY_MAX_DELAY_SEC, offsetsForSchedule } from '../../sync/ntfyReconciler.js';
import { parseUniverseId } from '../../lib/universeId.js';
import { fireAtFor } from '../../domain/adhoc.js';
import {
  nearestCancellableSlot, fsOffsetsToCancel, hasUpcomingFsSlot, FS_CANCEL_WINDOW_SEC,
} from '../../domain/fleetSave.js';
import { injectStyle } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { readPending, lastAdhocIntent, lastWaveIntent } from './pending.js';
import { readFleetSaveCancel, pruneFleetSaveCancel } from './fleetSaveCancel.js';
import { fleetRowMeta } from './fleetSaveScan.js';
import { GAME } from '../../lib/gameDom.js';

/** @typedef {import('../../sync/reminders.js').ReminderState} ReminderState */
/** @typedef {import('../../domain/adhoc.js').AdhocReminder} AdhocReminder */

const STYLE_ID = 'oge-eventlist-rem-style';
const BADGE_CLASS = 'oge-rem-badge';
const REFRESH_DEBOUNCE_MS = 200;
/** The cancel window, in whole minutes, for human-facing hint text. */
const FS_CANCEL_WINDOW_MIN = Math.round(FS_CANCEL_WINDOW_SEC / 60);

/** English mission-type names for the push label (locale-independent). */
const MISSION_NAMES = /** @type {Record<string, string>} */ ({
  1: 'Attack', 2: 'ACS attack', 3: 'Transport', 4: 'Deployment',
  5: 'ACS defend', 6: 'Espionage', 7: 'Colonisation', 8: 'Recycle',
  9: 'Moon destruction', 15: 'Expedition',
});

const CSS = `
.${BADGE_CLASS} { border-radius: 3px; transition: box-shadow .12s, background-color .12s; }
.${BADGE_CLASS}.act { cursor: pointer; }
/* Idle: the bell is ALWAYS visible (faint) so the cell reads as tappable
   on mobile, where there's no hover. Hover just brightens it. */
.${BADGE_CLASS}.idle::before { content: '🔔'; opacity: 0.55; margin-right: 2px; font-size: 0.85em; }
.${BADGE_CLASS}.idle:hover::before { opacity: 1; }
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
.${BADGE_CLASS}.fs { background: rgba(255, 176, 32, 0.20); box-shadow: inset 0 0 0 1px rgba(255, 176, 32, 0.75); }
.${BADGE_CLASS}.fs::before { content: '🛡'; margin-right: 2px; font-size: 0.85em; }
/* Cancel window open: the badge brightens, pulses and grows a ✕ so the
   player SEES the moment the slot becomes cancellable (and sees the state
   drop back after a successful cancel). */
.${BADGE_CLASS}.fs-cancel { background: rgba(255, 176, 32, 0.32); animation: oge-rem-fs-cancel 1.2s ease-in-out infinite; }
.${BADGE_CLASS}.fs-cancel::after { content: '✕'; margin-left: 3px; font-size: 0.8em; opacity: 0.85; }
@keyframes oge-rem-fs-cancel {
  0%, 100% { box-shadow: inset 0 0 0 1px rgba(255, 205, 90, 0.95); }
  50% { box-shadow: inset 0 0 0 2px rgba(255, 220, 130, 0.55); }
}
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

/** Epoch SECONDS → locale HH:MM — the one clock format every tooltip uses. */
const fmtClock = (/** @type {number} */ epochSec) =>
  new Date(epochSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Push label naming where the fleet actually LANDS, e.g.
 * "Expedition → [4:467:16]".
 *
 * The reminder fires for the arrival of THIS leg, so the coords must be
 * the leg's landing point — not always the mission destination. On a
 * return flight (`data-return-flight="true"`) the fleet is coming home,
 * so it lands at its origin (`.coordsOrigin`); on an outbound leg it
 * lands at the destination (`.destCoords`). Reading `.destCoords`
 * unconditionally mislabels every return as arriving at the target it is
 * in fact leaving.
 *
 * @param {Element} row
 * @returns {string}
 */
const labelFor = (row) => {
  const mt = row.getAttribute('data-mission-type') || '';
  const mission = MISSION_NAMES[mt] || 'Fleet';
  const isReturn = row.getAttribute('data-return-flight') === 'true';
  const sel = isReturn ? GAME.COORDS_ORIGIN : GAME.COORDS_DEST;
  const landing = denseCoords(row.querySelector(sel)?.textContent);
  return landing ? `${mission} → [${landing}]` : mission;
};

/**
 * Every class we own. We toggle ONLY these via classList so OGame's own
 * cell classes (notably `arrivalTime`, which `render` selects on) survive
 * — overwriting `className` wholesale used to strip `arrivalTime`, after
 * which the cell could never be found (or updated) again.
 */
const OWNED_CLASSES = [
  BADGE_CLASS, 'act', 'idle', 'armed', 'wave', 'wave-off', 'member', 'member-off', 'fs', 'fs-cancel',
  'disabled', 'syncing',
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

/**
 * Multi-line tooltip for a wave anchor: the whole reminder series spelled
 * out as clock times (the wave's locked `baseAt` + each preset offset),
 * then the action hint. Browsers render `\n` in `title` tooltips, so the
 * player can read every scheduled ntfy time for the wave at a glance.
 *
 * @param {import('../../domain/waves.js').Wave} w
 * @param {string} schedule  Active schedule preset key.
 * @param {string} hint      Trailing action line.
 * @returns {string}
 */
const waveTitle = (w, schedule, hint) => {
  const baseAt = snapshot?.notifyState?.[w.id]?.baseAt ?? w.nextWaveAt;
  const times = offsetsForSchedule(schedule).map((o) => fmtClock(baseAt + o)).join(', ');
  return `Wave reminders at: ${times}\n${hint}`;
};

/**
 * Multi-line tooltip for a fleet-save badge: the reminder times actually
 * registered with ntfy — its `fireAts` filtered to the future slots still
 * inside the 3-day cap (exactly what the scheduler queues) — then a hint
 * whose wording depends on `mode` (cancellable now / collapses the rest /
 * passive). The leg's mission / coords / ship count are deliberately omitted:
 * the player already reads those in the row itself (they ride along only in
 * the push body). A save still more than 3 days out has no registered slot
 * yet, so it falls back to the bare hint.
 *
 * @param {import('../../domain/fleetSave.js').FleetSaveReminder} fs
 * @param {number} now  Epoch SECONDS.
 * @param {'cancel' | 'cancel-collapse' | 'passive'} mode  Hint wording.
 * @returns {string}
 */
const fsTitle = (fs, now, mode) => {
  const live = (fs.fireAts || [])
    .filter((t) => Number.isFinite(t) && t > now && t <= now + NTFY_MAX_DELAY_SEC)
    .map(fmtClock);
  const hint =
    mode === 'cancel'
      ? 'Cancellable now — click to cancel this reminder'
      : mode === 'cancel-collapse'
        ? 'Cancellable now — click to cancel this + the landing/after reminders'
        : live.length
          ? `Set automatically — the next reminder is cancellable in its final ${FS_CANCEL_WINDOW_MIN} min`
          // No live slot yet: every fire time is still beyond ntfy's 3-day cap,
          // so NOTHING is queued. Say so instead of the misleading "Set
          // automatically" (which read as already-armed).
          : 'Too far out to schedule yet — reminders set automatically once it\'s within 3 days of landing';
  return live.length ? `Fleet-save reminders at: ${live.join(', ')}\n${hint}` : hint;
};

/**
 * Apply the player's not-yet-synced slot cancellations to a fleet-save's
 * series, returning a copy with the suppressed offsets removed. The gist
 * mirror reflects them only after the next sync; this keeps the badge honest
 * (and the cancellable-slot maths correct) in the gap between click and sync.
 *
 * @param {import('../../domain/fleetSave.js').FleetSaveReminder} fs
 * @param {number[] | undefined} cancelledOffsets
 * @returns {import('../../domain/fleetSave.js').FleetSaveReminder}
 */
const effectiveFs = (fs, cancelledOffsets) => {
  if (!cancelledOffsets || !cancelledOffsets.length) return fs;
  const offsetsSec = (fs.offsetsSec || []).filter((o) => !cancelledOffsets.includes(o));
  const fireAts = (fs.fireAts || []).filter((_, i) => !cancelledOffsets.includes(fs.offsetsSec[i]));
  return { ...fs, offsetsSec, fireAts };
};

// ── Render ──────────────────────────────────────────────────────────────

/**
 * Exact re-render timer for the next fleet-save state flip (a cancel window
 * opening, or the open slot firing). Re-armed on every render pass to the
 * EARLIEST upcoming transition, so the badge changes at the right second
 * instead of waiting on the 3 s safety poll.
 *
 * @type {ReturnType<typeof setTimeout> | null}
 */
let fsFlipTimer = null;

const clearFsFlipTimer = () => {
  if (fsFlipTimer !== null) { clearTimeout(fsFlipTimer); fsFlipTimer = null; }
};

/**
 * One render pass: stamp every fleet row's arrival cell from settings +
 * mirror snapshot + the pending-intent queue. Pure-ish (reads DOM +
 * snapshot + localStorage; writes only guarded classes/attrs).
 *
 * @returns {void}
 */
const render = () => {
  const s = settingsStore.get();
  // Wave enable + schedule + ad-hoc lead time are per-universe — read from the
  // reminderConfig store; only master + token stay in Settings.
  const r = reminderConfigStore.get();
  const sectionOn = s.remindersMasterEnabled && isValidNtfyToken(s.reminderNtfyToken);
  const adhocOn = sectionOn; // ad-hoc reminders are always on when the section is
  const waveOn = sectionOn && r.reminderEnabled;
  // Fleet-save enable is per-universe (B3b) — read from the galaxyScanConfig store.
  const fsOn = sectionOn && galaxyScanConfigStore.get().fsEnabled;
  const now = Math.floor(Date.now() / 1000);
  const universeId = parseUniverseId(location.host);
  const pending = readPending(universeId);

  const rows = [.../** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll(GAME.EVENT_FLEET_ROWS)
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

  /** Earliest upcoming FS state flip (epoch sec) — feeds the exact timer. */
  let nextFsFlipAt = Infinity;

  const armedSet = new Set((snapshot?.adhoc || []).map((e) => e.id));
  const fsById = new Map((snapshot?.fleetSave || []).map((e) => [e.id, e]));
  // Local, not-yet-synced FS slot cancellations (read-only here; the producer
  // owns the writes). Keyed by reminder id → suppressed offsets.
  const fsCancel = pruneFleetSaveCancel(readFleetSaveCancel(universeId), now);

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
            waveTitle(w, r.reminderSchedule, 'Cancelled — click to resend the whole series'));
        } else {
          stamp(cell, `wave${syncing}`, 'cancelWave', w.id,
            waveTitle(w, r.reminderSchedule, 'Click to cancel the whole wave'));
        }
      } else {
        stamp(cell, cancelled ? 'member-off' : 'member', '', '',
          'Part of an expedition-wave reminder');
      }
      continue;
    }

    // Fleet-save: a leg the producer classified as a save (mirror-driven, so
    // it reflects the ship + flight-time gates and the lock — never a short
    // hop). Outranks the ad-hoc toggle on the row — but a SPENT series
    // (every slot fired or cancelled) falls through and releases the row to
    // ad-hoc; safe, because the persisted entry survives as an empty-series
    // lock and can't be re-auto-classified.
    if (fsOn) {
      const rawFs = fsById.get(id);
      if (rawFs) {
        const fs = effectiveFs(rawFs, fsCancel[id]?.offsets);
        if (hasUpcomingFsSlot(fs, now)) {
          const slot = nearestCancellableSlot(fs, now);
          if (slot) {
            const collapse = fsOffsetsToCancel(fs.offsetsSec, slot.offset).length > 1;
            stamp(cell, 'fs fs-cancel', 'cancelFs', '', fsTitle(fs, now, collapse ? 'cancel-collapse' : 'cancel'));
            // Open window: next flip is the slot firing (badge drops back).
            nextFsFlipAt = Math.min(nextFsFlipAt, slot.fireAt);
          } else {
            // No cancellable slot now. Split "scheduled, waiting for its
            // cancel window" from "still beyond ntfy's 3-day cap, so NOTHING
            // is queued yet" — the latter must NOT look armed, so it's dimmed.
            const liveSlots = fs.fireAts.filter(
              (t) => Number.isFinite(t) && t > now && t <= now + NTFY_MAX_DELAY_SEC,
            );
            if (liveSlots.length) {
              stamp(cell, 'fs', '', '', fsTitle(fs, now, 'passive'));
              // Closed window: next flip is the window opening for the
              // nearest scheduled slot.
              nextFsFlipAt = Math.min(nextFsFlipAt, Math.min(...liveSlots) - FS_CANCEL_WINDOW_SEC);
            } else {
              // Far future: detected but unschedulable until it enters the cap.
              stamp(cell, 'fs disabled', '', '', fsTitle(fs, now, 'passive'));
              const earliest = Math.min(...fs.fireAts.filter((t) => Number.isFinite(t) && t > now));
              nextFsFlipAt = Math.min(nextFsFlipAt, earliest - NTFY_MAX_DELAY_SEC);
            }
          }
          continue;
        }
      }
    }

    if (adhocOn && Number.isFinite(arrivalAt)) {
      const pa = lastAdhocIntent(pending, id);
      const armed = pa ? pa === 'arm' : armedSet.has(id);
      const syncing = pa !== null ? ' syncing' : '';
      if (armed) {
        const entry = (snapshot?.adhoc || []).find((e) => e.id === id);
        const fireAt = entry?.fireAt ?? fireAtFor(arrivalAt, r.adhocOffsetSec);
        stamp(cell, `armed${syncing}`, 'disarm', '', `Reminder at ${fmtClock(fireAt)} — click to cancel`);
      } else {
        const fireAt = fireAtFor(arrivalAt, r.adhocOffsetSec);
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

  // Re-arm the exact flip timer to the earliest upcoming FS transition.
  // +250 ms lands safely past the boundary; capped at 1 h (the 3 s safety
  // poll covers anything farther out after sleep/clock drift anyway).
  clearFsFlipTimer();
  if (Number.isFinite(nextFsFlipAt)) {
    const delayMs = Math.min(Math.max(nextFsFlipAt - now, 0) * 1000 + 250, 3_600_000);
    fsFlipTimer = setTimeout(() => { fsFlipTimer = null; if (installed) render(); }, delayMs);
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
 * @param {(id: string, offsets: number[], expiresAt: number) => void} [api.cancelFsSlot]
 * @returns {{ dispose: () => void, refresh: () => void }}
 *   `refresh` re-reads the gist mirror and re-renders — call it after a
 *   sync so confirmed state appears without waiting on a storage event.
 */
export const installEventListReminders = ({
  armAdhoc, disarmAdhoc, cancelWave, resendWave, cancelFsSlot = () => {},
}) => {
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
    else if (act === 'cancelFs') {
      // Re-derive from the freshest state at click time — the cancel window
      // may have moved since render, and the slot must still be cancellable.
      const universeId = parseUniverseId(location.host);
      const now = Math.floor(Date.now() / 1000);
      const rawFs = (snapshot?.fleetSave || []).find((e) => e.id === id);
      if (rawFs) {
        const fs = effectiveFs(rawFs, pruneFleetSaveCancel(readFleetSaveCancel(universeId), now)[id]?.offsets);
        const slot = nearestCancellableSlot(fs, now);
        if (slot) {
          const offsets = fsOffsetsToCancel(fs.offsetsSec, slot.offset);
          const expiresAt = Math.max(...offsets.map((o) => fs.arrivalAt + o)) + 60;
          cancelFsSlot(id, offsets, expiresAt);
        }
      }
    } else if (act === 'arm') {
      const arrivalAt = parseInt(row.getAttribute('data-arrival-time') || '', 10);
      if (!Number.isFinite(arrivalAt)) return;
      const offsetSec = reminderConfigStore.get().adhocOffsetSec;
      const fleetId = row.querySelector('.recallFleet')?.getAttribute('data-fleet-id') || undefined;
      armAdhoc({
        id, arrivalAt, offsetSec, fireAt: fireAtFor(arrivalAt, offsetSec),
        label: labelFor(row),
        // Per-leg push metadata (origin/target coords + names, ship count) so
        // ad-hoc bodies share the same wildcard set as fleet-save.
        ...fleetRowMeta(row),
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

  // Fleet-save enable is per-universe (B3b): re-render when it (or the async
  // hydrate of the galaxyScanConfig store) flips so the 🛡 badges appear/clear
  // without a reload.
  let prevFsEnabled = galaxyScanConfigStore.get().fsEnabled;
  const unsubScanConfig = galaxyScanConfigStore.subscribe((next) => {
    if (next.fsEnabled === prevFsEnabled) return;
    prevFsEnabled = next.fsEnabled;
    scheduleRender();
  });

  // Wave enable + schedule + ad-hoc lead time are per-universe: re-render when
  // they (or the async hydrate of the reminderConfig store) change so the wave
  // badges + ad-hoc fire-time tooltips reflect a dashboard edit live.
  let prevReminderConfigSig = pickReminderConfigSig(reminderConfigStore.get());
  const unsubReminderConfig = reminderConfigStore.subscribe((next) => {
    const sig = pickReminderConfigSig(next);
    if (sig === prevReminderConfigSig) return;
    prevReminderConfigSig = sig;
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
      clearFsFlipTimer();
      unsubSettings();
      unsubScanConfig();
      unsubReminderConfig();
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
  JSON.stringify({
    t: s.reminderNtfyToken, m: s.remindersMasterEnabled,
  });

/** @param {ReturnType<typeof reminderConfigStore.get>} r @returns {string} */
const pickReminderConfigSig = (r) =>
  JSON.stringify({ o: r.adhocOffsetSec, e: r.reminderEnabled });

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
