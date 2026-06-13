# REFACTOR.md — staged refactoring plan

This is a **living, multi-session plan**. It came out of a full architecture
review (2026-06-13). The codebase is healthy and well-layered; this plan is
*dostrajanie*, not rescue. Work it top-to-bottom, one task per commit, marking
each task as you finish. A future session with zero prior context should be
able to pick any unblocked task and execute it from this file alone.

> Companion docs: `CLAUDE.md` holds the **invariants** (the rules this plan
> protects and must never break). This file holds the **work**. When a task
> changes an invariant, it says so explicitly and edits `CLAUDE.md` in the
> same commit.

---

## How to use this document (guideline postępowania)

**Per-session loop:**

1. **Re-read `CLAUDE.md`** (Architecture & invariants + General rules) and the
   "Context hygiene" section. Those rules win over anything here.
2. **Pick the first task** whose status is `[ ]` and whose listed
   *dependencies* are all `[x]`. Don't skip ahead past an unmet dependency —
   several Phase-0 lint rules only stay green once an earlier fix lands.
3. Read **only** the files the task names (use `Grep`/`Glob` + ranged `Read`).
   Don't slurp whole large files.
4. **Implement** the smallest change that satisfies the task's *Acceptance*
   bullets. Resist scope creep — extra cleanup belongs in its own task; add it
   to the Backlog instead of folding it in.
5. **Verify** before committing:
   - `npm run test` — must be green (truncate output: capture the summary line
     only, e.g. `… | Select-String "Test Files|Tests |FAIL"`).
   - `npm run typecheck` — must exit 0.
   - From Phase 0 onward, also `npm run lint` — must exit 0.
6. **Commit** with a Conventional Commit message (`fix:`/`feat:`/`refactor:`/
   `chore:`/`test:`/`docs:`). One task = one logical commit (a task may be a
   couple of commits if large, but never bundle two tasks).
7. **Mark the task** in this file (`[ ]` → `[x]`), fill its **Done:** line with
   the date + short commit subject, and **commit that doc change** (can ride
   along in the task's commit, or a trailing `docs:` commit). Add anything you
   discovered-but-didn't-do to the **Backlog**.
8. Update `CHANGELOG.md`'s `[Unreleased]` section **only** for user-visible
   behavior changes. Pure refactors/tests/tooling usually need no changelog
   entry. Do **not** run `npm run release` as part of this plan — releases are
   a separate, deliberate act (see `CLAUDE.md`).

**Status legend:** `[ ]` todo · `[~]` in progress (note who/when) ·
`[x]` done (fill the **Done:** line) · `[!]` blocked (note why on a **Blocked:**
line) · `[-]` dropped (note why; keep for history).

**Golden rules for this refactor specifically:**

- **No behavior change unless the task says so.** Phases 0–2 are
  behavior-preserving by design; tests must pass *without being weakened*. If a
  test needs editing, it's because an *interface* moved (e.g. an import path),
  not because behavior changed.
- **Don't break a green build to make a point.** When a new lint rule would
  flag existing code, add the rule **in the same commit** that fixes the last
  violation it covers (see G1 sub-steps), so `main`/the branch never goes red.
- **Each task is independently revertable.** If something feels like it needs
  three other tasks to land first, recheck the dependency list — maybe the
  ordering is wrong; fix the plan rather than smushing tasks together.
- **Prefer existing mechanisms.** This whole plan is largely "use the thing we
  already built": `gameDom.js`, `fleetProtocol.js`'s event pattern,
  `lib/persist.js`, `shared/fleetCourier.js`. Reach for those before inventing.

---

## Progress snapshot

| Phase | Theme | Tasks | Done |
|-------|-------|-------|------|
| 0 | Gates (tooling that locks invariants in) | 2 | 2 / 2 |
| 1 | Invariant violations (highest value) | 3 | 3 / 3 |
| 2 | Contract unification & dedup | 5 | 5 / 5 |
| 3 | Structural (parity, pure-core, test isolation) | 4 | 2 / 4 |
| 4 | Low-cost polish | 4 | 3 / 4 |
| 5 | Documentation reduction (DRY for docs) | 5 | 0 / 5 |

> Update the "Done" column whenever a task flips to `[x]`.

---

## Session resume — read this first (2026-06-13)

**Phases 0, 1, 2 are COMPLETE** (Gates, invariant violations, contract
unification). Phase 3 `S3` + `S4` and Phase 4 `P1` are also done. Everything is
merged to `main`; the branch and `main` are green (`npm run test` 1388, plus
`typecheck` + `lint`).

**Next unblocked task — pick one (all deps met):**

1. **Phase 4 `P2`/`P4`** · *recommended next* · **no deps**, small, no in-game
   behaviour change (`P2` ntfy missing-id logging; `P4` `stampFsRoutesChanged`
   flush). Safe to do blind. (`P3` rename depends on `C1`, which is done.)
2. **Phase 5 docs DRY** (`D1`→`D5`, `D1` first — it defines D2–D5). No code
   change; pure docs work.
3. **`S1` — `sendExp/domHelpers.js`** (then **`S2`**, which depends on S1).
   Both touch **behaviour-critical fleetdispatch** — the plan asks for an
   in-game smoke test (`verify` skill) after S2. Do these when you can verify
   in-game, not blind.

**Housekeeping available (Backlog):** now that Phases 0–2 have landed, the
"compact `REFACTOR.md`'s own task format" item is ripe — a future session may
collapse the finished tasks' verbose bodies to one-line summaries (the
per-task **Done:** lines + the Decision log hold the durable record). Left
undone deliberately so it's a conscious choice, not a side effect.

---

## Phase 0 — Gates

*Goal: turn the prose invariants in `CLAUDE.md` into mechanical checks so none
of the fixes below can silently regress. Do this first — every later phase
benefits.*

### `[x]` G1 — ESLint flat config enforcing the dependency direction
- **Severity:** high · **Size:** M · **Risk:** low · **Deps:** none
- **Why:** The layering invariants (no feature→feature, bridge→lib-only,
  domain has no DOM/chrome) are honor-system today. A linter makes them
  un-violable and would have caught I1 automatically.
