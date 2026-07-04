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
// # Wave identity = the set of return-times
//
// As of v1.3.2 a wave's identity is the **set of return-time epoch
// seconds** that belong to it. Each in-flight expedition has a fixed,
// deterministic return time the moment OGame accepts the send; that
// timestamp never changes in flight. The DOM row carrying it
// disappears the moment the fleet lands. Two scans share a wave iff
// their return-time sets overlap by at least one timestamp.
// Consequences:
//
//   - Landing: the set shrinks (landed expeditions disappear from
//     `#eventContent`). Overlap with the previous scan is always
//     non-empty until the last expedition lands — same wave, same id.
//   - Re-send: brand-new return-times (≥ one full round-trip later),
//     zero overlap with any prev wave — brand-new wave, fresh id and
//     fresh alarmClock schedule.
//   - `nextWaveAt` drifts across scans (it's the earliest remaining
//     return); since identity doesn't depend on it, drift is irrelevant.
//
// The id is **stamped once at brand-new detection** (`'w_' + min
// returnAt` at that moment) and carried forward unchanged through the
// wave's whole life, even when the smallest live return-time changes
// as expeditions land. Stamping happens ONLY on the `!match` branch
// of `reconcileWaves`; matched waves inherit `match.id` verbatim.
//
// Rationale: pure-time identity by `nextWaveAt` alone (v1.3.1) broke
// whenever a long gap between observations let `nextWaveAt` drift past
// the 300 s tolerance — typically a page reload mid-wave — causing the
// same wave to be treated as brand-new and getting a second six-
// alarmClock schedule stacked on top of the original one still queued
// on ntfy. Identity by the FULL set of return-times closes that gap:
// even one shared timestamp is enough to tie the scans together.

/**
 * Default maximum gap, in seconds, between two consecutive expedition
 * returns for them to count as the SAME wave inside a single scan.
 * Used purely for grouping returns within one observation — identity
 * across scans no longer relies on it (see {@link reconcileWaves}).
 */
export const DEFAULT_CLUSTER_GAP_SECONDS = 300;

/**
 * After this many seconds past the wave's first alarmClock a matched
 * wave is TOMBSTONED (`cancelled: true`) if a brand-new wave shows up
 * in the same scan. The player has clearly re-sent, the wave's first
 * push already fired (or is about to), so the remaining pings are noise.
 *
 * Tombstone — not drop — because the wave's fleets are still in flight;
 * see the cleanup rule in {@link reconcileWaves} for why dropping would
 * let the wave resurrect with a fresh schedule on the next scan.
 *
 * 60 s also covers the "first alarmClock fires in <1 minute" case the
 * product owner asked about explicitly.
 */
export const CLEANUP_GRACE_SEC = 60;

/**
 * One expedition's return-flight, as extracted from the event list by
 * the feature layer. All this module needs to cluster and identify.
 *
 * @typedef {object} ReturnEntry
 * @property {number} returnAt  Epoch SECONDS the fleet lands back home.
 * @property {string} origin    Origin coords `"g:s:p"`. May be empty.
 */

/**
 * A clustered wave — the unit ntfy.sh reminds on.
 *
 * @typedef {object} Wave
 * @property {string}   id          Stable identity stamped at brand-new
 *   detection and carried through the wave's life. See module header.
 * @property {number}   nextWaveAt  Epoch SECONDS of the EARLIEST return
 *   currently observed. May drift across scans; not part of identity.
 * @property {number}   fleetCount  How many expeditions share this wave.
 * @property {number[]} returnAts   Sorted, unique return-time timestamps
 *   currently observed for this wave. The identity carrier.
 * @property {string[]} origins     Sorted, de-duplicated origin coords
 *   (for display only).
 * @property {number}   [detectedAt] Epoch SECONDS this wave was first
 *   observed. Carried forward across same-wave scans.
 * @property {boolean}  [cancelled] This wave is suppressed — the scheduler
 *   skips it for the rest of its life. Set either by the user dismissing
 *   it from the Dashboard OR by the brand-new cleanup rule (a re-send made
 *   its remaining alarmClock noise; see {@link reconcileWaves}). Carried
 *   across matched scans so the flag sticks even as fleets land and
 *   `nextWaveAt` drifts. Naturally cleared when the wave falls out of
 *   `out` (DOM rows gone → unmatched prev) and a re-send from the same
 *   planets stamps a brand-new id.
 */

