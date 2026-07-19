// @ts-check

// Long-horizon presence ledger — the MONTHS-scale memory behind the dossier's
// presence-history explorer and the alliance pool.
//
// # Why this exists next to domain/presence.js
//
// The offline-window ENGINE (domain/presence.js) is statistical: it wants raw
// collapsed probes with counts and exact times (Beta shrinkage needs a
// denominator, decay needs ages), and it deliberately works a short window
// (PRESENCE_RECENCY_MS — routines drift). Its fuel — the activity rings and
// report history rings — is capped per body and swept at 45 days, so nothing
// in the system remembered LAST QUARTER. This module is the complementary
// memory: a per-player, per-day pair of 24-bit hour masks
// (`[activeMask, quietMask]`) that keeps over a YEAR of "when did we ever see
// this player interact / when did we look and see nothing" at ~constant size
// per observed day. Cycle hunting (daily / weekly / monthly shifts) needs
// exactly this shape and nothing finer.
//
// # Why hour-bit masks, not probe lists or counts
//
//   - Bounded by DAYS, not by observation volume — a hunting spree can't
//     bloat it (a probe list grows per look; the alliance file is plain
//     pretty-printed JSON and every member's watch list rides in it).
//   - The merge is a bitwise OR — commutative, idempotent, monotonic. That
//     makes device sync, alliance pooling and re-folds of the same rings all
//     trivially convergent (re-folding is a no-op by construction, so the
//     fold can run on ANY cadence without bookkeeping).
//   - JS bitwise ops are 32-bit; 24 hour bits fit. Half-hour resolution
//     (48 bits) would not, and hour grain is what offline-window hunting
//     needs anyway.
//
// The cost accepted: masks drop look COUNTS within an hour. Day-level counts
// re-emerge at render time (an hour-of-week cell aggregates "how many
// Tuesdays was 14:00 active/quiet"), which is the honest unit for patterns.
//
// # Provenance discipline
//
// The ledger is folded from the PRESENCE PROBES (domain/presence.js
// buildPresenceProbes), never from raw rings: probes are already
// self-induced-discounted (our own probes don't register as the target's
// activity) and correlation-collapsed (N bodies quiet at one moment = ONE
// offline sample). Pooled alliance ledgers therefore never measure a
// member's scanning rhythm. Like every shared/derived layer it is
// DISPLAY-ONLY: it must never feed the danger score or the scan plan (same
// invariant as domain/allianceIntel.js).
//
// Pure: no DOM, no storage, no Date.now() — time arrives as arguments.

/** @typedef {import('./presence.js').PresenceProbe} PresenceProbe */

/**
 * One player's long-horizon presence memory: epoch-day (UTC, `floor(t/86400)`,
 * stringified int) → `[activeMask, quietMask]`, each a 24-bit int with bit
 * `h` = "hour h (UTC) had at least one active / quiet observation that day".
 * UTC canonical so devices/allies in different timezones OR the same bits;
 * views re-bucket to the viewer's local clock at render time.
 * @typedef {Record<string, [number, number]>} PresenceLedger
 */

/** Seconds per day / per hour — the bucketing constants. */
const DAY_S = 86400;
const HOUR_S = 3600;

/** Days a device keeps locally (~13 months — covers monthly-cycle hunting). */
export const LEDGER_KEEP_DAYS = 400;

/**
 * Days one member SHARES to the alliance file (~6 months). Smaller than the
 * local horizon deliberately: the alliance file is uncompressed pretty JSON
 * every member re-PATCHes, so the wire form stays lean while local analysis
 * keeps the full year.
 */
export const LEDGER_SHARE_DAYS = 180;

/**
 * Upper bound accepted for a packed ledger string arriving from the alliance
 * file (a well-formed 400-day ledger packs to ~8 KB; 64 KB = generous slack,
 * beyond it the string is junk or abuse and is dropped whole).
 */
export const PACKED_LEDGER_MAX_CHARS = 65536;

/** @param {unknown} v @returns {number} 24-bit-masked non-negative int. */
const asMask = (v) => (typeof v === 'number' && Number.isFinite(v) ? (v & 0xffffff) >>> 0 : 0);

/**
 * Fold collapsed presence probes into a ledger. Each probe sets ONE bit:
 * active (the player interacted somewhere ~then) or quiet (we looked, all
 * bodies silent). Returns the same reference when nothing new was learned —
 * the caller's cheap "anything changed?" test (folds run on a debounce, most
 * are no-ops over already-folded rings).
 *
 * @param {PresenceLedger} ledger
 * @param {PresenceProbe[]} probes
 * @returns {{ merged: PresenceLedger, changed: boolean }}
 */
