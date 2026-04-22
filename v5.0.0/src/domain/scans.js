// Galaxy-scan domain logic. Two responsibilities live here and only here:
//
//   1. CLASSIFY a fresh observation from the game's `galaxyContent` array
//      into our canonical {status, player?, flags?} shape. OGame's payload
//      carries a dozen independent per-player flags (isAdmin / isBanned /
//      isOnVacation / isInactive / isLongInactive / …) and a nested
//      `planets` array with its own pile of flags (isDestroyed / isMoon /
//      luna / debris). `classifyPosition` is THE place where that flag
//      soup collapses into a single 10-state status enum plus an
//      independent flag set, so every downstream consumer (colonization
//      target picker, galaxy overlay painter, target list) operates on
//      the same stable vocabulary.
//
//   2. MERGE a fresh per-system scan with the previous snapshot, with
//      ONE twist: the game's galaxy view is oblivious to our own in-flight
//      colonize fleets. A slot we dispatched a colonizer to just looks
//      `empty` in the scan until the fleet lands. If we let that fresh
//      `empty` overwrite our locally-stamped `empty_sent` marker, the
//      target picker would immediately re-pick the slot and double-send.
//      `mergeScanResult` preserves `empty_sent` iff the pending-fleet
//      registry (passed in as a Set of coord keys, built by a caller
//      outside this module) confirms the fleet is still on the way.
//      Everything observable in-game (mine / occupied / abandoned / …)
//      always wins — the scan is authoritative for visible state.
//
// Both functions are PURE: no DOM access, no storage, no timers, no
// reading of `Date.now()` or any module-level mutable state. All
// "am I still waiting on a fleet?" knowledge arrives through the
// `pendingCoordKeys` parameter. This keeps the module trivially
// unit-testable (no mocks, no fake timers) and lets us reuse it from
// anywhere — background service worker, content script, tests —
// without dragging in platform assumptions.
//
// @ts-check

/**
 * One of ten canonical states we assign to a galaxy slot.
 *
 * - `empty`         — no planets, no pending fleet of ours
 * - `empty_sent`    — WE dispatched a colonizer here; game hasn't seen it yet
 * - `mine`          — live planet owned by `ownPlayerId`
 * - `occupied`      — live planet owned by some other active player
 * - `inactive`      — owner has the game's `i` (inactive) flag
 * - `long_inactive` — owner has the game's `I` (long-inactive) flag
 * - `vacation`      — owner is in vacation mode
 * - `banned`        — owner is banned
 * - `admin`         — owner is an admin / GM account
 * - `abandoned`     — only destroyed-planet remnants remain
 *
 * @typedef {'empty' | 'empty_sent' | 'mine' | 'occupied' | 'inactive'
 *   | 'long_inactive' | 'vacation' | 'banned' | 'admin' | 'abandoned'} PositionStatus
 */

/**
 * Independent observational flags attached to a position. Each is
 * `true` when present, absent when not — we never carry `false`
 * explicitly so `Object.keys(flags).length === 0` means "nothing
 * interesting" and the whole `flags` object is omitted from the
 * parent `Position`.
 *
 * @typedef {object} PositionFlags
 * @property {true} [hasAbandonedPlanet] Destroyed-planet remnants present
 *   (a d-slot or similar). Coexists with a live planet — a player can
 *   still own slot N while slot N has leftover debris of a prior colony.
 * @property {true} [hasMoon] At least one planet in the slot carries a
 *   moon (`isMoon` or `luna` truthy in the game payload).
 * @property {true} [hasDebris] Debris field observed, either attached
 *   to the slot (`entry.debris`) or to one of its planets (`p.debris`).
 * @property {true} [inAlliance] The slot's player has a non-zero
 *   `allyId`. Absent for empty / abandoned / mine positions where we
 *   intentionally drop the `player` block.
 */

/**
 * A minimal player projection. We deliberately keep this to the two
 * fields every consumer needs; richer metadata lives in a separate
 * player cache, not in per-slot scan results.
 *
 * @typedef {object} PositionPlayer
 * @property {number} id   Game-assigned `playerId`.
 * @property {string} name Game-shown `playerName` (display name).
 */

