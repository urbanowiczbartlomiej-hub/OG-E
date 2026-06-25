// Player-metadata projection + merge — the richer-than-per-slot view of a
// galaxy neighbour.
//
// # Why a separate module (and a separate cache)
//
// `domain/scans.js` deliberately keeps the per-slot {@link Position} player
// block minimal ({id, name, rank?, ally?, rankClass?}) — its typedef even
// says "richer metadata lives in a separate player cache, not in per-slot
// scan results". This is that projection. The game's `fetchGalaxyContent`
// player block carries a dozen more signals that matter for target
// selection — is the player active, strong, a newbie, in OUR alliance, an
// outlaw, what's their alliance rank — but a player owns many colonies, so
// storing all of it on every slot would duplicate it N times. The cache
// (`state/players.js`) keys by `playerId` and stores each player once;
// `scoreRegion` joins on id to enrich neighbourhood analysis.
//
// Both functions are PURE: no DOM, no storage, no clock. `seenAt` (the
// freshness timestamp the cache merges on) is supplied by the caller, never
// read from `Date.now()` here — keeps the module trivially unit-testable.
//
// @ts-check

/**
 * The "deep space / unoccupied" placeholder the game attaches to empty
 * slots. Never a real neighbour — {@link extractPlayerMeta} drops it.
 */
const SENTINEL_PLAYER_ID = 99999;

/**
 * A player's alliance, as far as the galaxy view exposes it.
 *
 * @typedef {object} PlayerAlliance
 * @property {string} tag  Alliance tag (e.g. `"2040"`). May be `""` if the
 *   game gave only a numeric id.
 * @property {string} [name] Full alliance name, when present.
 * @property {number} [id]   `allianceId`, when non-zero.
 * @property {number} [rank] Alliance highscore rank (`highscorePositionAlliance`),
 *   when > 0 — how strong the alliance controlling this area is.
 */

/**
 * Only-`true` flag set (absent key = false), mirroring the `PositionFlags`
 * convention in `domain/scans.js`: we never carry `false`, so an empty set
 * is dropped entirely.
 *
 * @typedef {object} PlayerFlags
 * @property {true} [active]   `isActive` — explicitly active. Distinguishes a
 *   live player merely ON VACATION (dangerous, will return) from a dormant
 *   account that happens to be flagged vacation.
 * @property {true} [vacation]     `isOnVacation` — game-protected right now.
 * @property {true} [inactive]     `isInactive` (`i`, 7–28d).
 * @property {true} [longInactive] `isLongInactive` (`I`, 28d+).
 * @property {true} [banned]       `isBanned`.
 * @property {true} [admin]        `isAdmin` / GM.
 * @property {true} [newbie]       `isNewbie` — noob-protected, cannot be raided.
 * @property {true} [strong]       `isStrong` — outside your protection bracket
 *   (much stronger than you); attacking is allowed but costly.
 * @property {true} [buddy]        `isBuddy` — on your friends list; never a target.
 * @property {true} [allianceMember] `isAllianceMember` — a member of YOUR
 *   alliance (game-computed relative to the viewer). Replaces the manual
 *   "Ally tag" field for the alliance-proximity signal.
 * @property {true} [outlaw]       `isOutlaw` — has lost protection by raiding
 *   weaker players (a sanctioned target / aggressor flag).
 * @property {true} [honorable]    `isHonorableTarget` — attacking earns honour.
 */

/**
 * One de-duplicated player record, keyed by {@link PlayerMeta.id} in the cache.
 *
 * @typedef {object} PlayerMeta
 * @property {number} id   `playerId`.
 * @property {string} name `playerName` at scan time.
 * @property {number} [rank] Highscore rank (`highscorePositionPlayer`), > 0.
 * @property {string} [rankClass] Honor-rank CSS class (e.g. `"rank_bandit2"`).
 * @property {PlayerAlliance} [ally] Alliance block, when the player is in one.
 * @property {PlayerFlags} [flags] Only-true flag set; absent when none apply.
 * @property {number} [seenAt] ms timestamp of the scan that produced this
 *   record. Absent on a fresh projection; stamped by the cache on write and
 *   used by {@link mergePlayerMeta} for newest-wins.
 */

/**
 * Project one raw `galaxyContent[].player` block into a {@link PlayerMeta}.
 * Returns `null` for the deep-space sentinel and for anything without a
 * numeric `playerId` (empty / malformed slots) — the caller skips those.
 *
 * Best-effort: every optional field is included only when the payload
 * actually exposes it, so the stored record stays minimal and a missing
 * field never fabricates a `0` / `""`.
 *
 * @param {any} player Raw player block (untyped — straight from JSON).
 * @returns {PlayerMeta | null}
 */
export const extractPlayerMeta = (player) => {
  if (!player || typeof player.playerId !== 'number') return null;
  if (player.playerId === SENTINEL_PLAYER_ID) return null;

  /** @type {PlayerMeta} */
  const meta = { id: player.playerId, name: String(player.playerName ?? '') };

  const rank = player.highscorePositionPlayer;
  if (typeof rank === 'number' && Number.isFinite(rank) && rank > 0) meta.rank = rank;

  const rc = player.rank;
  if (rc && rc.hasRank && typeof rc.rankClass === 'string' && rc.rankClass) {
    meta.rankClass = rc.rankClass;
  }

  const tag = typeof player.allianceTag === 'string' ? player.allianceTag : '';
  const allyId = typeof player.allianceId === 'number' ? player.allianceId : 0;
  if (tag || allyId) {
    /** @type {PlayerAlliance} */
    const ally = { tag };
    if (typeof player.allianceName === 'string' && player.allianceName) {
      ally.name = player.allianceName;
    }
    if (allyId) ally.id = allyId;
    const allyRank = player.highscorePositionAlliance;
    if (typeof allyRank === 'number' && Number.isFinite(allyRank) && allyRank > 0) {
      ally.rank = allyRank;
    }
    meta.ally = ally;
  }

  /** @type {PlayerFlags} */
  const flags = {};
  if (player.isActive) flags.active = true;
  if (player.isOnVacation) flags.vacation = true;
  if (player.isInactive) flags.inactive = true;
  if (player.isLongInactive) flags.longInactive = true;
  if (player.isBanned) flags.banned = true;
  if (player.isAdmin) flags.admin = true;
  if (player.isNewbie) flags.newbie = true;
  if (player.isStrong) flags.strong = true;
  if (player.isBuddy) flags.buddy = true;
  if (player.isAllianceMember) flags.allianceMember = true;
  if (player.isOutlaw) flags.outlaw = true;
  if (player.isHonorableTarget) flags.honorable = true;
  if (Object.keys(flags).length > 0) meta.flags = flags;

  return meta;
};

