# IDEAS.md — backlog of future enhancements

Captured ideas for later, not yet designed/built. Unlike the transient
plan docs (`*-AUDIT.md`, `REFACTOR.md`) this is a long-lived backlog: an
entry stays until it ships (then it moves to `CHANGELOG.md` and is deleted
here) or is explicitly dropped. Each entry records the *intent* and the
concrete game-DOM hooks, so a future session can pick it up cold.

Owner: solo dev (see CLAUDE.md). Ideas are in the user's own words,
grounded against the current code at capture time.

---

## 2. Alliance-shared Spyglass sync (scan/activity co-op, sync-on-click)

**Goal.** Optionally pool Spyglass intel with alliance-mates: share our
scans of watched players (spy reports, galaxy-view activity, relationship
tags) into a shared store so the alliance sees each other's coverage of who
is being spied / how active targets are. Sync happens ONLY on an explicit
click — never in the background — so it stays opt-in and never leaks
silently.

**Why it needs its own trust model (the reason it's backlog, not a quick
add).** Today's sync is strictly single-user: one personal GitHub PAT
(`TOKEN_KEY = 'oge_gistToken'`, `sync/gist.js`) → one PRIVATE gist owned by
that user (`GIST_ID_KEY = 'oge_gist'`) → many files inside it (the
`GIST_FILENAME` bundle + per-universe `oge-alarmClock-*`), each PATCHed
independently so features don't clobber each other. An alliance share means
a SECOND token/gist-id pair pointing at an alliance-OWNED gist that
non-owners can write to — a different trust boundary than anything we have.

**Shape (rough).**
- Second, separately-stored token + gist-id (mirror the `TOKEN_KEY` /
  `GIST_ID_KEY` pattern, or a `chromeStore` mirror like alarmClock's
  `ALARM_CLOCK_TOKEN_KEY` in `sync/alarmClock.js`), pointing at the shared
  alliance gist.
- New dedicated file `oge-spyglass-alliance-<universeId>.json`, written via
  the same per-file PATCH path in `sync/scheduler.js` — the alarm-clock
  files coexisting with the main bundle are the precedent for a new filename
  in the same gist.
- Sync-on-click only: a "Share now / Pull alliance intel" button; no
  clock/debounce backstop.
- Merge = union across members + last-writer-wins per (player, field), with
  tombstones for un-watch (reuse the watchlist LWW+tombstone model from
  1.40.0).

**Open questions for the design session.**
- Gist ownership: one alliance leader owns it and shares a fine-grained PAT,
  or each member owns their own share-out gist and others pull N of them?
- Privacy/consent: exactly what leaves the device (coords, player ids,
  timestamps) and it must be scoped to the current universe only.
- Abuse: a shared writable token is a shared secret — rotation and
  read-vs-write scoping.
- Never feed shared intel into the danger score `D` — keep it a
  display/coverage layer, same discipline as the civil baseline.

See related: the cross-device watchlist sync shipped in 1.40.0 — the C6
silent-wipe class applies here too, and its single-user LWW+tombstone model
is the precursor to reuse. Decided 2026-07-09: backlog only, own design
session before any code.

