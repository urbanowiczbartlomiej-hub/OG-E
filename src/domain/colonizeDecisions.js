// @ts-check

// Colonization decision log — the small, per-coordinate set of
// "looks-free-but-isn't" facts the public API physically cannot know, and the
// ONLY colonization state worth syncing cross-device (Stage 4).
//
// # Why this exists
//
// The OGame API (universe.xml, weekly) tells us which slots are occupied — but
// it lags up to 7 days and never knows our LOCAL actions. So a slot the API
// calls "empty" can in truth be: one we just dispatched a colonizer to; one we
// already colonized; one we colonized then ABANDONED (a HOLD — see below); one
// a live scan just saw taken while the API still lags; or one reserved by a
// planet-move (a temporary hold). This log records each as a per-coord decision
// so the colonize picker subtracts them and the Scout can flag them — and so a
// second device can "continue only the remaining free positions".
//
// # Abandonment is a temporary hold, not a permanent verdict
//
// OGame does NOT free an abandoned position immediately: the slot is released on
// the daily server cleanup (03:00 local/server time), and only for planets given
// up at least 24h earlier. Until that sweep a colony ship sent there is refused;
// AFTER it the position is colonizable again and yields a FRESH random planet (a
// re-roll — the old field count no longer applies). So `abandoned` blocks only
// for its hold window ({@link abandonRecolonizableAt}); past the window the coord
// returns to the candidate pool exactly as the game frees it. The weekly API
// lags this by up to 7 days and may still list the freed slot as ours, so the
// picker OVERRIDES a stale "occupied-by-us" with the local freed fact
// ({@link freedAbandonedCoords}).
//
// Lifecycle (see the per-coord state diagram): empty → sent → {mine | taken |
// (recall→empty)}; mine → abandoned → (game window → empty, re-roll); empty →
// reserved → (expiry→empty).
//
// Pure: no DOM/storage/clock — `domain/` contract. The reactive store lives in
// `state/colonizeDecisions.js`; the writers in features.

/** We dispatched a colonizer here; in-flight (`aa` = arrival epoch-ms). */
export const DEC_SENT = 1;
/** Our colony (landed). `f` = planet field count (API-invisible histogram datum). */
export const DEC_MINE = 2;
/** We colonized then gave it up. HOLD, not permanent: blocks only for the game's
 *  re-colonization window ({@link abandonRecolonizableAt}), then frees for a
 *  re-roll. `ts` = give-up time (drives the window); `f` = last field count. */
export const DEC_ABANDONED = 3;
/** A live scan / the API shows a foreign owner: not a target. */
export const DEC_TAKEN = 4;
/** Planet-move hold (checkTarget error 140016); temporary (`aa` = expiry epoch-ms). */
export const DEC_RESERVED = 5;

/** No-show grace after a sent fleet's arrival before it stops blocking (recall/fail). */
export const SENT_GRACE_MS = 60 * 60 * 1000; // 1h
/** Estimated planet-move hold window stamped onto a `reserved` decision's `aa`. */
export const RESERVE_HOLD_MS = 36 * 60 * 60 * 1000; // ~36h
/** Age after which a `taken` decision is prunable (the API re-derives occupancy). */
export const TAKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d

/**
 * Minimum age an abandoned planet must reach before the game's daily cleanup
 * will free its position (OGame rule the user verified: freed only 24h AFTER
 * give-up, and only on the 03:00 sweep).
 */
export const ABANDON_MIN_HOLD_MS = 24 * 60 * 60 * 1000; // 24h
/** Local/server hour of OGame's daily position-cleanup sweep. */
export const ABANDON_CLEANUP_HOUR = 3; // 03:00

/**
 * When an abandoned position becomes colonizable again: the FIRST daily cleanup
 * (03:00 local — the extension treats the local wall clock as server time, like
 * `domain/traderClock.js` / `domain/gameDayKey.js`) that falls at least 24h
 * after the give-up. Conservative by construction — never earlier than the game
 * actually frees the slot, so a colony ship is never wasted on a still-held one.
 *
 * @param {number} ts  Give-up epoch-ms (the `abandoned` decision's `ts`).
 * @returns {number}   Epoch-ms the position re-enters the candidate pool.
 */