export const foldProbesIntoLedger = (ledger, probes) => {
  /** @type {PresenceLedger | null} */
  let next = null;
  for (const pr of probes || []) {
    if (!pr || typeof pr.tSec !== 'number' || !Number.isFinite(pr.tSec) || pr.tSec <= 0) continue;
    const day = String(Math.floor(pr.tSec / DAY_S));
    const bit = 1 << Math.floor((pr.tSec % DAY_S) / HOUR_S);
    const cur = (next || ledger)[day];
    const active = asMask(cur?.[0]);
    const quiet = asMask(cur?.[1]);
    // Active dominates quiet for the same hour of the same day: an active
    // marker is the stronger reading, so setting it CLEARS any quiet bit there
    // (and a quiet look never overwrites an already-active hour). Dominance is
    // also enforced at read (aggregateLedger), but keeping the stored masks
    // disjoint keeps the packed wire form minimal.
    const nextActive = pr.online ? (active | bit) >>> 0 : active;
    const nextQuiet = pr.online
      ? (quiet & ~bit) >>> 0
      : ((active & bit) ? quiet : (quiet | bit) >>> 0);
    if (nextActive === active && nextQuiet === quiet) continue;
    if (!next) next = { ...ledger };
    next[day] = [nextActive, nextQuiet];
  }
  return next ? { merged: next, changed: true } : { merged: ledger, changed: false };
};

/**
 * Merge two ledgers, per-day bitwise OR of both masks. `changed` is the
 * anti-loop hint (sync/merge.js discipline): `true` iff `incoming`
 * contributed at least one bit `local` lacked; when `false`, `merged` IS the
 * `local` reference and callers must not write it back.
 *
 * @param {PresenceLedger} local
 * @param {PresenceLedger | null | undefined} incoming
 * @returns {{ merged: PresenceLedger, changed: boolean }}
 */
export const mergePresenceLedgers = (local, incoming) => {
  if (!incoming || typeof incoming !== 'object') return { merged: local, changed: false };
  /** @type {PresenceLedger | null} */
  let next = null;
  for (const day of Object.keys(incoming)) {
    const inc = incoming[day];
    const incActive = asMask(inc?.[0]);
    const incQuiet = asMask(inc?.[1]);
    if (!incActive && !incQuiet) continue;
    const cur = (next || local)[day];
    const active = ((asMask(cur?.[0])) | incActive) >>> 0;
    const quiet = ((asMask(cur?.[1])) | incQuiet) >>> 0;
    if (cur && active === asMask(cur[0]) && quiet === asMask(cur[1])) continue;
    if (!next) next = { ...local };
    next[day] = [active, quiet];
  }
  return next ? { merged: next, changed: true } : { merged: local, changed: false };
};

/**
 * Merge two `pid → ledger` maps (the per-universe store / sync-slot shape).
 * Same `{ merged, changed }` contract as every sync/merge.js reconciler.
 *
 * @param {Record<string, PresenceLedger>} local
 * @param {Record<string, PresenceLedger> | null | undefined} incoming
 * @returns {{ merged: Record<string, PresenceLedger>, changed: boolean }}
 */
export const mergePresenceLedgerMaps = (local, incoming) => {
  if (!incoming || typeof incoming !== 'object') return { merged: local, changed: false };
  /** @type {Record<string, PresenceLedger> | null} */
  let next = null;
  for (const pid of Object.keys(incoming)) {
    const inc = incoming[pid];
    if (!inc || typeof inc !== 'object') continue;
    const { merged, changed } = mergePresenceLedgers((next || local)[pid] || {}, inc);
    if (!changed) continue;
    if (!next) next = { ...local };
    next[pid] = merged;
  }
  return next ? { merged: next, changed: true } : { merged: local, changed: false };
};

/**
 * Drop days older than `keepDays` before `nowSec` (and malformed entries).
 * Returns the same reference when nothing was dropped.
 *
 * @param {PresenceLedger} ledger
 * @param {number} nowSec
 * @param {number} [keepDays]
 * @returns {PresenceLedger}
 */
export const sweepPresenceLedger = (ledger, nowSec, keepDays = LEDGER_KEEP_DAYS) => {
  const minDay = Math.floor(nowSec / DAY_S) - keepDays;
  let dropped = false;
  /** @type {PresenceLedger} */
  const out = {};
  for (const day of Object.keys(ledger)) {
    const d = Number(day);
    const entry = ledger[day];
    const active = asMask(entry?.[0]);
    const quiet = asMask(entry?.[1]);
    if (!Number.isFinite(d) || d < minDay || (!active && !quiet)) {
      dropped = true;
      continue;
    }
    out[day] = entry;
  }
  return dropped ? out : ledger;
};

