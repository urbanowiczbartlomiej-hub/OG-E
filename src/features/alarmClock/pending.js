// @ts-check

// Reload-safe pending-intent queue for the event-list alarmClock actions.
//
// # The problem it solves
//
// OGame is not an SPA: every click hits the PHP server and reloads the
// page, tearing down the content script. Our gist + ntfy round-trip takes
// a few seconds, so a player who arms a alarmClock and immediately clicks
// elsewhere would lose it — the async sync never finished before the
// reload.
//
// So the moment the user acts, we write the INTENT (a small serialisable
// command) SYNCHRONOUSLY to localStorage, keyed per universe. Two readers:
//
//   - the producer drains the queue on its next run, folds the commands
//     into the gist sync, and clears the ones it applied (only on a
//     successful write — a failed sync leaves them for the next load to
//     retry);
//   - the event-list UI reads the queue every render so a just-clicked
//     cell shows a "syncing" state that survives re-renders AND the page
//     reload, flipping to "armed/cancelled" only once the gist mirror
//     confirms ntfy actually holds (or dropped) the message.
//
// Commands are data, not closures, precisely so they can round-trip
// through localStorage and a page reload.
//
// @see ./producer.js  — drains + applies the queue
// @see ./eventList.js — renders the "syncing" state from it

import { safeLS } from '../../lib/storage.js';

/** @typedef {import('../../domain/adhoc.js').AdhocAlarmClock} AdhocAlarmClock */
/** @typedef {import('../../domain/waves.js').Wave} Wave */

/**
 * One queued user action. Serialisable (survives localStorage + reload).
 *
 * @typedef {(
 *   { kind: 'arm', entry: AdhocAlarmClock } |
 *   { kind: 'disarm', id: string } |
 *   { kind: 'cancelWave', waveId: string } |
 *   { kind: 'resendWave', waveId: string }
 * )} PendingCommand
 */

/** @param {string} universeId @returns {string} */
const keyFor = (universeId) => `oge_alarmClockPending_${universeId}`;

/**
 * Read the queued commands for a universe (always an array).
 *
 * @param {string} universeId
 * @returns {PendingCommand[]}
 */
export const readPending = (universeId) => {
  const v = safeLS.json(keyFor(universeId), []);
  return Array.isArray(v) ? v : [];
};

/**
 * Replace the queue. Removes the key entirely when empty so a clean state
 * leaves no localStorage cruft.
 *
 * @param {string} universeId
 * @param {PendingCommand[]} cmds
 * @returns {void}
 */
export const writePending = (universeId, cmds) => {
  if (cmds.length) safeLS.setJSON(keyFor(universeId), cmds);
  else safeLS.remove(keyFor(universeId));
};

/**
 * Append one command (synchronous — the whole point is that it lands
 * before any navigation).
 *
 * @param {string} universeId
 * @param {PendingCommand} cmd
 * @returns {void}
 */
export const pushPending = (universeId, cmd) => {
  const cur = readPending(universeId);
  cur.push(cmd);
  writePending(universeId, cur);
};

/**
 * Fold the ad-hoc commands (`arm` / `disarm`) into an entry list. Pure.
 *
 * @param {AdhocAlarmClock[]} entries
 * @param {PendingCommand[]} cmds
 * @returns {AdhocAlarmClock[]}
 */
export const applyAdhocCmds = (entries, cmds) => {
  let out = entries;
  for (const c of cmds) {
    if (c.kind === 'arm') {
      out = out.some((e) => e.id === c.entry.id)
        ? out.map((e) => (e.id === c.entry.id ? c.entry : e))
        : [...out, c.entry];
    } else if (c.kind === 'disarm') {
      out = out.filter((e) => e.id !== c.id);
    }
  }
  return out;
};

/**
 * Fold the wave commands (`cancelWave` / `resendWave`) into a wave list:
 * cancel tombstones, resend lifts the tombstone so the series reschedules.
 * Pure.
 *
 * @param {Wave[]} waves
 * @param {PendingCommand[]} cmds
 * @returns {Wave[]}
 */
export const applyWaveCmds = (waves, cmds) => {
  let out = waves;
  for (const c of cmds) {
    if (c.kind === 'cancelWave') {
      out = out.map((w) => (w.id === c.waveId ? { ...w, cancelled: true } : w));
    } else if (c.kind === 'resendWave') {
      out = out.map((w) => (w.id === c.waveId ? { ...w, cancelled: false } : w));
    }
  }
  return out;
};

/**
 * Last pending command kind touching an ad-hoc row id, or null. The UI
 * uses it to pick the optimistic "syncing" look (arm-ish vs idle-ish).
 *
 * @param {PendingCommand[]} cmds
 * @param {string} id
 * @returns {'arm' | 'disarm' | null}
 */
export const lastAdhocIntent = (cmds, id) => {
  let out = /** @type {'arm' | 'disarm' | null} */ (null);
  for (const c of cmds) {
    if (c.kind === 'arm' && c.entry.id === id) out = 'arm';
    else if (c.kind === 'disarm' && c.id === id) out = 'disarm';
  }
  return out;
};

/**
 * Last pending command kind touching a wave id, or null.
 *
 * @param {PendingCommand[]} cmds
 * @param {string} waveId
 * @returns {'cancelWave' | 'resendWave' | null}
 */
export const lastWaveIntent = (cmds, waveId) => {
  let out = /** @type {'cancelWave' | 'resendWave' | null} */ (null);
  for (const c of cmds) {
    if ((c.kind === 'cancelWave' || c.kind === 'resendWave') && c.waveId === waveId) out = c.kind;
  }
  return out;
};