/**
 * Our canonical shape for one slot in one system. Produced by
 * {@link classifyPosition} (fresh observation) or preserved by
 * {@link mergeScanResult} (keeping `empty_sent` alive across rescans).
 *
 * Invariants:
 *   - `player` is present iff `status ∈ { occupied, inactive,
 *     long_inactive, vacation, banned, admin }`.
 *     It is OMITTED for `mine` (that's us), and for the no-planet
 *     statuses (`empty`, `empty_sent`, `abandoned`).
 *   - `flags` is present iff at least one flag is set. When no flags
 *     apply the whole key is dropped — callers MUST null-check.
 *
 * @typedef {object} Position
 * @property {PositionStatus} status
 * @property {PositionPlayer} [player] Present only for non-`mine` live
 *   colonies — see invariant above.
 * @property {PositionFlags} [flags] Absent when no flags apply.
 */

/**
 * Shape of a single entry in the game's `galaxyContent` array (what we
 * observe passively via the galaxy XHR hook). We only describe the
 * fields we actually consume; the real payload carries more, but
 * anything we don't read stays `unknown` from the domain's perspective.
 *
 * @typedef {object} GalaxyContentEntry
 * @property {number} position Slot number 1..15.
 * @property {Array<{
 *   isDestroyed?: boolean,
 *   isMoon?: boolean,
 *   luna?: unknown,
 *   debris?: unknown,
 * }>} [planets] Zero-or-more planet entries. A slot is observable as
 *   empty when this is missing OR empty-after-filter.
 * @property {{
 *   playerId: number,
 *   playerName: string,
 *   isAdmin?: boolean,
 *   isBanned?: boolean,
 *   isOnVacation?: boolean,
 *   isInactive?: boolean,
 *   isLongInactive?: boolean,
 *   allyId?: number,
 * }} [player] Owner metadata. Absent on empty / abandoned slots.
 * @property {unknown} [debris] System-level debris hint (the game
 *   sometimes attaches debris at the entry level rather than per-planet).
 */

/**
 * Classify one `galaxyContent` entry into our {@link Position} shape.
 *
 * Flags are computed independently of status, so e.g. a `long_inactive`
 * colony with a moon and an alliance membership produces all three flags
 * plus the right status in one pass.
 *
 * Status resolution (first-match wins):
 *
 * ```
 *   no live planet:
 *     flags.hasAbandonedPlanet  → 'abandoned'
 *     else                      → 'empty'
 *   live planet:
 *     player.playerId === ownPlayerId → 'mine' (player block dropped)
 *     player.isAdmin                  → 'admin'
 *     player.isBanned                 → 'banned'
 *     player.isOnVacation             → 'vacation'
 *     player.isLongInactive           → 'long_inactive'  (before isInactive!)
 *     player.isInactive               → 'inactive'
 *     player present, no flag         → 'occupied'
 *     no player object                → 'occupied'       (unusual fallback)
 * ```
 *
 * Note the `isLongInactive`-before-`isInactive` order: the game sets
 * `isInactive=true` on any inactive account AND also sets
 * `isLongInactive=true` for the longer-dormancy subset. Checking the
 * stricter flag first means long_inactive colonies aren't mis-tagged
 * as plain `inactive`.
 *
 * Example — live colony belonging to someone else, with a moon:
 *
 * ```js
 * classifyPosition(
 *   {
 *     position: 8,
 *     planets: [{ isMoon: true }],
 *     player: { playerId: 99, playerName: 'Bob' },
 *   },
 *   123, // ownPlayerId
 * );
 * // → { status: 'occupied', player: { id: 99, name: 'Bob' }, flags: { hasMoon: true } }
 * ```
 *
 * Example — we own it, with destroyed-planet remains alongside:
 *
 * ```js
 * classifyPosition(
 *   {
 *     position: 4,
 *     planets: [{ isDestroyed: true }, {}],
 *     player: { playerId: 123, playerName: 'me' },
 *   },
 *   123,
 * );
 * // → { status: 'mine', flags: { hasAbandonedPlanet: true } }
 * // (no `player` block — it's us)
 * ```
 *
 * @param {GalaxyContentEntry} entry One element of the game's
 *   `data.system.galaxyContent` array.
 * @param {number | null} ownPlayerId Our own player id, used to
 *   short-circuit to the `mine` status. Pass `null` when unknown —
 *   our own colonies will then read as plain `occupied`, which the
 *   caller can live with until the id is available.
 * @returns {Position} The canonical projection. See the invariants on
 *   the {@link Position} typedef for which fields are present when.
 */
