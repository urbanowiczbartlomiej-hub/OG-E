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
// data-return-flight="true"`), identified by its `eventRow-<n>` id and
// carrying the home-return epoch in `data-arrival-time`. The feature
// layer reads those rows out of the DOM (the same passive read the badge
// feature does — see `features/badges.js`) and hands this module a flat
// list of {@link ReturnEntry}. Everything here works on that list; we
// never touch the DOM ourselves.
//
// # Wave identity = the set of MEMBER ROW IDS
//
// A wave's membership is the set of `eventRow-<n>` ids that belong to it.
// That id is the *event* id — stable for the whole life of the leg (see
// `domain/adhoc.js`'s header) — and the return row is the one invariant of
// a two-way mission: exactly one per in-flight expedition, from dispatch
// until the fleet is home (`docs/ogame-fleet-mechanics.md`). So a member
// can be followed across scans exactly, with no heuristic.
//
// ## Why NOT identity by return time (the model this replaced)
//
// Until 1.69 membership was the set of return-time epoch seconds, matched
// across scans by overlap. The belief underneath it — stated outright in
// the old header — was that an expedition's return time *never changes in
// flight*. It does: an expedition can roll a return-speed outcome at the
// end of its hold, and the row's `data-arrival-time` then jumps by many
// minutes. The consequences, all measured:
//
//   - a shifted member no longer shared ANY timestamp with its own wave,
//     so it was re-clustered as a BRAND-NEW wave and handed a full,
//     duplicate reminder schedule — permanently, since nothing ever
//     healed it;
//   - the repair pass for the sibling case (a recalled member splitting a
//     cluster in two) linked candidates by *identical* timestamps, so it
//     was blind to the one case that actually needed it;
//   - the grouping threshold was the only defence, which made correctness
//     depend on a number nobody had measured (how big is the return-speed
//     jump?) — and raising it merges genuinely separate waves, which costs
//     a MISSING reminder rather than a spare one.
//
// Keying on the row id removes the dependency on that unknown entirely: a
// member stays in its wave whatever its clock does.
//
// # Provisional vs COMMITTED — the seal
//
// A freshly-detected wave is *provisional*: its membership may still be
// reorganised, and nothing has been scheduled for it yet. Sending a wave
// takes minutes (one page reload per expedition), and each send is a
// separate scan, so a wave observed mid-send is a partial wave whose
// grouping can still change under us. Committing on first sight is what
// made a half-sent wave pay for a reminder schedule it then threw away.
//
// A wave COMMITS — `committedAt` is stamped, and the caller may schedule
// it — once either:
//
//   - its membership has been stable for {@link DEFAULT_SETTLE_SECONDS}
//     (no new member joined in that window: the send has finished), or
//   - its anchor is less than that window away, so waiting any longer
//     would miss the first reminder (the late-login case).
//
// After the stamp the wave is SEALED: it never gains a member, never
// merges with another wave, and its anchor never moves. Members only
// leave, by landing. Everything the player sends afterwards forms its own
// wave. Before the stamp, provisional waves re-cluster freely and may
// merge — which is what lets a wave that momentarily looked like two
// fragments mid-send end up as the single wave it really is.
//
// # The anchor is the FIRST mission's return, frozen
//
// `anchorAt` is stamped at creation from the earliest return then visible
// and never recomputed — not when an earlier-returning expedition joins,
// and not when a member rolls a return-speed outcome. It is deliberately
// the ORIGINAL planned return of the first mission of the send, because
// that is what the reminder is for: the player repeats the wave by
// replaying the same send order at the same spacing, and the anchor is the
// start of that sequence. A reminder that chased the actual earliest
// landing would drift away from the sequence it is meant to cue.

/**
 * Default maximum gap, in seconds, between two consecutive expedition
 * returns for them to count as the same wave. Applied by
 * {@link clusterWaves} to returns that are not yet members of a wave;
 * a known member is followed by its row id and is never re-grouped.
 *
 * The threshold is a CHAIN, not a window: a new cluster starts whenever
 * the gap to the previous return exceeds it, so ten returns five minutes
 * apart form ONE wave spanning most of an hour. That transitivity is why
 * it stays small — a larger value does not widen a wave, it bridges
 * separate ones through whatever happens to return in between.
 */
export const DEFAULT_CLUSTER_GAP_SECONDS = 300;

