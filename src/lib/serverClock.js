// @ts-check

// OGame server-clock reference.
//
// OGame stamps the page-generation time in `<meta name="ogame-timestamp">`
// (epoch SECONDS) and ticks every in-game countdown off the SERVER clock — so a
// player whose OS clock is wrong still sees correct in-game timers. Any OG-E
// countdown computed as `serverEpochValue - Date.now()` (e.g. an event row's
// `data-arrival-time` minus "now") would instead be skewed by the OS-clock
// error. This module measures the one-time offset (server − local) from that
// meta and exposes {@link serverNow} so our countdowns match the game no matter
// how the OS clock is set.
//
// The offset is measured ONCE (lazily, on first use); elapsed time thereafter
// comes from `Date.now()` deltas, which stay correct even when the absolute
// clock is wrong (the only residual error is the sub-second meta resolution plus
// the page-generation→first-read latency, both negligible against a per-second
// countdown — and vastly smaller than a minutes/hours-wrong OS clock).

import { GAME } from './gameDom.js';

/** Cached server−local offset (ms). `null` until first measured. */
/** @type {number | null} */
let offsetMs = null;

/**
 * Measure (server clock − local clock) in ms from OGame's page-generation
 * timestamp meta. Returns 0 when the meta is absent / unparseable (dev pages,
 * node tests) so callers cleanly degrade to the raw local clock.
 *
 * @returns {number}
 */
const measureOffsetMs = () => {
  const el =
    typeof document !== 'undefined' ? document.querySelector(GAME.META_TIMESTAMP) : null;
  const secs = el ? parseInt(el.getAttribute('content') || '', 10) : NaN;
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return secs * 1000 - Date.now();
};

/**
 * The server↔local clock offset in ms — measured once from the page's
 * `ogame-timestamp` meta, then cached.
 *
 * @returns {number}
 */
export const serverClockOffsetMs = () => {
  if (offsetMs === null) offsetMs = measureOffsetMs();
  return offsetMs;
};

/**
 * "Now" on the OGame SERVER clock (epoch ms) = local clock + the one-time
 * server−local offset. Use this — never a raw `Date.now()` — whenever comparing
 * against a server-epoch value OGame put in the DOM (event `data-arrival-time`,
 * etc.), so the result tracks the game's own timers regardless of the OS clock.
 *
 * @returns {number}
 */
export const serverNow = () => Date.now() + serverClockOffsetMs();

/**
 * Test-only: drop the cached offset so the next {@link serverNow} re-measures.
 * @returns {void}
 */
export const _resetServerClockForTest = () => {
  offsetMs = null;
};
