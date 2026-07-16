// MAIN-world bridge that observes the game's `action=sendFleet` XHR and
// records a fleet-save SEND HINT — the true one-way flight duration plus the
// leg's expected landing body/time — into localStorage
// (`lib/storageKeys.FS_SEND_HINTS_KEY`, read back by `state/fsSendHints.js`).
//
// # Why hints exist
//
// The FS classifier's minimum-flight-time gate can only approximate flight
// time by "time remaining at FIRST sight" (the event list has no departure
// time). A long fleet-save first OBSERVED late — hidden tab, the producer's
// debounce killed by OGame's post-click reload, a reload near arrival — reads
// as a short hop and is rejected forever (a rejected leg is never locked and
// the remaining time only shrinks). At SEND time the truth is right there:
// `#durationOneWay` + the dispatch form. The producer matches event-list
// candidates against these hints (`domain/fleetSave.fsHintOkIds`) and waves a
// hinted leg through the time gate on its TRUE duration.
//
// # Which legs produce a hint
//
//   - One-way missions (4 Deployment, 7 Colonisation): the OUTBOUND leg lands
//     at the target → one hint at `sentAt + duration`.
//   - Round-trip missions with no configurable stay (Transport, Attack,
//     Recycle, Espionage, …): only the RETURN leg lands the fleet back home →
//     one hint at the origin, `sentAt + 2 × duration`.
//   - Missions with a hold/stay time (5 ACS-defend-hold, 15 Expedition) are
//     SKIPPED: their return time isn't derivable from the one-way duration
//     alone, and expeditions have their own wave pipeline anyway.
//
// # Write in the SEND phase, prune-on-write
//
// Like `sendFleetHook.js`'s registry write: the write is a SYNC localStorage
// update in the `send` phase, so the game's post-response navigation cannot
// beat it. We don't wait for the response — a hint for a rejected send matches
// no event row and expires on its own. Strict observer otherwise: no `.open` /
// `.send` calls of our own, no response mutation.
//
// Layering: bridges import `lib` + pure `domain` only. The isolated-world
// reader is `state/fsSendHints.js`; the shared key string lives in
// `lib/storageKeys.js` (same pattern as REGISTRY_KEY).

// @ts-check

import { observeXHR } from './xhrObserver.js';
import { safeLS } from '../lib/storage.js';
import { GAME } from '../lib/gameDom.js';
import { FS_SEND_HINTS_KEY } from '../lib/storageKeys.js';
import { parseClockDuration } from '../domain/duration.js';
import { denseCoords, bodyKey } from '../domain/bodies.js';

/** @typedef {import('../domain/fleetSave.js').FsSendHint} FsSendHint */

/** One-way missions — the outbound leg IS the landing (mirrors
 *  `domain/fleetSave.ONE_WAY_MISSIONS`, kept local: that set is private and
 *  this bridge must stay lean). */
const ONE_WAY = new Set(['4', '7']);

/** Missions whose fleet STAYS at the target for a configurable time — the
 *  return time is not `sentAt + 2 × duration`, so no hint is recorded. */
const HOLD_MISSIONS = new Set(['5', '15']);

/** Hints kept per universe — a rolling cap; ~40 in-flight own sends is far
 *  beyond any real fleet count, and the reader prunes by expiry anyway. */
const HINT_CAP = 40;

/** Mirror of `state/fsSendHints.FS_HINT_LINGER_SEC` (not importable here —
 *  bridges must not pull in the state layer). */
const LINGER_SEC = 3600;

/**
 * The TARGET body of the send, straight from the request body's
 * `galaxy/system/position/type` params — the very values the server acts on.
 * `''` when any is missing/invalid.
 *
 * @param {URLSearchParams} params
 * @returns {string} `g:s:p:type` or ''.
 */
