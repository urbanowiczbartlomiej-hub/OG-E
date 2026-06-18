# Contributing

Welcome. OG-E is a deliberately small codebase — six rules, a clean
workflow, and the rest falls out of the code itself. Read this once
and you're set.

## 1. Compliance comes first

**One user click → at most one HTTP request to the game server.**
This is not a guideline, it is the whole product's reason for
existing. We observe XHRs the game already fires (see `src/bridges/`)
and republish them as DOM events; we never originate traffic to the
game server. No background cycles, no batch actions, no "one click,
five fleets out", no rate-limit circumvention. `location.href = url`
in response to a single visible user click is fine; so are requests to
user-controlled third-party services (`api.github.com` for sync,
`ntfy.sh` for reminders — both opt-in, both keyed by a token the user
supplies).

The full, formal statement — the one AMO reviewers read — lives in
[`REVIEWERS.md`](REVIEWERS.md) (§Compliance summary). When unsure, open
an issue before the PR.

## 2. Purity where you can

`src/lib/` and `src/domain/` are **pure** — no DOM, no storage, no
`Date.now()` without an explicit parameter — which is why most of the
codebase runs in Node's vitest with zero mocking. If your helper needs
any of those, it belongs in `src/state/` (storage) or `src/features/`
(DOM) instead. The authoritative layering rules (dependency direction,
the pure-core rule) live in [`CLAUDE.md`](CLAUDE.md) (§Architecture &
invariants).

## 3. JSDoc + `@ts-check`

We ship vanilla JS, but every source file opens with `// @ts-check`
and every public function has `@param` / `@returns`. `npm run typecheck`
must exit 0 before each commit — and so must `npm run lint`, which
mechanically enforces the import-layering rules (§2).

TypeScript is not required. Types are.

## 4. Tests where they earn their keep

- `src/domain/` and `src/lib/` — every helper has a test file in
  `test/domain/` or `test/lib/` (often ten-plus edge cases each).
- `src/features/` — happy-dom integration smoke tests, focused on
  wiring and regression catches.
- `src/bridges/` — happy-dom XHR shim; verify the dispatched DOM
  event payload is well-shaped.

We don't chase 100 % coverage. We chase **regression killers** and
**contract locks**.

Day-to-day, commits are *not* gated on the suite — a change is driven by the
build plus a manual in-game check, and the unit suite is reconciled to green
once, at release (the release script enforces it as a hard gate). The
per-commit gates are `npm run typecheck` + `npm run lint`.

## 5. Commit format

`fix:` / `feat:` / `chore:` / `docs:` / `refactor:` / `test:`
followed by a short imperative. Commit body explains **why**, not
**what** — the diff shows the what.

```
feat: lock Send Exp button on Sent!

Previously the button remained clickable after firing the dispatch,
letting a fast double-tap trigger two navigations. Lock + 3 s
safety-unlock (by which time the page has reloaded or the game
returned an error).
```

## 6. No new runtime dependencies

Vanilla JS and browser APIs, period. If you really need a library,
open an issue with the trade-off laid out (bundle cost, tree-shake
story, maintenance burden).

Dev dependencies (rollup, vitest, typescript) are fine and normal.

---

## Dev workflow

```bash
npm install
npm run dev           # rollup watch; rebuilds dist/ on save
npm run test          # vitest
npm run typecheck     # must exit 0
```

A change is ready when those pass cleanly and you've load-tested
`dist/manifest.json` as a temporary add-on (Firefox) or unpacked
extension (Chrome) against a running OGame account. The reproducible
production build (`npm run build:prod` → `dist/`) is documented in
[`REVIEWERS.md`](REVIEWERS.md) (§Steps) — that's its canonical home.

## Test-in-game checklist

Before merging anything that touches DOM behaviour:

- Unified floating action button visible + draggable; its module orbs
  switch between Send Exp / Send Col / Send Lifeform.
- Send Col mode: Scan subtext shows the remaining scan count.
- Galaxy scan persists across reloads; histogram page shows pixels.
- On a colony below `colonyMinFields`, the FAB offers the one-tap Abandon
  action (this is where the old fresh-planet banner + abandon overlay went).
- AGR settings menu contains the OG-E tab and it expands.
- Readability boost toggle flips the event-box styling on/off.

## Release workflow

The whole release is one flagless command (`npm run release X.Y.Z`) with a
short by-hand prep (a dated `CHANGELOG.md` section left uncommitted;
`AMO_JWT_*` secrets in a gitignored `.env`, or push a `vX.Y.Z` tag and let
the GitHub Action publish). The authoritative, step-by-step procedure lives
in [`CLAUDE.md`](CLAUDE.md) (§Release checklist). Follow and update it there;
don't restate it here.

Before releasing anything that touches DOM behaviour, spot-check the
in-game checklist above on both Firefox and Chrome.

## Contact

Open an issue. Please don't email.
