// Opt-in diagnostic logger — off by default, enabled from Settings.
//
// v5 deliberately keeps DevTools quiet in the common case. When a user
// hits a bug and the support channel asks "send us the console", we
// want a single toggle that (a) starts echoing our events to the real
// console with a recognizable `[OG-E v5]` prefix and (b) captures the
// last ~500 events in a ring buffer the user can grab straight from
// DevTools (`logger.getEntries()`) for paste-back. When the toggle is
// off, every call site turns into an early-return no-op: no buffering,
// no console chatter, no measurable cost.
//
// Privacy / persistence split (DESIGN.md §15, P6):
//   - The `enabled` FLAG IS persisted (localStorage, `oge5_debugLoggerEnabled`)
//     so the preference survives reload. It's a single boolean and
//     carries no user data.
//   - The ring BUFFER is strictly in-memory. We never serialize captured
//     args to disk or to chromeStore. If the user closes the tab, the
//     buffer is gone. The user copies what they need from DevTools while
//     the session is live; we never exfiltrate anything implicitly.
//
// Reactive store shape: `loggerEnabled` is a real `Store<boolean>` so
// the Settings UI can subscribe, render the checkbox live, and flip
// state with `.set(...)`. A subscriber wired up at module load writes
// every flip back to localStorage; that's the whole persistence story.
//
// @ts-check

import { createStore } from './createStore.js';
import { safeLS } from './storage.js';

/**
 * @typedef {object} LogEntry
 * @property {number} timestamp
 *   Wall-clock capture time in ms since the Unix epoch (`Date.now()`),
 *   recorded at the moment `push` runs — i.e. after the enabled check
 *   passed, before we forward to the real console.
 * @property {'log' | 'warn' | 'error'} level
 *   Which `logger.*` method produced this entry. Mirrors the console
 *   method we forward to.
 * @property {unknown[]} args
 *   The raw varargs as passed to `logger.log(...)` / `.warn(...)` /
 *   `.error(...)`. NOT cloned — if a caller mutates an object they
 *   logged, the entry sees the mutation. Matches how `console.*` works.
 */

const ENABLED_KEY = 'oge5_debugLoggerEnabled';
const PREFIX = '[OG-E v5]';
const MAX_ENTRIES = 500;

/** @type {LogEntry[]} */
let entries = [];

/**
 * Reactive store holding the logger's on/off flag.
 *
 * Initialized from `localStorage` on module load (default: `false`, i.e.
 * logging is off unless the user has explicitly opted in in a prior
 * session). The subscriber registered directly below auto-persists every
 * future change back to `localStorage` under {@linkcode ENABLED_KEY}, so
 * Settings UI can just call `loggerEnabled.set(true/false)` without
 * worrying about I/O.
 *
 * @type {import('./createStore.js').Store<boolean>}
 */
export const loggerEnabled = createStore(safeLS.bool(ENABLED_KEY, false));

// Auto-persist: every flip of the flag writes the new value to
// localStorage. `safeLS.set` coerces via String(), so the stored form is
// exactly `'true'` / `'false'` — the same strings `safeLS.bool` reads
// back on the next module load.
loggerEnabled.subscribe((enabled) => {
  safeLS.set(ENABLED_KEY, String(enabled));
});

/**
 * Append one entry to the ring buffer and forward to the real console.
 * Fast-path early-return when the flag is off — this is the hot path
 * for every `logger.*` call site in disabled-state.
 *
 * @param {'log' | 'warn' | 'error'} level Which console method to invoke.
 * @param {unknown[]} args Raw varargs from the public `logger.*` wrapper.
 * @returns {void}
 */
const push = (level, args) => {
  if (!loggerEnabled.get()) return;

  entries.push({ timestamp: Date.now(), level, args });

  // Trim with a single `splice` instead of a `while (entries.length >
  // MAX) entries.shift()` loop. Each `shift` is O(n) because it
  // re-indexes every remaining element; repeating it `k` times for a
  // `k`-element overshoot is O(n * k). A single splice is O(n) total
  // regardless of overshoot. In steady state `k === 1`, but this also
  // keeps us honest if a batch of entries lands before the check runs.
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  console[level](PREFIX, ...args);
};

/**
 * Public logger namespace. All methods are safe to call at any time;
 * the gating happens inside {@linkcode push}.
 *
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} log
 *   Capture + forward to `console.log` when enabled; no-op otherwise.
 * @property {(...args: unknown[]) => void} warn
 *   Capture + forward to `console.warn` when enabled; no-op otherwise.
 * @property {(...args: unknown[]) => void} error
 *   Capture + forward to `console.error` when enabled; no-op otherwise.
 * @property {() => LogEntry[]} getEntries
 *   Return a shallow copy of the ring buffer. Callers can mutate the
 *   returned array freely — internal state is unaffected. Entries
 *   themselves are NOT deep-cloned (see {@link LogEntry.args}).
 * @property {() => void} clear
 *   Empty the ring buffer in place. Does NOT touch {@link loggerEnabled}
 *   or localStorage — enabling/disabling is orthogonal to buffer state.
 * @property {() => void} enable
 *   Convenience wrapper for `loggerEnabled.set(true)`.
 * @property {() => void} disable
 *   Convenience wrapper for `loggerEnabled.set(false)`.
 */

/** @type {Logger} */
export const logger = {
  /**
   * @param {...unknown} args Values to capture and forward as a single
   *   `console.log(PREFIX, ...args)` call.
   */
  log: (...args) => push('log', args),

  /**
   * @param {...unknown} args Values to capture and forward as a single
   *   `console.warn(PREFIX, ...args)` call.
   */
  warn: (...args) => push('warn', args),

  /**
   * @param {...unknown} args Values to capture and forward as a single
   *   `console.error(PREFIX, ...args)` call.
   */
  error: (...args) => push('error', args),

  // `slice()` with no args returns a fresh array with the same
  // references — exactly the "shallow copy" semantics we want. A
  // subsequent `snap.push(...)` / `snap.splice(...)` by the caller does
  // not touch our internal `entries`.
  getEntries: () => entries.slice(),

  // Reassignment rather than `entries.length = 0`: either works for
  // clearing, but reassignment leaves any outstanding snapshot the
  // caller already holds (from `getEntries()`) untouched. We already
  // hand out copies, so this is defensive more than necessary, but it
  // keeps the mental model "each snapshot is its own array" airtight.
  clear: () => {
    entries = [];
  },

  enable: () => loggerEnabled.set(true),
  disable: () => loggerEnabled.set(false),
};
