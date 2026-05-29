// @ts-check

// Unit test for the deterministic ntfy-topic derivation.
//
// The topic is SHA-256(ntfyToken), `oge-` + first 22 hex chars. It is
// derived from the ntfy access token (not the gist id — changed in
// v1.8.0) so the push channel belongs to the ntfy account and is
// independent of cloud-sync setup. The hash is one-way, so the public
// topic never reveals the token.
//
// The golden vector below pins the algorithm (hash + slice) so a future
// refactor that "improves" it trips this test loudly — every device must
// compute the same topic from the same token or pushes route to the
// wrong channel.

import { describe, it, expect } from 'vitest';
import { deriveNtfyTopic } from '../../src/sync/reminders.js';

describe('deriveNtfyTopic', () => {
  it('returns an empty string for an empty token', async () => {
    expect(await deriveNtfyTopic('')).toBe('');
  });

  it('produces an oge-prefixed 22-hex-char topic of stable shape', async () => {
    const t = await deriveNtfyTopic('tk_tbqdljrkz4ivlgagxwewjz17k26gw');
    expect(t).toMatch(/^oge-[0-9a-f]{22}$/);
  });

  it('is deterministic — same token → same topic', async () => {
    const token = 'tk_tbqdljrkz4ivlgagxwewjz17k26gw';
    const a = await deriveNtfyTopic(token);
    const b = await deriveNtfyTopic(token);
    expect(a).toBe(b);
  });

  it('differs for different tokens', async () => {
    const a = await deriveNtfyTopic('tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = await deriveNtfyTopic('tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaab');
    expect(a).not.toBe(b);
  });

  it('golden vector: pin the hash + slice so every device agrees', async () => {
    // sha256("tk_tbqdljrkz4ivlgagxwewjz17k26gw"), first 22 hex chars,
    // prefixed with `oge-`. If you change the algorithm, every existing
    // user re-homes to a new topic — change this value deliberately.
    const token = 'tk_tbqdljrkz4ivlgagxwewjz17k26gw';
    const expected = 'oge-' + (await sha256Hex(token)).slice(0, 22);
    expect(await deriveNtfyTopic(token)).toBe(expected);
  });
});

/** @param {string} s @returns {Promise<string>} */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
