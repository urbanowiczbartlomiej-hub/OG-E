// Unit tests for the gzip+base64 codec.
//
// Exercises the full encode/decode roundtrip across the shapes we actually
// send to a Gist: ASCII, Unicode, JSON, and a 100 KB repetitive blob that
// forces the chunked base64 builder to take more than one pass. Also pins
// the output alphabet (RFC 4648 base64) and the two failure modes that
// callers must handle: malformed base64 and well-formed base64 whose
// bytes are not a gzip stream.
//
// Runs under vitest's default (Node) environment — `CompressionStream`,
// `DecompressionStream`, `Blob`, `Response`, `btoa` and `atob` are all
// native globals in Node 18+.

/** @ts-check */

import { describe, it, expect } from 'vitest';
import { gzipEncode, gzipDecode } from '../../src/lib/gzip.js';

describe('gzip codec', () => {
  it('roundtrips the empty string', async () => {
    const encoded = await gzipEncode('');
    expect(typeof encoded).toBe('string');
    expect(await gzipDecode(encoded)).toBe('');
  });

  it('roundtrips plain ASCII', async () => {
    const encoded = await gzipEncode('hello world');
    expect(await gzipDecode(encoded)).toBe('hello world');
  });

  it('roundtrips Polish Unicode (multi-byte UTF-8)', async () => {
    const input = 'żółć — śląsk, łódź';
    const encoded = await gzipEncode(input);
    expect(await gzipDecode(encoded)).toBe(input);
  });

  it('roundtrips a JSON payload without mutating structure', async () => {
    const data = { a: 1, b: [1, 2, 3], c: { nested: 'foo' } };
    const encoded = await gzipEncode(JSON.stringify(data));
    const parsed = JSON.parse(await gzipDecode(encoded));
    expect(parsed).toEqual(data);
  });

  it('roundtrips a long repetitive input (exercises chunked base64 builder)', async () => {
    // 100_000 identical chars > CHUNK (32 KiB) so the encoder loops
    // multiple times over the base64 builder, and the compressed blob
    // itself is small (repetitive input compresses hard).
    const big = 'a'.repeat(100_000);
    const encoded = await gzipEncode(big);
    // gzip of 100k repeated bytes lands well under 2 KB once base64-padded.
    expect(encoded.length).toBeLessThan(2000);
    expect(await gzipDecode(encoded)).toBe(big);
  });

  it('produces output that matches the base64 alphabet', async () => {
    const encoded = await gzipEncode('sample payload for alphabet check');
    // RFC 4648 base64: upper, lower, digits, `+`, `/`, `=` padding.
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('rejects when the input is not valid base64', async () => {
    // `!` is outside the base64 alphabet; `atob` throws InvalidCharacterError.
    await expect(gzipDecode('not-valid-base64!!!')).rejects.toThrow();
  });

  it('rejects when the bytes decode from base64 but are not a gzip stream', async () => {
    // Valid base64 of the literal string "hello" — the bytes decode fine
    // but lack the gzip magic number, so `DecompressionStream` errors out
    // while the pipeline is consumed.
    await expect(gzipDecode(btoa('hello'))).rejects.toThrow();
  });
});
