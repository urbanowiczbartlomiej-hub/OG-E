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
 * @property {number} [ships]           Ship COUNT (military feed). 0 = pure
 *   defense — cannot attack; undefined = player absent from the military feed.
 * @property {number} [destroyedScore]  Military destroyed (lifetime kill
 *   history) — only combat moves it; defense kills count too.
 */

/**
 * @typedef {object} TargetFilterOptions
 * @property {number} [ownTotalScore]      Your total score — enables the noob-protection band.
 * @property {string} [ownAlliance]        Your alliance id — enables own-alliance exclusion.
 * @property {string} [ownPlayerId]        Your player id — always excluded.
 * @property {number} [protectionFactor]   Noob-protection multiplier (default 5).
 * @property {[number, number]} [rankWindow]  Inclusive total-rank window [lo, hi].
 * @property {number} [minMilitary]        Minimum military score to keep.
 * @property {number} [maxMilitary]        Maximum military score to keep (0/absent = no cap).
 * @property {boolean} [excludeVacation]   Default true.
 * @property {boolean} [excludeInactive]   Default true (covers i and I).
 * @property {boolean} [excludeBanned]     Default true.
 * @property {boolean} [excludeAdmin]      Default true.
 * @property {boolean} [excludeOwnAlliance] Default true.
 * @property {Set<string>} [forceInclude]  Player ids to keep regardless of every
 *   exclusion — the search bar's "show anyway" override.
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
  // "Show anyway" override: a player the user force-included from the search bar
  // bypasses every exclusion below.
  if (opts.forceInclude && opts.forceInclude.has(c.id)) return null;
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

  // A 0/absent cap means "no upper bound"; only players WITH a known military
  // score can exceed it (an unknown score is treated as 0, never above a cap).
  if (typeof opts.maxMilitary === 'number' && opts.maxMilitary > 0) {
    if ((c.militaryScore ?? 0) > opts.maxMilitary) return 'maxMilitary';
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
 * Re-sort an already-filtered target list by a chosen column, without mutating
 * the input. The three sortable axes mirror the table columns:
 *
 *   - `hiddenFleet` — estimated hidden-fleet points (looked up in
 *     {@link hiddenById}). Players we haven't spied have no estimate and always
 *     sink to the bottom regardless of direction, so a known fleet is never
 *     buried under a wall of un-spied unknowns.
 *   - `military`    — military highscore score.
 *   - `totalRank`   — total-highscore position (1 = top).
 *   - `ships`       — ship count (unknown sinks to the bottom, like hiddenFleet).
 *   - `destroyed`   — lifetime military-destroyed score (unknown sinks).
 *
 * Ties (and the un-spied tail under `hiddenFleet`) fall back to the canonical
 * ranking from {@link buildTargetList}: military score desc, then total score
 * desc — so the most fleet-potential targets stay clustered at the top.
 *
 * @param {TargetCandidate[]} list
 * @param {'hiddenFleet'|'military'|'totalRank'|'ships'|'destroyed'|'danger'|'fleet'} key
 * @param {'asc'|'desc'} [dir]
 * @param {Record<string, number>} [hiddenById]  playerId → hidden-fleet points.
 * @param {Record<string, {danger:number, fleet:number}>} [dangerById]  playerId →
 *   {danger 0..1, fleet = mobile-military ceiling}. The free whole-server
 *   fleet-finder axes (v2): `danger` ranks by the D scalar, `fleet` by the
 *   attack-capable-military ceiling. Players with no profile sink to the
 *   bottom (like the un-spied tail under `hiddenFleet`).
 * @returns {TargetCandidate[]}
 */
export function sortTargetList(list, key, dir = 'desc', hiddenById = {}, dangerById = {}) {
  const factor = dir === 'asc' ? 1 : -1;
  /** @param {TargetCandidate} c @returns {number | null} */
  const value = (c) => {
    if (key === 'hiddenFleet') {
      const h = hiddenById[c.id];
      return typeof h === 'number' && Number.isFinite(h) ? h : null;
    }
    if (key === 'danger') {
      const d = dangerById[c.id];
      return d ? d.danger : null;
    }
    if (key === 'fleet') {
      const d = dangerById[c.id];
      return d ? d.fleet : null;
    }
    if (key === 'totalRank') {
      return typeof c.totalRank === 'number' ? c.totalRank : null;
    }
    if (key === 'ships') {
      return typeof c.ships === 'number' ? c.ships : null;
    }
    if (key === 'destroyed') {
      return typeof c.destroyedScore === 'number' ? c.destroyedScore : null;
    }
    return typeof c.militaryScore === 'number' ? c.militaryScore : null;
  };
  /** @param {TargetCandidate} a @param {TargetCandidate} b */
  const tiebreak = (a, b) =>
    (b.militaryScore ?? 0) - (a.militaryScore ?? 0) ||
    (b.totalScore ?? 0) - (a.totalScore ?? 0);
  return list.slice().sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va == null && vb == null) return tiebreak(a, b);
    if (va == null) return 1; // missing value always sinks, either direction
    if (vb == null) return -1;
    if (va !== vb) return factor * (va - vb);
    return tiebreak(a, b);
  });
}