/**
 * Per-wave alarmClock bookkeeping. Keyed by {@link Wave.id} in the gist's
 * `notifyState`. Stores the ids of the ntfy.sh messages we have queued
 * for that wave so a "player is back" event can cancel them before
 * delivery.
 *
 * @typedef {object} NotifyEntry
 * @property {number} [baseAt] Locked schedule anchor (epoch SECONDS). The
 *   wave's alarmClock slots are `baseAt + offsetsSec[i]` for the resolved
 *   schedule (see `sync/ntfyReconciler.offsetsForSchedule`). Set the
 *   first time the wave is recorded and fed back unchanged on later scans,
 *   so the slot times stay stable as the earliest live return drifts.
 * @property {string[]} [scheduledMessageIds] ntfy.sh message ids currently
 *   queued for this wave (mirrors the queue; used by the Dashboard preview
 *   and its cross-universe orphan backstop).
 */

/**
 * A clustering candidate produced by {@link clusterWaves}. Same shape
 * as {@link Wave} minus the `id` (assigned only by {@link reconcileWaves}
 * once we can tell whether this matches a prev wave or is brand-new).
 *
 * @typedef {object} WaveCandidate
 * @property {number}   nextWaveAt
 * @property {number}   fleetCount
 * @property {number[]} returnAts
 * @property {string[]} origins
 */

/**
 * Reduce a flat list of return-flights into one {@link WaveCandidate}
 * per group of returns whose consecutive gaps stay within `gapSeconds`.
 *
 * Algorithm:
 *   1. Drop entries with a non-finite `returnAt` (defensive).
 *   2. Sort ascending by `returnAt`.
 *   3. Walk the sorted list; start a new cluster whenever the gap from
 *      the previous entry's return time exceeds `gapSeconds`.
 *   4. Each cluster becomes a candidate: `nextWaveAt` = its earliest
 *      return, `fleetCount` = entries in cluster, `returnAts` = sorted
 *      unique return-times, `origins` = sorted unique origins.
 *
 * Two fleets that happen to share the exact same epoch second collapse
 * to one element in `returnAts` (set semantics). `fleetCount` keeps
 * the true count from `group.length`. Identity is still preserved: the
 * shared timestamp leaves `returnAts` only when BOTH fleets land.
 *
 * No `id` is assigned here — {@link reconcileWaves} does that, because
 * identity depends on history (a candidate's return-times may overlap
 * a prev wave, in which case the prev id is carried forward).
 *
 * Pure: returns a fresh array, never mutates the input.
 *
 * @param {ReturnEntry[]} entries
 * @param {{ gapSeconds?: number }} [opts]
 * @returns {WaveCandidate[]} Candidates in ascending `nextWaveAt` order.
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
    const returnAts = [...new Set(group.map((e) => e.returnAt))].sort((a, b) => a - b);
    return {
      nextWaveAt: group[0].returnAt,
      fleetCount: group.length,
      returnAts,
      origins,
    };
  });
};

/**
 * Find the prev wave with the greatest return-time overlap with the
 * candidate. Returns `null` when no prev wave shares any return-time.
 * Ties broken by largest overlap first, then by appearance order.
 *
 * @param {Wave[]} prevWaves
 * @param {WaveCandidate} cand
 * @param {Set<string>} consumed  prev ids already matched
 * @returns {Wave | null}
 */
const findBestOverlap = (prevWaves, cand, consumed) => {
  const curSet = new Set(cand.returnAts);
  /** @type {Wave | null} */
  let best = null;
  let bestOverlap = 0;
  for (const prev of prevWaves) {
    if (consumed.has(prev.id)) continue;
    let overlap = 0;
    for (const t of prev.returnAts) if (curSet.has(t)) overlap++;
    if (overlap > bestOverlap) {
      best = prev;
      bestOverlap = overlap;
    }
  }
  return best;
};

