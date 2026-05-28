// @ts-check

// Expedition-wave domain logic — pure, no DOM, no storage, no
// `Date.now()` without an explicit `now` parameter. Tests run in Node
// with zero mocks.
//
// # What is a "wave"
//
// A wave is a *cluster of expeditions that come home together*. OGame's
// event list (`#eventContent`) carries, for every in-flight expedition,
// exactly one return-flight row (`data-mission-type="15"
// data-return-flight="true"`) whose `data-arrival-time` is the epoch-
// second moment the fleet lands back home. The feature layer reads
// those rows out of the DOM (the same passive read the badge feature
// does — see `features/badges.js`) and hands this module a flat list
// of {@link ReturnEntry}. Everything here works on that list; we never
// touch the DOM ourselves.
//
// # Wave identity = TIME
//
// As of v1.3.1 a wave is identified by its `nextWaveAt` — the earliest
// return time in the cluster. Two clusters whose `nextWaveAt` falls
// within {@link DEFAULT_CLUSTER_GAP_SECONDS} of each other are treated
// as the same wave (so a brief DOM mutation that drops then re-adds a
// row doesn't spawn a duplicate). Origin planets are kept on the wave
// for display, but they no longer participate in identity.
//
// Rationale — quoting the product owner: "Skoro coś wraca w jednej
// minucie to jest dla gracza tą samą falą niezależnie od tego skąd
// czy dokąd leci. Fala to czas." Pure time-based identity also makes
// reconcile trivial.
//
// Tradeoff we explicitly accept: when the user re-sends a wave between
// two scans (so the extension never observes the old cluster going
// away and the new one appearing), the old wave persists as "idle" and
// its remaining ntfy.sh reminders keep firing until they expire. The
// {@link STALE_WAVE_AFTER_SEC} purge below curbs that — any prev wave
// whose return time + the full reminder window has elapsed gets
// dropped on the next reconcile.

/**
 * Default maximum gap, in seconds, between two consecutive expedition
 * returns for them to count as the SAME wave. 300 s (5 min) sits well
 * above the few-seconds spacing of a single send burst and well below
 * the minutes-to-quarter-hour gap of a deliberate partial send.
 * Doubles as the tolerance for identifying two scans of the same wave
 * across time in {@link reconcileWaves}.
 */
export const DEFAULT_CLUSTER_GAP_SECONDS = 300;

/**
 * After this many seconds past `nextWaveAt`, a wave that hasn't been
 * observed in the current scan is dropped. Sized to be longer than the
 * ntfy.sh reminder window (6 × 10 min = 3600 s) plus a buffer, so we
 * never drop a wave whose pushes are still firing.
 */
export const STALE_WAVE_AFTER_SEC = 4200;

/**
 * One expedition's return-flight, as extracted from the event list by
 * the feature layer. All this module needs to cluster and identify.
 *
 * @typedef {object} ReturnEntry
 * @property {string} fleetId   OGame's per-flight row id.
 * @property {number} returnAt  Epoch SECONDS the fleet lands back home.
 * @property {string} origin    Origin coords `"g:s:p"`. May be empty.
 */

/**
 * A clustered wave — the unit ntfy.sh reminds on.
 *
 * @typedef {object} Wave
 * @property {string}   id          Stable identity, see {@link computeWaveId}.
 * @property {number}   nextWaveAt  Epoch SECONDS of the EARLIEST return.
 * @property {number}   fleetCount  How many expeditions share this wave.
 * @property {string[]} origins     Sorted, de-duplicated origin coords
 *   (for display only — no longer part of identity).
 * @property {number}   [detectedAt] Epoch SECONDS this wave was first
 *   observed. Carried forward across same-wave scans.
 */

/**
 * Per-wave reminder bookkeeping. Keyed by {@link Wave.id} in the gist's
 * `notifyState`. As of v1.3.1 this only stores the ids of the ntfy.sh
 * messages we have queued ahead of time so that a re-send can cancel
 * them before delivery (the Worker / push counters from v1.3.0 are
 * gone — ntfy.sh's `X-Delay` carries the timing instead).
 *
 * @typedef {object} NotifyEntry
 * @property {string[]} [scheduledMessageIds]
 */

