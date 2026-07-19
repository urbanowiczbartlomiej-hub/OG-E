// @ts-check

// Shift-rhythm analysis — the "does this player rotate shifts?" layer on top of
// the long-horizon presence ledger (domain/presenceLedger.js).
//
// # Why this exists next to the presence explorer
//
// The explorer's aggregateLedger COLLAPSES a whole range into ONE grid: every
// Tuesday of the last 90 days is averaged together. That is exactly wrong for a
// shift worker. Someone on a weekly-rotating 3-shift roster is active
// afternoons one week, evenings the next, and overnight the third — pooled into
// one week×hour grid those three rhythms cancel into grey mush, and the reader
// sees "no clear pattern" precisely when the pattern is most exploitable.
//
// This module keeps the WEEKS SEPARATE: it builds a 24-hour activity profile
// per ISO-week (Monday-anchored, the European work week), reads each week's
// "phase" (the circular-mean hour of the player's online window), and then asks
// three questions a raider actually cares about:
//
//   1. How many distinct rhythms does this player cycle through? (1 = steady,
//      2 = two-shift, 3 = three-shift; more = irregular.)
//   2. Do those rhythms rotate on a fixed period? (weekly is the common roster.)
//   3. Given the rotation, what is THIS week's offline/strike window, and what
//      will NEXT week's be?
//
// Plus a separate, simpler weekend read: does the player work Saturdays, never,
// or every other one? Weekend rhythm is almost always a different regime from
// the weekday one, so it is analysed on its own axis — and, so it does not
// smear the weekday phase, the rotation detector looks at Mon–Fri only.
//
// # Honesty discipline (inherited from routine.js / presenceLedger.js)
//
//   - Coverage is thin and uneven (the ledger only holds hours SOMEONE looked
//     at). Every verdict carries a gate (none/hint/pattern/strong) and the
//     sample basis, and the module returns `gate:'none'` rather than guess when
//     the weeks are too few or too sparse. It NEVER asserts "online".
//   - The signal is inverted for work: a shift worker is OFFLINE both asleep
//     and at the job, ONLINE only in the free window — so it is the online
//     window that rotates, and that is what we phase on.
//   - DST and timezone: every UTC hour bit is placed to the viewer's LOCAL
//     clock per-hour (same as aggregateLedger), so a spring-forward shifts a
//     week by one hour at most — absorbed by the ±tolerance in clustering.
//
// Pure: no DOM, no storage, no Date.now() — `nowSec` arrives as an argument.
// `new Date(ms)` is used only to read the viewer's local wall clock for a known
// instant (never the current time), exactly as domain/presenceLedger.js does.

/** @typedef {import('./presenceLedger.js').PresenceLedger} PresenceLedger */

const DAY_S = 86400;
const HOUR_S = 3600;

/** @param {unknown} v @returns {number} 24-bit-masked non-negative int. */
const asMask = (v) => (typeof v === 'number' && Number.isFinite(v) ? (v & 0xffffff) >>> 0 : 0);

/** Mon–Fri weekday set (getDay(): 0=Sun..6=Sat) — the rotation detector's default. */
export const WEEKDAYS_MON_FRI = new Set([1, 2, 3, 4, 5]);

// ── Tunable thresholds (all deliberately conservative — see honesty note) ──

/** A week needs this many OBSERVED local days before it earns a phase reading. */
const MIN_WEEK_OBSERVED = 3;
/** …and this many total active day-hours, or its phase is too noisy to trust. */
const MIN_WEEK_ACTIVE = 3;
/** Fewest phased weeks before rotation clustering is even attempted. */
const MIN_PHASED_WEEKS = 5;
/** Circular gap (hours) between sorted phases that splits one cluster from the next. */
const CLUSTER_GAP_H = 3;
/** A cluster wider than this (hours, max dist to its centre) is "loose", not a clean shift. */
const CLUSTER_MAX_SPREAD_H = 3.5;
/** Most distinct shifts we treat as a roster; beyond this the life is just irregular. */
const MAX_SHIFTS = 3;
/** Fraction of same-period week pairs that must share a cluster to call it a rotation. */
const ROTATION_MIN_AGREEMENT = 0.7;
/** A quiet band this many hours or longer qualifies as an offline/strike window. */
const MIN_OFFLINE_RUN_H = 3;

