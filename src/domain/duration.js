// @ts-check

// Duration parsing + formatting for the Settings panel's time fields.
//
// # The model
//
// Internally the whole alarmClock pipeline speaks SECONDS (ntfy's `X-Delay`
// is in seconds, as are its min/max bounds). The Settings UI, however, is
// MINUTES-FIRST with an explicit unit suffix:
//
//   - a BARE number is MINUTES  — `30` ⇒ 1800 s
//   - an explicit suffix scales — `90s` ⇒ 90 s, `10m` ⇒ 600 s, `1h` ⇒ 3600 s,
//     `5d` ⇒ 432000 s (days, for the Galaxy-Scan rescan fields)
//   - decimals are allowed       — `1.5m` ⇒ 90 s
//
// So this module is the single boundary that converts the user's
// minutes-first text into the canonical seconds the domain/scheduler
// consume, and back ({@link formatDuration}) for display. Keeping the
// conversion here means every time field — scalars (lead time, min flight)
// and comma lists (wave/FS schedules) — shares ONE grammar, which is the
// "systematic, repeatable" convention the panel is built around.
//
// Pure: no DOM, no storage, no `Date`. Fully unit-testable in Node.

/** Seconds-per-unit. The absent suffix defaults to `m` (minutes-first). */
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

/** One token: optional sign, integer/decimal magnitude, optional s/m/h/d. */
const TOKEN_RE = /^([+-]?)(\d+(?:\.\d+)?)(s|m|h|d)?$/i;

/**
 * Parse ONE duration token into whole seconds. Bare number = minutes; an
 * `s`/`m`/`h`/`d` suffix (any case) overrides. Returns `null` for anything
 * that isn't a single well-formed token, so callers can skip garbage.
 *
 * @param {string} token
 * @returns {number | null}  Whole seconds (may be negative), or null.
 */
export const parseDuration = (token) => {
  const m = TOKEN_RE.exec(String(token).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const mag = parseFloat(m[2]);
  if (!Number.isFinite(mag)) return null;
  const unit = (m[3] || 'm').toLowerCase();
  return Math.round(sign * mag * UNIT_SECONDS[/** @type {'s'|'m'|'h'|'d'} */ (unit)]);
};

/**
 * Parse a comma-separated duration list into a sorted, de-duped array of
 * whole-second offsets. Tolerant of spaces, a leading `+`, and a trailing
 * comma; drops tokens that don't parse.
 *
 * `signed: false` (the default) drops negatives — used for the wave
 * schedule, whose offsets are minutes AFTER the wave returns and so can't
 * be negative. `signed: true` keeps them — used for FS offsets, which are
 * relative to landing (negative = before).
 *
 * @param {string} str
 * @param {{ signed?: boolean }} [opts]
 * @returns {number[]}  Sorted unique whole-second offsets.
 */
export const parseDurationList = (str, { signed = false } = {}) => {
  /** @type {Set<number>} */
  const seen = new Set();
  for (const tok of String(str ?? '').split(',')) {
    const t = tok.trim();
    if (!t) continue;
    const n = parseDuration(t);
    if (n === null) continue;
    if (!signed && n < 0) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
};

/**
 * Parse a game-rendered CLOCK duration (`H:MM:SS`, or `D:H:MM:SS` for
 * flights over a day — e.g. `#durationOneWay`'s text, `01:50:48` = 6648 s)
 * into whole seconds. Any other shape, empty text, or a NaN chunk returns
 * `0`; callers treat `0` as "duration unknown". Shared by the MAIN-world
 * send observers (`bridges/sendFleetHook.js`, `bridges/fleetSaveSendHint.js`)
 * — a different grammar from {@link parseDuration}'s minutes-first Settings
 * tokens, which is why it is a separate function.
 *
 * @param {string | null | undefined} text
 * @returns {number} Duration in seconds, or `0` if unparseable.
 */
export const parseClockDuration = (text) => {
  const t = (text || '').trim();
  if (!t) return 0;
  const parts = t.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 4) return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  return 0;
};

/**
 * Format whole seconds back into a canonical minutes-first token for
 * display: a whole number of minutes renders as `Nm` (so `3600 ⇒ "60m"`,
 * matching the input grammar's preference for minutes), anything else as
 * `Ns`. Zero is `"0m"`. Negative values keep their sign (`-600 ⇒ "-10m"`).
 *
 * Deliberately never emits an `h` suffix — `parseDuration` accepts it, but
 * round-tripping everything through minutes keeps the displayed series
 * uniform (`60m`, not `1h`).
 *
 * @param {number} sec
 * @returns {string}
 */
export const formatDuration = (sec) => {
  const n = Number.isFinite(sec) ? Math.round(sec) : 0;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a === 0) return '0m';
  if (a % 60 === 0) return `${sign}${a / 60}m`;
  return `${sign}${a}s`;
};