/**
 * How far apart, in seconds, two still-PROVISIONAL waves may return and
 * still be recognised as one send (see {@link reconcileWaves}'s merge
 * pass). Deliberately much wider than {@link DEFAULT_CLUSTER_GAP_SECONDS}:
 * sending a wave takes minutes and the flight times differ per expedition,
 * so a late-sent mission can land well outside the chain gap and would
 * otherwise become a wave of its own with a full, duplicate reminder set.
 *
 * It is safe to be this wide ONLY because it applies to provisional waves,
 * which exist for the few minutes a send takes. A window this size in the
 * general grouping would bridge waves sent an hour apart through whatever
 * happened to return in between — which costs a MISSING reminder, the one
 * failure worse than a spare one.
 */
export const PROVISIONAL_JOIN_SECONDS = 900;

/**
 * Default membership-settling window, in seconds (see the header's
 * "Provisional vs COMMITTED"). Long enough to cover a multi-minute send
 * — the clock restarts on every new member, so it is measured from the
 * LAST expedition of the wave, not the first — and irrelevant to the
 * player, whose earliest reminder is a round trip away.
 */
export const DEFAULT_SETTLE_SECONDS = 180;

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
 * the feature layer.
 *
 * @typedef {object} ReturnEntry
 * @property {string} id        Event-row id (`eventRow-<n>`) — the member
 *   key, stable for the leg's whole life. See the module header.
 * @property {number} returnAt  Epoch SECONDS the fleet lands back home.
 *   An ATTRIBUTE, not identity: it can change in flight.
 * @property {string} origin    Origin coords `"g:s:p"`. May be empty.
 */

/**
 * A clustered wave — the unit ntfy.sh reminds on.
 *
 * @typedef {object} Wave
 * @property {string}   id          Stable identity stamped at creation and
 *   carried through the wave's life.
 * @property {string[]} memberIds   Sorted event-row ids currently in flight
 *   for this wave. THE identity carrier; shrinks as expeditions land.
 * @property {number}   anchorAt    Schedule anchor — the earliest return
 *   observed when the wave was created, frozen for life. See the header.
 * @property {number}   nextWaveAt  Epoch SECONDS of the EARLIEST return
 *   currently observed. Drifts; display only, never identity or anchor.
 * @property {number}   fleetCount  How many expeditions share this wave.
 * @property {number[]} returnAts   Sorted, unique return-time timestamps
 *   currently observed. Display + legacy matching only.
 * @property {string[]} origins     Sorted, de-duplicated origin coords
 *   (for display only).
 * @property {number}   [detectedAt] Epoch SECONDS this wave was first
 *   observed. Carried forward across scans.
 * @property {number}   [membersChangedAt] Epoch SECONDS a member last
 *   JOINED. Drives the settle window; landings do not bump it.
 * @property {number}   [committedAt] Epoch SECONDS the wave was sealed and
 *   became schedulable. Absent ⇒ provisional (see the header).
 * @property {boolean}  [cancelled] This wave is suppressed — the scheduler
 *   skips it for the rest of its life. Set either by the user dismissing
 *   it from the Dashboard OR by the brand-new cleanup rule (a re-send made
 *   its remaining alarmClock noise; see {@link reconcileWaves}). Carried
 *   across scans so the flag sticks as fleets land. Naturally cleared when
 *   the wave falls out of `out` (every member landed) and a re-send stamps
 *   a brand-new wave.
 */

/**
 * Per-wave alarmClock bookkeeping. Keyed by {@link Wave.id} in the gist's
 * `notifyState`. Stores the ids of the ntfy.sh messages we have queued
 * for that wave so a "player is back" event can cancel them before
 * delivery.
 *
 * @typedef {object} NotifyEntry
 * @property {number} [baseAt] Locked schedule anchor (epoch SECONDS) —
 *   mirrors {@link Wave.anchorAt}. The wave's alarmClock slots are
 *   `baseAt + offsetsSec[i]` for the resolved schedule (see
 *   `sync/ntfyReconciler.offsetsForSchedule`).
 * @property {string[]} [scheduledMessageIds] ntfy.sh message ids currently
 *   queued for this wave (mirrors the queue; used by the Dashboard preview
 *   and its cross-universe orphan backstop).
 */

/**
 * A clustering candidate produced by {@link clusterWaves}.
 *
 * @typedef {object} WaveCandidate
 * @property {number}   nextWaveAt
 * @property {number}   fleetCount
 * @property {number[]} returnAts
 * @property {string[]} origins
 * @property {string[]} memberIds
 */

