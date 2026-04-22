// @ts-check

// Pure domain logic for the colonization registry — the short list of
// "fleets we just dispatched on mission=colonize" that 4.x used to
// coordinate the min-gap timer and to hide already-ours coords from the
// scan UI. Three helpers, no I/O: prune expired entries, dedupe a
// candidate against recent identical sends, detect min-gap conflicts.
//
// Zero side effects. The caller does all the storage work (localStorage
// in the extension, in-memory in tests) and feeds plain arrays in and
// out of these functions. Time is passed explicitly as `now` so tests
// can replay any scenario deterministically; the `Date.now()` default
// is a convenience for production callers only.
//
// Exports:
//   - RegistryEntry  {coords, sentAt, arrivalAt}      typedef
//   - pruneRegistry(reg, now?)                        drop arrived/unparseable
//   - dedupeEntry(reg, candidate, toleranceMs?)       guard against re-adds
//   - findConflict(reg, candidateArrivalAt, minGapMs, now?)  min-gap probe
//
// Behavioural parity target: OG-E 4.x. The reference implementations
// live in `content.js` (prune on scan read), `fleet-redirect.js` (sync
// dedup-then-push in the XHR send hook) and `mobile.js:getColonizeWaitTime`
// (min-gap conflict search). The v5 rewrite consolidates those three
// ad hoc pieces into one pure module.
//
// @see ../../SCHEMAS.md (see OG-E 4.x) for the oge_colonizationRegistry schema.

/**
 * @typedef {object} RegistryEntry
 * @property {`${number}:${number}:${number}`} coords
 *   Target coordinate string in "galaxy:system:position" form. Position
 *   is 0 when the send response did not expose one; we still store the
 *   entry to block min-gap even without a position.
 * @property {number} sentAt
 *   Millisecond epoch captured with `Date.now()` immediately before the
 *   native XHR send. Used only for dedup (±toleranceMs window) — never
 *   for flight-time math.
 * @property {number} arrivalAt
 *   `sentAt + durationSec * 1000`. 0 when the duration element was
 *   missing or unparseable at send time; such entries are always
 *   pruned (see {@link pruneRegistry}) because they cannot contribute
 *   to min-gap conflict detection.
 */

/**
 * Drop every entry whose fleet has already landed, returning a freshly
 * allocated array of the still-pending entries.
 *
 * An entry is *pending* iff `arrivalAt > now`. Entries with
 * `arrivalAt <= now` represent fleets whose colonization has already
 * completed (or would have by `now`) — they no longer constrain future
 * sends and must be removed so they do not pollute min-gap calculations.
 *
 * Entries with `arrivalAt === 0` (duration was unparseable at send
 * time) are always dropped: `0 <= now` for any realistic `now > 0`, so
 * this falls out of the same comparison. Documented explicitly because
 * callers sometimes reason about the zero case separately.
 *
 * Pure: does not mutate `reg`. The returned array is always a new
 * reference, even if every entry survives.
 *
 * @param {RegistryEntry[]} reg  current registry
 * @param {number} [now=Date.now()]  cut-off timestamp (ms)
 * @returns {RegistryEntry[]}    pending entries, in original order
 *
 * @example
 *   const reg = [
 *     { coords: '1:2:3', sentAt: 100, arrivalAt: 1000 },  // pending
 *     { coords: '1:2:4', sentAt: 200, arrivalAt: 500 },   // arrived
 *     { coords: '1:2:5', sentAt: 300, arrivalAt: 0 },     // unparsed
 *   ];
 *   pruneRegistry(reg, 600);
 *   // → [{ coords: '1:2:3', sentAt: 100, arrivalAt: 1000 }]
 */
export const pruneRegistry = (reg, now = Date.now()) =>
  reg.filter((r) => r.arrivalAt > now);