export const classifyPosition = (entry, ownPlayerId) => {
  const planets = entry.planets || [];
  const player = entry.player || null;
  const livePlanets = planets.filter((p) => !p.isDestroyed);

  // Compute flags defensively — a slot can carry debris / an abandoned
  // remnant / an alliance badge regardless of whether it ends up
  // classified as empty, occupied, or anything else. We build the
  // object up front so every branch below can reference the same
  // `flags.hasAbandonedPlanet` when deciding between 'empty' and
  // 'abandoned'.
  /** @type {PositionFlags} */
  const flags = {};
  if (planets.some((p) => p.isDestroyed)) flags.hasAbandonedPlanet = true;
  if (planets.some((p) => p.isMoon || p.luna)) flags.hasMoon = true;
  if (entry.debris || planets.some((p) => p.debris)) flags.hasDebris = true;
  if (player && player.allyId) flags.inAlliance = true;

  const hasAnyFlag = Object.keys(flags).length > 0;

  // No live planet — "empty-ish" branch. The only question is whether
  // destroyed remnants exist, which promotes us from 'empty' to
  // 'abandoned'. No `player` block is emitted in either case: the
  // game may still have a `player` object attached (stale metadata on
  // fully-destroyed colonies), but our vocabulary reserves the player
  // block for live-colony statuses.
  if (livePlanets.length === 0) {
    /** @type {Position} */
    const out = {
      status: flags.hasAbandonedPlanet ? 'abandoned' : 'empty',
    };
    if (hasAnyFlag) out.flags = flags;
    return out;
  }

  // Live planet owned by us. We explicitly drop the `player` block —
  // downstream code distinguishes "mine" from "occupied" by the
  // status, and leaking our own player id / name into every scan
  // result is pointless.
  if (player && ownPlayerId !== null && player.playerId === ownPlayerId) {
    /** @type {Position} */
    const out = { status: 'mine' };
    if (hasAnyFlag) out.flags = flags;
    return out;
  }

  // Live planet with an identifiable player. Pick status from the
  // player's flag soup; the priority ordering matters (admin/banned
  // > vacation > long_inactive > inactive > plain occupied).
  if (player) {
    /** @type {PositionStatus} */
    let status;
    if (player.isAdmin) status = 'admin';
    else if (player.isBanned) status = 'banned';
    else if (player.isOnVacation) status = 'vacation';
    else if (player.isLongInactive) status = 'long_inactive';
    else if (player.isInactive) status = 'inactive';
    else status = 'occupied';

    /** @type {Position} */
    const out = {
      status,
      player: { id: player.playerId, name: player.playerName },
    };
    if (hasAnyFlag) out.flags = flags;
    return out;
  }

  // Live planet with no player object. Unusual — the game normally
  // attaches a player record to any live colony — but defensive
  // handling keeps downstream code simple: treat as generic 'occupied'
  // without a player block. Flags still flow through untouched.
  /** @type {Position} */
  const out = { status: 'occupied' };
  if (hasAnyFlag) out.flags = flags;
  return out;
};