/**
 * Reduce a flat list of return-flights into one {@link WaveCandidate}
 * per group of returns whose consecutive gaps stay within `gapSeconds`.
 *
 * Used by {@link reconcileWaves} for returns that belong to no wave yet
 * (and by the caller for display). A return already claimed by a wave is
 * never routed through here — it is followed by its row id instead.
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

  return clusters.map(summarise);
};

/**
 * Summarise a group of return-flights into the display + identity fields
 * every wave carries. Shared by {@link clusterWaves} and the reconcile so
 * the two can never disagree about how a group is described.
 *
 * Two fleets sharing an epoch second collapse to one `returnAts` element
 * (set semantics); `fleetCount` keeps the true count from the group size.
 *
 * @param {ReturnEntry[]} group  Non-empty, ascending by `returnAt`.
 * @returns {WaveCandidate}
 */
const summarise = (group) => ({
  nextWaveAt: group[0].returnAt,
  fleetCount: group.length,
  returnAts: [...new Set(group.map((e) => e.returnAt))].sort((a, b) => a - b),
  origins: [...new Set(group.map((e) => e.origin).filter(Boolean))].sort(),
  memberIds: [...new Set(group.map((e) => e.id).filter(Boolean))].sort(),
});

/**
 * Is this wave sealed (see the header's "Provisional vs COMMITTED")?
 *
 * @param {Wave} w
 * @returns {boolean}
 */
export const isWaveCommitted = (w) => typeof w.committedAt === 'number';

/**
 * Should a provisional wave be sealed now? True once its membership has
 * been stable for `settleSec` (the send finished) or its anchor is close
 * enough that waiting would cost the first reminder.
 *
 * @param {Wave} w
 * @param {number} now        Epoch SECONDS.
 * @param {number} settleSec
 * @returns {boolean}
 */
const shouldCommit = (w, now, settleSec) =>
  now - (w.membersChangedAt ?? w.detectedAt ?? now) >= settleSec
  || w.anchorAt - now <= settleSec;

/**
 * The live return-flights belonging to a stored wave, by member id.
 *
 * Legacy bridge: a wave written before membership moved to row ids has no
 * `memberIds`. For those — and ONLY those — we fall back to the old
 * return-time match, which re-adopts the still-flying members and lets the
 * wave carry on with a proper member set from this scan on. Without it the
 * upgrade would orphan every wave in flight and re-schedule all of them.
 *
 * @param {Wave} w
 * @param {ReturnEntry[]} entries
 * @returns {ReturnEntry[]} Ascending by `returnAt`.
 */
const liveMembersOf = (w, entries) => {
  const ids = new Set(w.memberIds ?? []);
  const live = ids.size > 0
    ? entries.filter((e) => ids.has(e.id))
    : (() => {
        const times = new Set(w.returnAts ?? []);
        return entries.filter((e) => times.has(e.returnAt));
      })();
  return live.slice().sort((a, b) => a.returnAt - b.returnAt);
};

/**
 * Reconcile the previously-stored waves with the return-flights just
 * observed in the event list.
 *
 * The pass runs in two halves, which is the whole point of the design:
 *
 *   1. **Sealed waves keep their members by id.** A committed wave claims
 *      every observed row whose id is in its membership, whatever that
 *      row's arrival time now says — so a return-speed outcome is a field
 *      update, not a new wave. Members only leave by landing; a wave whose
 *      last member has landed is dropped (the caller cancels its queued
 *      messages).
 *   2. **Everything else re-clusters freely.** Unclaimed rows and the
 *      members of still-provisional waves go into one pool that is
 *      grouped by {@link clusterWaves}. A group containing members of a
 *      provisional wave INHERITS that wave (the oldest one, if a merge
 *      pulls two together), so a wave that briefly looked like fragments
 *      mid-send converges without ever having been scheduled. A group
 *      with no prior owner is brand-new: `id = 'w_' + min returnAt`,
 *      `anchorAt` frozen to that same moment.
 *
 * Each surviving wave is then sealed if {@link shouldCommit} says its
 * membership has settled.
 *
 * **Brand-new triggers cleanup**: whenever at least one brand-new wave is
 * detected, any surviving prior wave whose `nextWaveAt` is within
 * {@link CLEANUP_GRACE_SEC} of `now` (its first alarmClock already fired
 * or fires in <1 min) is TOMBSTONED (`cancelled: true`), NOT removed. The
 * player is clearly back in game; the rest of that wave's cycle is noise.
 * Keeping the wave in the set is what stops it resurrecting: its fleets
 * are still in flight, so they keep matching it and carry the flag
 * forward. The caller excludes `cancelled` waves from the live set, so
 * their queued messages are swept. The tombstone exits naturally once
 * every member lands.
 *
 * Pure: no `Date.now()` (time comes in via `now`), no mutation. Returns
 * the reconciled wave list plus the ids of waves that fell out (so the
 * caller can pick up their `notifyState` entries for cancellation).
 *
 * @param {Wave[]} prevWaves
 * @param {ReturnEntry[]} entries  Every expedition return-flight observed
 *   right now. MUST be an authoritative read (see the producer's
 *   event-list gate) — an empty list is taken as "everything landed".
 * @param {number} now             Epoch SECONDS.
 * @param {{ gapSeconds?: number, settleSec?: number }} [opts]
 * @returns {{ waves: Wave[], droppedIds: string[], brandNewDetected: boolean }}
 */
