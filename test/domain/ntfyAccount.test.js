// @ts-check

import { describe, it, expect } from 'vitest';
import {
  formatNtfyAccountStatus,
  formatNtfyAccountLines,
} from '../../src/domain/ntfyAccount.js';

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

describe('formatNtfyAccountLines', () => {
  it('reuses the error ladder as the head, with no detail, on failure', () => {
    expect(formatNtfyAccountLines({ ok: false, status: 0, error: 'badtoken' })).toEqual({
      ok: false,
      head: '✗ Not a valid token (expected tk_…)',
      detail: [],
    });
    expect(formatNtfyAccountLines({ ok: false, status: 401, error: 'http' })).toEqual({
      ok: false,
      head: '✗ Token rejected by ntfy.sh (HTTP 401)',
      detail: [],
    });
  });

  it('treats a nullish result as a failure', () => {
    expect(
      formatNtfyAccountLines(/** @type {any} */ (null)),
    ).toEqual({ ok: false, head: '✗ ntfy.sh error', detail: [] });
  });

  it('shows a ✓ head plus login·tier and usage lines on success', () => {
    expect(
      formatNtfyAccountLines({
        ok: true,
        status: 200,
        username: 'alice',
        tier: 'Supporter',
        used: 12,
        remaining: 238,
        limit: 250,
      }),
    ).toEqual({
      ok: true,
      head: '✓ Valid',
      detail: ['alice · Supporter', '12 / 250 messages · 238 left'],
    });
  });

  it('omits the "left" suffix when remaining is absent', () => {
    expect(
      formatNtfyAccountLines({ ok: true, status: 200, username: 'bob', used: 5, limit: 100 }),
    ).toEqual({ ok: true, head: '✓ Valid', detail: ['bob', '5 / 100 messages'] });
  });

  it('shows the login alone when only a username is present', () => {
    expect(formatNtfyAccountLines({ ok: true, status: 200, username: 'carol' })).toEqual({
      ok: true,
      head: '✓ Valid',
      detail: ['carol'],
    });
  });

  it('shows the tier alone when only a tier is present', () => {
    expect(formatNtfyAccountLines({ ok: true, status: 200, tier: 'Pro' })).toEqual({
      ok: true,
      head: '✓ Valid',
      detail: ['Pro'],
    });
  });

  it('yields a ✓ head with no detail when no identity or usage fields are present', () => {
    expect(formatNtfyAccountLines({ ok: true, status: 200 })).toEqual({
      ok: true,
      head: '✓ Valid',
      detail: [],
    });
  });
});
