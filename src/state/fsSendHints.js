// Fleet-save send hints — the isolated-world READ side of the dispatch-time
// capture done by `bridges/fleetSaveSendHint.js` (MAIN world, which writes the
// key by hand via `safeLS`; the shared key string lives in
// `lib/storageKeys.js`).
//
// WHY: the event list carries no departure time, so the FS classifier
// approximates flight time by "time remaining at FIRST sight" — and a long
// fleet-save first observed late (hidden tab, a debounce killed by OGame's
// post-click reload, a reload near arrival) reads as a short hop and is
// rejected FOREVER (a rejected leg is never locked, and the remaining time
// only shrinks). A hint captured at send time knows the TRUE one-way duration,
// so the producer can wave such a leg through the time gate (see
// `domain/fleetSave.fsHintOkIds`).
//
// Hints are device-local by nature (the device that sent is the one whose
// first sight can be late — a send reloads the page and races the producer's
// debounce). Cross-device, the classification itself travels via the gist lock.
//
// Plain key-owner over `safeLS` (NO reactive store): one consumer (the
// producer) pulls once per scan. Per-origin localStorage = per-universe
// scoping. Pruning happens on read — the MAIN-world writer stays append-only
// simple.
//
// @ts-check

import { safeLS } from '../lib/storage.js';
import { FS_SEND_HINTS_KEY } from '../lib/storageKeys.js';

/** @typedef {import('../domain/fleetSave.js').FsSendHint} FsSendHint */

/**
 * How long past its expected landing a hint is kept. Covers server-side
 * rounding and any drift between our `sentAt` clock and the game's — after
 * that the leg has left the event list anyway.
 */
export const FS_HINT_LINGER_SEC = 3600;

/**
 * Read the live hints, dropping expired ones. Read-only — the writer (the
 * MAIN-world bridge) prunes on write with the same predicate, so the key
 * stays bounded without this side ever writing it back.
 *
 * @param {number} now Epoch SECONDS.
 * @returns {FsSendHint[]}
 */
export const readFsSendHints = (now) => {
  const v = safeLS.json(FS_SEND_HINTS_KEY, []);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (h) =>
      h && typeof h === 'object' &&
      typeof h.landingKey === 'string' && h.landingKey !== '' &&
      Number.isFinite(h.arrivalAt) && Number.isFinite(h.flightSec) &&
      h.arrivalAt + FS_HINT_LINGER_SEC >= now,
  );
};