export const reconcileWaves = (prevWaves, entries, now, opts = {}) => {
  const gapSeconds = opts.gapSeconds ?? DEFAULT_CLUSTER_GAP_SECONDS;
  const settleSec = opts.settleSec ?? DEFAULT_SETTLE_SECONDS;

  // De-duplicate by row id (first wins) and drop unusable rows, so a
  // repeated id can never put one fleet in two waves.
  /** @type {ReturnEntry[]} */
  const live = [];
  /** @type {Set<string>} */
  const seenIds = new Set();
  for (const e of entries) {
    if (!Number.isFinite(e.returnAt)) continue;
    if (e.id) {
      if (seenIds.has(e.id)) continue;
      seenIds.add(e.id);
    }
    live.push(e);
  }

  /** @type {Wave[]} */
  const kept = [];
  /** @type {string[]} */
  const droppedIds = [];
  /** @type {Set<string>} */
  const claimed = new Set();

  // ── 1. every known wave keeps its members, by row id ──────────────────
  // Sealed and provisional alike: a member is followed by its id, so its
  // arrival time may do whatever it likes (the expedition return-speed
  // outcome) without moving it out of its wave. Members leave only by
  // landing; the last one landing drops the wave.
  for (const prevStored of prevWaves) {
    const mine = liveMembersOf(prevStored, live);
    if (mine.length === 0) {
      droppedIds.push(prevStored.id);
      continue;
    }
    // Legacy bridge (see liveMembersOf): a wave stored under the old
    // time-set model adopts the members we just matched by time AND is
    // treated as sealed — it was scheduled under the old rules, so
    // re-opening it would hand it a second schedule on the upgrade.
    const prev = (prevStored.memberIds ?? []).length > 0
      ? prevStored
      : {
          ...prevStored,
          memberIds: mine.map((e) => e.id).filter(Boolean).sort(),
          anchorAt: prevStored.anchorAt ?? prevStored.nextWaveAt,
          committedAt: prevStored.committedAt ?? prevStored.detectedAt ?? now,
        };
    for (const e of mine) claimed.add(e.id);
    kept.push(rebuild(prev, mine, now));
  }

  // ── 2. rows belonging to no known wave start provisional waves ────────
  for (const cand of clusterWaves(live.filter((e) => !claimed.has(e.id)), { gapSeconds })) {
    const stamp = cand.returnAts[0];
    kept.push({
      ...cand,
      id: 'w_' + stamp,
      anchorAt: stamp,
      detectedAt: now,
      membersChangedAt: now,
    });
  }

  // ── 3. fuse provisional waves that are really one send ────────────────
  // A wave sealed on an earlier scan is untouchable; the rest are still
  // open, and two of them returning within PROVISIONAL_JOIN_SECONDS are
  // the same send seen mid-flight — a mission whose flight time put it
  // outside the chain gap, which is the whole reason a half-sent wave used
  // to buy a second reminder set. The older wave wins, keeping the anchor
  // on the FIRST mission sent.
  const fused = fuseProvisional(kept, now);

  // ── 4. seal whatever has settled, and report what fell out ────────────
  const waves = fused.map((w) => (isWaveCommitted(w) ? w : commitIfSettled(w, now, settleSec)));
  const surviving = new Set(waves.map((w) => w.id));
  for (const prev of prevWaves) {
    if (!surviving.has(prev.id) && !droppedIds.includes(prev.id)) droppedIds.push(prev.id);
  }

  // A wave is brand-new only if it SURVIVED this pass under an id stamped
  // now — a cluster that was fused into an existing wave is not a new
  // send, and must not trip the cleanup rule below.
  const brandNewDetected = waves.some((w) => w.detectedAt === now);

  // Cleanup rule: a brand-new wave means the player is actively sending
  // again. Any older wave whose first alarmClock already fired (or fires
  // in <CLEANUP_GRACE_SEC) is noise from this point on. TOMBSTONE it
  // rather than remove it: its fleets are still in flight, so dropping it
  // would let the next scan re-detect them as a brand-new wave with a
  // fresh schedule. The flag rides along every scan until the last member
  // lands and the wave is dropped for real.
  if (brandNewDetected) {
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      if (w.detectedAt === now || w.cancelled) continue;
      if (w.nextWaveAt <= now + CLEANUP_GRACE_SEC) waves[i] = { ...w, cancelled: true };
    }
  }

  waves.sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  return { waves, droppedIds, brandNewDetected };
};