/**
 * Append `candidate` to `reg` unless a near-duplicate already exists.
 *
 * "Near-duplicate" means an entry with identical `coords` *and* a
 * `sentAt` within `±toleranceMs` of the candidate. Both conditions
 * must hold — identical coords alone are not enough (two legitimate
 * colonizations of the same coord can happen minutes apart if the
 * first one fails), and a close sentAt alone is not enough (two
 * different targets can be sent within the same second).
 *
 * The default tolerance of 2000 ms is taken verbatim from the 4.x
 * `fleet-redirect.js` sync pre-register path. Two seconds is wide
 * enough to catch retry bursts and the rare fleet-redirect hook
 * misfire where the same send shows up twice, and narrow enough that a
 * deliberate re-send of the same coord after the first attempt lands
 * is not falsely swallowed.
 *
 * Strict `<=` (inclusive): a candidate exactly `toleranceMs` away from
 * an existing entry is still considered a duplicate. Callers that want
 * zero-tolerance exact matching pass `toleranceMs = 0`, in which case
 * only an identical `sentAt` triggers the dedup.
 *
 * Pure: does not mutate `reg`. Returns either the same reference (when
 * the candidate is a duplicate) or a new array `[...reg, candidate]`.
 *
 * @param {RegistryEntry[]} reg           current registry
 * @param {RegistryEntry}   candidate     entry to add
 * @param {number}          [toleranceMs=2000]  dedup window around sentAt
 * @returns {RegistryEntry[]}             reg unchanged, or reg + candidate
 *
 * @example
 *   const reg = [{ coords: '1:2:3', sentAt: 1000, arrivalAt: 60000 }];
 *   // Same coord, 1.5s later — duplicate, reg unchanged.
 *   dedupeEntry(reg, { coords: '1:2:3', sentAt: 2500, arrivalAt: 61500 });
 *   // Same coord, 3s later — outside tolerance, appended.
 *   dedupeEntry(reg, { coords: '1:2:3', sentAt: 4000, arrivalAt: 63000 });
 *   // Different coord, same sentAt — not a dup, appended.
 *   dedupeEntry(reg, { coords: '1:2:4', sentAt: 1000, arrivalAt: 61000 });
 */
export const dedupeEntry = (reg, candidate, toleranceMs = 2000) => {
  const isDup = reg.some(
    (r) =>
      r.coords === candidate.coords &&
      Math.abs(r.sentAt - candidate.sentAt) <= toleranceMs,
  );
  return isDup ? reg : [...reg, candidate];
};

/**
 * Return the first still-pending registry entry whose arrival time sits
 * within `minGapMs` of `candidateArrivalAt`, or `null` if none do.
 *
 * "Within minGapMs" uses strict `<`: an entry *exactly* `minGapMs` away
 * is NOT a conflict. This matches the 4.x `mobile.js:getColonizeWaitTime`
 * semantics, where `if (gap < minGap) conflict` — at the boundary the
 * gap is already "enough" by definition of minGap.
 *
 * Only pending entries (arrivalAt > now) participate. Entries that have
 * already arrived cannot conflict with a future landing; they are
 * simply ignored here. `pruneRegistry` would have removed them anyway,
 * but this redundancy means callers who skip the prune still get
 * correct answers.
 *
 * When `candidateArrivalAt === 0` we cannot compute a gap and return
 * `null` — the safe default of "no conflict", matching the 4.x behaviour
 * of returning wait=0 when `#durationOneWay` was unparseable.
 *
 * Order of iteration is array order, and the first match wins. Callers
 * that want the *worst* conflict (longest wait) must iterate themselves;
 * here we short-circuit because, for the min-gap timer, "is there any
 * conflict at all?" is already the decision — the concrete worst entry
 * is a diagnostic detail, not a correctness issue.
 *
 * Pure: does not read the clock beyond the `now` default, does not
 * mutate `reg`.
 *
 * @param {RegistryEntry[]} reg                 current registry
 * @param {number}          candidateArrivalAt  prospective arrival (ms)
 * @param {number}          minGapMs            required separation (ms)
 * @param {number}          [now=Date.now()]    pending/expired cut-off
 * @returns {RegistryEntry | null}              first conflicting entry, or null
 *
 * @example
 *   const reg = [
 *     { coords: '1:2:3', sentAt: 0, arrivalAt: 10_000 },
 *     { coords: '1:2:4', sentAt: 0, arrivalAt: 15_000 },
 *   ];
 *   // Our fleet would land at 10_500, minGap 1000.
 *   //   gap to :3 = 500  < 1000 → conflict, returns the :3 entry.
 *   findConflict(reg, 10_500, 1000, 0);
 *
 *   // Our fleet would land at 11_000, minGap 1000.
 *   //   gap to :3 = 1000 NOT < 1000 → no conflict from :3.
 *   //   gap to :4 = 4000 NOT < 1000 → no conflict from :4.
 *   // Returns null.
 *   findConflict(reg, 11_000, 1000, 0);
 */
export const findConflict = (
  reg,
  candidateArrivalAt,
  minGapMs,
  now = Date.now(),
) => {
  if (candidateArrivalAt === 0) return null;
  for (const r of reg) {
    // Defensive coerce to `Number` — older registry payloads (hand-
    // written import, pre-v5 leftovers, migration remnants) have been
    // observed to carry `arrivalAt` as a string. v4 4.9.4 learned this
    // the hard way: `string <= now` tricks one-sided coercion and
    // `Math.abs('10000' - 10000)` gives 0, which would mask a real
    // min-gap conflict. An explicit cast here makes every downstream
    // comparison numeric and keeps the logic identical for
    // well-formed data.
    const arrivalAt = Number(r.arrivalAt) || 0;
    if (arrivalAt <= now) continue;
    if (Math.abs(arrivalAt - candidateArrivalAt) < minGapMs) return r;
  }
  return null;
};
