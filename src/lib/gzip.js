// Gzip + base64 codec for Gist payload text fields.
//
// OG-E persists user state (feature settings, long-lived caches) into a
// GitHub Gist whose `content` field accepts only text. Raw JSON is bulky
// and embarrassingly compressible — feature configs repeat keys, caches
// repeat planet names and resource IDs — so we gzip first and then base64
// the bytes to get back to ASCII-safe text.
//
// Pipeline (encode): string -> UTF-8 bytes -> gzip stream -> base64 text.
// Pipeline (decode): base64 text -> gzip bytes -> gunzip stream -> string.
//
// Streams vs one-shots
// --------------------
// We use the platform's native `CompressionStream` / `DecompressionStream`
// (available in Node >=18, Firefox >=113, Chrome >=80). The manifest already
// requires Firefox >=140, so the APIs are guaranteed at runtime. Keeping
// this dependency-free is important: the extension ships hand-written
// vanilla JS with no bundled polyfills, and a pure-JS inflate would be
// kilobytes of code we do not need.
//
// Why a chunked base64 builder?
// -----------------------------
// The natural one-liner — `btoa(String.fromCharCode(...bytes))` — blows up
// on large inputs. The spread copies every byte onto the argument stack,
// and engines throw RangeError somewhere between 100k and 1M arguments
// depending on the platform. Using `Function.prototype.apply` on subarrays
// of 0x8000 (32 KiB) bytes keeps each call's argument list well under any
// engine's limit and still runs in O(n) total work. The `+=` string build
// is fine here — V8 and SpiderMonkey both rope-concatenate short strings.
//
// UTF-8
// -----
// `new Blob([string])` implicitly UTF-8-encodes its string parts, so the
// encode path hands the compressor the correct bytes without an explicit
// TextEncoder. The decode path uses `Response.text()`, which decodes the
// gunzipped bytes as UTF-8 and yields back the original JS string.

/** @ts-check */

/* global Blob, CompressionStream, DecompressionStream, TextDecoder, btoa, atob */

// 32 KiB per `String.fromCharCode.apply` call. Comfortably below the
// per-call argument limit on every current engine while still amortizing
// the per-call overhead. See file header for rationale.
const CHUNK = 0x8000;

/**
 * Drain a `ReadableStream<Uint8Array>` into a single `Uint8Array`, without
 * wrapping the stream in `new Response(stream)`.
 *
 * Why not `new Response(stream).arrayBuffer()`? Inside Firefox content
 * scripts, a stream produced by `CompressionStream` / `DecompressionStream`
 * is guarded by an Xray wrapper. Passing such a stream into a `Response`
 * constructor occasionally raises
 * `"Permission denied to access property 'constructor'"` — a
 * wrapper-integrity error that's hard to diagnose and impossible to
 * catch higher up. Walking the reader by hand bypasses the wrapper
 * conversion entirely and works identically under Chrome / Firefox /
 * Node tests.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<Uint8Array>}
 */
const readStreamToBytes = async (stream) => {
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

/**
 * Convert a byte buffer to a base64 ASCII string without triggering the
 * "too many arguments" RangeError that naive spread-based one-liners hit
 * on inputs longer than ~100 KB.
 *
 * @param {Uint8Array} bytes
 * @returns {string} base64 (with `=` padding)
 */
const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    // `apply` expands the subarray as positional args to `fromCharCode`,
    // which treats each value as a Latin-1 code unit. Since every byte is
    // 0..255, the resulting string is a 1-to-1 byte-to-char image that
    // `btoa` can consume.
    binary += String.fromCharCode.apply(
      null,
      /** @type {number[]} */ (/** @type {unknown} */ (bytes.subarray(i, i + CHUNK))),
    );
  }
  return btoa(binary);
};

/**
 * Inverse of {@link bytesToBase64}. Throws if the input is not valid
 * base64 (propagated from `atob`).
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
const base64ToBytes = (b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Encode a string to gzip+base64 text.
 *
 * Pipeline: UTF-8 encode the input, gzip-compress the bytes via the
 * platform `CompressionStream`, then base64-encode the compressed bytes.
 * The output is pure ASCII and safe to drop into a Gist file's `content`
 * field or any other text-only sink.
 *
 * @param {string} input Arbitrary UTF-16 JS string. Empty strings are fine.
 * @returns {Promise<string>} base64 text (padded with `=`).
 */
export const gzipEncode = async (input) => {
  // Blob implicitly UTF-8-encodes string parts; `.stream()` gives a
  // ReadableStream<Uint8Array> that we pipe straight through the gzipper.
  const compressed = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const bytes = await readStreamToBytes(compressed);
  return bytesToBase64(bytes);
};

/**
 * Decode a gzip+base64 string produced by {@link gzipEncode}.
 *
 * The input MUST be (1) valid base64 and (2) valid gzip once decoded.
 * Either constraint violation rejects the returned promise — `atob` throws
 * on invalid base64, and `DecompressionStream` surfaces gzip-format errors
 * while the pipeline is consumed. Callers that handle user-supplied
 * payloads should wrap this in their own try/catch.
 *
 * @param {string} b64 base64 text previously produced by {@link gzipEncode}.
 * @returns {Promise<string>} The original input string.
 */
export const gzipDecode = async (b64) => {
  const bytes = base64ToBytes(b64);
  // `Blob` accepts a Uint8Array directly; its `.stream()` replays the same
  // bytes through the decompressor. `TextDecoder` then UTF-8-decodes the
  // inflated output into the original JS string.
  //
  // Stream → bytes → text rather than `new Response(stream).text()` for
  // the same Xray-wrapper reason as `gzipEncode` — see `readStreamToBytes`.
  //
  // The `BlobPart` cast works around a TypeScript 5.7+ typing quirk: the
  // lib.d.ts now narrows `BlobPart` to require `ArrayBufferView<ArrayBuffer>`
  // specifically (excluding `SharedArrayBuffer`), while a plain `Uint8Array`
  // carries the wider `Uint8Array<ArrayBufferLike>`. Runtime-wise we just
  // allocated the buffer ourselves via `new Uint8Array(length)` so it is
  // guaranteed to be a regular `ArrayBuffer` — the cast is safe.
  const decompressed = new Blob([/** @type {BlobPart} */ (bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const out = await readStreamToBytes(decompressed);
  return new TextDecoder().decode(out);
};
