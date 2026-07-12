# IDEAS.md — backlog of future enhancements

Captured ideas for later, not yet designed/built. Unlike the transient
plan docs (`*-AUDIT.md`, `REFACTOR.md`) this is a long-lived backlog: an
entry stays until it ships (then it moves to `CHANGELOG.md` and is deleted
here) or is explicitly dropped. Each entry records the *intent* and the
concrete game-DOM hooks, so a future session can pick it up cold.

Owner: solo dev (see CLAUDE.md). Ideas are in the user's own words,
grounded against the current code at capture time.

---

## 3. Alliance Spyglass share — follow-ups (v1 shipped in 1.47.0)

The opt-in alliance co-op share shipped in 1.47.0 (per-member-block model,
sync-on-click, config on the Sync tab — see `domain/allianceIntel.js` /
`sync/allianceShare.js` / `features/dashboard/allianceShare.js`). Deliberately
deferred from v1, each its own small design chunk:

- **Token rotation UX.** The alliance token is a shared secret; today
  rotation = the owner mints a new PAT and everyone re-pastes. Consider a
  "token changed?" hint when a pull starts failing with 401 after having
  worked.
- **Read-only membership tier.** A member who should PULL the union but not
  write a block (e.g. a trial member). Needs either a second read-only token
  (gist is private → any read needs auth) or acceptance that read = write
  trust in v1.
- **Own-block preview before first share.** A "what exactly leaves this
  device" dry-run view (render `buildMemberBlock` locally without a PATCH) —
  strengthens the consent story before the first click.
