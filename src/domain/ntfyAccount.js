// @ts-check

// Pure presentation of an ntfy.sh account probe (see
// `sync/ntfyAccount.js` for the I/O that produces the input). Lives in the
// domain layer so the validation/usage ladder is unit-testable with no
// network: feed it a plain result object, assert the displayed line.
//
// # Why a ladder
//
// Before this, a wrong token failed silently — the player never learned
// their pushes weren't being attributed. The status line under the token
// field turns that into explicit feedback, from cheapest signal to richest:
//
//   1. malformed token   — caught client-side, no request made
//   2. rejected (401/403) — token reached ntfy and was refused
//   3. unreachable        — network / CORS / offline
//   4. other HTTP error   — anything else non-2xx
//   5. OK                 — show today's message usage against the limit

/**
 * One normalised probe result, as returned by `fetchNtfyAccount`.
 *
 * @typedef {object} NtfyAccountResult
 * @property {boolean} ok          True only for a 2xx with parseable body.
 * @property {number}  status      HTTP status, or 0 when the request never landed.
 * @property {'badtoken'|'network'|'parse'|'http'} [error]
 *   Set when `ok` is false; distinguishes the failure modes above.
 * @property {number} [used]       Messages used in the current period.
 * @property {number} [remaining]  Messages still allowed in the period.
 * @property {number} [limit]      Period message cap.
 * @property {string} [tier]       Account tier / role name, when present.
 * @property {string} [username]   Signed-in account login, when present.
 */

/**
 * Render a {@link NtfyAccountResult} as a single status line for the
 * Settings panel. `✓`/`✗` prefix so success vs failure reads at a glance.
 *
 * @param {NtfyAccountResult} r
 * @returns {string}
 */
export const formatNtfyAccountStatus = (r) => {
  if (!r || !r.ok) {
    switch (r && r.error) {
      case 'badtoken':
        return '✗ Not a valid token (expected tk_…)';
      case 'network':
        return '✗ Could not reach ntfy.sh (offline / blocked)';
      case 'parse':
        return '✗ Unexpected response from ntfy.sh';
      default: {
        const status = r && r.status ? ` (HTTP ${r.status})` : '';
        if (r && (r.status === 401 || r.status === 403)) {
          return `✗ Token rejected by ntfy.sh${status}`;
        }
        return `✗ ntfy.sh error${status}`;
      }
    }
  }

  /** @param {unknown} n */
  /** @param {unknown} n */
  const has = (n) => typeof n === 'number' && Number.isFinite(n);
  // Kept deliberately short — the value column is narrow, so we show only
  // the used/limit ratio. Remaining is implied (limit − used) and the tier
  // name isn't actionable, so both are dropped to keep this one line.
  if (has(r.used) && has(r.limit)) {
    return `✓ ${r.used} / ${r.limit} messages used`;
  }
  // 2xx but the body lacked the usage fields (schema drift / unlimited tier).
  return '✓ Token valid';
};

/**
 * Richer multi-line variant for the OG-E Dashboard's Reminders tab, where the
 * value column is wide enough to show the account login + tier and the message
 * usage UNDER a `✓ Valid` head. A failure reuses {@link formatNtfyAccountStatus}'s
 * error ladder as the head, with no detail lines. Pure — feed it a result,
 * assert the head + lines.
 *
 * @param {NtfyAccountResult} r
 * @returns {{ ok: boolean, head: string, detail: string[] }}
 */
export const formatNtfyAccountLines = (r) => {
  if (!r || !r.ok) return { ok: false, head: formatNtfyAccountStatus(r), detail: [] };
  /** @param {unknown} n */
  const num = (n) => typeof n === 'number' && Number.isFinite(n);
  /** @type {string[]} */
  const detail = [];
  const who = typeof r.username === 'string' ? r.username : '';
  const tier = typeof r.tier === 'string' ? r.tier : '';
  if (who && tier) detail.push(`${who} · ${tier}`);
  else if (who) detail.push(who);
  else if (tier) detail.push(tier);
  if (num(r.used) && num(r.limit)) {
    const left = num(r.remaining) ? ` · ${r.remaining} left` : '';
    detail.push(`${r.used} / ${r.limit} messages${left}`);
  }
  return { ok: true, head: '✓ Valid', detail };
};
