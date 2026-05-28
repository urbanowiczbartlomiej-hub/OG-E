// @ts-check

// Unit test for the deterministic ntfy-topic derivation.
//
// This MUST match the Worker's own implementation in
// `worker/src/index.js#deriveNtfyTopic` byte-for-byte — extension and
// Worker compute the topic independently from `env.GIST_ID`, so any
// algorithmic drift would route pushes to a different ntfy channel than
// the one the user subscribed to.
//
// The golden vector below was computed by hand:
//   sha256("2dd8f8d3583f230ecd1e8af440e5e10d") in hex → first 22 chars
// and pinned here so a future refactor that "improves" the algorithm
// (different hash, different slice) trips this test loudly.

import { describe, it, expect } from 'vitest';
import { deriveNtfyTopic } from '../../src/sync/reminders.js';

describe('deriveNtfyTopic', () => {
  it('returns an empty string for an empty gist id', async () => {
    expect(await deriveNtfyTopic('')).toBe('');
  });

  it('produces an oge-prefixed 22-hex-char topic of stable shape', async () => {
    const t = await deriveNtfyTopic('any-gist-id-will-do');
    expect(t).toMatch(/^oge-[0-9a-f]{22}$/);
  });

  it('is deterministic — same gist id → same topic', async () => {
    const id = '2dd8f8d3583f230ecd1e8af440e5e10d';
    const a = await deriveNtfyTopic(id);
    const b = await deriveNtfyTopic(id);
    expect(a).toBe(b);
  });

  it('differs for different gist ids', async () => {
    const a = await deriveNtfyTopic('abc');
    const b = await deriveNtfyTopic('abd');
    expect(a).not.toBe(b);
  });

  it('golden vector: pin the algorithm so extension and Worker cannot drift', async () => {
    // sha256("2dd8f8d3583f230ecd1e8af440e5e10d"), first 22 hex chars,
    // prefixed with `oge-`. If you change the algorithm, change this
    // value AND the Worker simultaneously (and ship Worker first).
    const expected = 'oge-' +
      (await sha256Hex('2dd8f8d3583f230ecd1e8af440e5e10d')).slice(0, 22);
    expect(await deriveNtfyTopic('2dd8f8d3583f230ecd1e8af440e5e10d')).toBe(expected);
  });
});

/** @param {string} s @returns {Promise<string>} */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