// ── Local-time day extraction ────────────────────────────────────────────

/**
 * One local calendar day distilled from the ledger.
 * @typedef {object} DayRec
 * @property {number} localDayIdx  Local-midnight day index (floor(localEpoch/DAY)).
 * @property {number} dow          Local weekday, 0=Sun..6=Sat.
 * @property {number} weekStartIdx localDayIdx of this day's Monday (the ISO-week key).
 * @property {number} activeHours  24-bit mask, bit h = local hour h had ≥1 active obs.
 * @property {number} quietHours   24-bit mask, bit h = quiet look, no active, that hour.
 */

/**
 * Walk the ledger (trimmed to `rangeDays` before `nowSec`) and fold its UTC
 * hour bits into per-LOCAL-day records. A UTC day straddles two local days near
 * midnight, so each hour bit is placed by its own local timestamp. Active
 * dominates quiet within an hour.
 *
 * @param {PresenceLedger} ledger
 * @param {number} nowSec
 * @param {number} [rangeDays] 0 / omitted = all kept days.
 * @returns {DayRec[]} sorted by localDayIdx ascending.
 */
export const collectLocalDays = (ledger, nowSec, rangeDays = 0) => {
  const minDay = rangeDays > 0 ? Math.floor(nowSec / DAY_S) - rangeDays : -Infinity;
  /** @type {Map<number, DayRec>} */
  const byLocal = new Map();

  for (const dayKey of Object.keys(ledger)) {
    const day = Number(dayKey);
    if (!Number.isFinite(day) || day < minDay) continue;
    const entry = ledger[dayKey];
    const active = asMask(entry?.[0]);
    const quiet = asMask(entry?.[1]);
    if (!active && !quiet) continue;

    for (let h = 0; h < 24; h++) {
      const bit = 1 << h;
      const isActive = (active & bit) !== 0;
      const isQuiet = !isActive && (quiet & bit) !== 0;
      if (!isActive && !isQuiet) continue;

      const utcSec = day * DAY_S + h * HOUR_S;
      const d = new Date(utcSec * 1000);
      const lh = d.getHours();
      const dow = d.getDay();
      // Local-midnight day index, DST-correct via the instant's own offset.
      const localDayIdx = Math.floor((utcSec - d.getTimezoneOffset() * 60) / DAY_S);
      const weekStartIdx = localDayIdx - ((dow + 6) % 7); // back up to Monday

      let rec = byLocal.get(localDayIdx);
      if (!rec) {
        rec = { localDayIdx, dow, weekStartIdx, activeHours: 0, quietHours: 0 };
        byLocal.set(localDayIdx, rec);
      }
      if (isActive) {
        rec.activeHours = (rec.activeHours | (1 << lh)) >>> 0;
        rec.quietHours = (rec.quietHours & ~(1 << lh)) >>> 0;
      } else if (!(rec.activeHours & (1 << lh))) {
        rec.quietHours = (rec.quietHours | (1 << lh)) >>> 0;
      }
    }
  }
  return [...byLocal.values()].sort((a, b) => a.localDayIdx - b.localDayIdx);
};

// ── Weekly hour profiles ───────────────────────────────────────────────────

/**
 * One aggregated hour cell within a week: how many of the week's observed days
 * had that local hour active / quiet.
 * @typedef {object} HourCell
 * @property {number} active
 * @property {number} quiet
 * @property {number} observed
 */

/**
 * One ISO-week's activity profile.
 * @typedef {object} WeekRow
 * @property {number} weekStartIdx  Local day index of the week's Monday.
 * @property {number} weekStartMs   That Monday at ~local midnight, ms (for labels).
 * @property {number} parity        weekStartIdx parity (0/1) — the every-other axis.
 * @property {HourCell[]} cells      24 cells, index = local hour.
 * @property {number} observedDays   Distinct days that fed this week (post-filter).
 * @property {number} activeDays     Of those, days with ≥1 active hour.
 * @property {number|null} phaseHour Circular-mean hour of the online window, or null if too thin.
 * @property {number} activeTotal    Σ active over cells (the phase weight mass).
 */

