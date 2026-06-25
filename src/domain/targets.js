// @ts-check

// Pure "who is a viable target" filter + ranking. Operates on a denormalised
// candidate row that the feature layer assembles by joining the public API
// feeds (players.xml status/alliance + the total & military highscores). No
// I/O here — just the predicate and the sort.
//
// # The "newbie" exclusion is really noob-protection
//
// OGame's player flags `n` (newbie) / `s` (strong) are GALAXY-VIEW relative to
// YOU and aren't in the statistics API. But the underlying rule is exact and
// derivable from points: you may only attack players within a points band of
// your own — by default 1/5× … 5× your total score. Anyone below the band is
// noob-protected ("newbie"), anyone above is "too strong". Computing the band
// from your own score subsumes both, universe-wide, without those flags.
//
// API status letters (see domain/apiOccupancy.js): '' = active,
//   v = vacation, i = inactive, I = long-inactive, o = outlaw, b = banned,
//   a = admin.

/**
 * A denormalised player row to be judged. Most fields are optional because the
 * API joins are best-effort (a player can be missing from a feed).
 * @typedef {object} TargetCandidate
 * @property {string} id
 * @property {string} [name]
 * @property {string} [status]          API status letters; '' / absent = active.
 * @property {string} [alliance]        Alliance id (absent/empty = none).
 * @property {number} [totalScore]      Total highscore score.
 * @property {number} [totalRank]       Total highscore position (1 = top).
 * @property {number} [militaryScore]   Military highscore score (fleet+defense pts).
 * @property {number} [militaryRank]    Military highscore position.
 */

/**
 * @typedef {object} TargetFilterOptions
 * @property {number} [ownTotalScore]      Your total score — enables the noob-protection band.
 * @property {string} [ownAlliance]        Your alliance id — enables own-alliance exclusion.
 * @property {string} [ownPlayerId]        Your player id — always excluded.
 * @property {number} [protectionFactor]   Noob-protection multiplier (default 5).
 * @property {[number, number]} [rankWindow]  Inclusive total-rank window [lo, hi].
 * @property {number} [minMilitary]        Minimum military score to keep.
 * @property {boolean} [excludeVacation]   Default true.
 * @property {boolean} [excludeInactive]   Default true (covers i and I).
 * @property {boolean} [excludeBanned]     Default true.
 * @property {boolean} [excludeAdmin]      Default true.
 * @property {boolean} [excludeOwnAlliance] Default true.
 */

const DEFAULT_PROTECTION_FACTOR = 5;

/**
 * Resolve a boolean option that defaults to true when unset.
 * @param {boolean|undefined} v
 * @returns {boolean}
 */
function onByDefault(v) {
  return v !== false;
}

/**
 * Why a candidate is excluded, or null if it passes. Returning the reason (not
 * just a boolean) lets the UI explain a drop and the tests assert on cause.
 * @param {TargetCandidate} c
 * @param {TargetFilterOptions} [opts]
 * @returns {string | null}
 */
export function targetExclusionReason(c, opts = {}) {
  if (opts.ownPlayerId != null && c.id === opts.ownPlayerId) return 'self';

  const status = c.status || '';
  if (onByDefault(opts.excludeVacation) && status.includes('v')) return 'vacation';
  if (onByDefault(opts.excludeBanned) && status.includes('b')) return 'banned';
  if (onByDefault(opts.excludeAdmin) && status.includes('a')) return 'admin';
  if (
    onByDefault(opts.excludeInactive) &&
    (status.includes('i') || status.includes('I'))
  ) {
    return 'inactive';
  }

  if (
    onByDefault(opts.excludeOwnAlliance) &&
    opts.ownAlliance &&
    c.alliance &&
    c.alliance === opts.ownAlliance
  ) {
    return 'ownAlliance';
  }

  const factor = opts.protectionFactor ?? DEFAULT_PROTECTION_FACTOR;
  if (opts.ownTotalScore != null && factor > 0 && typeof c.totalScore === 'number') {
    if (c.totalScore < opts.ownTotalScore / factor) return 'tooWeak';
    if (c.totalScore > opts.ownTotalScore * factor) return 'tooStrong';
  }

  if (opts.rankWindow && typeof c.totalRank === 'number') {
    const [lo, hi] = opts.rankWindow;
    if (c.totalRank < lo || c.totalRank > hi) return 'rankWindow';
  }

  if (typeof opts.minMilitary === 'number') {
    if ((c.militaryScore ?? 0) < opts.minMilitary) return 'minMilitary';
  }

  return null;
}

/**
 * Filter to viable targets and rank them most-fleet-potential first
 * (military score desc, total score as tiebreaker).
 * @param {TargetCandidate[]} candidates
 * @param {TargetFilterOptions} [opts]
 * @returns {TargetCandidate[]}
 */
export function buildTargetList(candidates, opts = {}) {
  return candidates
    .filter((c) => targetExclusionReason(c, opts) === null)
    .sort(
      (a, b) =>
        (b.militaryScore ?? 0) - (a.militaryScore ?? 0) ||
        (b.totalScore ?? 0) - (a.totalScore ?? 0),
    );
}

/**
 * Minimal shape of a players.xml row (name + status + alliance).
 * @typedef {object} ApiPlayerLite
 * @property {string} [name]
 * @property {string} [status]
 * @property {string} [alliance]
 */

/**
 * Minimal shape of a highscore.xml rank (position + score).
 * @typedef {object} ApiRankLite
 * @property {number} [position]
 * @property {number} [score]
 */

/**
 * Join the three already-cached API feeds into candidate rows. The candidate
 * set is the UNION of player ids appearing in any feed, so a player missing
 * from one feed (e.g. unranked on a highscore page) still surfaces with
 * whatever is known. Pure — the feature layer hands in the plain maps it
 * already holds (no state/ coupling here).
 * @param {object} [feeds]
 * @param {Record<string, ApiPlayerLite>} [feeds.players]   players.xml: id → {name,status,alliance}.
 * @param {Record<string, ApiRankLite>} [feeds.total]       total highscore: id → {position,score}.
 * @param {Record<string, ApiRankLite>} [feeds.military]    military highscore: id → {position,score}.
 * @returns {TargetCandidate[]}
 */
export function buildTargetCandidates(feeds = {}) {
  const players = feeds.players || {};
  const total = feeds.total || {};
  const military = feeds.military || {};

  /** @type {Set<string>} */
  const ids = new Set();
  for (const id of Object.keys(players)) ids.add(id);
  for (const id of Object.keys(total)) ids.add(id);
  for (const id of Object.keys(military)) ids.add(id);

  /** @type {TargetCandidate[]} */
  const out = [];
  for (const id of ids) {
    const p = players[id];
    const t = total[id];
    const mil = military[id];
    out.push({
      id,
      name: p ? p.name : undefined,
      status: p ? p.status : undefined,
      alliance: p ? p.alliance : undefined,
      totalScore: t ? t.score : undefined,
      totalRank: t ? t.position : undefined,
      militaryScore: mil ? mil.score : undefined,
      militaryRank: mil ? mil.position : undefined,
    });
  }
  return out;
}
