# CLAUDE.md — instructions for the AI assistant

## Architecture & invariants (don't break these)

This section is deliberately about *rules that must stay true*, not a
description of what each file does (descriptions rot; invariants don't).
If a change would violate one of these, that's a design smell — stop and
reconsider, don't paper over it. The layering below is the reason this
extension stays testable and survives OGame updates. It is mechanically
enforced by ESLint (`eslint.config.mjs`'s import zones) — not
honor-system — so `npm run lint` catches a layering violation directly.

**Dependency direction (one-way, no cycles):**

```
domain  ←  state  ←  features / sync
  ↑          ↑            ↑
  └──────── lib (foundation, zero app deps) ───────┘
bridges → lib + domain (MAIN-world; must NOT import state/features/sync)
```

- **`domain/`** is pure logic: no DOM, no timers, no storage, no
  `chrome.*`. Plain functions over plain data. Everything here is unit
  tested. Never reach into the page from `domain/`.
- **`state/`** owns all persisted state. Mutate it ONLY through the
  reactive stores (`store.set(...)`); never write the backing
  `localStorage` / `chrome.storage` keys from a feature directly. Stores
  are write-through and their `init*()` is idempotent. Teardown surface is
  uniform: every store exposes `dispose*Store()` (idempotent; cuts the
  persist subscription) and nothing else — tests reset in-memory state with
  an explicit `store.set(<initial>)` after disposing (no per-store
  `_reset*ForTest` helper; that affordance is for *features*, not stores).
  *Sanctioned exception — plain key-owner modules:* `state/dailyActions.js`
  and `state/lifeformArtifacts.js` are plain `read*/write*` helpers over
  `safeLS` with **no** `createStore`/`persist` and no reactive store. That's
  deliberate: nothing subscribes to them (they're read on demand at the one
  call site that needs them), so a reactive store would be pure overhead.
  Add a store only if a real consumer needs to react to changes.
- **`features/`** may depend on `domain` + `state` + `lib`, but **no
  feature imports another feature.** Each `install*()` is independent and
  idempotent, and ships a `_reset*ForTest()` for the suite. Order in
  `content.js` is not load-bearing.
- **`bridges/`** are MAIN-world observers. They import `lib` and pure
  `domain` helpers only (domain is side-effect-free, so it is safe across
  the world boundary) — **never** `state`/`features`/`sync` (the
  isolated-world layers pull in `chrome.*`, which doesn't exist in the
  MAIN world). Shared key strings live in `lib/storageKeys.js`. They
  communicate with the isolated world exclusively via `oge:*` CustomEvents
  on `document`. (Enforced by the `bridges` lint zone.)
- **`lib/`** is the dependency-free foundation. Nothing here may import
  from `domain`/`state`/`features`/`sync`.

**The pure-core rule.** A feature big enough to have non-trivial logic
splits it into a `pure.js` (the axiom there: *no DOM reads/writes, no
timers, no listeners*) so the logic is testable without happy-dom. See
`features/sendColony/pure.js` / `features/sendExpedition/pure.js`. Don't grow an
orchestrator past ~400 lines of mixed logic+DOM without extracting a
pure core.

**Game-DOM selectors live in ONE place.** Every OGame-native / AGR CSS
selector read by **two or more** features goes in `src/lib/gameDom.js`
and is imported from there — that file is the single source of truth for
our fragile external DOM contract (so a game rename is a one-line fix).
Rules: (1) selectors used by exactly ONE feature stay local to it —
hoisting them only adds indirection; (2) OG-E's OWN injected ids/classes
(dashboard elements, `oge-*`, badge classes) are NOT a contract with
anyone — keep them next to the code that emits them; (3) the game's
misspellings (`hightlightPlanet`, `planet-koords`) are kept verbatim,
documented in `gameDom.js`.

**Testing bar.** Pure/domain/state/sync logic is expected to be unit
tested. New bridge logic (XHR projection, event gating) and dashboard
I/O (import/merge, tombstone writes) need *behavioral* tests — drive a
fake XHR / `File` through happy-dom and assert the observable output
(dispatched event, stored value), not internals. `npm run test` and
`npm run typecheck` (test files included) must both be green before any
commit touching `src/` — see General rules below.

## Release checklist (one flagless command, two ways to run it)

`scripts/release.mjs` takes ONLY a version — no flags. It auto-detects its
situation, so the SAME command serves both release paths and they never
collide (upload skipped if the version is already on AMO; commit/tag skipped if
the tag exists; push skipped when HEAD is detached). The two paths:

- **Manual (local, with `.env` creds):** `npm run release 1.25.1` on `main`.
  Validates the CHANGELOG, runs tests + typecheck, bumps `package.json` +
  `manifest.json`, packages, commits + tags `vX.Y.Z`, **uploads to AMO via the
  API**, then pushes the branch + tag. (Pushing the tag fires the workflow,
  which then no-ops because the version is already on AMO.)
- **Official (GitHub Action, on a `vX.Y.Z` tag):** `.github/workflows/release.yml`
  checks out the tag and runs the same `node scripts/release.mjs <ver>` with the
  repo secrets. HEAD is detached + the tag exists, so it skips commit/tag/push
  and just uploads. Use this when you have no local creds: cut the tag with
  `npm run release` (it bumps/commits/tags/pushes, skipping the upload when no
  creds are present) and CI publishes it.

Either way, do this first (the one manual step): add the dated
`## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md`. Leave it uncommitted — the
script commits it together with the version bump into the single
`chore(release): X.Y.Z` commit the tag points at, and sends it verbatim as the
public AMO release notes. The script refuses to run without it, requires a
clean tree EXCEPT the three release files (`CHANGELOG.md` / `package.json` /
`manifest.json`), and hard-asserts `dist.zip` + `source.zip` before uploading.
Git stays local until AMO accepts the archive. Because a tag push = a **public**
release that auto-updates existing users, confirm with the user before pushing.

`AMO_JWT_ISSUER` / `AMO_JWT_SECRET` live as GitHub repo secrets (for the
Action) and in a gitignored local `.env` (loaded automatically by
`npm run release`; see `.env.example`). With neither present the upload is
simply skipped — the bump/commit/tag/push still run.

## AMO note fields (sent automatically by the script)

- **Notes to Reviewer** (internal) ← `amo-reviewer-notes.txt`, sent verbatim.
  That file IS the source of truth (the script reads it) — edit it there when
  build steps or permissions change; don't restate its contents here.
- **Release notes** (public) ← the `## [X.Y.Z]` section of `CHANGELOG.md`,
  verbatim. No separate short-form list is maintained any more.

## General rules

- Patch bump (`1.0.x`) for bug fixes; minor (`1.x.0`) for new
  user-visible features; major (`x.0.0`) for breaking changes to
  stored data formats or required AGR version.
- `npm run test` must be green before any commit that touches `src/`.
- `npm run typecheck` and `npm run lint` must both exit 0 before any commit.
- Follow Conventional Commits: `fix:` / `feat:` / `refactor:` /
  `chore:` / `test:` / `docs:`.
- **Documentation hygiene (DRY).** Each topic has ONE source of truth;
  every other mention *links* to it instead of restating it. Canonical
  homes: build steps → `REVIEWERS.md`; release workflow → `CLAUDE.md`;
  architecture invariants → `CLAUDE.md`; privacy/permissions → `PRIVACY.md`;
  user-visible changes → `CHANGELOG.md`. Plan docs (a transient `REFACTOR.md`
  and the like) have a lifecycle — delete them once their cycle closes (git
  keeps the history); they are not permanent. **Carve-out:** this rule governs the standalone
  `.md`/`.txt` docs ONLY — it does **not** apply to in-code comments. Those
  are reverse-engineered game knowledge with no other home (OG-E has no access
  to OGame's source/docs); never trim them under a "DRY" banner.

## Context hygiene (read this every session)

This repo is large (`src/` ~830 KB, `test/` ~600 KB, single files up to
~1100 lines) and OGame HTML dumps the user pastes are huge. A naive
session burns hundreds of thousands of tokens. Keep context lean:

- **Read narrowly.** Prefer `Grep`/`Glob` to locate, then `Read` with
  `offset`/`limit` for just the relevant span. Don't slurp whole large
  files when you need one function. Never read a file already pasted into
  the conversation.
- **Don't read tests you aren't changing.** To copy a harness pattern
  (e.g. the fake-XHR helper), open ONE example with a tight `limit`, not
  every test file.
- **Truncate every command's output.** Pipe through
  `Select-String`/`Select-Object -Last N`; never dump full `npm test` /
  `npm run build` / `tsc` logs — capture the summary line only (e.g.
  `Select-String "Test Files|Tests |FAIL"`).
- **Delegate broad search to an agent, ask for conclusions.** When using
  the Explore/general agent, instruct it to return file:line pointers and
  a short verdict — not large code excerpts.
- **Never echo back the user's pasted HTML.** Extract the few selectors /
  IDs / values you need and reference those; quoting the blob doubles its
  cost.
- `dist/` is gitignored — building never dirties the tree, so a build for
  manual testing is free of release-process side effects.