/**
 * Build one {@link WeekRow} per ISO-week present in `days`, optionally keeping
 * only weekdays in `weekdays` (e.g. {@link WEEKDAYS_MON_FRI}).
 *
 * @param {DayRec[]} days
 * @param {{ weekdays?: Set<number> }} [opts]
 * @returns {WeekRow[]} ascending by weekStartIdx.
 */
export const weeklyProfiles = (days, opts = {}) => {
  const wd = opts.weekdays;
  /** @type {Map<number, WeekRow>} */
  const weeks = new Map();
  for (const rec of days) {
    if (wd && !wd.has(rec.dow)) continue;
    let wk = weeks.get(rec.weekStartIdx);
    if (!wk) {
      wk = {
        weekStartIdx: rec.weekStartIdx,
        weekStartMs: rec.weekStartIdx * DAY_S * 1000,
        parity: ((rec.weekStartIdx % 2) + 2) % 2,
        cells: Array.from({ length: 24 }, () => ({ active: 0, quiet: 0, observed: 0 })),
        observedDays: 0,
        activeDays: 0,
        phaseHour: null,
        activeTotal: 0,
      };
      weeks.set(rec.weekStartIdx, wk);
    }
    wk.observedDays += 1;
    if (rec.activeHours) wk.activeDays += 1;
    for (let h = 0; h < 24; h++) {
      const bit = 1 << h;
      if (rec.activeHours & bit) { wk.cells[h].active += 1; wk.activeTotal += 1; }
      else if (rec.quietHours & bit) wk.cells[h].quiet += 1;
    }
  }
  for (const wk of weeks.values()) {
    for (const c of wk.cells) c.observed = c.active + c.quiet;
    wk.phaseHour = wk.observedDays >= MIN_WEEK_OBSERVED && wk.activeTotal >= MIN_WEEK_ACTIVE
      ? circMeanHour(wk.cells.map((c) => c.active))
      : null;
  }
  return [...weeks.values()].sort((a, b) => a.weekStartIdx - b.weekStartIdx);
};

// ── Circular-hour helpers ────────────────────────────────────────────────

/**
 * Weighted circular mean of the 24 hours (weights = per-hour mass). Hours are a
 * ring, so a naive average lies across the 23→0 seam; this projects onto the
 * unit circle and back. @param {number[]} weights length-24 @returns {number|null}
 * hour in [0,24), or null if no mass.
 */
export const circMeanHour = (weights) => {
  let sx = 0;
  let sy = 0;
  for (let h = 0; h < 24; h++) {
    const w = weights[h] || 0;
    if (!w) continue;
    const a = (2 * Math.PI * h) / 24;
    sx += w * Math.cos(a);
    sy += w * Math.sin(a);
  }
  if (sx === 0 && sy === 0) return null;
  let ang = Math.atan2(sy, sx);
  if (ang < 0) ang += 2 * Math.PI;
  return (ang / (2 * Math.PI)) * 24;
};

/** Shortest distance between two hours on the 24h ring. @param {number} a @param {number} b @returns {number} 0..12 */
export const circDistHour = (a, b) => {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
};

// ── Rotation detection ─────────────────────────────────────────────────────

/**
 * One detected rhythm the player cycles through.
 * @typedef {object} ShiftCluster
 * @property {number} id           Stable index, ordered by centre hour.
 * @property {number} centreHour   Circular-mean online hour of its weeks.
 * @property {number} spreadHour   Max member distance to centre (tightness).
 * @property {number} weeks        Member week count.
 * @property {OfflineWindow|null} offline Representative offline/strike window.
 * @property {string} label        Short human tag from the online centre.
 */

/**
 * A contiguous offline (quiet) band — the strike window.
 * @typedef {object} OfflineWindow
 * @property {number} startH  Inclusive local start hour.
 * @property {number} endH    Inclusive local end hour (may wrap past 24 → use %24 at render).
 * @property {number} quietFrac 0..1 mean quiet fraction across the band.
 */

/**
 * @typedef {'none'|'hint'|'pattern'|'strong'} Gate
 */