/**
 * Fuse waves that are still provisional and return close enough together
 * to be one send (see {@link PROVISIONAL_JOIN_SECONDS}). Sealed waves pass
 * through untouched — the seal is exactly the promise that a wave stops
 * being reorganised.
 *
 * Walks the list in return order and links each provisional wave to the
 * previous one when the gap between them is inside the window, so a chain
 * of late-sent missions converges on one wave. The survivor is the OLDEST
 * wave of the group (earliest `detectedAt`), which is what keeps the
 * anchor on the first mission of the send.
 *
 * @param {Wave[]} waves
 * @param {number} now
 * @returns {Wave[]} Fresh array; inputs are never mutated.
 */
const fuseProvisional = (waves, now) => {
  const provisional = waves.filter((w) => !isWaveCommitted(w));
  if (provisional.length < 2) return waves.slice();

  const ordered = provisional.slice().sort((a, b) => a.nextWaveAt - b.nextWaveAt);
  /** @type {Wave[][]} */
  const groups = [];
  for (const w of ordered) {
    const last = groups[groups.length - 1];
    const prevEnd = last ? last[last.length - 1].returnAts.at(-1) ?? 0 : -Infinity;
    if (last && w.nextWaveAt - prevEnd <= PROVISIONAL_JOIN_SECONDS) last.push(w);
    else groups.push([w]);
  }

  /** @type {Set<string>} ids of waves this pass absorbed into a survivor */
  const replaced = new Set();
  /** @type {Wave[]} */
  const merged = [];
  for (const group of groups) {
    if (group.length === 1) continue;
    const survivor = group
      .slice()
      .sort((a, b) => (a.detectedAt ?? 0) - (b.detectedAt ?? 0) || a.anchorAt - b.anchorAt)[0];
    for (const w of group) replaced.add(w.id);
    const memberIds = [...new Set(group.flatMap((w) => w.memberIds))].sort();
    const returnAts = [...new Set(group.flatMap((w) => w.returnAts))].sort((a, b) => a - b);
    merged.push({
      id: survivor.id,
      memberIds,
      anchorAt: survivor.anchorAt,
      nextWaveAt: returnAts[0],
      fleetCount: group.reduce((sum, w) => sum + w.fleetCount, 0),
      returnAts,
      origins: [...new Set(group.flatMap((w) => w.origins))].sort(),
      detectedAt: survivor.detectedAt,
      // A fuse IS a membership change for every wave but the survivor, so
      // the settle clock restarts: the send is evidently still running.
      membersChangedAt: now,
      ...(group.some((w) => w.cancelled) ? { cancelled: true } : {}),
    });
  }

  return [...waves.filter((w) => !replaced.has(w.id)), ...merged];
};

/**
 * Refresh a sealed wave's observed fields from its live members. Identity,
 * anchor and the settle bookkeeping are carried verbatim — a sealed wave
 * neither re-anchors nor re-commits, and a landing is not a membership
 * change for the settle clock.
 *
 * @param {Wave} prev
 * @param {ReturnEntry[]} members  Non-empty, ascending by `returnAt`.
 * @param {number} now
 * @returns {Wave}
 */
const rebuild = (prev, members, now) => ({
  ...summarise(members),
  id: prev.id,
  anchorAt: prev.anchorAt,
  detectedAt: prev.detectedAt ?? now,
  membersChangedAt: prev.membersChangedAt ?? prev.detectedAt ?? now,
  committedAt: prev.committedAt,
  ...(prev.cancelled ? { cancelled: true } : {}),
});

/**
 * Stamp `committedAt` on a provisional wave whose membership has settled
 * (see {@link shouldCommit}). Already-sealed waves never reach here.
 *
 * @param {Wave} w
 * @param {number} now
 * @param {number} settleSec
 * @returns {Wave}
 */
const commitIfSettled = (w, now, settleSec) =>
  shouldCommit(w, now, settleSec) ? { ...w, committedAt: now } : w;

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
  const liveIds = new Set(waves.map((w) => w.id));
  /** @type {Record<string, NotifyEntry>} */
  const next = {};
  for (const id of Object.keys(notifyState)) {
    if (liveIds.has(id)) next[id] = notifyState[id];
  }
  return next;
};
