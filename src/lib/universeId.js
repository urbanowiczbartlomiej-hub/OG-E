// @ts-check

// Universe id parser — single source of truth for the namespace prefix
// every per-universe key in `chrome.storage.local` uses.
//
// # Why it exists
//
// `chrome.storage.local` is shared across every origin the extension runs
// on. `localStorage` IS per-origin, so user preferences naturally split
// per universe — but the bulk data (colony history, galaxy scans) lives
// in `chrome.storage.local` and would bleed across universes without an
// explicit namespace. We prefix every such key with `<universeId>:` so
// each OGame server's data sits in its own slice of the storage area.
//
// # Why we parse the universe out of `location.host` rather than using
// the full host string
//
// `s163-pl.ogame.gameforge.com` would work as a key prefix but is verbose
// in DevTools and in the histogram's server-selector UI. Players already
// refer to universes by their short id (`s163-pl`, "Uni 163 PL"). The
// parser shortens the prefix while preserving uniqueness — every
// Gameforge OGame universe has a distinct `s<num>-<lang>` token.
//
// Pure function, no side effects, no DOM access. Callers pass
// `location.host` (or a test fixture); the wrapper is one regex.

/**
 * Extract the universe identifier from a Gameforge OGame host string.
 *
 * Recognises the canonical format `s<digits>-<lang>.ogame.gameforge.com`
 * and returns the leading `s<digits>-<lang>` token (e.g.
 * `s163-pl.ogame.gameforge.com` → `s163-pl`). When the host does not
 * match this pattern — empty string, a dev environment, a future host
 * shape we haven't seen — the full input is returned unchanged so the
 * caller still gets a unique namespace string. The manifest's content
 * script filter already restricts game-origin code to
 * `*.ogame.gameforge.com/game/index.php*`, so the fallback should not
 * fire in production; it exists so tests and edge tooling don't have
 * to special-case the parse failure.
 *
 * Pattern details:
 *   - `^s\d+` — literal `s` followed by the universe number.
 *   - `-[a-z]{2,4}` — separator and locale code. Two-to-four chars
 *     covers every Gameforge locale seen so far (`en`, `pl`, `de`,
 *     `tw`, `br`, ...) with one extra position of headroom against
 *     longer codes Gameforge has not used yet.
 *   - `\.` — the dot that separates the universe id from the rest of
 *     the hostname. Anchors the match so `s10` inside a path or query
 *     string can never be picked up.
 *
 * Case-sensitive on purpose: `location.host` is always lowercase per
 * the URL spec, so anything mixed-case must be coming from a non-
 * browser caller. We fall back rather than silently downcasing —
 * quieter failure mode and the per-universe prefix remains distinct
 * from the lowercase one.
 *
 * @param {string} host  Typically `location.host` of the current tab.
 * @returns {string}     The parsed universe id, or `host` unchanged
 *                       when the pattern does not match.
 */
export const parseUniverseId = (host) => {
  const match = /^(s\d+-[a-z]{2,4})\./.exec(host);
  return match ? match[1] : host;
};
