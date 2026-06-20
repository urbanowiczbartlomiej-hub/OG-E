// One extension-wide, visibility-aware tick bus.
//
// Before this module every feature that needed a periodic re-paint or a
// safety re-check built its OWN `setInterval`, each running forever,
// regardless of whether the tab was even visible. That's a dozen
// independent timers waking the page while nobody is looking — wasted
// CPU/battery and copy-pasted boilerplate.
//
// `clock` collapses all of that onto a SINGLE `setInterval(BASE_MS)`:
//
//   - Subscribers register a callback + a cadence (`everyMs`). The bus
//     calls each one on the BASE_MS grid, every `everyMs` (rounded up to
//     a whole number of base ticks).
//   - It PAUSES while the tab is hidden. If no subscriber asked to keep
//     running in the background (`whileHidden`), the base interval is
//     stopped ENTIRELY — zero wake-ups while the tab sits in the
//     background. On regaining visibility every subscriber fires once
//     immediately (so frozen countdowns snap to the truth) and ticking
//     resumes.
//   - It is LAZY: the base interval and the `visibilitychange` listener
//     exist only while there is at least one subscriber.
//
// Pausing is CORRECTNESS, not a regression: a re-paint nobody can see is
// pure waste, and the snap-on-regain restores truth the moment it
// matters. The fast path for "react to a DOM change" stays the feature's
// `MutationObserver` (observers are not throttled by visibility); the
// clock is the slow, periodic backstop / repaint cadence.
//
// Foundation module: depends on `logger` only (to isolate a throwing
// subscriber without silently swallowing the error). No DOM writes, no
// app-layer imports.

import { logger } from './logger.js';

/** Base granularity. Every cadence is rounded up to a multiple of this. */
const BASE_MS = 1000;

/**
 * Jitter tolerance. Real `setInterval` ticks drift by a few ms; without a
 * little slack a 5000 ms subscriber could miss the tick that lands at
 * 4999 ms and fire a whole base tick late. Half a base tick is generous
 * and can never cause a double-fire (subscribers are >= BASE_MS apart).
 */
const EPS_MS = BASE_MS / 2;

/**
 * @typedef {object} Subscription
 * @property {() => void} cb         Callback invoked on each due tick.
 * @property {number} everyMs        Cadence (already snapped to the grid).
 * @property {boolean} whileHidden   Keep firing while `document.hidden`.
 * @property {number} lastAt         Timestamp of the last invocation.
 */

/**
 * @typedef {object} ClockDeps
 * @property {() => number} [now]                     Defaults to `Date.now`.
 * @property {(fn: () => void, ms: number) => unknown} [setInterval]
 * @property {(id: unknown) => void} [clearInterval]
 * @property {{ hidden: boolean,
 *   addEventListener: (t: string, h: () => void) => void,
 *   removeEventListener: (t: string, h: () => void) => void } | undefined} [doc]
 *   Visibility source. Defaults to the global `document`.
 */

/**
 * Build a clock. The default singleton (`clock`, below) is wired to the
 * real globals; tests construct their own with fakes via `createClock`.
 *
 * The global timer/`now` accessors are read LAZILY (at call time, through
 * `globalThis`) so the singleton — created at module load — still honours
 * fake timers installed later by a test.
 *
 * @param {ClockDeps} [deps]
 * @returns {{ subscribe: (cb: () => void, opts?: { everyMs?: number, whileHidden?: boolean }) => () => void,
 *   _dispose: () => void }}
 */
export const createClock = (deps = {}) => {
  const now = deps.now ?? (() => Date.now());
  const setIv = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIv = deps.clearInterval ?? ((id) => globalThis.clearInterval(/** @type {number} */ (id)));
  const doc = deps.doc ?? (typeof document !== 'undefined' ? document : undefined);

  /** @type {Set<Subscription>} */
  const subs = new Set();
  /** @type {unknown} */
  let intervalId = null;
  let visBound = false;

  const isHidden = () => !!doc?.hidden;
  const eligible = (/** @type {Subscription} */ s) => s.whileHidden || !isHidden();

  const fire = (/** @type {Subscription} */ s, /** @type {number} */ t) => {
    s.lastAt = t;
    try {
      s.cb();
    } catch (err) {
      // Isolate: one feature's throwing callback must not starve the
      // others on the shared bus. Surface it through the (gated) logger.
      logger.error('clock subscriber threw', err);
    }
  };

  const onTick = () => {
    const t = now();
    for (const s of subs) {
      if (eligible(s) && t - s.lastAt + EPS_MS >= s.everyMs) fire(s, t);
    }
  };

  // Start the base interval iff some subscriber is eligible to run right
  // now; otherwise stop it. Called after every membership/visibility change.
  const ensureRunning = () => {
    let wanted = false;
    for (const s of subs) {
      if (eligible(s)) {
        wanted = true;
        break;
      }
    }
    if (wanted && intervalId === null) {
      intervalId = setIv(onTick, BASE_MS);
    } else if (!wanted && intervalId !== null) {
      clearIv(intervalId);
      intervalId = null;
    }
  };

  const onVisibility = () => {
    // Regained visibility: snap every subscriber to truth before resuming
    // the normal cadence (the whole point of pausing is invisible to the
    // user). Harmless extra fire for `whileHidden` subs — callbacks are
    // idempotent re-paints.
    if (!isHidden()) {
      const t = now();
      for (const s of subs) fire(s, t);
    }
    ensureRunning();
  };

  const bindVis = () => {
    if (visBound || !doc) return;
    doc.addEventListener('visibilitychange', onVisibility);
    visBound = true;
  };
  const unbindVis = () => {
    if (!visBound || !doc) return;
    doc.removeEventListener('visibilitychange', onVisibility);
    visBound = false;
  };

  return {
    /**
     * @param {() => void} cb
     * @param {{ everyMs?: number, whileHidden?: boolean }} [opts]
     *   `everyMs` is rounded UP to a multiple of BASE_MS (min BASE_MS).
     *   `whileHidden` (default false) keeps the subscriber ticking while
     *   the tab is hidden.
     * @returns {() => void} Idempotent unsubscribe.
     */
    subscribe: (cb, opts = {}) => {
      const requested = opts.everyMs ?? BASE_MS;
      const everyMs = Math.max(BASE_MS, Math.ceil(requested / BASE_MS) * BASE_MS);
      /** @type {Subscription} */
      const s = { cb, everyMs, whileHidden: !!opts.whileHidden, lastAt: now() };
      subs.add(s);
      bindVis();
      ensureRunning();
      return () => {
        if (!subs.delete(s)) return;
        ensureRunning();
        if (subs.size === 0) unbindVis();
      };
    },

    /** Stop everything and forget all subscribers. For test resets. */
    _dispose: () => {
      if (intervalId !== null) {
        clearIv(intervalId);
        intervalId = null;
      }
      subs.clear();
      unbindVis();
    },
  };
};

/** The shared, extension-wide clock. Features subscribe to this. */
export const clock = createClock();
