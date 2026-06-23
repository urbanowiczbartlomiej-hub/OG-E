// @ts-check

// ntfy.sh account probe — the ONE network call behind the Settings panel's
// "ntfy.sh — account status" row. Fetches the signed-in account so the
// panel can (a) confirm the entered token is actually accepted by ntfy and
// (b) show today's message usage against the daily limit.
//
// # Auth: query param, not header
//
// Reuses `ntfyAuthParam` from `ntfyReconciler.js` — the SAME base64
// `?auth=` query param the publish/poll/cancel calls use. This is not a
// stylistic choice: Firefox content scripts can't send an `Authorization`
// header to ntfy.sh even with `host_permissions`, because ntfy's CORS
// `Access-Control-Allow-Headers: *` does not (per the Fetch spec) cover
// `Authorization`. The query param sidesteps the preflight entirely. See
// the long note above `ntfyAuthParam` for the full story.
//
// # Output shape
//
// Returns a normalised {@link import('../domain/ntfyAccount.js').NtfyAccountResult}
// so the pure formatter (`domain/ntfyAccount.js`) decides the displayed
// line. This module owns ONLY the I/O + field extraction; all wording and
// the validation ladder live in the domain so they're testable without a
// network.

import { ntfyAuthParam } from './ntfyReconciler.js';
import { isValidNtfyToken } from './alarmClock.js';

/** ntfy account endpoint. The token authorises it via the `auth` query param. */
const ACCOUNT_URL = 'https://ntfy.sh/v1/account';

/**
 * Probe the ntfy.sh account for `token`. Never throws — every failure mode
 * is mapped onto a result object the formatter can render:
 *
 *   - syntactically invalid token  → `{ ok:false, error:'badtoken' }` (no request)
 *   - fetch rejected (offline/CORS) → `{ ok:false, error:'network' }`
 *   - non-2xx                       → `{ ok:false, error:'http', status }`
 *   - 2xx but unparseable body      → `{ ok:false, error:'parse', status }`
 *   - 2xx OK                        → `{ ok:true, used, remaining, limit, tier, username }`
 *
 * @param {string} token  ntfy.sh access token (`tk_…`).
 * @returns {Promise<import('../domain/ntfyAccount.js').NtfyAccountResult>}
 */
export const fetchNtfyAccount = async (token) => {
  // Cheapest signal first: don't spend a request on a token that can't be
  // valid. Mirrors the client-side gate the rest of the section uses.
  if (!isValidNtfyToken(token)) return { ok: false, status: 0, error: 'badtoken' };

  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${ACCOUNT_URL}?${ntfyAuthParam(token)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { ok: false, status: 0, error: 'network' };
  }

  if (!res.ok) return { ok: false, status: res.status, error: 'http' };

  /** @type {any} */
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status, error: 'parse' };
  }

  // Defensive reads: ntfy may add/rename fields, and free/unlimited tiers
  // can omit usage entirely. The formatter degrades to "Token valid" when
  // the numeric fields are absent.
  /** @param {unknown} v @returns {number | undefined} */
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    ok: true,
    status: res.status,
    used: num(body?.stats?.messages),
    remaining: num(body?.stats?.messages_remaining),
    limit: num(body?.limits?.messages),
    tier:
      (typeof body?.tier?.name === 'string' && body.tier.name) ||
      (typeof body?.role === 'string' && body.role) ||
      undefined,
    username: typeof body?.username === 'string' ? body.username : undefined,
  };
};
