# REFACTOR.md — open refactoring work

This file holds **only what is left to do**. The 2026-06-13 architecture-review
refactor (Phases 0–5: lint gates, invariant fixes, contract dedup, pure-core
extraction, doc DRY) is **complete and merged to `main`** — its full task-by-task
record lives in git history (`git log`), not here. One task remains.

> **Lifecycle.** Per the "Documentation hygiene" rule in `CLAUDE.md`, plan docs
> are finite-cycle. When `S2` lands, this file has served its purpose — delete it
> (git keeps the history). Add a fresh plan only when there's fresh planned work.

---

## How to work a task

1. Re-read `CLAUDE.md` (Architecture & invariants + General rules + Context
   hygiene). Those rules win over anything here.
2. Read **only** the files the task names (`Grep`/`Glob` + ranged `Read`).
3. Implement the smallest change that satisfies the **Acceptance** bullets.
4. Verify before committing: `npm run test` (green), `npm run typecheck` (0),
   `npm run lint` (0). Truncate output to the summary line.
5. One task = one logical commit (Conventional Commits). Mark the task `[x]`
   with a **Done:** line, then delete this file per the lifecycle note above.

---

## `[ ]` S2 — Consolidate the "advance native fleetdispatch" sequence

- **Severity:** med · **Size:** M · **Risk:** med · **Deps:** I2 ✓, S1 ✓ (both done)
- **Why:** The fleetdispatch-wizard sequence ("select-all ships → load
  all-resources → dispatch") is partially re-encoded across three sites:
  - `features/fleetdispatchShortcut.js:65-76` — reads `GAME.FD_ALL_RESOURCES`
    then clicks `GAME.FD_SEND_ALL` (`.send_all a`) / fallback inline.
  - `features/fsCollect/domHelpers.js:207-213` — `selectAllShips()` /
    `loadAllResources()` (the cleanest existing copies of the steps).
  - `features/shared/fleetCourier.js:287,507` — clicks `GAME.FD_ALL_RESOURCES`
    and `GAME.FD_DISPATCH` in its own flow.
- **What:** Define the canonical small step helpers in
  `features/shared/fleetCourier.js` (using `GAME.FD_*` from `lib/gameDom.js`) —
  expose just the steps the callers actually share (`selectAllShips`,
  `loadAllResources`, and the dispatch click). Have `fleetdispatchShortcut.js`
  and `fsCollect/domHelpers.js` import and call them instead of re-clicking the
  selectors themselves. Don't over-abstract — no orchestration layer, just the
  shared leaf clicks. (`shared/` is the sanctioned cross-feature home; importing
  from it does not violate the no-feature→feature rule.)
- **Acceptance:** One implementation of each FD step; the three sites import it;
  `npm run test` + `typecheck` + `lint` green; **no behavior change**.
- **⚠ Verify in-game (required):** fleetdispatch is behaviour-critical and the
  pure unit tests can't prove the live click sequence still advances the wizard.
  Run the `verify` skill (or a manual smoke: Daily Run + the fleetdispatch
  shortcut both still select-all → load-resources → dispatch) before calling
  this done. Do **not** land it blind.
- **Done:**

---

## Don't relitigate (settled non-findings)

- `sync/scheduler.js` and `sync/ntfyReconciler.js` are **not** duplicate
  schedulers and must **not** be merged — different mechanisms (timer-based
  debounce+lock vs stateless server-queue diff); only `gist.js` does backoff.
  The rename to `ntfyReconciler` (was `ntfyScheduler`) exists to stop
  re-inviting this question; its module header explains why.