/**
 * Humanize a landing-relative offset (whole seconds; negative = BEFORE
 * landing, positive = AFTER, zero = at landing) into the plain-English
 * impact phrase shared by the fleet-save push body and the AlarmClock-tab
 * offset editor preview:
 *
 *   -600 ⇒ "10 min before landing"
 *      0 ⇒ "landing now"
 *    900 ⇒ "15 min after landing"
 *
 * Magnitude is rounded to the nearest WHOLE MINUTE — matching the push's
 * coarseness (the ntfy app shows whole minutes) and the minutes-first
 * grammar users type in. Single source of truth so the push text and the
 * editor preview can never drift.
 *
 * @param {number} sec  Offset relative to landing, in seconds.
 * @returns {string}
 */
export const humanizeOffset = (sec) => {
  const n = Number.isFinite(sec) ? Math.round(sec) : 0;
  if (n === 0) return 'landing now';
  const m = Math.round(Math.abs(n) / 60);
  return n < 0 ? `${m} min before landing` : `${m} min after landing`;
};

/**
 * Humanize a wave-alarmClock offset (whole seconds AFTER the wave returns;
 * negatives are dropped before they reach here, so non-positive ⇒ "at return")
 * into the plain-English impact phrase for the AlarmClock-tab wave-schedule
 * editor preview:
 *
 *      0 ⇒ "when the wave returns"
 *    600 ⇒ "10 min after the wave returns"
 *
 * Counterpart to {@link humanizeOffset} for the wave reference point — the
 * wave push body ("Expeditions back (HH:MM) …") states the absolute time, so
 * the relative phrasing lives only here, but keeping it next to
 * {@link humanizeOffset} keeps the two reference points in one place.
 *
 * @param {number} sec  Offset from the wave's return, in seconds.
 * @returns {string}
 */
export const humanizeReturnOffset = (sec) => {
  const n = Number.isFinite(sec) ? Math.round(sec) : 0;
  if (n <= 0) return 'when the wave returns';
  const m = Math.round(n / 60);
  return `${m} min after the wave returns`;
};

/**
 * Humanize an ARRIVAL-relative offset (whole seconds; negative = BEFORE
 * arrival, positive = AFTER, zero = at arrival) into the plain-English impact
 * phrase shared by the ad-hoc push body (`{offset}`) and the ad-hoc schedule
 * editor preview:
 *
 *   -600 ⇒ "10 min before arrival"
 *      0 ⇒ "at arrival"
 *    900 ⇒ "15 min after arrival"
 *
 * Ad-hoc's counterpart to {@link humanizeOffset} — same signed convention and
 * whole-minute coarseness, but worded for a leg's ARRIVAL (a fleet "arrives";
 * "landing" is the fleet-save reference). Single source of truth so the ad-hoc
 * push text and its editor preview can never drift.
 *
 * @param {number} sec  Offset relative to arrival, in seconds.
 * @returns {string}
 */
export const humanizeArrivalOffset = (sec) => {
  const n = Number.isFinite(sec) ? Math.round(sec) : 0;
  if (n === 0) return 'at arrival';
  const m = Math.round(Math.abs(n) / 60);
  return n < 0 ? `${m} min before arrival` : `${m} min after arrival`;
};

/**
 * One-line plain-English summary of a WHOLE alarmClock schedule — the combined
 * readout shown under the chip row so the user sees, at a glance, what the set
 * of chips actually adds up to (e.g. `"15m, 10m & 5m before landing · at
 * landing · 5m & 20m after landing"`).
 *
 * The offsets are grouped into before / at / after the reference point;
 * `before` is listed FURTHEST-first and `after` NEAREST-first, so both read in
 * the chronological order the pushes fire. Duplicates collapse. Empty input (or
 * all-unparseable) ⇒ `''`. Pure.
 *
 * @param {number[]} secs   Signed offset seconds (neg = before, 0 = at, pos = after).
 * @param {'landing' | 'return' | 'arrival'} reference  Point the offsets are measured from.
 * @returns {string}
 */
export const summarizeSchedule = (secs, reference) => {
  const uniq = [...new Set(secs.filter((s) => Number.isFinite(s)))];
  const before = uniq.filter((s) => s < 0).map((s) => -s).sort((a, b) => b - a);
  const at = uniq.some((s) => s === 0);
  const after = uniq.filter((s) => s > 0).sort((a, b) => a - b);
  /** @param {number[]} arr */
  const list = (arr) => {
    const parts = arr.map(formatDuration);
    return parts.length <= 1
      ? parts[0] ?? ''
      : `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
  };
  const out = [];
  if (before.length) out.push(`${list(before)} before ${reference}`);
  if (at) out.push(`at ${reference}`);
  if (after.length) out.push(`${list(after)} after ${reference}`);
  return out.join(' · ');
};