/**
 * Newest-wins merge for one player record (a tie on `seenAt` REPLACES — not a
 * no-op; harmless since every scan event carries a unique `Date.now()`).
 * Returns the record the cache should store under this id:
 *
 *   - no existing record, or `seenAt` ≥ the existing `seenAt` → the fresh
 *     projection stamped with `seenAt`;
 *   - otherwise (a stale observation arrived) → the existing record,
 *     unchanged (returned by reference, so callers can cheaply detect "no
 *     change" via identity).
 *
 * A player's attributes are global (alliance, honour, strong/newbie/buddy
 * are not per-colony), so the whole record is replaced on a newer sighting
 * rather than field-merged — the latest scan is authoritative.
 *
 * @param {PlayerMeta | undefined} existing  Current cached record, if any.
 * @param {PlayerMeta} fresh  Projection from {@link extractPlayerMeta}.
 * @param {number} seenAt  ms timestamp of the scan that produced `fresh`.
 * @returns {PlayerMeta}
 */
export const mergePlayerMeta = (existing, fresh, seenAt) => {
  if (!existing || typeof existing.seenAt !== 'number' || seenAt >= existing.seenAt) {
    return { ...fresh, seenAt };
  }
  return existing;
};

/**
 * Classify an occupied slot's owner into one of the game's NoobProtection
 * bands, read straight from the cached flags — which the game itself computes
 * RELATIVE to your own score, so they ARE the protection brackets, no rank
 * arithmetic needed:
 *
 *   - `'weak'`      — `isNewbie`: noob-protected, can't be honourably raided.
 *   - `'strong'`    — `isStrong`: outside your bracket, much stronger than you.
 *   - `'honorable'` — `isHonorableTarget`: a fair fight — attacking earns honour.
 *   - `'normal'`    — the "white" player: live-scanned, past noob protection,
 *     below the honour bracket, no honour reward — a plain attackable farm
 *     target. It's the ABSENCE of the three flags above (the game exposes no
 *     positive flag for it), so we infer it — but ONLY for a player we actually
 *     hold a cache record for. Friends (`isBuddy`) and your own alliance
 *     (`isAllianceMember`) are NOT farm targets, so they're excluded back to
 *     `null` rather than mislabelled "normal".
 *
 * Bands are checked weakest-first so the exclusive lower band wins, then
 * `strong` before `honorable` (a much-stronger player is often ALSO an
 * honourable target; we surface the more cautionary signal). Returns `null`
 * ONLY when the player isn't in the cache at all — i.e. never live-scanned, so
 * genuinely UNKNOWN — letting the caller keep the plain "Occupied" label and
 * keeping "normal" (a confirmed white target) distinct from "we don't know yet".
 *
 * Pure: a flag read, nothing else.
 *
 * @param {PlayerMeta | null | undefined} meta
 * @returns {'weak' | 'strong' | 'honorable' | 'normal' | null}
 */
export const occupantStrength = (meta) => {
  if (!meta) return null; // not in the cache → never live-scanned → unknown
  const f = meta.flags;
  if (f) {
    if (f.newbie) return 'weak';
    if (f.strong) return 'strong';
    if (f.honorable) return 'honorable';
    if (f.buddy || f.allianceMember) return null; // friends/allies aren't targets
  }
  return 'normal';
};

/**
 * Parse a galaxy `rankClass` (HONOUR rank) into its kind + tier. The honour
 * system is ORTHOGONAL to {@link occupantStrength} (noob-protection): a player
 * can be both `strong` AND a `rank_bandit3`. `rankClass` is present only for
 * players who actually hold an honour rank (`player.rank.hasRank`); neutral
 * players carry none, so this returns `null` for them.
 *
 *   - `'bandit'` — negative honour, an aggressor who farms the weak. Tiers:
 *     1 = Bandit, 2 = Bandit Lord, 3 = Bandit King (`rank_bandit{1,2,3}`). The
 *     danger signal for a fresh colony.
 *   - `'honored'` — positive honour, a decorated fighter (any other `rank_*`).
 *
 * Tier is the trailing digit of the class (`"rank_bandit3"` → 3), falling back
 * to 1 for an unknown variant. (Mirrors the bandit/honoured split `scoreRegion`
 * uses for its tallies, kept here as the single per-player classifier.)
 *
 * @param {string | null | undefined} rankClass
 * @returns {{ kind: 'bandit' | 'honored', tier: number } | null}
 */
export const honorRank = (rankClass) => {
  if (!rankClass || typeof rankClass !== 'string') return null;
  const tier = parseInt(rankClass.slice(-1), 10) || 1;
  return rankClass.startsWith('rank_bandit')
    ? { kind: 'bandit', tier }
    : { kind: 'honored', tier };
};
