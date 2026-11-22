// GitHub API call trail — a local, diagnostic-only record of what OG-E asked
// GitHub and what came back, so the NEXT unexplained 403 / rate-limit can be
// reconstructed after the fact.
//
// # Why it exists
//
// A 403 arms a gist backoff that blocks every gist call — the data sync AND
// the alarm clock's arm/disarm (`sync/gist.js` `gh`). The one time it bit, all
// that survived was `oge_lastSyncErr` ("rate limited — backing off"): not which
// request was refused, nor GitHub's headers, nor what burst preceded it. OGame
// reloads on nearly every click, so an in-memory trail would be gone too.
//
// # Two rings, both per-origin localStorage (= per universe)
//
//   - {@link GH_CALL_LOG_KEY}: the last {@link MAX_CALLS} calls, ok or not
//     (method, path, the gist files a PATCH touched, status, latency, GitHub's
//     rate headers, the game page it ran on). Status `0` = network error or
//     timeout; `-1` = refused locally by an active backoff (no request sent).
//   - {@link GH_ERROR_LOG_KEY}: the last {@link MAX_ERRORS} non-ok responses
//     (status ≥ 400), each with the full rate headers, the trimmed body, the
//     backoff it armed, and a copy of the {@link CONTEXT_CALLS} calls that
//     preceded it — so the error ring outlives the call ring's churn.
//
// Nothing here is ever sent anywhere: it never leaves the browser. No tokens
// are recorded (only the API path). Read on demand from DevTools.
//
// Plain key-owner (no reactive store): nothing subscribes; the only writer is
// `gh`, the only reader a human — see CLAUDE.md's store-less key-owner rule.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** localStorage key: ring of the most recent GitHub calls. */
export const GH_CALL_LOG_KEY = 'oge_ghCallLog';
/** localStorage key: ring of the most recent GitHub error responses. */
export const GH_ERROR_LOG_KEY = 'oge_ghErrorLog';

const MAX_CALLS = 60;
const MAX_ERRORS = 20;
const CONTEXT_CALLS = 20;
const BODY_MAX = 400;

/**
 * @typedef {object} GhCall
 * @property {string} at        ISO timestamp the call started.
 * @property {string} method
 * @property {string} path      API path (no host, no token).
 * @property {string[]} [files] Gist file names a write touched (who wrote).
 * @property {number} status    HTTP status; 0 = network/timeout; -1 = blocked by backoff.
 * @property {number} ms        Latency.
 * @property {string} [remaining]  X-RateLimit-Remaining.
 * @property {string} [used]       X-RateLimit-Used.
 * @property {string} [resource]   X-RateLimit-Resource.
 * @property {string} [page]       OGame `page=` the call ran on.
 * @property {string} [note]       Short reason (network error text / backoff).
 */

/**
 * @typedef {GhCall & {
 *   retryAfter?: string, reset?: string, limit?: string,
 *   body: string, backoffMs: number, recent: GhCall[],
 * }} GhError
 */

/** @param {string} key @returns {any[]} */
const readRing = (key) => {
  const v = safeLS.json(key, []);
  return Array.isArray(v) ? v : [];
};

/** @returns {GhCall[]} */
export const readGhCalls = () => readRing(GH_CALL_LOG_KEY);

/** @returns {GhError[]} */
export const readGhErrors = () => readRing(GH_ERROR_LOG_KEY);

/**
 * Append one call to the trail; when `error` is given (a non-ok response),
 * also append an error entry carrying the preceding calls as context.
 * Best-effort: a storage failure must never break the request it describes.
 *
 * @param {GhCall} call
 * @param {{ retryAfter?: string, reset?: string, limit?: string, body: string, backoffMs: number }} [error]
 * @returns {void}
 */
export const recordGhCall = (call, error) => {
  try {
    const calls = [...readGhCalls(), call].slice(-MAX_CALLS);
    safeLS.setJSON(GH_CALL_LOG_KEY, calls);
    if (error) {
      /** @type {GhError} */
      const entry = {
        ...call,
        ...error,
        body: error.body.slice(0, BODY_MAX),
        recent: calls.slice(-CONTEXT_CALLS - 1, -1),
      };
      safeLS.setJSON(GH_ERROR_LOG_KEY, [...readGhErrors(), entry].slice(-MAX_ERRORS));
    }
  } catch {
    // Diagnostic only — never let it fail the call.
  }
};