export const abandonRecolonizableAt = (ts) => {
  const earliest = ts + ABANDON_MIN_HOLD_MS;
  const at = new Date(earliest);
  at.setHours(ABANDON_CLEANUP_HOUR, 0, 0, 0);
  if (at.getTime() < earliest) at.setDate(at.getDate() + 1);
  return at.getTime();
};

/**
 * @typedef {object} Decision
 * @property {1|2|3|4|5} s   State (see DEC_* constants).
 * @property {number} ts     Epoch-ms of the decision — the LWW merge key.
 * @property {number} [aa]   Arrival (sent) / expiry (reserved) epoch-ms.
 * @property {number} [f]    Planet field count — only on `mine`/`abandoned`.
 * @property {string} [src]  Originating install id — diagnostics only, NOT merged.
 */

/** @typedef {Record<string, Decision>} DecisionMap  Keyed by `"g:s:p"`. */

/** States that must never regress to sent/reserved (they're outcomes, not pending). */
const TERMINAL = new Set([DEC_MINE, DEC_ABANDONED, DEC_TAKEN]);

/**
 * Merge two decisions for the SAME coord. A terminal outcome
 * (mine/abandoned/taken) never regresses to sent/reserved regardless of `ts`;
 * otherwise newest `ts` wins (ties → `incoming`).
 *
 * @param {Decision | undefined} existing
 * @param {Decision | undefined} incoming
 * @returns {Decision | undefined}
 */
export const mergeDecision = (existing, incoming) => {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const exTerm = TERMINAL.has(existing.s);
  const inTerm = TERMINAL.has(incoming.s);
  if (exTerm && !inTerm) return existing;
  if (inTerm && !exTerm) return incoming;
  return incoming.ts >= existing.ts ? incoming : existing;
};

/**
 * Apply one decision to a map, monotonically. Returns the SAME map reference
 * when nothing changed (so a store `update` is a no-op), else a new map.
 *
 * @param {DecisionMap} map
 * @param {string} coordKey  `"g:s:p"`.
 * @param {Decision} decision
 * @returns {DecisionMap}
 */
export const withDecision = (map, coordKey, decision) => {
  const merged = mergeDecision(map[coordKey], decision);
  if (merged === map[coordKey]) return map;
  return { ...map, [coordKey]: /** @type {Decision} */ (merged) };
};

/**
 * Union-merge two full decision maps (for cross-device gist sync, Stage 4).
 * Per-coord {@link mergeDecision}; `changed` is true iff the result differs
 * from `local`.
 *
 * @param {DecisionMap} local
 * @param {DecisionMap} remote
 * @returns {{ merged: DecisionMap, changed: boolean }}
 */
export const mergeColonizeDecisions = (local, remote) => {
  /** @type {DecisionMap} */
  const merged = { ...local };
  let changed = false;
  for (const key of Object.keys(remote)) {
    const m = mergeDecision(local[key], remote[key]);
    if (m && m !== local[key]) {
      merged[key] = m;
      changed = true;
    }
  }
  return { merged, changed };
};

/**
 * Drop decisions that no longer carry information — storage hygiene only (the
 * picker's {@link blockingCoords} already ignores expired holds/no-shows at
 * read time, so correctness doesn't depend on running this). Removes a
 * `sent` past arrival+grace (recall/fail no-show), an expired `reserved`, and
 * an aged `taken`. `mine`/`abandoned` are kept forever (they carry `f`).
 *
 * @param {DecisionMap} map
 * @param {number} now  Epoch-ms.
 * @returns {{ map: DecisionMap, changed: boolean }}
 */