/**
 * @typedef {object} RotationSummary
 * @property {Gate} gate
 * @property {ShiftCluster[]} clusters       Distinct rhythms (ordered by centre).
 * @property {number} phasedWeeks            Weeks that earned a phase.
 * @property {number|null} period            Rotation period in weeks (null = no clean rotation).
 * @property {number} agreement              0..1 periodicity agreement.
 * @property {ShiftCluster|null} thisWeek     Cluster the current local week matches (null if unseen/thin).
 * @property {ShiftCluster|null} nextWeek     Predicted next-week cluster (rotation only).
 * @property {boolean} weekdaysOnly          True when computed on Mon–Fri (the default).
 */

/**
 * Cluster the phased weeks by online phase (circular gap split), then test
 * whether the cluster labels rotate on a fixed weekly period.
 *
 * @param {WeekRow[]} weeks  Output of {@link weeklyProfiles} (ideally Mon–Fri).
 * @param {number} nowSec    Used only to locate the current local week.
 * @param {boolean} [weekdaysOnly]
 * @returns {RotationSummary}
 */
export const detectRotation = (weeks, nowSec, weekdaysOnly = true) => {
  /** @type {RotationSummary} */
  const empty = {
    gate: 'none', clusters: [], phasedWeeks: 0, period: null, agreement: 0,
    thisWeek: null, nextWeek: null, weekdaysOnly,
  };
  const phased = weeks.filter((w) => w.phaseHour != null);
  if (phased.length < MIN_PHASED_WEEKS) return { ...empty, phasedWeeks: phased.length };

  // 1) Circular gap clustering on the phase hours.
  const pts = phased
    .map((w) => ({ hour: /** @type {number} */ (w.phaseHour), week: w }))
    .sort((a, b) => a.hour - b.hour);
  // Gaps between adjacent phases around the ring (last→first wraps +24).
  /** @type {number[]} split-after indices */
  const splits = [];
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length];
    const gap = i + 1 < pts.length ? next.hour - pts[i].hour : next.hour + 24 - pts[i].hour;
    if (gap >= CLUSTER_GAP_H) splits.push(i);
  }
  // Segments between splits = clusters (rotate the array to start after a split).
  let groups;
  if (splits.length === 0) {
    groups = [pts.slice()];
  } else {
    const start = (splits[splits.length - 1] + 1) % pts.length;
    const ordered = [...pts.slice(start), ...pts.slice(0, start)];
    groups = [];
    let cur = [ordered[0]];
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1].hour;
      const h = ordered[i].hour;
      const gap = h - prev >= 0 ? h - prev : h + 24 - prev;
      if (gap >= CLUSTER_GAP_H) { groups.push(cur); cur = []; }
      cur.push(ordered[i]);
    }
    groups.push(cur);
  }

  // Too fragmented to be a roster → irregular life, no rotation verdict.
  if (groups.length > MAX_SHIFTS) {
    return { ...empty, phasedWeeks: phased.length, gate: 'hint' };
  }

  // 2) Build clusters, ordered by centre hour for stable ids/labels. Members
  // stay in a parallel array (keyed by the final id), never on the cluster.
  const built = groups
    .map((g) => {
      const centre = /** @type {number} */ (circMeanHour(hoursHistogram(g.map((p) => p.hour))));
      const spread = g.reduce((m, p) => Math.max(m, circDistHour(p.hour, centre)), 0);
      const offline = offlineWindowFrom(g.map((p) => p.week));
      return { centre, spread, offline, weeks: g.map((p) => p.week) };
    })
    .sort((a, b) => a.centre - b.centre);

  /** @type {ShiftCluster[]} */
  const clusters = built.map((b, i) => ({
    id: i, centreHour: b.centre, spreadHour: b.spread,
    weeks: b.weeks.length, offline: b.offline, label: onlineLabel(b.centre),
  }));

  // Map each week → cluster id for the periodicity test.
  /** @type {Map<number, number>} weekStartIdx → cluster id */
  const weekLabel = new Map();
  built.forEach((b, i) => { for (const w of b.weeks) weekLabel.set(w.weekStartIdx, i); });

  const looseCluster = clusters.some((c) => c.spreadHour > CLUSTER_MAX_SPREAD_H);

  // 3) Periodicity: find the weekly period whose same-period pairs agree most.
  const idxs = [...weekLabel.keys()].sort((a, b) => a - b);
  const weekSpan = 7; // one weekStartIdx step per calendar week (Monday indices)
  let bestPeriod = null;
  let bestAgreement = 0;
  const maxPeriod = Math.min(MAX_SHIFTS, clusters.length) || 1;
  for (let p = 1; p <= maxPeriod; p++) {
    let pairs = 0;
    let hits = 0;
    for (const wi of idxs) {
      const partner = weekLabel.get(wi + p * weekSpan);
      if (partner == null) continue;
      pairs += 1;
      if (partner === weekLabel.get(wi)) hits += 1;
    }
    if (pairs >= 2) {
      const agree = hits / pairs;
      if (agree > bestAgreement) { bestAgreement = agree; bestPeriod = p; }
    }
  }

  // A period of 1 with high agreement means "steady" (no rotation), not a roster.
  const rotates = clusters.length >= 2 && bestPeriod != null
    && bestPeriod >= 1 && bestAgreement >= ROTATION_MIN_AGREEMENT
    && bestPeriod === clusters.length;

  // 4) This week + prediction. "This week" is the real current local week; the
  // prediction follows the observed rotation ORDER (successor of the latest
  // observed week's cluster), so a gap between the newest data and today does
  // not blank the forecast.
  const thisWeekIdx = mondayIndexOf(nowSec);
  const thisId = weekLabel.get(thisWeekIdx);
  const thisWeek = thisId != null ? clusters[thisId] : null;
  let nextWeek = null;
  if (rotates) {
    // Most common id→id transition across consecutive weeks = the cycle order.
    /** @type {Map<number, Map<number, number>>} */
    const succ = new Map();
    for (const wi of idxs) {
      const a = weekLabel.get(wi);
      const b = weekLabel.get(wi + weekSpan);
      if (a == null || b == null) continue;
      if (!succ.has(a)) succ.set(a, new Map());
      const m = /** @type {Map<number, number>} */ (succ.get(a));
      m.set(b, (m.get(b) || 0) + 1);
    }
    const latestIdx = idxs[idxs.length - 1];
    const latestId = weekLabel.get(latestIdx);
    if (latestId != null && succ.has(latestId)) {
      const m = /** @type {Map<number, number>} */ (succ.get(latestId));
      let bestId = -1;
      let bestN = 0;
      for (const [id, n] of m) if (n > bestN) { bestN = n; bestId = id; }
      if (bestId >= 0) nextWeek = clusters[bestId];
    }
  }

  // 5) Gate.
  /** @type {Gate} */
  let gate = 'hint';
  if (clusters.length === 1) {
    gate = phased.length >= 8 ? 'pattern' : 'hint';
  } else if (rotates) {
    gate = (!looseCluster && bestAgreement >= 0.85 && phased.length >= 2 * clusters.length + 2)
      ? 'strong' : 'pattern';
  } else {
    gate = 'hint';
  }

  return {
    gate, clusters, phasedWeeks: phased.length,
    period: rotates ? bestPeriod : null, agreement: bestAgreement,
    thisWeek, nextWeek, weekdaysOnly,
  };
};