/**
 * Re-unify wave candidates that are fragments of a single stored wave.
 *
 * {@link clusterWaves} groups returns by consecutive gaps ≤ the cluster
 * gap. When a live wave loses an INTERIOR member — an expedition recalled
 * mid-flight, so its `data-arrival-time` shifts out of the cluster — the
 * gap across the hole can exceed the threshold and split the remaining
 * returns into two candidates. Left alone, {@link reconcileWaves}'s greedy
 * overlap match lets the first fragment consume the prev wave and stamps
 * the second BRAND-NEW (fresh `id` + `detectedAt`), handing it a duplicate
 * six-alarm schedule — the exact double-schedule the wave identity exists
 * to prevent — and it can even tombstone the matched fragment via the
 * brand-new cleanup rule.
 *
 * This pass runs BEFORE matching: it links every candidate that shares any
 * of a prev wave's return-times (union-find over candidate indices) and
 * merges each connected group into one candidate (union of `returnAts`,
 * summed `fleetCount`, union of `origins`). In steady state each candidate
 * overlaps exactly one prev wave and vice-versa, so every group is a
 * singleton and the output is identical to the input — the merge only
 * fires when ≥2 candidates overlap the SAME prev wave (the split case). A
 * genuinely new candidate that shares nothing with any prev wave is never
 * merged, so brand-new detection is preserved.
 *
 * Pure: builds fresh candidates, never mutates the inputs.
 *
 * @param {Wave[]} prevWaves
 * @param {WaveCandidate[]} candidates  ascending `nextWaveAt` (from clusterWaves)
 * @returns {WaveCandidate[]} Re-unified candidates, ascending `nextWaveAt`.
 */
const mergeSplitCandidates = (prevWaves, candidates) => {
  const n = candidates.length;
  if (n < 2 || prevWaves.length === 0) return candidates;

  // Union-find over candidate indices; roots kept as the smallest index so
  // group order is stable.
  const parent = candidates.map((_, i) => i);
  /** @param {number} x @returns {number} */
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  /** @param {number} a @param {number} b */
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Link all candidates that share any of a given prev wave's return-times:
  // they are fragments of that one wave.
  for (const prev of prevWaves) {
    const times = new Set(prev.returnAts);
    let anchor = -1;
    for (let i = 0; i < n; i++) {
      if (candidates[i].returnAts.some((t) => times.has(t))) {
        if (anchor === -1) anchor = i;
        else union(anchor, i);
      }
    }
  }

  // Collect groups by root, preserving first-seen order.
  /** @type {Map<number, number[]>} */
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  /** @type {WaveCandidate[]} */
  const merged = [];
  for (const idxs of groups.values()) {
    if (idxs.length === 1) {
      merged.push(candidates[idxs[0]]);
      continue;
    }
    const group = idxs.map((i) => candidates[i]);
    const returnAts = [...new Set(group.flatMap((c) => c.returnAts))].sort((a, b) => a - b);
    const origins = [...new Set(group.flatMap((c) => c.origins))].sort();
    const fleetCount = group.reduce((sum, c) => sum + c.fleetCount, 0);
    merged.push({ nextWaveAt: returnAts[0], fleetCount, returnAts, origins });
  }

  merged.sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  return merged;
};

/**
 * Reconcile the previously-stored waves with the wave candidates just
 * observed in the event list.
 *
 *   - **Overlap match** (`|prev.returnAts ∩ cand.returnAts| ≥ 1`) →
 *     same wave. Carry `id` and `detectedAt`; reuse identity unchanged.
 *     The `id` field is NEVER recomputed for matched waves.
 *   - **No overlap** → brand-new wave. Stamp `id = 'w_' + min returnAt`
 *     observed RIGHT NOW; that's the wave's identity forever. Later
 *     scans never re-derive this even though the smallest LIVE return
 *     shifts as expeditions land — the original stamp persists via the
 *     match branch.
 *   - **Unmatched prev** (no current candidate shares any of its
 *     return-times) → the wave has fully landed; drop from the
 *     returned set. The caller cancels its `scheduledMessageIds`.
 *   - **Brand-new triggers cleanup**: whenever at least one brand-new
 *     wave is detected, any matched prev wave whose `nextWaveAt` is
 *     within {@link CLEANUP_GRACE_SEC} of `now` (i.e. its first
 *     alarmClock already fired or fires in <1 min) is TOMBSTONED
 *     (`cancelled: true`), NOT removed from the set. The player is
 *     clearly back in game; the rest of that wave's cycle is noise.
 *     Keeping the wave in the set (with the flag) is what stops it
 *     resurrecting: its fleets are still in flight, so their return-
 *     times keep matching it and carry the flag forward, instead of
 *     being re-clustered into a brand-new wave with a fresh six-alarmClock
 *     schedule on the next scan. The caller excludes `cancelled` waves
 *     from the live set, so their queued messages are swept off ntfy.
 *     The tombstone exits naturally once every fleet lands (unmatched
 *     prev → dropped).
 *
 * Pure: no `Date.now()` (time comes in via `now`), no mutation. Returns
 * the reconciled wave list plus the ids of waves that fell out (so the
 * caller can pick up their `notifyState` entries for cancellation).
 *
 * @param {Wave[]} prevWaves
 * @param {WaveCandidate[]} currentCandidates
 * @param {number} now            Epoch SECONDS.
 * @returns {{ waves: Wave[], droppedIds: string[], brandNewDetected: boolean }}
 */