export const compactDecisions = (map, now) => {
  /** @type {DecisionMap} */
  const out = {};
  let changed = false;
  for (const key of Object.keys(map)) {
    const d = map[key];
    if (d.s === DEC_SENT && typeof d.aa === 'number' && d.aa + SENT_GRACE_MS < now) {
      changed = true;
      continue;
    }
    if (d.s === DEC_RESERVED && typeof d.aa === 'number' && d.aa < now) {
      changed = true;
      continue;
    }
    if (d.s === DEC_TAKEN && d.ts + TAKEN_TTL_MS < now) {
      changed = true;
      continue;
    }
    out[key] = d;
  }
  return { map: changed ? out : map, changed };
};

/**
 * The set of `"g:s:p"` coords a colonize candidate must currently avoid: any
 * sent (still within arrival+grace), mine, taken, abandoned (still within its
 * game re-colonization window), or reserved (still within its hold). Expired
 * sent/reserved and past-window abandoned entries do NOT block — the slot is
 * free again (a freed abandoned slot is ALSO surfaced positively by
 * {@link freedAbandonedCoords} so it overrides stale scan/API occupancy).
 *
 * @param {DecisionMap} map
 * @param {number} now  Epoch-ms.
 * @returns {Set<string>}
 */
export const blockingCoords = (map, now) => {
  /** @type {Set<string>} */
  const set = new Set();
  for (const key of Object.keys(map)) {
    const d = map[key];
    switch (d.s) {
      case DEC_MINE:
      case DEC_TAKEN:
        set.add(key);
        break;
      case DEC_ABANDONED:
        // A hold, not a permanent block: frees on the game's daily cleanup.
        if (typeof d.ts !== 'number' || now < abandonRecolonizableAt(d.ts)) set.add(key);
        break;
      case DEC_SENT:
        if (typeof d.aa !== 'number' || d.aa + SENT_GRACE_MS > now) set.add(key);
        break;
      case DEC_RESERVED:
        if (typeof d.aa !== 'number' || d.aa > now) set.add(key);
        break;
      default:
        break;
    }
  }
  return set;
};

/**
 * The `"g:s:p"` coords whose `abandoned` hold has passed — positions the game
 * has (or is about to) free for re-colonization. Surfaced as a POSITIVE "free
 * again" signal so the picker overrides the two stale layers that would still
 * hide them: our own `abandoned` remnant in the live scan map, and a weekly-API
 * snapshot that predates the give-up and still lists the slot as ours. Each
 * yields a fresh random planet on re-colonization (a re-roll), so the retained
 * `f` no longer applies. Kept in the log (not pruned) precisely so this override
 * survives until the slot is actually re-sent/re-colonized.
 *
 * @param {DecisionMap} map
 * @param {number} now  Epoch-ms.
 * @returns {Set<string>}
 */
export const freedAbandonedCoords = (map, now) => {
  /** @type {Set<string>} */
  const set = new Set();
  for (const key of Object.keys(map)) {
    const d = map[key];
    if (d.s === DEC_ABANDONED && typeof d.ts === 'number' && now >= abandonRecolonizableAt(d.ts)) {
      set.add(key);
    }
  }
  return set;
};

/**
 * Drop a past-window `abandoned` entry at one coord so a fresh `sent`/`mine`
 * write lands cleanly. `abandoned` is TERMINAL (it must beat the `mine` it
 * replaces on give-up), so a later non-terminal `sent` would otherwise be held
 * off by {@link mergeDecision}. Callers invoke this right before recording a
 * re-colonization send to a freed slot. Returns the SAME map when nothing was
 * cleared (no-op store update).
 *
 * @param {DecisionMap} map
 * @param {string} coordKey  `"g:s:p"`.
 * @param {number} now  Epoch-ms.
 * @returns {DecisionMap}
 */
export const clearFreedAbandoned = (map, coordKey, now) => {
  const d = map[coordKey];
  if (d && d.s === DEC_ABANDONED && typeof d.ts === 'number' && now >= abandonRecolonizableAt(d.ts)) {
    const rest = { ...map };
    delete rest[coordKey];
    return rest;
  }
  return map;
};