/** Rebuild a length-24 histogram from a bag of exact-ish phase hours (for a robust re-centre). @param {number[]} hours @returns {number[]} */
function hoursHistogram(hours) {
  const h = new Array(24).fill(0);
  for (const x of hours) h[Math.round(x) % 24] += 1;
  return h;
}

/** Short tag for an online-window centre hour. Heuristic, secondary to the times shown. @param {number} c @returns {string} */
function onlineLabel(c) {
  if (c >= 5 && c < 12) return 'morning';
  if (c >= 12 && c < 17) return 'afternoon';
  if (c >= 17 && c < 22) return 'evening';
  return 'night';
}

/**
 * Best contiguous offline (quiet) band across a set of weeks' pooled cells.
 * Circular scan over the 24 hours; a band is a run whose mean quiet-fraction
 * stays high and is ≥ {@link MIN_OFFLINE_RUN_H} long.
 * @param {WeekRow[]} weeks @returns {OfflineWindow|null}
 */
function offlineWindowFrom(weeks) {
  const active = new Array(24).fill(0);
  const observed = new Array(24).fill(0);
  for (const w of weeks) {
    for (let h = 0; h < 24; h++) {
      active[h] += w.cells[h].active;
      observed[h] += w.cells[h].observed;
    }
  }
  // Quiet fraction per hour (unknown hours score 0.5 so they don't anchor a window).
  const quietFrac = observed.map((o, h) => (o ? (o - active[h]) / o : 0.5));
  const QUIET_MIN = 0.6; // an hour counts as "offline" when ≥60% of looks were quiet
  // Scan the doubled ring for the longest/strongest qualifying run.
  let best = null;
  let runStart = -1;
  for (let i = 0; i < 48; i++) {
    const h = i % 24;
    const ok = quietFrac[h] >= QUIET_MIN && observed[h] > 0;
    if (ok && runStart < 0) runStart = i;
    if ((!ok || i === 47) && runStart >= 0) {
      const runEnd = ok ? i : i - 1;
      const len = runEnd - runStart + 1;
      if (len >= MIN_OFFLINE_RUN_H && len <= 24) {
        let sum = 0;
        for (let k = runStart; k <= runEnd; k++) sum += quietFrac[k % 24];
        const score = sum;
        if (!best || score > best.score) {
          best = { startH: runStart % 24, endH: runStart % 24 + (len - 1), quietFrac: sum / len, score };
        }
      }
      runStart = -1;
    }
  }
  if (!best) return null;
  return { startH: best.startH, endH: best.endH, quietFrac: best.quietFrac };
}

