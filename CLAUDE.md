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
  *Sanctioned exception — plain key-owner modules:* some `state/` modules are
  plain `read*/write*` helpers with **no** `createStore`/`persist` and no
  reactive store — currently `state/dailyActions.js`,
  `state/lifeformArtifacts.js`, `state/fleetSaveSet.js`,
  `state/manualLandedFs.js`, and `state/badgeCache.js` (over `safeLS`) plus
  `state/ownProfile.js` and `state/apiCache.js` (over `chrome.storage`).
  That's deliberate: nothing subscribes to them (they're read on demand at the
  one call site that needs them), so a reactive store would be pure overhead —
  each says so in its own header. The rule is structural, not this list: a
  store-less key-owner is sanctioned whenever nothing needs to react to its
  changes; add a reactive store only if a real consumer does.
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

**How we work (build-and-verify first, tests at release).** Day-to-day the
loop is: change the code → `npm run build` → the user verifies it in the
browser → iterate on their feedback until they approve. **Do NOT write or run
the unit-test suite during this loop** — it's wasted churn while the design is
still moving. Commits may land with the suite untouched (even red). `npm run
typecheck` + `npm run lint` stay a cheap pre-commit sanity check (they catch
real errors without authoring any test); the test SUITE is deliberately
deferred.

**Tests are reconciled once, at release time** — when the user asks to publish
(push a `vX.Y.Z` tag / upload to AMO). Only THEN do we add/fix tests for
everything the session changed, and bring `npm run test` back to green. The
release script runs `npm run test` + `npm run typecheck` as a hard gate before
the AMO upload, so a red suite blocks the publish — that gate is the backstop
that makes deferring safe.

**What the tests should cover (when you do write them).** Pure/domain/state/
sync logic gets unit tests. Bridge logic (XHR projection, event gating) and
dashboard I/O (import/merge, tombstone writes) get *behavioral* tests — drive a
fake XHR / `File` through happy-dom and assert the observable output (dispatched
event, stored value), not internals. Tests are hermetic: no real network (the
shared `test/setup.js` neuters `fetch` + `XMLHttpRequest.send`), so stub any
request the code under test makes.

## Release checklist (one path: bump the version, push to `main`)

There is exactly ONE way to publish, and **we never cut a `vX.Y.Z` tag by
hand** — `.github/workflows/release.yml` mints it. You bump the version and
push to `main`; CI does everything else (tags, tests, packages, uploads to AMO).

The procedure:

1. **Reconcile the tests** — this is the moment the session's deferred test
   work happens: add/fix tests for everything that changed and get
   `npm run test` green. (CI re-runs `npm run test` + `npm run typecheck` as a
   hard gate inside `scripts/release.mjs`, so a red suite blocks the publish.)
2. **Add the dated `## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md`** (the
   one manual content step). It is sent verbatim as the public AMO release
   notes *and* it is the trigger — CI publishes only a version whose CHANGELOG
   section exists.
3. **Bump `"version"` in `package.json` AND `manifest.json`** to `X.Y.Z`.
4. **Commit all three together** as `chore(release): X.Y.Z` and **push to
   `main`**. Because that push = a **public** release that auto-updates existing
   users, confirm with the user before pushing.

On that push, `release.yml` sees the new, documented version, mints + pushes the
`vX.Y.Z` tag, checks it out (detached HEAD) and runs `scripts/release.mjs` —
which validates the CHANGELOG, runs the test + typecheck gate, packages
`dist.zip` + `source.zip` (hard-asserting both), and uploads to AMO. The script
auto-detects this CI situation (tag present + detached HEAD) and skips its own
commit/tag/push, so it only uploads.

`AMO_JWT_ISSUER` / `AMO_JWT_SECRET` are GitHub repo secrets the Action injects;
the workflow also needs **Settings → Actions → Workflow permissions = "Read and
write"** to push the tag. (`scripts/release.mjs` still accepts `.env` creds and
can be run locally as a break-glass fallback — it bumps, commits, tags, uploads,
and pushes — but the push-to-`main` path above is the only one we use.)

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
- `npm run typecheck` and `npm run lint` must both exit 0 before any commit.
- The unit-test suite is NOT a per-commit gate (see "How we work" above):
  build + manual verification drives the session; `npm run test` is brought
  green once, at release time, and enforced there by the release script.
- Follow Conventional Commits: `fix:` / `feat:` / `refactor:` /
  `chore:` / `test:` / `docs:`.
- **Documentation hygiene (DRY).** Each topic has ONE source of truth;
  every other mention *links* to it instead of restating it. Canonical
  homes: build steps → `REVIEWERS.md`; release workflow → `CLAUDE.md`;
  architecture invariants → `CLAUDE.md`; privacy/permissions → `PRIVACY.md`;
  user-visible changes → `CHANGELOG.md`; reverse-engineered OGame game rules
  (fleet movement, phalanx, fleet-save) → `docs/ogame-fleet-mechanics.md`.
  Plan docs (a transient `REFACTOR.md`
  and the like) have a lifecycle — delete them once their cycle closes (git
  keeps the history); they are not permanent. **Carve-out:** this rule governs the standalone
  `.md`/`.txt` docs ONLY — it does **not** apply to in-code comments. Those
  are reverse-engineered game knowledge with no other home (OG-E has no access
  to OGame's source/docs); never trim them under a "DRY" banner.

## UI/UX wording & iconography

OG-E must be **intuitive, not descriptive**. Two rules the injected surface obeys:

- **No decorative emoji / symbol icons in the UI** — do not use 📍 🏷 ⚠ ● ○ and
  the like as button labels, prefixes, or state markers. They read as noise, not
  signal. Convey state with colour + a short word, or a plain control — not a
  glyph. (A few long-standing FUNCTIONAL markers pre-date this rule, e.g. the 💀
  RIP-range flag with its footnote legend; leave those unless asked, but do not
  add new ones.)
- **Keywords over descriptions.** Labels are short keywords, not sentences —
  `Coords` / `Names`, never "Toggle the column between coordinates and names".
  Tooltips are a fallback, not the primary UI. If a control needs a full
  sentence to be understood, that is a UX smell — reconsider the design before
  writing the description.

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
