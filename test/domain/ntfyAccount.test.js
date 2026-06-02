// @ts-check

import { describe, it, expect } from 'vitest';
import { formatNtfyAccountStatus } from '../../src/domain/ntfyAccount.js';

describe('formatNtfyAccountStatus', () => {
  it('shows usage against the limit on success (concise, no remaining/tier)', () => {
    expect(
      formatNtfyAccountStatus({ ok: true, status: 200, used: 12, remaining: 238, limit: 250 }),
    ).toBe('✓ 12 / 250 messages used');
    // Tier present but deliberately not shown — keeps the line short.
    expect(
      formatNtfyAccountStatus({ ok: true, status: 200, used: 0, limit: 250, tier: 'Supporter' }),
    ).toBe('✓ 0 / 250 messages used');
  });

  it('falls back to "Token valid" when usage fields are absent', () => {
    expect(formatNtfyAccountStatus({ ok: true, status: 200 })).toBe('✓ Token valid');
    expect(formatNtfyAccountStatus({ ok: true, status: 200, tier: 'user' })).toBe('✓ Token valid');
  });

  it('flags a malformed token without implying a server verdict', () => {
    expect(formatNtfyAccountStatus({ ok: false, status: 0, error: 'badtoken' })).toBe(
      '✗ Not a valid token (expected tk_…)',
    );
  });

  it('flags a server-rejected token', () => {
    expect(formatNtfyAccountStatus({ ok: false, status: 401, error: 'http' })).toBe(
      '✗ Token rejected by ntfy.sh (HTTP 401)',
    );
    expect(formatNtfyAccountStatus({ ok: false, status: 403, error: 'http' })).toBe(
      '✗ Token rejected by ntfy.sh (HTTP 403)',
    );
  });

  it('distinguishes unreachable from other HTTP errors', () => {
    expect(formatNtfyAccountStatus({ ok: false, status: 0, error: 'network' })).toBe(
      '✗ Could not reach ntfy.sh (offline / blocked)',
    );
    expect(formatNtfyAccountStatus({ ok: false, status: 500, error: 'http' })).toBe(
      '✗ ntfy.sh error (HTTP 500)',
    );
    expect(formatNtfyAccountStatus({ ok: false, status: 200, error: 'parse' })).toBe(
      '✗ Unexpected response from ntfy.sh',
    );
  });
});