// ── Weekend rhythm ───────────────────────────────────────────────────────

/**
 * One classified weekend day.
 * @typedef {object} WeekendDay
 * @property {number} localDayIdx
 * @property {number} parity        Week parity (0/1).
 * @property {'active'|'quiet'|'none'} state
 */

/**
 * @typedef {object} WeekendSummary
 * @property {Gate} gate
 * @property {WeekendDay[]} saturdays  Recent-first.
 * @property {'always'|'never'|'alternating'|'irregular'|'unknown'} pattern
 *   Activity pattern (active = player was seen playing that weekend day).
 * @property {number} activeParity    For 'alternating': the parity that is active (0/1), else -1.
 * @property {'active'|'quiet'|'unknown'} nextSaturday Predicted state of the coming Saturday.
 */

/** Local daytime hours used to decide "present that day": 08:00–20:00. */
const WEEKEND_DAY_START = 8;
const WEEKEND_DAY_END = 20;

/**
 * Classify recent Saturdays and fit the simplest activity pattern (always
 * present / never / every-other / irregular). "Present" = seen active in local
 * daytime; a purely-quiet daytime is a plausible "away/working" signal but is
 * reported as quiet, not asserted as work.
 *
 * @param {DayRec[]} days
 * @param {number} nowSec
 * @param {number} [dow] Which weekend day (default 6 = Saturday).
 * @returns {WeekendSummary}
 */