const targetBodyKeyOf = (params) => {
  const g = parseInt(params.get('galaxy') || '', 10);
  const s = parseInt(params.get('system') || '', 10);
  const p = parseInt(params.get('position') || '', 10);
  const t = parseInt(params.get('type') || '', 10);
  if (!(g > 0) || !(s > 0) || !(p > 0)) return '';
  // 1 = planet, 3 = moon; 2 (debris) can't host a landed fleet → no hint.
  if (t !== 1 && t !== 3) return '';
  return bodyKey(`${g}:${s}:${p}`, t);
};

/**
 * The ORIGIN body of the send, from OGame's per-page meta tags (present on
 * every ingame page, moon-aware). `''` when unreadable.
 *
 * @returns {string} `g:s:p:type` or ''.
 */
const originBodyKeyOf = () => {
  const coords = denseCoords(
    document.querySelector(GAME.META_PLANET_COORDS)?.getAttribute('content'),
  );
  if (!/^\d+:\d+:\d+$/.test(coords)) return '';
  const isMoon =
    document.querySelector(GAME.META_PLANET_TYPE)?.getAttribute('content') === 'moon';
  return bodyKey(coords, isMoon ? 3 : 1);
};

/**
 * Append `hint` to the stored list — pruned of expired entries, capped
 * newest-last. Fully synchronous (see module header).
 *
 * @param {FsSendHint} hint
 * @param {number} now Epoch SECONDS.
 * @returns {void}
 */
const pushHint = (hint, now) => {
  const cur = safeLS.json(FS_SEND_HINTS_KEY, []);
  const live = (Array.isArray(cur) ? cur : []).filter(
    (h) =>
      h && typeof h === 'object' &&
      Number.isFinite(h.arrivalAt) && h.arrivalAt + LINGER_SEC >= now,
  );
  live.push(hint);
  safeLS.setJSON(FS_SEND_HINTS_KEY, live.slice(-HINT_CAP));
};

/** Idempotency sentinel (same pattern as the sibling bridges). */
/** @type {(() => void) | null} */
let unsubscribeFn = null;

/**
 * Register the fleet-save send-hint observer on the shared `xhrObserver`.
 * Call once from the MAIN-world entry point (`src/page.js`). Idempotent.
 *
 * @returns {() => void} Unsubscribe.
 */
export const installFleetSaveSendHint = () => {
  if (unsubscribeFn) return unsubscribeFn;

  const unsub = observeXHR({
    urlPattern: /action=sendFleet/,
    on: 'send',
    handler: ({ body }) => {
      if (typeof body !== 'string') return;
      /** @type {URLSearchParams} */
      let params;
      try {
        params = new URLSearchParams(body);
      } catch {
        return;
      }
      const mission = params.get('mission') || '';
      if (!mission || HOLD_MISSIONS.has(mission)) return;

      // Freeze everything AT SEND TIME — the game may rewrite the form DOM
      // and navigate once the response lands.
      const durSec = parseClockDuration(
        document.getElementById('durationOneWay')?.textContent,
      );
      if (durSec <= 0) return;
      const now = Math.floor(Date.now() / 1000);

      /** @type {FsSendHint | null} */
      let hint = null;
      if (ONE_WAY.has(mission)) {
        const landingKey = targetBodyKeyOf(params);
        if (landingKey) hint = { landingKey, arrivalAt: now + durSec, flightSec: durSec };
      } else {
        const landingKey = originBodyKeyOf();
        if (landingKey) hint = { landingKey, arrivalAt: now + 2 * durSec, flightSec: durSec };
      }
      if (hint) pushHint(hint, now);
    },
  });

  unsubscribeFn = () => {
    unsub();
    unsubscribeFn = null;
  };
  return unsubscribeFn;
};

/**
 * Test-only: clear the idempotency sentinel WITHOUT running the underlying
 * unsubscribe (paired with `xhrObserver._resetObserversForTest`).
 *
 * @returns {void}
 */
export const _resetFleetSaveSendHintForTest = () => {
  unsubscribeFn = null;
};