- **What:**
  1. Add `eslint` + `eslint-plugin-import` (and `@eslint/js`) as devDeps; add
     `eslint.config.mjs` (flat config, ESM, matches repo module style).
  2. Baseline rules first (must pass on current tree as-is): recommended JS
     rules, `no-unused-vars`, `import/no-unresolved`, `import/no-cycle`.
  3. Add `import/no-restricted-paths` zones encoding the diagram. Add each
     zone **only once its violations are zero**:
     - `domain/**` may not import `state|features|sync|bridges` (and add a
       `no-restricted-globals` for `document|window|localStorage|chrome|
       setTimeout|setInterval` inside `domain/**`). → should be green now.
     - `lib/**` may not import `domain|state|features|sync|bridges`. → green now.
     - `features/**/X` may not import `features/**/Y` (cross-feature). `shared`
       is allowed. → green now (review found zero violations).
     - `bridges/**` may not import `state|features|sync`. → **goes green only
       after I1**. Land this specific zone in the I1 commit, not here.
  4. Add `"lint": "eslint ."` (and `"lint:fix"`) to `package.json` scripts.
- **Acceptance:** `npm run lint` exits 0 on the current tree with all zones
  above *except* the `bridges→state` one (deferred to I1). `domain` globals
  rule is active and green.
- **Note for executor:** if `import/no-restricted-paths` proves fiddly with
  flat config, `eslint-plugin-boundaries` is an acceptable alternative — pick
  whichever expresses the zones cleanly; document the choice in a config comment.
- **Done:** 2026-06-13 — `chore: add ESLint flat config enforcing layering`.
  `eslint.config.mjs` with `eslint-plugin-import` `no-restricted-paths` zones
  (domain, lib, and programmatic per-feature cross-feature zones built from the
  `src/features` listing) + `no-restricted-globals` for `domain/**`. Pinned
  `eslint@^9` (eslint-plugin-import peer maxes at 9). Notes for later tasks:
  (1) **bridges→state zone deferred to I1** as planned — no `bridges` zone exists
  yet, so I3's "bless bridges→domain" is automatically satisfied (nothing
  restricts bridges today). (2) `except` in `no-restricted-paths` is resolved
  **relative to `from`**, not cwd — feature zones use `['./<name>', './shared']`.
  (3) `no-redeclare` is set `{ builtinGlobals: false }` so the repo's per-file
  `/* global … */` annotations don't collide with our configured browser/
  webextension globals. (4) **Enabled `no-console` for `src/**`** (beyond the
  listed baseline): the codebase was already littered with
  `eslint-disable-next-line no-console` for a never-configured rule, so turning
  it on makes those opt-outs meaningful and routes logging through `lib/logger`
  (its single `console[level]` sink got the one sanctioned disable). Tests/
  scripts use console freely. Small lint-clean fixes rode along (all
  behavior-preserving): removed dead imports/vars (`TARGET_PLANET`, `coordKey`,
  `sysDist`, test `vi`/`beforeEach`/`afterEach`/`BASE`/`entry`), an unnecessary
  regex escape in `badges.js`/`readabilityBoost.test.js`, trimmed unused
  `/* global */` names (chrome/browser/CustomEvent are read via `globalThis`,
  not as bare idents), added a `// falls through` marker to the intentional
  `sendLifeform` switch fall-through, dropped a stale `no-constant-condition`
  disable, and removed 8 stale `@typescript-eslint/no-explicit-any` file-level
  disables (that plugin is not configured).

### `[x]` G2 — CI workflow (test + typecheck + lint)
- **Severity:** low · **Size:** S · **Risk:** none · **Deps:** G1
- **Why:** The "must be green before commit" bar lives only in `CLAUDE.md`
  prose. Mechanize it.
- **What:** Add `.github/workflows/ci.yml`: on `pull_request` + `push`, Node
  from `.nvmrc` (see P1), `npm ci`, then `npm run test`, `npm run typecheck`,
  `npm run lint`. No deploy/release steps.