export const weekendPattern = (days, nowSec, dow = 6) => {
  const daytimeMask = daytimeBits();
  /** @type {WeekendDay[]} */
  const list = days
    .filter((d) => d.dow === dow)
    .map((d) => {
      const activeDay = (d.activeHours & daytimeMask) !== 0;
      const quietDay = !activeDay && (d.quietHours & daytimeMask) !== 0;
      return {
        localDayIdx: d.localDayIdx,
        parity: ((d.weekStartIdx % 2) + 2) % 2,
        state: /** @type {'active'|'quiet'|'none'} */ (activeDay ? 'active' : quietDay ? 'quiet' : 'none'),
      };
    })
    .sort((a, b) => b.localDayIdx - a.localDayIdx); // recent first

  const decided = list.filter((s) => s.state !== 'none');
  if (decided.length < 4) {
    return { gate: 'none', saturdays: list, pattern: 'unknown', activeParity: -1, nextSaturday: 'unknown' };
  }

  const activeCount = decided.filter((s) => s.state === 'active').length;
  const frac = activeCount / decided.length;

  /** @type {WeekendSummary['pattern']} */
  let pattern = 'irregular';
  let activeParity = -1;
  if (frac >= 0.85) pattern = 'always';
  else if (frac <= 0.15) pattern = 'never';
  else {
    // Every-other test: does state track week parity?
    let byParity = 0;
    for (const s of decided) {
      const wantActive = s.parity === decided[0].parity ? decided[0].state === 'active' : decided[0].state !== 'active';
      // Compare each to the parity-implied expectation seeded from the newest.
      if ((s.state === 'active') === wantActive) byParity += 1;
    }
    if (byParity / decided.length >= 0.8) {
      pattern = 'alternating';
      activeParity = decided.find((s) => s.state === 'active')?.parity ?? -1;
    }
  }

  // Predict the coming Saturday.
  const comingIdx = nextDowIndex(nowSec, dow);
  const comingParity = ((mondayFromLocalDay(comingIdx) % 2) + 2) % 2;
  /** @type {'active'|'quiet'|'unknown'} */
  let nextSaturday = 'unknown';
  if (pattern === 'always') nextSaturday = 'active';
  else if (pattern === 'never') nextSaturday = 'quiet';
  else if (pattern === 'alternating' && activeParity >= 0) {
    nextSaturday = comingParity === activeParity ? 'active' : 'quiet';
  }

  /** @type {Gate} */
  const gate = decided.length >= 8 && pattern !== 'irregular' ? 'pattern'
    : pattern === 'irregular' ? 'hint' : 'hint';

  return { gate, saturdays: list, pattern, activeParity, nextSaturday };
};

/** 24-bit mask of the daytime hours [WEEKEND_DAY_START, WEEKEND_DAY_END). @returns {number} */
function daytimeBits() {
  let m = 0;
  for (let h = WEEKEND_DAY_START; h < WEEKEND_DAY_END; h++) m |= 1 << h;
  return m >>> 0;
}

// ── Local-week arithmetic (no Date.now; nowSec is passed) ────────────────

/** Monday (local day index) of the week containing `sec`. @param {number} sec @returns {number} */
function mondayIndexOf(sec) {
  if (!sec) return 0;
  const d = new Date(sec * 1000);
  const localDayIdx = Math.floor((sec - d.getTimezoneOffset() * 60) / DAY_S);
  return localDayIdx - ((d.getDay() + 6) % 7);
}

/** Monday index for a given local day index. @param {number} localDayIdx @returns {number} */
function mondayFromLocalDay(localDayIdx) {
  // localDayIdx 0 = 1970-01-01 (Thursday) in local terms → dow via +4 offset.
  const dow = (((localDayIdx % 7) + 4) % 7 + 7) % 7; // 0=Sun..6=Sat
  return localDayIdx - ((dow + 6) % 7);
}

/** Local day index of the next occurrence of weekday `dow` strictly after now. @param {number} nowSec @param {number} dow @returns {number} */
function nextDowIndex(nowSec, dow) {
  const d = new Date(nowSec * 1000);
  const todayIdx = Math.floor((nowSec - d.getTimezoneOffset() * 60) / DAY_S);
  const todayDow = d.getDay();
  let delta = (dow - todayDow + 7) % 7;
  if (delta === 0) delta = 7; // strictly the NEXT one
  return todayIdx + delta;
}

/**
 * Top-level convenience: full shift analysis from a raw ledger.
 * @param {PresenceLedger} ledger
 * @param {number} nowSec
 * @param {{ rangeDays?: number }} [opts]
 * @returns {{ rotation: RotationSummary, weekend: WeekendSummary }}
 */
export const summarizeShiftPattern = (ledger, nowSec, opts = {}) => {
  const days = collectLocalDays(ledger, nowSec, opts.rangeDays || 0);
  const mfWeeks = weeklyProfiles(days, { weekdays: WEEKDAYS_MON_FRI });
  return {
    rotation: detectRotation(mfWeeks, nowSec, true),
    weekend: weekendPattern(days, nowSec, 6),
  };
};
