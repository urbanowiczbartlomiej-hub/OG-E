// @ts-check

// Expedition-wave domain logic — pure, no DOM, no storage, no
// `Date.now()` without an explicit `now` parameter. Tests run in Node
// with zero mocks.
//
// # What is a "wave"
//
// A wave is a *cluster of expeditions that were sent together and come
// home together*. OGame's event list (`#eventContent`) carries, for
// every in-flight expedition, exactly one return-flight row
// (`data-mission-type="15" data-return-flight="true"`) whose
// `data-arrival-time` is the epoch-second moment the fleet lands back
// home. The feature layer reads those rows out of the DOM (the same
// passive read the badge feature does — see `features/badges.js`) and
// hands this module a flat list of {@link ReturnEntry}. Everything
// here works on that list; we never touch the DOM ourselves.
//
// A player typically sends 8-15 expeditions in one burst, a few seconds
// apart (the time it takes to switch planet and re-send). Their return
// times are therefore tightly bunched. We must NOT treat each individual
// return as its own "next wave" — the user would get a reminder, then
// another 5 seconds later, then another. So we CLUSTER returns whose
// gaps are small ({@link clusterWaves}) and treat the whole cluster as a
// single wave whose `nextWaveAt` is the EARLIEST return in the cluster
// (the user's own rule: "najbliższy powrót oznaczamy jako czas fali").
//
// A player who sends a partial burst (5 now, the rest 15 minutes later)
// produces two clusters separated by a gap far larger than the
// inter-expedition spacing. Those become two independent waves, each
// reminded on its own schedule.
//
// # Wave identity = the set of origin planets
//
// {@link computeWaveId} hashes the SORTED SET OF ORIGIN COORDS, not the
// fleet ids. This is deliberate and load-bearing:
//
//   - **Re-send is the same wave.** Expedition routines re-send from the
//     same planets every cycle. Same origins → same id → the reminder
//     state (notifyCount / lastNotifiedAt) carries over, and a re-send
//     is detected purely as "nextWaveAt jumped into the future" (see
//     {@link reconcileWaves}), which resets the counters per the user's
//     step 8.
//   - **An idle, returned wave survives a page reload.** Once a fleet
//     lands and sits idle, its return row VANISHES from the event list.
//     If identity were the fleet id we'd lose track of it. Keyed by
//     origins, {@link reconcileWaves} keeps a previously-known wave that
//     is simply absent from the current event list — so the worker keeps
//     reminding "you have idle fleets" until the user actually re-sends.
//
// Known limitation: with more than one simultaneous expedition per
// planet (maxExpPerPlanet > 1) whose returns fall into separate
// clusters, two clusters can share an identical origin set and collide
// on id. The dominant one-expedition-per-planet case is exact. We
// accept the collision for v1 rather than reintroduce fleet-id
// instability; the worst case is two such waves sharing one reminder
// counter.

/**
 * Default maximum gap, in seconds, between two consecutive expedition
 * returns for them to count as the SAME wave. 300 s (5 min) sits well
 * above the few-seconds spacing of a single send burst and well below
 * the minutes-to-quarter-hour gap of a deliberate partial send. Tunable
 * by the caller via {@link clusterWaves}'s options.
 */
export const DEFAULT_CLUSTER_GAP_SECONDS = 300;

/**
 * One expedition's return-flight, as extracted from the event list by
 * the feature layer. All this module needs to cluster and identify.
 *
 * @typedef {object} ReturnEntry
 * @property {string} fleetId   OGame's per-flight row id (e.g. the
 *   numeric suffix of `eventRow-141279718`). Used only as an id
 *   fallback when origin coords are missing.
 * @property {number} returnAt  Epoch SECONDS the fleet lands back home
 *   (`data-arrival-time` of the return-flight row).
 * @property {string} origin    Origin coords `"g:s:p"` (no brackets,
 *   no spaces). May be empty string if the source cell was missing.
 */

/**
 * A clustered wave — the unit the worker reminds on.
 *
 * @typedef {object} Wave
 * @property {string}   id          Stable identity, see {@link computeWaveId}.
 * @property {number}   nextWaveAt  Epoch SECONDS of the EARLIEST return
 *   in the cluster. The worker reminds once `now >= nextWaveAt`.
 * @property {number}   fleetCount  How many expeditions share this wave.
 * @property {string[]} origins     Sorted, de-duplicated origin coords.
 * @property {number}   [detectedAt] Epoch SECONDS this wave (this id at
 *   this `nextWaveAt`) was first observed. Stamped by
 *   {@link reconcileWaves}; absent on a bare {@link clusterWaves} result.
 */

/**
 * Per-wave reminder bookkeeping. Keyed by {@link Wave.id} in the gist's
 * `notifyState`. Owned by the worker; the extension only ever resets or
 * prunes entries (never increments).
 *
 * @typedef {object} NotifyEntry
 * @property {number} notifyCount        How many pushes have fired for
 *   this wave since it was (re)detected.
 * @property {number | null} lastNotifiedAt  Epoch SECONDS of the last
 *   push, or null if none yet.
 */

/**
 * Build a stable wave id from a set of origin coords.
 *
 * The id is `w_` followed by the SORTED, de-duplicated origins with
 * `:` swapped for `-` and joined by `__`. Sorting makes the id
 * order-independent (the event list may list planets in any order);
 * de-duplication collapses multiple expeditions from one planet.
 *
 * When `origins` is empty (coords were missing on every row — rare,
 * typically a mid-mutation read), we fall back to hashing the sorted
 * `fleetIds` so distinct waves still get distinct ids instead of all
 * collapsing to `"w_"`.
 *
 * @param {string[]} origins   Origin coords, any order, possible dupes.
 * @param {string[]} [fleetIds] Fallback identity source when `origins`
 *   is empty.
 * @returns {string}
 *
 * @example
 *   computeWaveId(['4:468:14', '4:467:15']); // 'w_4-467-15__4-468-14'
 */