/**
 * Build a stable wave id from its `nextWaveAt`. Pure time-based — two
 * clusters whose returns land at the exact same epoch second share an
 * id, and within {@link reconcileWaves}'s tolerance any drift of less
 * than {@link DEFAULT_CLUSTER_GAP_SECONDS} is treated as the same wave.
 *
 * @param {number} nextWaveAt
 * @returns {string}
 */
export const computeWaveId = (nextWaveAt) => 'w_' + Math.floor(nextWaveAt);

/**
 * Reduce a flat list of return-flights into one {@link Wave} per group
 * of returns whose consecutive gaps stay within `gapSeconds`.
 *
 * Algorithm:
 *   1. Drop entries with a non-finite `returnAt` (defensive).
 *   2. Sort ascending by `returnAt`.
 *   3. Walk the sorted list; start a new cluster whenever the gap from
 *      the previous entry's return time exceeds `gapSeconds`.
 *   4. Each cluster becomes a wave: `nextWaveAt` = its earliest return,
 *      `fleetCount` = entries in cluster, `origins` = sorted unique
 *      origins (display-only).
 *
 * Pure: returns a fresh array, never mutates the input.
 *
 * @param {ReturnEntry[]} entries
 * @param {{ gapSeconds?: number }} [opts]
 * @returns {Wave[]} Waves in ascending `nextWaveAt` order.
 */
export const clusterWaves = (entries, opts = {}) => {
  const gapSeconds = opts.gapSeconds ?? DEFAULT_CLUSTER_GAP_SECONDS;
  const sorted = entries
    .filter((e) => Number.isFinite(e.returnAt))
    .slice()
    .sort((a, b) => a.returnAt - b.returnAt);

  /** @type {ReturnEntry[][]} */
  const clusters = [];
  let lastReturnAt = -Infinity;
  for (const e of sorted) {
    if (e.returnAt - lastReturnAt <= gapSeconds && clusters.length > 0) {
      clusters[clusters.length - 1].push(e);
    } else {
      clusters.push([e]);
    }
    lastReturnAt = e.returnAt;
  }

  return clusters.map((group) => {
    const origins = [...new Set(group.map((e) => e.origin).filter(Boolean))].sort();
    const nextWaveAt = group[0].returnAt;
    return {
      id: computeWaveId(nextWaveAt),
      nextWaveAt,
      fleetCount: group.length,
      origins,
    };
  });
};

/**
 * Reconcile the previously-stored waves with the waves just observed
 * in the event list. Two scans match when their `nextWaveAt` fall
 * within `gapSeconds` of each other — that's "the same wave" by the
 * v1.3.1 time-only identity rule.
 *
 *   - **Match within tolerance** → same wave, in-flight. Carry
 *     `detectedAt` and, if the exact id changed (a few seconds of
 *     drift across scans), emit a rename so the caller can move
 *     `notifyState[oldId]` to `notifyState[newId]`.
 *   - **No match** → brand-new wave, stamp `detectedAt = now`.
 *
 * Prev waves left unmatched are kept as idle (the fleet landed and
 * its row dropped from `#eventContent`) UNLESS they are stale —
 * older than `STALE_WAVE_AFTER_SEC` past their return time, by
 * which point all six reminders have fired and there's nothing left
 * to remind about. Stale prev waves are simply dropped.
 *
 * Pure: no `Date.now()` (time comes in via `now`), no mutation.
 *
 * @param {Wave[]} prevWaves
 * @param {Wave[]} currentWaves
 * @param {number} now            Epoch SECONDS.
 * @param {{ gapSeconds?: number, staleAfterSec?: number }} [opts]
 * @returns {{ waves: Wave[], resetIds: string[], renames: Record<string, string> }}
 */