export const reconcileWaves = (prevWaves, currentCandidates, now) => {
  // Re-unify candidates a mid-flight recall split apart before matching, so
  // a partially-recalled wave can't resurrect its tail half as brand-new
  // (see mergeSplitCandidates). No-op unless ≥2 candidates share a prev wave.
  const candidates = mergeSplitCandidates(prevWaves, currentCandidates);

  /** @type {Wave[]} */
  const out = [];
  /** @type {Set<string>} */
  const consumed = new Set();
  let brandNewDetected = false;

  for (const cand of candidates) {
    const match = findBestOverlap(prevWaves, cand, consumed);
    if (match) {
      consumed.add(match.id);
      out.push({
        id: match.id,
        nextWaveAt: cand.nextWaveAt,
        fleetCount: cand.fleetCount,
        returnAts: cand.returnAts,
        origins: cand.origins,
        detectedAt: match.detectedAt ?? now,
        ...(match.cancelled ? { cancelled: true } : {}),
      });
    } else {
      brandNewDetected = true;
      const stamp = cand.returnAts.length > 0 ? cand.returnAts[0] : cand.nextWaveAt;
      out.push({
        id: 'w_' + stamp,
        nextWaveAt: cand.nextWaveAt,
        fleetCount: cand.fleetCount,
        returnAts: cand.returnAts,
        origins: cand.origins,
        detectedAt: now,
      });
    }
  }

  /** @type {string[]} */
  const droppedIds = [];

  // Cleanup rule: a brand-new wave means the player is actively sending
  // again. Any matched wave whose first alarmClock already fired (or fires
  // in <CLEANUP_GRACE_SEC) is noise from this point on. TOMBSTONE it
  // (cancelled: true) rather than remove it from the set.
  //
  // Why tombstone, not drop: the wave's fleets are still in flight, so
  // their return rows persist in the event list. If we dropped the wave
  // entirely, the very next scan would re-cluster those same return-
  // times, find no matching prev wave, and stamp them brand-new — handing
  // the wave a fresh six-alarmClock schedule (resurrecting a wave the player
  // already re-sent past). Keeping it with cancelled:true lets the
  // overlap-match branch carry the flag forward every scan, so the caller
  // skips it (excluded from the live ntfy set → its queued messages are
  // swept). It exits naturally once every fleet has landed: no candidate
  // overlaps it → unmatched prev → dropped just below.
  if (brandNewDetected) {
    for (let i = 0; i < out.length; i++) {
      const w = out[i];
      const wasMatched = consumed.has(w.id);
      if (wasMatched && !w.cancelled && w.nextWaveAt <= now + CLEANUP_GRACE_SEC) {
        out[i] = { ...w, cancelled: true };
      }
    }
  }

  // Unmatched prev waves — fully landed. Drop them.
  for (const prev of prevWaves) {
    if (!consumed.has(prev.id)) droppedIds.push(prev.id);
  }

  out.sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  return { waves: out, droppedIds, brandNewDetected };
};

/**
 * Return a copy of `notifyState` containing only entries whose id still
 * appears in `waves`. Keeps the gist from accumulating dead counters
 * for waves that have been dropped (landed or swept by the cleanup rule).
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