/**
 * Sweep a whole `pid → ledger` map; empty ledgers drop with their pid.
 * Returns the same reference when nothing was dropped.
 *
 * @param {Record<string, PresenceLedger>} map
 * @param {number} nowSec
 * @param {number} [keepDays]
 * @returns {Record<string, PresenceLedger>}
 */
export const sweepPresenceLedgerMap = (map, nowSec, keepDays = LEDGER_KEEP_DAYS) => {
  let dropped = false;
  /** @type {Record<string, PresenceLedger>} */
  const out = {};
  for (const pid of Object.keys(map)) {
    const ledger = map[pid];
    if (!ledger || typeof ledger !== 'object') { dropped = true; continue; }
    const swept = sweepPresenceLedger(ledger, nowSec, keepDays);
    if (swept !== ledger) dropped = true;
    if (Object.keys(swept).length) out[pid] = swept;
    else dropped = true;
  }
  return dropped ? out : map;
};

// ── Pattern aggregation (the offline-window explorer) ────────────────
//
// The ledger is UTC bit masks; the hunter thinks in THEIR local clock and in
// cycles (hour-of-week, day-of-month). These fold the raw days — trimmed to a
// chosen range — onto a chosen phase grid, IN LOCAL TIME, producing per-cell
// active/quiet/observed counts. The offline read is the honest one: a cell is
// a good strike window when it was OBSERVED many times and was QUIET (little
// active) across them. No statistics here beyond counting — the view decides
// colour/《gates; counting is the pure, testable core.

/**
 * One aggregated phase cell.
 * @typedef {object} LedgerCell
 * @property {number} active   Days this phase had ≥1 active hour-bit.
 * @property {number} quiet    Days this phase had a quiet look but NO active bit.
 * @property {number} observed active + quiet (the coverage denominator).
 */

/**
 * @typedef {'weekHour'|'dayHour'|'monthDay'} LedgerPhase
 *   - weekHour  : 7 rows (local weekday) × 24 local hours — weekly routine.
 *   - dayHour   : 1 row × 24 local hours — pooled daily rhythm.
 *   - monthDay  : 1 row × 31 columns (local day-of-month 1..31) — monthly cycle.
 */

/**
 * @typedef {object} LedgerAggregate
 * @property {LedgerPhase} phase
 * @property {number} rows
 * @property {number} cols
 * @property {LedgerCell[][]} cells   [row][col].
 * @property {number} observedDays    Distinct source days that fell in range.
 * @property {number} activeDays      Of those, days with ≥1 active bit.
 * @property {number} firstDay        Epoch-day of the oldest source day (0 = none).
 * @property {number} lastDay         Epoch-day of the newest source day (0 = none).
 */

/** Empty cell grid. @param {number} rows @param {number} cols @returns {LedgerCell[][]} */
const emptyCells = (rows, cols) =>
  Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ active: 0, quiet: 0, observed: 0 })));

/**
 * Aggregate a ledger onto a phase grid in LOCAL time, over the last
 * `rangeDays` before `nowSec` (0 / omitted = all kept days).
 *
 * Each SOURCE DAY contributes to its LOCAL-time cells: because a UTC day
 * straddles two local days near midnight, every hour bit is placed by its own
 * local timestamp (day-of-week / day-of-month recomputed per hour), which is
 * what makes the local-cycle read correct rather than UTC-shifted. A day
 * counts as `active` in a cell if it had ≥1 active bit landing there, `quiet`
 * if it had a quiet look there but no active bit.
 *
 * `opts.weekdays` (a Set of getDay() values 0=Sun..6=Sat) keeps only hours that
 * fall on those LOCAL weekdays — e.g. Mon–Fri to strip the weekend regime.
 *
 * @param {PresenceLedger} ledger
 * @param {number} nowSec
 * @param {{ phase: LedgerPhase, rangeDays?: number, weekdays?: Set<number> }} opts
 * @returns {LedgerAggregate}
 */