export const reconcileWaves = (prevWaves, currentWaves, now, opts = {}) => {
  const gapSeconds = opts.gapSeconds ?? DEFAULT_CLUSTER_GAP_SECONDS;
  const staleAfter = opts.staleAfterSec ?? STALE_WAVE_AFTER_SEC;

  /** @type {Wave[]} */
  const out = [];
  /** @type {string[]} */
  const resetIds = [];
  /** @type {Record<string, string>} */
  const renames = {};
  /** @type {Set<string>} */
  const consumed = new Set();

  for (const cur of currentWaves) {
    /** @type {Wave | null} */
    let match = null;
    let bestDiff = Infinity;
    for (const prev of prevWaves) {
      if (consumed.has(prev.id)) continue;
      const diff = Math.abs(prev.nextWaveAt - cur.nextWaveAt);
      if (diff <= gapSeconds && diff < bestDiff) {
        match = prev;
        bestDiff = diff;
      }
    }
    if (match) {
      consumed.add(match.id);
      if (match.id !== cur.id) renames[match.id] = cur.id;
      out.push({ ...cur, detectedAt: match.detectedAt ?? now });
    } else {
      out.push({ ...cur, detectedAt: now });
    }
  }

  // Idle prev waves: known before, not seen now → keep reminding,
  // unless past the stale horizon (all reminders fired anyway).
  for (const prev of prevWaves) {
    if (consumed.has(prev.id)) continue;
    if (prev.nextWaveAt + staleAfter < now) continue; // dropped
    out.push(prev);
  }

  out.sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  return { waves: out, resetIds, renames };
};

/**
 * Return a copy of `notifyState` with each `oldId` entry moved to its
 * `newId` slot, per the `renames` produced by {@link reconcileWaves}.
 * A new-id entry that already exists wins — we never clobber an
 * existing schedule on top of an old one.
 *
 * Must run BEFORE {@link applyResets} and {@link pruneNotifyState} so
 * reset/prune operate on the final ids.
 *
 * @param {Record<string, NotifyEntry>} notifyState
 * @param {Record<string, string>} renames
 * @returns {Record<string, NotifyEntry>}
 */
export const applyRenames = (notifyState, renames) => {
  const next = { ...notifyState };
  for (const [oldId, newId] of Object.entries(renames)) {
    if (next[oldId] === undefined) continue;
    if (next[newId] === undefined) next[newId] = next[oldId];
    delete next[oldId];
  }
  return next;
};

/**
 * Return a copy of `notifyState` with the given ids removed entirely.
 * A reset means "this wave is conceptually brand new" — the caller is
 * expected to schedule fresh ntfy messages and write a new entry, so
 * dropping the old entry is the cleanest representation.
 *
 * In the pure-time identity model {@link reconcileWaves} never emits
 * `resetIds` (a re-send becomes a brand-new wave with a brand-new id,
 * so there's nothing to reset). The function stays as a no-op safety
 * net for any caller still threading reset ids through the pipeline.
 *
 * @param {Record<string, NotifyEntry>} notifyState
 * @param {string[]} resetIds
 * @returns {Record<string, NotifyEntry>}
 */
export const applyResets = (notifyState, resetIds) => {
  const next = { ...notifyState };
  for (const id of resetIds) delete next[id];
  return next;
};

/**
 * Return a copy of `notifyState` containing only entries whose id still
 * appears in `waves`. Keeps the gist from accumulating dead counters
 * for waves that have been superseded.
 *
 * @param {Record<string, NotifyEntry>} notifyState
 * @param {Wave[]} waves
 * @returns {Record<string, NotifyEntry>}
 */
export const pruneNotifyState = (notifyState, waves) => {
  const live = new Set(waves.map((w) => w.id));
  /** @type {Record<string, NotifyEntry>} */
  const next = {};
  for (const id of Object.keys(notifyState)) {
    if (live.has(id)) next[id] = notifyState[id];
  }
  return next;
};