- **Acceptance:** Workflow file present and valid; jobs run all three commands.
  (Can't fully verify without pushing — keep it minimal and standard.)
- **Done:** 2026-06-13 — `chore: add CI workflow (test + typecheck + lint)`.
  `.github/workflows/ci.yml` on push + pull_request: checkout, setup-node with
  `node-version-file: .nvmrc` (+ npm cache), `npm ci`, then `npm run test`,
  `npm run typecheck`, `npm run lint`. No build/deploy/release steps. YAML
  validated locally; first real run happens on push.

---

## Phase 1 — Invariant violations (highest value, mostly mechanical)

### `[x]` I1 — Move shared key constants to `lib/`; kill `bridges → state`
- **Severity:** high · **Size:** S · **Risk:** low · **Deps:** none (do early)
- **Why:** `bridges/sendFleetHook.js:51` imports `REGISTRY_KEY` from
  `state/registry.js`, and `bridges/deployRedirect.js:48` imports
  `FS_REDIRECT_KEY` from `state/fsRoutes.js`. Both `state/` modules run a
  top-level `createStore(...)` (`registry.js:60`, `fsRoutes.js:143`) and
  `fsRoutes.js:32` imports `chromeStore`. Importing the const evaluates the
  whole module, dragging store machinery + a `chrome.storage` reference into
  the **MAIN-world** page bundle, where `chrome.*` doesn't exist. The comment
  in `sendFleetHook.js:36-43` claiming "a bare string constant with no side
  effects" is factually wrong. This violates `bridges → lib only`.
- **What:**
  1. Create `src/lib/storageKeys.js` exporting `REGISTRY_KEY` and
     `FS_REDIRECT_KEY` (move the canonical string definitions here; pure
     consts, no imports).
  2. `state/registry.js` and `state/fsRoutes.js` re-export the key from
     `lib/storageKeys.js` (keep the named export so existing isolated-world
     importers don't change).
  3. `bridges/sendFleetHook.js` and `bridges/deployRedirect.js` import the key
     from `lib/storageKeys.js`. Update the now-stale comments.
  4. Keep `deployRedirect.js`'s `export { FS_REDIRECT_KEY }` re-export (its
     test/consumers rely on it) — just source it from `lib/`.
  5. **Add the `bridges → state` zone to ESLint** (the one deferred from G1).
- **Acceptance:** No `import ... from '../state/...'` remains in `bridges/**`.
  `npm run lint` green with the bridges→state zone active. Existing bridge
  tests pass unchanged (behavior identical). Bundle no longer references
  `chrome.storage` via these paths (spot-check `dist/page.js` after a build if
  convenient — build is free, `dist/` is gitignored).
- **Done:** 2026-06-13 — `refactor(bridges): source shared storage keys from
  lib/storageKeys.js`. New `src/lib/storageKeys.js` owns `REGISTRY_KEY` +
  `FS_REDIRECT_KEY` (pure consts, no imports). `state/registry.js` and
  `state/fsRoutes.js` now re-export from lib (isolated-world importers
  unchanged); `bridges/sendFleetHook.js` + `bridges/deployRedirect.js` import
  from lib and their stale "bare const from state/" comments are corrected.
  Added the `bridges → state` ESLint zone (deferred from G1) — forbids
  `./src/state` from `./src/bridges`. Left the broadening to `features|sync`
  and the CLAUDE.md doc reconciliation to **I3** (kept I1 in scope). No
  `from '../state/` remains in bridges/; lint/typecheck/test all green
  (1365 tests).

### `[x]` I2 — Centralize duplicated game selectors in `gameDom.js`
- **Severity:** high · **Size:** M · **Risk:** low · **Deps:** none
- **Why:** The "every game selector used by 2+ features lives in one place"
  invariant is partly broken. Several selectors are re-hardcoded inline, and
  some **already exist in `GAME`** but aren't used.
- **What:** For each selector below, ensure a single `GAME.*` entry exists in
  `src/lib/gameDom.js` and replace inline literals with imports:
  | Selector | Already in GAME? | Re-hardcoded at | Action |
  |----------|------------------|-----------------|--------|
  | `#dispatchFleet` | ✅ `FD_DISPATCH` (gameDom.js:103) | `sendExp/index.js:439,544,617`; `fsCollect/domHelpers.js:38` | use `GAME.FD_DISPATCH` |
  | `#allresources` | ✅ `FD_ALL_RESOURCES` (gameDom.js:107) | `fsCollect/domHelpers.js:36`; `fleetdispatchShortcut.js:64` | use `GAME.FD_ALL_RESOURCES` |
  | `#eventContent` | ✅ `EVENT_CONTENT` (gameDom.js:68) | `badges.js:286` (`getElementById('eventContent')`) | use `GAME.EVENT_CONTENT` |
  | `#sendall` | ❌ | `fsCollect/domHelpers.js:32`; `fleetdispatchShortcut.js:75` | add `GAME.FD_SEND_ALL`, import both |
  | `#diameterContentField` | ❌ | `colonyRecorder.js:155,255`; `abandon/index.js:210` | add `GAME.DIAMETER_FIELD`, import both |
  | `a.moonlink` / moon img | ❌ | `planetBarCapture.js:75`; `fsCollect/domHelpers.js:126` | add `GAME.MOON_LINK` (+ `MOON_IMG` if needed), import both |
- **Also (med, optional within this task):** the mission-type event-row
  selector is hand-composed in `badges.js:187`, `sendExp/index.js:174`,
  `fsCollect/domHelpers.js:41`, `reminders/producer.js:79`. Consider a
  parameterized helper `eventFleetRows(missionType)` next to
  `GAME.EVENT_FLEET_ROWS`. If it gets messy, split into its own Backlog task —
  don't block I2 on it.
- **Leave local (do NOT hoist):** single-feature selectors stay put per
  CLAUDE.md rule 1 — `rewardingWatcher` (`#rewardings` etc.), `traderMenuHighlight`
  overlay selectors, `settingsUi` AGR selectors, `readabilityBoost`
  `#eventboxFilled`, abandon's `.errorBox`/`#abandonplanet`. OG-E's own
  `oge-*` ids never go in `gameDom.js`.
- **Acceptance:** Each of the 6 selectors appears as a string literal in
  exactly one place (`gameDom.js`). Grep for each raw literal outside
  `gameDom.js` → only matches are the verbatim-misspelling docs. Tests +
  typecheck green. No behavior change.
- **Done:** 2026-06-13 — `refactor: centralize shared game selectors in
  gameDom.js`. Used existing `GAME.FD_DISPATCH` / `FD_ALL_RESOURCES` /
  `EVENT_CONTENT` at the re-hardcoded sites; added `GAME.FD_SEND_ALL`,
  `GAME.DIAMETER_FIELD`, `GAME.MOON_LINK`. Converted the `getElementById('id')`
  call sites to `querySelector(GAME.X)` (behavior-equivalent) to match the
  repo's `document.querySelector(GAME.*)` convention. All 6 literals now exist
  as code strings only in `gameDom.js` (verified by grep; remaining matches are
  doc comments). `moonlink`'s moon-image part (`img.icon-moon`, one feature)
  stays local — composed as `${GAME.MOON_LINK} img.icon-moon`. Optional
  `eventFleetRows(missionType)` helper deferred to Backlog (already listed).
  lint/typecheck/test all green (1365). No behavior change.

### `[x]` I3 — Reconcile `bridges → domain` doc vs. reality
- **Severity:** med · **Size:** S · **Risk:** none · **Deps:** none
- **Why:** `CLAUDE.md`'s diagram says `bridges → lib only`, but bridges import
  pure `domain/` helpers (`galaxyHook.js:31` `classifyPosition`;
  `sendFleetHook.js:49-50`; `deployRedirect.js:47`; `expeditionRedirect.js:55`
  `MISSION_*`). Domain is pure, so this is safe — but doc and code disagree.
- **What:** Amend `CLAUDE.md` to bless `bridges → lib + domain` (domain is
  pure; this is the intended reality). Update the ASCII diagram + the bridges
  bullet. Reflect the same allowance in the ESLint bridges zone (G1/I1): forbid
  `state|features|sync`, **allow** `domain|lib`.
- **Acceptance:** `CLAUDE.md` and the ESLint config agree. No code change.
- **Done:** 2026-06-13 — `docs: bless bridges → lib + domain (I3)`. Updated the
  `CLAUDE.md` ASCII diagram (`bridges → lib + domain`, must not import
  `state/features/sync`) and the bridges bullet (domain is pure, safe across
  the world boundary; key strings in `lib/storageKeys.js`; enforced by lint).
  Broadened the ESLint `bridges` zone from just `state` (I1) to
  `state/features/sync`, leaving `domain`/`lib` allowed. No code change;
  lint + typecheck green.

---

## Phase 2 — Contract unification & deduplication

### `[x]` C1 — Central `oge:*` event-name registry
- **Severity:** med · **Size:** M · **Risk:** low · **Deps:** none
- **Why:** ~13 event names are bare string literals on both dispatch and listen
  sides across ~20 files; a typo silently no-ops (CustomEvents never throw on a
  missing listener). `lib/fleetProtocol.js:15-25` already proves a central
  registry works across the world boundary — extend that pattern.
- **What:** Create `src/lib/ogeEvents.js` exporting consts for every name:
  `GALAXY_SCANNED`, `COLONIZE_SENT`, `CHECK_TARGET_RESULT`, `FLEET_DISPATCHER`,
  `EVENT_BOX_LOADED`, `TRADER_BID_PLACED`, `TRADER_IMPORT_TRADED`,
  `SYSTEM_DISCOVERY_RESULT`, `SYNC_STATUS`, `SYNC_FORCE`, `NTFY_CHECK_NOW`,
  `DAILY_STATE_CHANGED`. Leave the three fleet-protocol names
  (`oge:fd:cmd`, `oge:fd:res`, `oge:sendFleetResult`) in `fleetProtocol.js` and
  **re-export them from `ogeEvents.js`** so there's one import surface.
  Replace literals in producers (bridges, state, settingsUi) and consumers
  (features, content.js). Note: some consumers reference names via config
  (`controls.js` `refreshEvent`, e.g. `settingsUi/sections/reminders.js:160`) —
  route those through the const too.
- **Acceptance:** Grep `oge:` string literals in `src/` → only `gameDom.js`-style
  docs and the two `lib/` registry files. Tests + typecheck green.
- **Note:** This touches bridges (MAIN world) — `lib/ogeEvents.js` must stay
  dependency-free (it already would be: just consts). Confirms G1 lib zone.
- **Done:** 2026-06-13 — `refactor: central oge:* event-name registry
  (lib/ogeEvents.js)`. New `lib/ogeEvents.js` defines all 12 event names and
  re-exports the three fleet-protocol names from `fleetProtocol.js` (one import
  surface). Removed every bare literal AND the scattered local `const X_EVENT =
  'oge:…'` definitions (`discoveryHook`, `scheduler` FORCE_SYNC, `gist`
  SYNC_STATUS, `dailyActions`, `scans`, `settingsUi/reminders`); all
  producers/consumers now import from `ogeEvents` (config `refreshEvent` sites
  in `settingsUi/sections/{reminders,sync}.js` too). **Naming deviation
  (intentional):** kept the `_EVENT` suffix on every export (e.g.
  `GALAXY_SCANNED_EVENT`, `SYNC_FORCE_EVENT`) rather than the bare names listed
  above — matches the re-exported `FD_*_EVENT` names and the existing codebase
  convention, and meant most importers only changed *path*, not identifier.
  `FORCE_SYNC_EVENT` → `SYNC_FORCE_EVENT` (the one rename) updated at its 2 sites
  + its test. Two tests re-pointed to import the const from `ogeEvents` (interface
  moved); all the wire-string literal assertions in tests were left intact —
  they pin the contract. Grep: no `'oge:` code literal outside the two `lib/`
  registry files. lint (incl. `no-cycle`) + typecheck + test (1365) all green.

### `[x]` C2 — Extract shared `fakeXhr` test helper
- **Severity:** med · **Size:** M · **Risk:** none · **Deps:** none
- **Why:** 11 bridge tests each redefine a `fakeXHR` helper
  (`galaxyHook.test.js:~24` literally comments "Mirrors the helper in
  xhrObserver.test.js"). 11 copies of fragile prototype-patching drift.
- **What:** Create `test/helpers/fakeXhr.js` (one round-trip through the
  patched XHR prototype: `open`/`send`/set `responseText`+`readyState`/dispatch
  `load`). Replace the inline copies in the 11 bridge tests. Match the most
  complete existing copy's capabilities so no test loses coverage.
- **Acceptance:** No `class FakeXHR`/`function fakeXHR` defined inside
  `test/bridges/*`. All bridge tests import the shared helper and pass.
- **Done:** 2026-06-13 — `test: extract shared fakeXhr round-trip helper
  (test/helpers/fakeXhr.js)`. One low-level helper `fakeXHR(url, { method, body,
  responseText, status })` (superset of all the per-file copies; returns the
  xhr after `load` + a microtask). **9** bridge tests now use it: `xhrObserver`
  imports it directly; `galaxyHook`/`traderActionHook`/`eventBoxHook` keep a
  thin local wrapper that pins method/positional shape; `discoveryHook`/
  `checkTargetHook`/`sendFleetResultHook` keep a wrapper carrying their
  JSON-stringify + invalid-JSON-sentinel shaping; `fleetDispatcherSnapshot`'s
  `fireCheckTarget` and `sendFleetHook`'s `setupScene` delegate too. No
  round-trip is re-implemented in `test/bridges/*` anymore. **Deliberately left
  inline (not copies of the helper):** `sendFleetHook`'s mutate-between-send-
  and-load case (timing test — needs a split round-trip), `xhrObserver`'s
  double-`load` `{ once:true }` case, `deployRedirect`'s send-only sims, and
  `expeditionRedirect`'s send-only `fakeSendFleetXHR` + `overrideResponseText`
  tests. typecheck/lint/test (1365) green; no assertion weakened.

### `[x]` C3 — Factor the per-universe key resolver
- **Severity:** low · **Size:** S · **Risk:** low · **Deps:** none
- **Why:** `currentScansKey` (scans.js:120), `currentBodiesKey`,
  `currentFsRoutesKey`, `currentHistoryKey`, `currentColPositionsKey`
  (settings.js) all reimplement the same
  `typeof location==='undefined' ? BASE : (parseUniverseId(host) ? keyFor(id) : BASE)`.
- **What:** Add a small helper (e.g. `state/universeKey.js` or in
  `lib/universeId.js`) `currentUniverseKey(baseKey, keyForId)`; collapse all
  five call sites to one-liners.
- **Acceptance:** One implementation of the fallback; five call sites use it.
  Tests + typecheck green.
- **Done:** 2026-06-13 — `refactor(state): factor the per-universe key resolver`.
  New `state/universeKey.js` exports `currentUniverseKey(baseKey, keyForId)`
  with the single `typeof location==='undefined' → base | parse → keyFor(id) |
  base` fallback. Collapsed `currentScansKey` / `currentBodiesKey` /
  `currentFsRoutesKey` / `currentHistoryKey` / `currentColPositionsKey` to
  one-liners; also collapsed the **6th** identical instance —
  `stampFsRoutesChanged`'s inline timestamp-key resolution — which let
  `parseUniverseId`'s import drop from all five store modules (it now lives only
  in `universeKey.js`; the remaining mentions are `{@link}` JSDoc). Put the
  helper in `state/` not `lib/universeId.js` because it reads the `location`
  global and that file's contract is "no DOM access". lint/typecheck/test (1365)
  green; no behavior change.

### `[x]` C4 — Unify the state test-reset convention
- **Severity:** low · **Size:** S · **Risk:** low · **Deps:** none
- **Why:** `bodies.js:210` and `fsRoutes.js:257` ship `_reset*ForTest`;
  `registry/history/scans/settings` expose only `dispose*Store`. Two
  conventions for the same need.
- **What:** Pick one (recommend: keep `dispose*Store` everywhere, since tests
  already use it + explicit `store.set`, and drop the two `_reset*ForTest`
  — OR add `_reset*ForTest` to all five). Document the chosen convention in a
  one-line note in `CLAUDE.md`'s state bullet. Update tests that referenced the
  removed name.
- **Acceptance:** All five store modules expose the same reset surface; tests
  green.
- **Done:** 2026-06-13 — `refactor(state): standardize stores on dispose*Store
  teardown (drop the two _reset*ForTest)`. Took the task's recommended path
  (dispose-only is the majority — scans/registry/history/settings already do
  `disposeXStore() + store.set(...)` inline). Removed `_resetBodiesStoreForTest`
  and `_resetFsRoutesStoreForTest`; their 4 test files now dispose + set the
  initial value inline (both empties are trivial literals — `{ bodies: [],
  capturedAt: 0 }` / `{ routes: [], collectTarget: null }`). Documented the
  convention in `CLAUDE.md`'s state bullet: stores expose only
  `dispose*Store()`; `_reset*ForTest` is a *feature* affordance, not a store
  one. lint/typecheck/test (1365) green.

### `[x]` C5 — Document (or migrate) the non-store state modules
- **Severity:** med · **Size:** S (document) / L (migrate) · **Deps:** none
- **Why:** `state/dailyActions.js` and `state/lifeformArtifacts.js` are plain
  `read*/write*` helpers over `safeLS` — no `createStore`/`persist`. This is an
  undocumented exception to "mutate state ONLY through reactive stores."
- **What (choose the cheap path first):** Add a sanctioned-exception note in
  `CLAUDE.md` ("plain key-owner modules: read/write helpers with no reactive
  store, used where a store subscription would be overkill or would pull the
  store layer somewhere it can't go — list the two modules"). Only migrate to
  `createStore` if a real consumer needs reactivity (track as a separate
  Backlog task if so).
- **Acceptance:** `CLAUDE.md` describes the exception and names both modules;
  no behavior change.
- **Done:** 2026-06-13 — `docs: sanction the plain key-owner state modules
  (C5)`. Took the cheap path: added a "Sanctioned exception — plain key-owner
  modules" note to `CLAUDE.md`'s state bullet naming `state/dailyActions.js`
  and `state/lifeformArtifacts.js` (confirmed: plain `read*/write*` over
  `safeLS`, no `createStore`/`persist`). Rationale recorded: nothing subscribes
  to them, so a reactive store would be overhead; migrate only if a consumer
  needs reactivity. No code change.

---

## Phase 3 — Structural (larger; one PR each)

### `[ ]` S1 — Give `sendExp` a `domHelpers.js` (sibling parity)
- **Severity:** med · **Size:** M · **Risk:** med (touches a 748-line file) · **Deps:** I2 (selectors centralized first)
- **Why:** `sendCol` and `sendLifeform` both split DOM reads into
  `domHelpers.js`; `sendExp/index.js` (748L) folds them inline (151-213,
  415-545). Accidental divergence; hurts testability.
- **What:** Extract `sendExp/domHelpers.js` mirroring the sibling shape (pure
  DOM read/click helpers, importing selectors from `gameDom.js`). Move the
  inline DOM helpers there; `index.js` imports them. Add a focused test if the
  helpers carry logic.
- **Acceptance:** `sendExp/` shape matches `sendCol`/`sendLifeform`; tests +
  typecheck green; no behavior change.
- **Done:**

### `[ ]` S2 — Consolidate the "advance native fleetdispatch" sequence
- **Severity:** med · **Size:** M · **Risk:** med · **Deps:** I2, S1
- **Why:** The "click select-all ships → click all-resources → dispatch"
  fleetdispatch-wizard sequence is partially re-encoded in
  `fleetdispatchShortcut.js:61-75`, `fsCollect/domHelpers.js` (`selectAllShips`
  /`loadAllResources` ~209-215), and `shared/fleetCourier.js`. Three partial
  copies.
- **What:** Define the canonical step helpers in `shared/fleetCourier.js`
  (using `GAME.FD_*`), have the other two call sites use them. Don't over-
  abstract — expose the small steps the callers actually share.
- **Acceptance:** One implementation of each FD step; the three sites import it;
  tests green. Manual smoke per `verify` skill recommended (fleetdispatch is
  behavior-critical).
- **Done:**

### `[x]` S3 — Extract `scheduler/pure.js` decision core
- **Severity:** med · **Size:** L · **Risk:** med · **Deps:** none
- **Why:** `sync/scheduler.js` (909L) mixes the lock/debounce/anti-loop
  *decision* logic (the `changed`-flag gating, ~lines 28-46) with store/network
  I/O. CLAUDE.md's pure-core rule applies past ~400 lines.
- **What:** Extract a pure module: given `{inFlight, changed, lastSyncAt, ...}`
  decide `schedule | skip | writeNow`. Unit-test it. `scheduler.js` keeps the
  timers/subscriptions and calls the pure core. (`ntfyScheduler`'s
  `reconcileWaveQueue` set-diff is a similar, smaller candidate — separate
  Backlog task.)
- **Acceptance:** A tested `scheduler/pure.js`; `scheduler.js` shrinks and
  delegates decisions; behavior unchanged (existing scheduler tests green).
- **Done:** 2026-06-13 — `refactor(sync): extract scheduler/pure.js decision
  core`. New `src/sync/scheduler/pure.js` (zero I/O) holds the gating
  predicates: `canStartSync({cloudSync,hasToken,inFlight})` (folds the two
  shared download/upload entry guards), `shouldScheduleUpload({cloudSync,
  applying})` (the subscription-handler gate + `applying*FromSync` anti-loop),
  `slotHasData`/`dailyStateHasData` (no-op-PATCH guards), and `sameJSON` +
  `gistIsCurrent` (the skip-PATCH "gist already matches" check, moved out of
  `scheduler.js`). `scheduler.js` now delegates at all six sites; behaviour
  identical. New `test/sync/scheduler/pure.test.js` (21 cases) drives each
  predicate directly in node-env; existing `scheduler.test.js` (19) unchanged
  and green. test 1388 / typecheck / lint all green.

### `[x]` S4 — Dashboard test-isolation: resets
- **Severity:** med · **Size:** S · **Risk:** low · **Deps:** none
- **Why:** `dashboard/index.js:185` `installDashboard` holds ~10 module-level
  `let`s + cached element refs (369-385) but ships no `_resetDashboardForTest`.
  `dashboard/reminders.js:83` sets `wired = true` and never resets it, so a
  second install in a fresh test is a silent no-op. Violates the uniform
  "each install ships a `_reset*ForTest`" rule.
- **What:** Add `_resetDashboardForTest` (null cached refs, re-init the `let`s)
  and a reset for `dashboard/reminders.js`'s `wired` (+ `getActiveUniverseId`).
  Consider `dashboard/routes.js` too (currently relies on DOM presence).
- **Acceptance:** Re-installing the dashboard in a test starts clean; add a
  test asserting double-install idempotency. Tests green.
- **Done:** 2026-06-13 — `test(dashboard): add reset affordances + install
  idempotency coverage`. Added `_resetRemindersForTest` to `dashboard/
  reminders.js` (clears `wired`, the `el` ref cache, and `getActiveUniverseId`)
  and `_resetDashboardForTest` to `dashboard/index.js` (re-inits the ~7
  module-level `let`s, nulls the wireDom-cached DOM refs + `weightSliders`/
  `weightValues`, and delegates to the reminders reset). New
  `test/features/dashboard/remindersInstall.test.js` proves install wires the
  copy-topic listener exactly once, a second install is a no-op while wired,
  and the reset re-opens the gate so a fresh install re-wires (the exact
  silent-no-op the reset prevents). **`dashboard/routes.js`: nothing to reset**
  — it has no module-level mutable state / `wired` guard (rebuilds DOM each
  `installRoutes` call, relies on DOM presence). +2 tests (1367 total);
  lint/typecheck green.

---

## Phase 4 — Low-cost polish (do anytime; no deps unless noted)

### `[x]` P1 — Align `.nvmrc` with documented Node line
- **Severity:** low · **Size:** S · **Deps:** none (do before G2 ideally)
- **Why:** `.nvmrc` pins `24.7.0` while `engines` says `>=20`, REVIEWERS.md
  says tested on 20.x/22.x, AMO notes say `>=20`. `.nvmrc` is ahead of every
  tested line.
- **What:** Set `.nvmrc` to a tested LTS (22) — or, if 24 is intentionally the
  dev target, add it to REVIEWERS.md's tested list. Keep CI (G2) reading
  `.nvmrc` so they can't drift again.
- **Acceptance:** `.nvmrc`, `engines`, REVIEWERS.md, AMO notes tell one story.
- **Done:** 2026-06-13 — `chore: pin .nvmrc to Node 22 (a tested LTS line)`.
  `.nvmrc` `24.7.0` → `22`. Now consistent: `engines` `>=20`, REVIEWERS tested
  on 20.x/22.x, AMO notes `>=20`, dev/CI pin on the tested `22` line. Done
  ahead of G2 so CI reads a tested `.nvmrc`.

### `[x]` P2 — Surface ntfy publish failures
- **Severity:** low · **Size:** S · **Deps:** none
- **Why:** ntfy POSTs have no backoff (gist does, in `gist.js:400-435`), and
  `ntfyScheduler.js:376` does `res.json().catch(() => ({}))` — a parse failure
  on a 2xx POST yields `{ id: undefined }`, silently orphaning a scheduled
  message (the exact failure the module exists to prevent).
- **What:** Log (via `lib/logger`) when `id` is absent after a 2xx POST.
  Optionally surface a 429 so the caller can defer. At minimum, document
  "ntfy: no backoff, relies on next reconcile" in the module header.
- **Acceptance:** Missing-`id`-after-2xx is logged; header documents the
  no-backoff design. Add a behavioral test for the missing-id log if cheap.
- **Done:** 2026-06-13 — `feat: log ntfy missing-id orphans; document no-backoff
  design (P2)`. The missing-id branch already *threw* (the review's silent
  `{id:undefined}` had since been hardened to a throw); P2 makes it **visible**:
  it now `logger.warn`s the 2xx-but-no-id anomaly before throwing — the message
  scheduled on ntfy but we lost its cancellation handle, a latent orphan the
  next reconcile re-discovers by title (keep if it still matches a live slot,
  cancel otherwise). Added a "No backoff (by design)" section to the module
  header contrasting with `gist.js`'s backoff and explaining the reconcile loop
  IS the recovery mechanism. New behavioral test asserts the warn fires (and the
  throw propagates) on a 2xx publish with no id. test 1389 / typecheck / lint
  green. No CHANGELOG entry — diagnostic logging only, no user-visible behaviour
  change (logger is off by default).

### `[ ]` P3 — Rename `ntfyScheduler.js` → `ntfyReconciler.js`
- **Severity:** low · **Size:** S · **Risk:** low (rename + import updates) · **Deps:** C1 (settle imports first to avoid churn collisions)
- **Why:** It's not a timer-based scheduler — it's a stateless queue reconciler
  against ntfy's `X-Delay` server-side queue. The name invited the "two
  schedulers, merge them" question this whole review was built around (and the
  answer was no). Rename to stop re-inviting it.
- **What:** `git mv` the file, update all imports (see review: `reminders/
  producer.js:60`, `reminders/eventList.js:61`, `settingsUi/sections/
  reminders.js:41`, `dashboard/reminders.js:37`, `ntfyAccount.js:26`,
  `sync/reminders.js`), rename its test file, update header doc.
- **Acceptance:** No `ntfyScheduler` path remains; tests + typecheck green.
- **Done:**

### `[x]` P4 — Make `stampFsRoutesChanged` flush (close the debounce race)
- **Severity:** low · **Size:** S · **Deps:** none
- **Why:** `state/fsRoutes.js:231-235` writes a timestamp key directly while the
  routes value itself saves on a `DEBOUNCE_MS` debounce. A caller that mutates
  routes, stamps, then navigates away can land the timestamp while the routes
  value is still in the debounce timer.
- **What:** Have `stampFsRoutesChanged` call `flushFsRoutesStore()` first, or
  document the flush requirement in its JSDoc and at known call sites.
- **Acceptance:** Stamp can't outrun the routes write; tests green.
- **Done:** 2026-06-13 — `fix: flush fsRoutes value before stamping its sync
  clock (P4)`. `stampFsRoutesChanged` is now `async` and `await`s
  `flushFsRoutesStore()` before writing the timestamp, so the routes value is
  guaranteed on disk before the clock advertises "changed" — closing the race
  where a stamp+navigate could land the newest ts over a still-debounced (lost)
  routes value. This fixes the `planetBarCapture` prune path automatically (it
  stamped right after a debounced `update` with no flush); the `fsCollect`
  set-target path already flushed explicitly and is left as-is (idempotent
  same-value write, kept as local documentation of intent). New behavioral test
  asserts the two writes fire in order — routes value first, timestamp second.
  test 1390 / typecheck / lint green. No CHANGELOG entry — internal correctness
  fix with no user-visible behaviour change.

---

## Phase 5 — Documentation reduction (DRY for docs)

*Goal: fewer, leaner, non-overlapping docs. The fix is mostly "one source of
truth per topic; everything else links." Tasks here are deliberately terse —
practicing the principle. Behavior never changes; verify the release script
still works where a task touches release inputs.*

### `[ ]` D1 — Add the doc-hygiene rule to `CLAUDE.md`
- **Severity:** med · **Size:** S · **Deps:** none (do first — defines D2–D5)
- **Why:** No rule currently keeps docs DRY; topics are re-stated across 5+
  files. Codify canonical homes + the living-plan lifecycle.
- **What:** Add a short "Documentation hygiene" rule under General rules:
  each topic has ONE source of truth, others link not re-state. Canonical:
  build→`REVIEWERS.md`; release→`CLAUDE.md`; architecture invariants→`CLAUDE.md`;
  privacy/permissions→`PRIVACY.md`; user-visible changes→`CHANGELOG.md`. Plan
  docs (`REFACTOR.md`, feedback plans) are archived/deleted when their cycle
  closes. **Scope:** this DRY rule governs the standalone docs only — it does
  **not** apply to in-code comments. Those document reverse-engineered game
  behavior (OG-E has no access to the game's source/docs) and are a primary
  knowledge asset; the rule must say so explicitly so no one trims them under
  a "DRY docs" banner.
- **Acceptance:** Rule present and ≤ ~8 lines, with the in-code carve-out. No
  code change.
- **Done:**

### `[ ]` D2 — De-duplicate across docs per the canonical homes
- **Severity:** med · **Size:** M · **Deps:** D1
- **Why:** Build steps live in 5 files; release workflow, architecture, privacy,
  and compliance each appear in 2–3. (Confirmed: build steps in README,
  CONTRIBUTING, REVIEWERS, CLAUDE.md, amo-reviewer-notes.)
- **What:** For each duplicated block, keep the canonical copy and replace the
  others with a one-line link:
  - Build steps → keep in `REVIEWERS.md`; README/CONTRIBUTING link to it.
  - Release workflow → keep in `CLAUDE.md`; `CONTRIBUTING §Release workflow`
    shrinks to a pointer.
  - Architecture → keep invariants in `CLAUDE.md`; `README §Architecture` stays
    only as the friendly 5-min intro (no invariant restatement);
    `CONTRIBUTING §Purity` points to `CLAUDE.md`.
  - Compliance → one home (`REVIEWERS §Compliance summary`); CONTRIBUTING links.
  - Privacy/permissions → keep in `PRIVACY.md`; README/CLAUDE/amo-notes link.
- **Acceptance:** Each topic's full text exists once; greps for "npm run
  build:prod", release-step lists, permission lists return one canonical hit +
  links. `amo-reviewer-notes.txt` already points to REVIEWERS — keep that.
- **Done:**

### `[ ]` D3 — Compact `CLAUDE.md` itself
- **Severity:** med · **Size:** S · **Deps:** D1
- **Why:** `CLAUDE.md §AMO note fields` quotes `amo-reviewer-notes.txt`
  **verbatim** (the file is the source of truth — the script reads it). The
  release-preview footgun is explained at length. Audit every rule for "does
  this still earn its place / can it be tighter."
- **What:** Replace the verbatim AMO boilerplate with a one-line pointer to
  `amo-reviewer-notes.txt`. Tighten the release-preview footgun to the
  essential warning + the one working preview command (keep the "why" — it
  bit us). Drop any rule that's now dead or covered by ESLint (G1) — e.g. a
  layering rule the linter now enforces can compress to "(enforced by lint)".
- **Acceptance:** `CLAUDE.md` is meaningfully shorter with **no invariant
  lost**; every remaining rule is load-bearing. (Sanity: line count drops; the
  Architecture & invariants section is untouched in substance.)
- **Done:**

### `[ ]` D4 — Archive old CHANGELOG entries
- **Severity:** low · **Size:** S · **Deps:** none
- **Why:** `CHANGELOG.md` is 1485 lines / 49 versions back to 1.0.0
  (2026-04-24). The release script only reads the current `## [X.Y.Z]` section,
  so archiving old entries is safe.
- **What:** Move entries below a cutoff (suggest **pre-1.10.0**) to
  `docs/CHANGELOG-archive.md`; leave a "older releases → docs/CHANGELOG-archive.md"
  link at the bottom of `CHANGELOG.md`. Keep `[Unreleased]` + recent versions.
- **Acceptance:** Active `CHANGELOG.md` is short; archive holds the rest;
  `npm run release` preview still finds the current-version section (verify
  with the preview command from `CLAUDE.md`, NOT a real release).
- **Done:**

### `[ ]` D5 — Living-plan lifecycle (FEEDBACK-PLAN + this file)
- **Severity:** low · **Size:** S · **Deps:** D1 · **may be Blocked**
- **Why:** `docs/FEEDBACK-PLAN.md` (987L) is 52/62 tasks in `REVIEW` at the
  current version (1.17.0) — a nearly-closed cycle. Per D1, closed plans get
  archived/deleted, not kept forever. Same eventually applies to `REFACTOR.md`.
- **What:** When the FEEDBACK-PLAN REVIEW items are user-verified + a release
  ships, archive it to `docs/plans/` (or delete — it's in git history). Until
  then, add a one-line lifecycle note at its top. Apply the same "archive when
  done" note to `REFACTOR.md`.
- **Blocked:** on user in-game verification of the REVIEW items — until then
  only the lifecycle note is actionable.
- **Done:**

---

## Backlog (discovered but not yet planned)

*Add items here as you find them; promote to a phase when prioritized.*

- Parameterized `eventFleetRows(missionType)` helper if I2's optional part is
  deferred (4 hand-composed copies of the mission-type row selector). **[still
  open — I2 deferred this optional part.]**
- Two more selectors re-hardcoded next to ones I2 touched but NOT in I2's
  table, so left for a follow-up: `getElementById('planetList')`
  (`badges.js:285`) while `GAME.PLANET_LIST` exists; `getElementById(
  'continueToFleet2')` (`fsCollect/domHelpers.js` `ID_CONTINUE`) while
  `GAME.FD_CONTINUE` exists. Both are used by 2+ features → fold into a small
  follow-up like I2.
- Coordinate-string normalizers duplicated across features (`badges.trimCoords`,
  `sendExp.stripBrackets`, `reminders.denseCoords`, `fsCollect.parseCoordsText`)
  — check whether one `domain`/`lib` helper covers them.
- `ntfyScheduler.reconcileWaveQueue` set-diff → small pure extraction + test.
- Behavioral tests for `dashboard/galaxy.js` (563L) and `dashboard/freeStreak.js`
  (342L) — render-layer coverage gap CLAUDE.md flags as "dashboard I/O".
- Behavioral test for `settingsUi/controls.js` (692L, largest untested file).
- Shared `chrome.storage` test fake (inconsistent: `vi.stubGlobal` vs hand-
  assigned `chrome = {}` across test files).
- Consider a `makePersistedStore({store, load, save, debounceMs})` factory to
  collapse the repeated init/dispose boilerplate across 5 store modules (judgment
  call — current form is readable).
- **Comments are NOT a reduction target — they are a primary asset.** OG-E is
  absolutely dependent on a game whose source and docs we do **not** have. The
  scattered in-code comments are reverse-engineered knowledge about the game's
  processes, goals, data shapes, and dependencies — knowledge that exists
  *nowhere else*. The ~53% comment density is therefore expected and valuable.
  Do **not** sweep, trim headers, or "tighten" comments as a goal. The only
  comments safe to remove are ones that restate the JavaScript language itself
  (e.g. `// loop over the array`). When in doubt, **keep**. This item exists to
  forbid the trim, not to schedule it.
- **Compact `REFACTOR.md`'s own task format** once Phases 0–2 land — the cold-
  pickup verbosity earns its place now, but finished phases can collapse to a
  one-line "done" summary to keep this file lean (eat our own dog food).

---

## Decision log

*Record any choice that future sessions shouldn't relitigate.*

- 2026-06-13 — Plan created from the architecture review. Headline non-finding:
  `scheduler.js` and `ntfyScheduler.js` are **not** duplicate schedulers and
  must **not** be merged (different mechanisms; one backoff, in `gist.js`).
- 2026-06-13 — `oge:ntfyCheckNow` is **not** a dead event (initial review
  suspicion); it's consumed via `controls.js` `refreshEvent` wiring
  (`controls.js:431,537`). No fix needed beyond folding it into C1's registry.
- 2026-06-13 — Doc landscape audited (Phase 5 added). Confirmed duplication:
  build steps in 5 files; release/architecture/privacy/compliance each in 2–3;
  `CLAUDE.md` quotes `amo-reviewer-notes.txt` verbatim. CHANGELOG 1485L/49
  versions; FEEDBACK-PLAN 987L at 52/62 REVIEW. Principle adopted: one source of
  truth per topic, others link; plan docs have a lifecycle.
- 2026-06-13 — G1 landed. Chose `eslint-plugin-import` (not
  `eslint-plugin-boundaries`) for the zones. Pinned `eslint@^9` (plugin-import
  peer caps at 9). **Enabled `no-console` for `src/**`** as part of G1 even
  though it's beyond the listed baseline rules — the repo already carried
  `no-console` disable directives for an unconfigured rule, so enabling it makes
  them meaningful and enforces the `lib/logger` sink. Tests/scripts are exempt.
- 2026-06-13 — **C1 event registry uses the `_EVENT` suffix** on every export,
  deviating from the bare names the task text listed (`GALAXY_SCANNED`, …). Two
  reasons: (1) the three re-exported fleet-protocol names already carry `_EVENT`
  (`FD_CMD_EVENT`), so a suffix-less set would make `ogeEvents.js` internally
  inconsistent; (2) all pre-existing exported event consts already used the
  suffix, so keeping it meant importers changed only their *path*, not the
  identifier — smaller, safer diff. Don't "fix" this back to bare names.
- 2026-06-13 — **In-code comments are off-limits to reduction (user-confirmed).**
  OG-E depends entirely on a game with no available source or docs; the
  scattered comments are reverse-engineered knowledge (game processes, goals,
  data shapes, dependencies) with no other home. The ~53% comment density is
  expected and valuable. The Phase-5 DRY-for-docs work targets standalone
  `.md`/`.txt` files only — never in-code comments.
- 2026-06-13 — **Session milestone: Phases 0–2 complete + `S4` + `P1`.** Landed
  `I1`/`I2`/`I3` (invariant violations), `C1`–`C5` (contract unification), and
  `S4` (dashboard test-isolation) in one session — each its own commit, gates
  green throughout (test 1365→1367, typecheck, lint). Merged to `main`. Next
  unblocked: `S3` (no deps, safe pure-logic refactor) is the recommended pick;
  `S1`/`S2` touch behaviour-critical fleetdispatch and want an in-game smoke
  test, so defer until verifiable in-game. See "Session resume" near the top.
  `C4` chose dispose-only stores; `C2` kept domain-specific test wrappers
  delegating to one shared `fakeXhr`; `C3` factored `state/universeKey.js`.
