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
| 0 | Gates (tooling that locks invariants in) | 2 | 0 / 2 |
| 1 | Invariant violations (highest value) | 3 | 0 / 3 |
| 2 | Contract unification & dedup | 5 | 0 / 5 |
| 3 | Structural (parity, pure-core, test isolation) | 4 | 0 / 4 |
| 4 | Low-cost polish | 4 | 0 / 4 |

> Update the "Done" column whenever a task flips to `[x]`.

---

## Phase 0 — Gates

*Goal: turn the prose invariants in `CLAUDE.md` into mechanical checks so none
of the fixes below can silently regress. Do this first — every later phase
benefits.*

### `[ ]` G1 — ESLint flat config enforcing the dependency direction
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
- **Done:**

### `[ ]` G2 — CI workflow (test + typecheck + lint)
- **Severity:** low · **Size:** S · **Risk:** none · **Deps:** G1
- **Why:** The "must be green before commit" bar lives only in `CLAUDE.md`
  prose. Mechanize it.
- **What:** Add `.github/workflows/ci.yml`: on `pull_request` + `push`, Node
  from `.nvmrc` (see P1), `npm ci`, then `npm run test`, `npm run typecheck`,
  `npm run lint`. No deploy/release steps.
- **Acceptance:** Workflow file present and valid; jobs run all three commands.
  (Can't fully verify without pushing — keep it minimal and standard.)
- **Done:**

---

## Phase 1 — Invariant violations (highest value, mostly mechanical)

### `[ ]` I1 — Move shared key constants to `lib/`; kill `bridges → state`
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
- **Done:**

### `[ ]` I2 — Centralize duplicated game selectors in `gameDom.js`
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
- **Done:**

### `[ ]` I3 — Reconcile `bridges → domain` doc vs. reality
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
- **Done:**

---

## Phase 2 — Contract unification & deduplication

### `[ ]` C1 — Central `oge:*` event-name registry
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
- **Done:**

### `[ ]` C2 — Extract shared `fakeXhr` test helper
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
- **Done:**

### `[ ]` C3 — Factor the per-universe key resolver
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
- **Done:**

### `[ ]` C4 — Unify the state test-reset convention
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
- **Done:**

### `[ ]` C5 — Document (or migrate) the non-store state modules
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
- **Done:**

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

### `[ ]` S3 — Extract `scheduler/pure.js` decision core
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
- **Done:**

### `[ ]` S4 — Dashboard test-isolation: resets
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
- **Done:**

---

## Phase 4 — Low-cost polish (do anytime; no deps unless noted)

### `[ ]` P1 — Align `.nvmrc` with documented Node line
- **Severity:** low · **Size:** S · **Deps:** none (do before G2 ideally)
- **Why:** `.nvmrc` pins `24.7.0` while `engines` says `>=20`, REVIEWERS.md
  says tested on 20.x/22.x, AMO notes say `>=20`. `.nvmrc` is ahead of every
  tested line.
- **What:** Set `.nvmrc` to a tested LTS (22) — or, if 24 is intentionally the
  dev target, add it to REVIEWERS.md's tested list. Keep CI (G2) reading
  `.nvmrc` so they can't drift again.
- **Acceptance:** `.nvmrc`, `engines`, REVIEWERS.md, AMO notes tell one story.
- **Done:**

### `[ ]` P2 — Surface ntfy publish failures
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
- **Done:**

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

### `[ ]` P4 — Make `stampFsRoutesChanged` flush (close the debounce race)
- **Severity:** low · **Size:** S · **Deps:** none
- **Why:** `state/fsRoutes.js:231-235` writes a timestamp key directly while the
  routes value itself saves on a `DEBOUNCE_MS` debounce. A caller that mutates
  routes, stamps, then navigates away can land the timestamp while the routes
  value is still in the debounce timer.
- **What:** Have `stampFsRoutesChanged` call `flushFsRoutesStore()` first, or
  document the flush requirement in its JSDoc and at known call sites.
- **Acceptance:** Stamp can't outrun the routes write; tests green.
- **Done:**

---

## Backlog (discovered but not yet planned)

*Add items here as you find them; promote to a phase when prioritized.*

- Parameterized `eventFleetRows(missionType)` helper if I2's optional part is
  deferred (4 hand-composed copies of the mission-type row selector).
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

---

## Decision log

*Record any choice that future sessions shouldn't relitigate.*

- 2026-06-13 — Plan created from the architecture review. Headline non-finding:
  `scheduler.js` and `ntfyScheduler.js` are **not** duplicate schedulers and
  must **not** be merged (different mechanisms; one backoff, in `gist.js`).
- 2026-06-13 — `oge:ntfyCheckNow` is **not** a dead event (initial review
  suspicion); it's consumed via `controls.js` `refreshEvent` wiring
  (`controls.js:431,537`). No fix needed beyond folding it into C1's registry.
