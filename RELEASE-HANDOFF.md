# RELEASE-HANDOFF — Danger-model v2 + Galaxy Viewer redesign

> **Transient plan doc** (per CLAUDE.md "Documentation hygiene"). Delete it once
> the release lands — git keeps the history. Written 2026-07-04.

This hands a **fresh session** everything needed to (1) reconcile the unit-test
suite and (2) cut the release for the large uncommitted change set produced over
2026-07-03…04. Per CLAUDE.md we deferred all test work during the build-and-verify
loop; this is the "reconcile once, at release time" step.

---

## 0. STOP — the working tree has UNRELATED concurrent work that does NOT compile

Before anything else, `npx tsc --noEmit` currently reports **~13 errors**, and
`npm run lint` reports errors — **all of them in files this change set never
touched**, from a *different, in-progress* effort in the same working tree:

- `src/features/sendColony/index.js`, `src/features/sendColony/pure.js`
  (param-ordering / `Set<string>` vs `number` signature mismatches)
- `test/features/sendColonyHelpers.test.js` (arg-count mismatches)
- lint: `writeDailyState` unused, `readImportNextAt` / `readAuctionQuietUntil`
  undefined (dailyActions / alarmClock area)
- other modified-but-not-ours files: `src/content.js`,
  `src/features/alarmClock/*`, `src/features/sendExpedition/index.js`,
  `src/features/shared/agrRoutine.js`, `src/lib/gameDom.js`

**None of these are part of the danger-model / Galaxy-Viewer work.** The
danger/GV files below are all tsc-clean on their own. But the release script
(`scripts/release.mjs`) runs `npm run test` **and** `npm run typecheck` as a hard
gate, so **the release is blocked until the concurrent work is also green.**

**Action:** confirm with the repo owner whether that concurrent work is meant to
ship in the same release. Either (a) it lands green first, or (b) it is stashed /
reverted so this feature release can go alone. Do **not** "fix" those files as
part of this handoff — they belong to another effort.

---

## 1. What shipped in this change set (context)

Two intertwined efforts, all in `src/`, all uncommitted:

- **Galaxy Viewer UX redesign** — chip-group controls (new
  `features/dashboard/chips.js`; select ids `freeZoneSelect`→`freeZoneChips`
  etc.), one config card, equal-height maps, inline accordion row expansion,
  grouped census (`buildScoreCards` → `buildCensusGroups`).
- **Danger model v2 (E0–E7)** — the big one:
  - `NEW src/domain/dangerScore.js` — per-player Danger `D` from the free
    whole-server feeds (ships / destroyed / honour / dispersion) + spy defence.
  - `src/domain/heatField.js` — threat field is now **per-player** (dedup across
    systems + capped presence bonus `presenceBonus`, exported).
  - `src/domain/cellClass.js` — threat intensity reads `ctx.danger` first.
  - `src/domain/zoneScore.js` — `adjustedThreatMean` ("Ignore worst") re-samples
    per-player to match the new field.
  - `src/domain/apiOccupancy.js` — `parseHighscore` reads the `ships` attribute.
  - `src/domain/espionageReport.js` — `SpyReport.timestamp` is now epoch
    **seconds** (was ms — a real bug); new `normalizeReportTimestamps`.
  - `src/domain/targets.js` — `TargetCandidate.ships/destroyedScore`;
    `buildTargetCandidates` `destroyed` feed; `sortTargetList` `danger`/`fleet`.
  - `src/features/apiContext/index.js` — 3 new feeds (economy/destroyed/lost),
    universe regen re-fetch, **per-feed resilience** (one feed failing no longer
    aborts the refresh).
  - `src/state/apiCache.js` — cache typedef gained the 3 feeds + `regenProbeTs`.
  - `src/state/targets.js` — applies `normalizeReportTimestamps` on hydrate.
  - `src/features/dashboard/{freeStreak,targets,index}.js` — the danger UI:
    D badges, "Top threats" panel, Spyglass fleet-finder columns
    (Danger/Fleet, `DEFAULT_TARGET_SORT` → `'danger'`), and the two-way
    map↔Spyglass deep-links.

The full per-stage narrative + rationale is in the memory file
`project_threat_model_v2.md` and `project_gv_ux_redesign.md`.

Every stage was **adversarially reviewed** (multi-agent) and its confirmed
findings fixed; the danger/GV files are tsc + lint clean.

---

## 2. Test reconciliation — the concrete work

Bring `npm run test` green. Inventory below (verify by running the suite; treat
as a map, not gospel).

### 2a. Tests that WILL fail and need updating

| Test file | Why it breaks | Fix |
|---|---|---|
| `test/features/apiContext.test.js` | Hard-codes the fetched-feed list `['universe','players','total','military','honor','server']` (6). Now **9** feeds (adds `economy`,`destroyed`,`lost`). | Update the expected feed list + any cold-cache count assertions. |
| `test/features/dashboard/freeStreak.test.js` | Heavy renderer rewrite: `buildScoreCards` removed → `buildCensusGroups`; detail is now an **inline accordion** (colspan row) not a bottom `detailHost`; `renderFreeRegions`/`renderServerMap` gained many params. Any import of `buildScoreCards`, any assertion on the old detail-at-bottom DOM, or the old `<select>` ids will fail. | Rewrite against the new DOM: accordion `tr.streak-detail`, census groups, `buildTopThreats`. Feed `danger`/`spied`/`onSelect` opts as needed. |
| `test/domain/heatField.test.js` | Threat magnitudes changed (per-position MAX → per-player dedup + presence bonus). Any test asserting an exact/relative threat value between clustered vs lone players will shift. Farm channel + output shape unchanged. | Re-baseline threat expectations; **add** a dedup case (one player, N nearby systems ≠ N×) and a two-different-players-sum case. |
| `test/state/apiCache.test.js` *(if it asserts the cache shape)* | New `economy`/`destroyed`/`lost` slots + `universe.regenProbeTs`. | Extend round-trip assertions. |