export const aggregateLedger = (ledger, nowSec, opts) => {
  const phase = opts.phase;
  const rows = phase === 'weekHour' ? 7 : 1;
  const cols = phase === 'monthDay' ? 31 : 24;
  const cells = emptyCells(rows, cols);
  const minDay = opts.rangeDays && opts.rangeDays > 0
    ? Math.floor(nowSec / DAY_S) - opts.rangeDays
    : -Infinity;

  let observedDays = 0;
  let activeDays = 0;
  let firstDay = 0;
  let lastDay = 0;

  for (const dayKey of Object.keys(ledger)) {
    const day = Number(dayKey);
    if (!Number.isFinite(day) || day < minDay) continue;
    const entry = ledger[dayKey];
    const active = asMask(entry?.[0]);
    const quiet = asMask(entry?.[1]);
    if (!active && !quiet) continue;
    observedDays += 1;
    if (active) activeDays += 1;
    if (!firstDay || day < firstDay) firstDay = day;
    if (day > lastDay) lastDay = day;

    // De-dupe per (row,col) within THIS day: one day is at most one active +
    // one quiet vote per cell, however many of its hours land there.
    /** @type {Set<number>} */ const dayActiveCells = new Set();
    /** @type {Set<number>} */ const dayQuietCells = new Set();
    for (let h = 0; h < 24; h++) {
      const bit = 1 << h;
      const isActive = (active & bit) !== 0;
      const isQuiet = !isActive && (quiet & bit) !== 0;
      if (!isActive && !isQuiet) continue;
      // Local placement of this UTC hour.
      const d = new Date((day * DAY_S + h * HOUR_S) * 1000);
      if (opts.weekdays && !opts.weekdays.has(d.getDay())) continue;
      const lh = d.getHours();
      let row = 0;
      let col = lh;
      if (phase === 'weekHour') row = d.getDay();
      else if (phase === 'monthDay') col = d.getDate() - 1;
      const idx = row * cols + col;
      if (isActive) dayActiveCells.add(idx);
      else dayQuietCells.add(idx);
    }
    for (const idx of dayActiveCells) cells[Math.floor(idx / cols)][idx % cols].active += 1;
    for (const idx of dayQuietCells) {
      // A cell that already got this day's ACTIVE vote isn't also "quiet".
      if (dayActiveCells.has(idx)) continue;
      cells[Math.floor(idx / cols)][idx % cols].quiet += 1;
    }
  }

  for (const row of cells) for (const c of row) c.observed = c.active + c.quiet;
  return { phase, rows, cols, cells, observedDays, activeDays, firstDay, lastDay };
};

// ── Wire codec (alliance file) ───────────────────────────────────────
//
// One ledger packs to a single compact string so the alliance file's pretty
// JSON stays one line per player: rows `<day>.<active>.<quiet>` (all base36,
// zero mask = empty field) joined by `,`. ~8-15 chars per observed day.

/**
 * Pack a ledger for the wire, oldest day first, trimmed to `keepDays` before
 * `nowSec` (pass {@link LEDGER_SHARE_DAYS} at the alliance boundary).
 *
 * @param {PresenceLedger} ledger
 * @param {number} nowSec
 * @param {number} [keepDays]
 * @returns {string}  '' when nothing survives the trim.
 */
export const packPresenceLedger = (ledger, nowSec, keepDays = LEDGER_SHARE_DAYS) => {
  const minDay = Math.floor(nowSec / DAY_S) - keepDays;
  const rows = [];
  for (const day of Object.keys(ledger).map(Number).filter((d) => Number.isFinite(d) && d >= minDay).sort((a, b) => a - b)) {
    const entry = ledger[String(day)];
    const active = asMask(entry?.[0]);
    const quiet = asMask(entry?.[1]);
    if (!active && !quiet) continue;
    rows.push(`${day.toString(36)}.${active ? active.toString(36) : ''}.${quiet ? quiet.toString(36) : ''}`);
  }
  return rows.join(',');
};

/**
 * Unpack a wire string back into a ledger. Tolerant: malformed rows are
 * skipped (never throw on alliance-supplied data), an over-long string
 * (> {@link PACKED_LEDGER_MAX_CHARS}) is dropped whole.
 *
 * @param {unknown} packed
 * @returns {PresenceLedger}
 */
export const unpackPresenceLedger = (packed) => {
  /** @type {PresenceLedger} */
  const out = {};
  if (typeof packed !== 'string' || !packed || packed.length > PACKED_LEDGER_MAX_CHARS) return out;
  for (const row of packed.split(',')) {
    const parts = row.split('.');
    if (parts.length !== 3) continue;
    const day = parseInt(parts[0], 36);
    if (!Number.isFinite(day) || day <= 0) continue;
    const active = parts[1] ? asMask(parseInt(parts[1], 36)) : 0;
    const quiet = parts[2] ? asMask(parseInt(parts[2], 36)) : 0;
    if (!active && !quiet) continue;
    out[String(day)] = [active, quiet];
  }
  return out;
};