/**
 * Merge a fresh per-system scan with the previous snapshot, preserving
 * our locally-stamped `empty_sent` markers when — and only when — the
 * pending-fleet registry confirms our colonizer is still on the way.
 *
 * Policy: the fresh scan is authoritative for everything observable in
 * the game (mine / occupied / abandoned / inactive / …). The ONLY thing
 * we keep from the old snapshot is `empty_sent`, and only while ALL of
 * these hold simultaneously:
 *
 *   1. `existingPositions[p].status === 'empty_sent'`
 *      — we previously stamped this slot as "fleet en route"
 *   2. `freshPositions[p].status === 'empty'`
 *      — the game still sees the slot as empty (fleet not landed)
 *   3. `pendingCoordKeys.has(\`${systemKey}:${p}\`)`
 *      — the colonization registry still lists our fleet as pending
 *
 * If any one fails, the fresh value wins: the fleet landed (game now
 * shows `mine`), was intercepted / recalled (registry drops it, fresh
 * still shows `empty`), or the slot got colonized by someone else
 * (fresh shows `occupied`).
 *
 * Returns a NEW `positions` object — the function never mutates its
 * inputs. Individual `Position` objects are shared between input and
 * output by reference (shallow merge), so callers must not mutate the
 * inner shapes either; treat `Position` values as immutable.
 *
 * Example — fleet still in flight, slot observed empty: preserve:
 *
 * ```js
 * mergeScanResult(
 *   { 8: { status: 'empty_sent' } },
 *   { 8: { status: 'empty' } },
 *   new Set(['4:30:8']),
 *   '4:30',
 * );
 * // → { 8: { status: 'empty_sent' } }
 * ```
 *
 * Example — fleet landed, game now shows mine: fresh wins:
 *
 * ```js
 * mergeScanResult(
 *   { 8: { status: 'empty_sent' } },
 *   { 8: { status: 'mine' } },
 *   new Set(['4:30:8']),
 *   '4:30',
 * );
 * // → { 8: { status: 'mine' } }
 * ```
 *
 * @param {Record<number, Position> | undefined} existingPositions
 *   Previous snapshot for this system, or `undefined` on first scan.
 *   When `undefined`, the returned object is a shallow copy of
 *   `freshPositions` — no merge logic applies.
 * @param {Record<number, Position>} freshPositions
 *   Latest scan result, already classified via {@link classifyPosition}.
 *   Treated as the source of truth for every slot unless the
 *   `empty_sent` carve-out applies.
 * @param {Set<string>} pendingCoordKeys
 *   Set of `"galaxy:system:position"` strings naming slots where we
 *   believe a colonizer is still in flight (`arrivalAt > Date.now()`
 *   in the caller's registry). Built outside this module so the
 *   domain stays pure.
 * @param {`${number}:${number}`} systemKey
 *   `"galaxy:system"` for the system being merged, used to build the
 *   full `"g:s:p"` coord key for `pendingCoordKeys.has`. Template
 *   literal type keeps obvious typos out at compile time.
 * @returns {Record<number, Position>} New merged positions map.
 */
export const mergeScanResult = (
  existingPositions,
  freshPositions,
  pendingCoordKeys,
  systemKey,
) => {
  // Shallow copy so the caller's `freshPositions` stays pristine. We
  // only ever REPLACE entries below — we never mutate the inner
  // `Position` values — so this is enough to keep inputs immutable.
  /** @type {Record<number, Position>} */
  const result = { ...freshPositions };

  // First-scan fast path: no prior state, no merge to do.
  if (!existingPositions) return result;

  for (const key of Object.keys(freshPositions)) {
    // `Record<number, …>` keys come back from `Object.keys` as strings.
    // Coerce once so the coord-key concat below is clean.
    const posNum = Number(key);
    const oldP = existingPositions[posNum];
    const newP = freshPositions[posNum];

    if (
      oldP?.status === 'empty_sent'
      && newP?.status === 'empty'
      && pendingCoordKeys.has(`${systemKey}:${posNum}`)
    ) {
      // Preserve our local marker: game sees empty, we know our fleet
      // is still inbound. The target-picker must NOT re-pick this slot.
      result[posNum] = oldP;
    }
  }

  return result;
};