### 2b. New modules / exports with ZERO coverage — add tests

- **`src/domain/dangerScore.js`** — `buildDangerProfiles` is the algorithmic
  heart; **must** get a unit test. Cover: friendly → D 0; `ships===0` → D 0
  (turtle); ships-bounded mobile mil; spy-complete → exact + provenance
  `'spied'`; **stale-complete-spy below the ships floor stays `'ships'` not
  `'spied'`** (the E4 fix); bandit bonus; percentile predator; dispersion prior;
  `DANGER_LABELS` mapping. Pure function — easy to test with hand-built feeds.
- **`src/domain/espionageReport.js` `normalizeReportTimestamps`** — ms(>1e11)→s,
  seconds left as-is, malformed/null bucket passed through (not dropped),
  identity return when nothing changed.
- **`src/features/dashboard/chips.js`** — `chipValue`/`setChipValue`/`wireChips`/
  `setChipsEnabled` (happy-dom): value read/write, rejecting unknown values,
  click delegation, disabled group ignores clicks.
- **`src/domain/apiOccupancy.js`** — a `parseHighscore` case asserting `ships`
  is parsed when present and **absent = undefined** (not 0) on a military row;
  and that non-military feeds don't fabricate it.
- **`src/domain/targets.js`** — `sortTargetList` `'danger'`/`'fleet'` keys
  (null-sinks-to-bottom) + `buildTargetCandidates` ships (`?? 0`) / destroyed.
- **`src/domain/zoneScore.js`** — an `adjustedThreatMean` case with a **clustered
  excluded player** (several planets in-span) asserting the drop ≈ the field's
  single per-player term (not the old over-subtraction). This guards the E7 fix.
- `freeStreak.js` new exports (`buildTopThreats`, `highlightPin`,
  `resetFreeSelection`) — behavioural coverage where practical.

### 2c. Test hygiene notes (from CLAUDE.md)

- Pure/domain/state get unit tests; renderer/bridge get **behavioural** tests
  (drive DOM/fake-XHR, assert observable output — not internals).
- Tests are hermetic: `test/setup.js` neuters `fetch` + `XMLHttpRequest.send` —
  stub any request the code makes.
- Stress flaky timing tests with **one** looped vitest process, never a
  concurrent second suite (see memory `feedback_vitest_stress_single_process`).

---

## 3. Release procedure (only after §0 is resolved and §2 is green)

Per CLAUDE.md "Release checklist" — there is exactly ONE path:

1. **Reconcile tests** (§2) → `npm run test` green. Also `npm run typecheck` +
   `npm run lint` exit 0 (needs §0 resolved).
2. **Add a dated `## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md`** — sent
   verbatim as the AMO public release notes AND the publish trigger. This is a
   **minor** release (new user-visible features: danger model, Spyglass
   fleet-finder, Galaxy Viewer redesign): current `1.33.0` → **`1.34.0`**
   (unless the concurrent work claims that number — coordinate).
   Suggested highlights: per-player danger scoring (defence-aware, ships/kills),
   Spyglass whole-server fleet-finder (Danger/Fleet columns), Galaxy Viewer UX
   redesign (chips, inline detail, grouped census, Top-threats), map↔Spyglass
   links, API freshness two-clock + resilience, spy-report timestamp fix.
3. **Bump `"version"` to `1.34.0` in BOTH `package.json` AND `manifest.json`**
   (both currently `1.33.0`).
4. **Commit all three** (`CHANGELOG.md`, `package.json`, `manifest.json`) as
   `chore(release): 1.34.0` and **push to `main`**.
   - **This push = a public auto-updating release. CONFIRM WITH THE USER before
     pushing.**
   - `release.yml` ("Release to AMO") then mints the `v1.34.0` tag, re-runs the
     test + typecheck gate, packages `dist.zip` + `source.zip`, uploads to AMO.
   - Remote is **`urbanowiczbartlomiej-hub`**, not `origin`. `gh` is absent →
     monitor via the Actions REST API (see memory `feedback_release_amo_automation`).
   - Multi-line commit message → temp file, never chained with tag/push
     (memory `feedback_powershell_commit_hereshell`).
   - Before `git add`, check for files the user already staged (memory
     `feedback_git_add_staged_index_check`) — the tree is multi-author right now.

`amo-reviewer-notes.txt` (internal) is sent automatically by the script; edit it
there only if build steps/permissions changed (they didn't).

---

## 4. Known deferred (NOT release blockers, note in memory not CHANGELOG)

- Cross-system presence bonus is an approximation; `adjustedThreatMean` now
  mirrors it (E7 fix) but only for the excluded players' **in-span** planets
  (documented conservative under-correction).
- Routine tracker (per-player hourly snapshots) parked — passive growth of
  ships/military makes deltas ambiguous.
- Pre-existing: nothing else outstanding in the danger/GV surface.
