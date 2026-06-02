// @ts-check

// Duration parsing + formatting for the Settings panel's time fields.
//
// # The model
//
// Internally the whole reminder pipeline speaks SECONDS (ntfy's `X-Delay`
// is in seconds, as are its min/max bounds). The Settings UI, however, is
// MINUTES-FIRST with an explicit unit suffix:
//
//   - a BARE number is MINUTES  — `30` ⇒ 1800 s
//   - an explicit suffix scales — `90s` ⇒ 90 s, `10m` ⇒ 600 s, `1h` ⇒ 3600 s
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
const UNIT_SECONDS = { s: 1, m: 60, h: 3600 };

/** One token: optional sign, integer/decimal magnitude, optional s/m/h. */
const TOKEN_RE = /^([+-]?)(\d+(?:\.\d+)?)(s|m|h)?$/i;

/**
 * Parse ONE duration token into whole seconds. Bare number = minutes; an
 * `s`/`m`/`h` suffix (any case) overrides. Returns `null` for anything
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
  return Math.round(sign * mag * UNIT_SECONDS[/** @type {'s'|'m'|'h'} */ (unit)]);
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