/**
 * A planet position parsed from the universe occupancy snapshot.
 * @typedef {object} PlanetPos
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 */

/**
 * Enumerate a player's planet positions from the universe.xml occupancy
 * snapshot. Pure: filter the `{coords, player}` rows by owner id, parse each
 * `coords` ("g:s:p") into numbers, drop anything malformed, and return them
 * ordered galaxy→system→position for a stable display. Planets only — moons
 * are `<moon>` children the snapshot parser doesn't surface, matching the
 * planets-only spy decision.
 *
 * @param {Array<{coords: string, player?: number}>} universePlanets
 * @param {string} playerId
 * @returns {PlanetPos[]}
 */
export function playerPlanets(universePlanets, playerId) {
  /** @type {PlanetPos[]} */
  const out = [];
  for (const pl of universePlanets || []) {
    if (!pl || pl.player == null || String(pl.player) !== playerId) continue;
    const parts = String(pl.coords).split(':');
    if (parts.length !== 3) continue;
    const galaxy = Number(parts[0]);
    const system = Number(parts[1]);
    const position = Number(parts[2]);
    if (!Number.isFinite(galaxy) || !Number.isFinite(system) || !Number.isFinite(position)) {
      continue;
    }
    out.push({ galaxy, system, position });
  }
  out.sort((a, b) => a.galaxy - b.galaxy || a.system - b.system || a.position - b.position);
  return out;
}

/**
 * Minimal shape of a players.xml row (name + status + alliance).
 * @typedef {object} ApiPlayerLite
 * @property {string} [name]
 * @property {string} [status]
 * @property {string} [alliance]
 */

/**
 * Minimal shape of a highscore.xml rank (position + score + military ships).
 * @typedef {object} ApiRankLite
 * @property {number} [position]
 * @property {number} [score]
 * @property {number} [ships]  Military feed only — see ApiRank in apiOccupancy.
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
 * @param {Record<string, ApiRankLite>} [feeds.military]    military highscore: id → {position,score,ships}.
 * @param {Record<string, ApiRankLite>} [feeds.destroyed]   military destroyed (type 5): id → {position,score}.
 * @returns {TargetCandidate[]}
 */
export function buildTargetCandidates(feeds = {}) {
  const players = feeds.players || {};
  const total = feeds.total || {};
  const military = feeds.military || {};
  const destroyed = feeds.destroyed || {};

  // Feed-level capability check: "attribute absent on a present row = 0
  // ships" is only a valid read when the feed CARRIES the attribute at all.
  // A military map cached by a pre-ships parser (or a server whose API
  // doesn't emit it) has no ships key on ANY row — without this guard every
  // player there would read as a confidently-green "0 ships — pure defense",
  // the exact inverted-danger signal. Any real feed has fleeted players, so
  // one carrying row is proof enough.
  const feedHasShips = Object.values(military).some((r) => typeof r.ships === 'number');

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
    const des = destroyed[id];
    out.push({
      id,
      name: p ? p.name : undefined,
      status: p ? p.status : undefined,
      alliance: p ? p.alliance : undefined,
      totalScore: t ? t.score : undefined,
      totalRank: t ? t.position : undefined,
      militaryScore: mil ? mil.score : undefined,
      militaryRank: mil ? mil.position : undefined,
      // Row present but attribute absent = 0 ships (server omits it for
      // pure-defense accounts) — but only when the feed carries the
      // attribute at all (see feedHasShips); else unknown, like a player
      // absent from the feed.
      ships: mil && feedHasShips ? (mil.ships ?? 0) : undefined,
      destroyedScore: des ? des.score : undefined,
    });
  }
  return out;
}