export const computeWaveId = (origins, fleetIds = []) => {
  const uniq = [...new Set(origins.filter(Boolean))].sort();
  if (uniq.length > 0) {
    return 'w_' + uniq.map((o) => o.replace(/:/g, '-')).join('__');
  }
  const f = [...new Set(fleetIds.filter(Boolean))].sort();
  return 'wf_' + f.join('__');
};

/**
 * Reduce a flat list of return-flights into one {@link Wave} per group
 * of returns whose consecutive gaps stay within `gapSeconds`.
 *
 * Algorithm:
 *   1. Drop entries with a non-finite `returnAt` (defensive — a
 *      malformed row shouldn't poison the whole cluster pass).
 *   2. Sort ascending by `returnAt`.
 *   3. Walk the sorted list; start a new cluster whenever the gap from
 *      the previous entry's return time exceeds `gapSeconds`.
 *   4. Each cluster becomes a wave: `nextWaveAt` = its earliest return
 *      (the first element, since the list is sorted), `fleetCount` =
 *      number of entries, `origins` = sorted unique origins.
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
    return {
      id: computeWaveId(origins, group.map((e) => e.fleetId)),
      nextWaveAt: group[0].returnAt, // sorted asc → earliest return
      fleetCount: group.length,
      origins,
    };
  });
};

/**
 * Reconcile the previously-stored waves with the waves just observed in
 * the event list, producing the wave set to write back plus the ids
 * whose reminder counters must be reset.
 *
 * Three cases, by wave id:
 *
 *   - **New id** (in current, not in previous) → a freshly-sent wave.
 *     Keep it, stamp `detectedAt = now`.
 *   - **Existing id, `nextWaveAt` advanced** → the user re-sent from the
 *     same planets; the return moved into the future. Keep the current
 *     (later) wave, re-stamp `detectedAt = now`, and add the id to
 *     `resetIds` so the caller zeroes its notify counters (the user's
 *     step 8: "wyzeruj lastNotifiedAt i notifyCount").
 *   - **Existing id, NOT in current** → the fleet already landed and is
 *     sitting idle (its return row dropped out of the event list). Keep
 *     the PREVIOUS wave unchanged so the worker keeps reminding until a
 *     real re-send bumps it. This is the case that makes a page reload
 *     safe.
 *
 *   (An existing id present in current with an unchanged or earlier
 *   `nextWaveAt` is treated as "same wave, still in flight": we keep the
 *   current row but preserve the original `detectedAt`.)
 *
 * Pure: no `Date.now()` (time comes in via `now`), no mutation of
 * inputs.
 *
 * @param {Wave[]} prevWaves      Waves currently stored in the gist.
 * @param {Wave[]} currentWaves   Waves just built by {@link clusterWaves}.
 * @param {number} now            Epoch SECONDS, injected by the caller.
 * @returns {{ waves: Wave[], resetIds: string[] }}
 */
export const reconcileWaves = (prevWaves, currentWaves, now) => {
  const prevById = new Map(prevWaves.map((w) => [w.id, w]));
  const curIds = new Set(currentWaves.map((w) => w.id));

  /** @type {Wave[]} */
  const waves = [];
  /** @type {string[]} */
  const resetIds = [];

  for (const cur of currentWaves) {
    const prev = prevById.get(cur.id);
    if (!prev) {
      waves.push({ ...cur, detectedAt: now });
    } else if (cur.nextWaveAt > prev.nextWaveAt) {
      resetIds.push(cur.id);
      waves.push({ ...cur, detectedAt: now });
    } else {
      waves.push({ ...cur, detectedAt: prev.detectedAt ?? now });
    }
  }

  // Idle waves: known before, absent now → keep reminding.
  for (const prev of prevWaves) {
    if (!curIds.has(prev.id)) waves.push(prev);
  }

  waves.sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  return { waves, resetIds };
};

/**
 * Return a copy of `notifyState` with the given ids reset to a fresh
 * "never notified" entry. Used after {@link reconcileWaves} reports a
 * re-send, so the next worker cycle treats the wave as brand new.
 *
 * @param {Record<string, NotifyEntry>} notifyState
 * @param {string[]} resetIds
 * @returns {Record<string, NotifyEntry>}
 */
export const applyResets = (notifyState, resetIds) => {
  const next = { ...notifyState };
  for (const id of resetIds) next[id] = { notifyCount: 0, lastNotifiedAt: null };
  return next;
};

/**
 * Return a copy of `notifyState` containing only entries whose id still
 * appears in `waves`. Keeps the gist from accumulating dead counters for
 * waves that have been superseded.
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

/**
 * Decide whether a wall-clock minute-of-day falls inside the allowed
 * notification window. Windows that wrap past midnight (start > end,
 * e.g. 22:00–06:00) are supported. A zero-width window (start === end)
 * means "no restriction — notify any time".
 *
 * Pure integer comparison; the caller is responsible for converting
 * "now" into minutes-of-day in the user's timezone before calling.
 *
 * @param {number} nowMinutes  Minute of day, 0..1439 (hour*60 + minute).
 * @param {string} startStr    `"HH:MM"`.
 * @param {string} endStr      `"HH:MM"`.
 * @returns {boolean}
 */
export const withinAllowedHours = (nowMinutes, startStr, endStr) => {
  /** @param {string} s @returns {number} */
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const start = toMin(startStr);
  const end = toMin(endStr);
  if (start === end) return true; // full day
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end; // wraps midnight
};
