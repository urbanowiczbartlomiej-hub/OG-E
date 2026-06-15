# REFRESH-PLAN — dashboard copy, settings split, README

> **Lifecycle doc.** This is a plan we execute across several sessions as
> a path of small PRs. Delete it once the path closes (git keeps the
> history) — see CLAUDE.md §Documentation hygiene.

## Goal

Three connected clean-ups, driven by one observation: configuration is
scattered between the in-game **AGR settings panel** and the **Dashboard**
extension page, and the prose describing it (dashboard copy + README) has
drifted from what the code actually does.

1. **Dashboard copy review** — trim stale/redundant descriptions, fix
   what's drifted.
2. **Settings clean split** — give every setting exactly ONE home.
3. **README marketing refresh** — benefit-led, user-facing, every
   user-visible feature covered; dev sections kept but pushed lower.

## Decisions locked

**Settings model: clean split, one home each.** No option editable in two
places.

**Guiding rule (refined):** only the *absolutely necessary* lives in AGR —
master on/off switches, required credentials (tokens), and any option that
has **no natural home tab** in the Dashboard. Everything that's an *add-on
with a sensible default* moves to the **thematically-relevant existing
Dashboard tab**. **There is NO separate "Settings" tab in the Dashboard** —
moved options join the tab they belong to.

**Where moved options land:**

- **Reminders config → Reminders tab** (it already shows the queue; config +
  observability finally live together).
- **Colonization config → the Galaxy Observations tab** (scans are mostly
  done for colonization; Colony Scout is a secondary use of the same data).
  **Tab name stays "Galaxy Observations"** (decided) — colonization options
  enter as a *"Colonization config"* sub-section, not a rename.

**Stays in AGR** (no home tab, or absolutely necessary): floating button
(on/off + size), display toggles (readability, event/trader highlights),
**all expedition settings** (no expeditions tab exists), cloud-sync master +
gist token, reminders **master** switch + **ntfy token** (token is required,
so it stays; add an annotation that the rest is configured in the Dashboard).

**No data migration (decided).** OG-E has a single user today, so the moved
settings are NOT migrated from their old localStorage keys — on first run
after the move they fall back to defaults and get re-set once from the
Dashboard. Drops the seed-once migration code and its dashboard-first-write
race entirely.

**Max expeditions per planet → 1/2 radio (done).** Stays in AGR; the old
1–20 slider is replaced by a horizontal 1/2 radio — as a rule you shouldn't
run more than two from one planet. (New reusable `radio` control type in
`features/settingsUi/controls.js`.)

**README:** keep everything in one file; lead with marketing, dev sections
lower down.

---

## Workstream A — Dashboard copy review *(low risk, do first)*

The descriptions are mostly purposeful and current. Confirmed concrete fixes:

- The **tab set is** Colony Sizes / Galaxy Observations / Reminders / Daily
  Run (`src/dashboard.html:210-213`). Any copy that still references a
  separate *Free Positions* tab is stale — that view is now the *Colony
  Scout — settlement area analysis* sub-section under Galaxy Observations
  (`src/dashboard.html:270`).
- The "target positions / position filter" concept is explained in three
  places (Galaxy Observations intro, Galaxy-Scan config intro, filter-bar
  label). Keep all three — different context depths — but make wording agree
  after the rename/moves in B.
- The **Reminders tab** intro (`src/dashboard.html:346-352`) says setup
  "lives in the OG-E settings panel inside the game." After B this is partly
  false (config moves here) — update as part of B3, not now.
- **Surface the list/range syntax for positions.** The fields where users
  type planet positions (Galaxy-Scan config "Target positions"; Colony Scout
  "Slots") accept a comma list AND ranges — but the hint lives only in the
  tooltip today (`scanConfig.js` "A list or range, e.g. 8,10-12,15"; Colony
  Scout "Slots" "a list or range like 8 or 12-15"). Promote a short visible
  hint next to the field/placeholder, e.g. `e.g. 7-9, 15`, and keep the
  wording consistent across both fields.
- Pass over every intro paragraph and tooltip for references to
  features/labels since renamed; fix verbatim.

**Deliverable:** one `docs:`/`fix:` commit, strings only, no logic change.
Tests/typecheck/lint green.

---

## Workstream B — Settings clean split *(the core work; multi-commit)*

### Stay vs. move (the 21 AGR fields)

| Field (storage key) | Decision |
|---|---|
| `oge_fabMode`, `oge_fabBtnSize` | **STAY** (FAB; no home tab) |
| `oge_readabilityBoost` | **STAY** (display; no home tab) |
| `oge_eventMenuHighlight` | **STAY** (display; no home tab) |
| `oge_traderMenuHighlight` | **STAY** (display; no home tab) |
| `oge_expeditionBadges` | **STAY** (no expeditions tab) |
| `oge_autoRedirectExpedition` | **STAY** (no expeditions tab) |
| `oge_maxExpeditionsPerPlanet` | **STAY** (no expeditions tab) |
| `oge_cloudSync` (master) | **STAY** |
| `oge_gistToken` (credential) | **STAY** |
| `oge_remindersMasterEnabled` (master) | **STAY** + annotation "configure in Dashboard → Reminders" |
| `oge_reminderNtfyToken` (credential) | **STAY** (required) |
| sync status / ntfy status + topic (read-only) | **STAY** |
| `oge_colonyMinGap` | **MOVE → Colonization tab** |
| `oge_colonyMinFields` | **MOVE → Colonization tab** |
| `oge_colonyPassword` | **MOVE → Colonization tab** (abandon-of-small-colonies config) |
| `oge_reminderEnabled` (exp-wave sub-enable) | **MOVE → Reminders tab** |
| `oge_reminderWaveOffsets` (schedule) | **MOVE → Reminders tab** |
| `oge_adhocOffsetSec` | **MOVE → Reminders tab** |
| `oge_fsEnabled` | **MOVE → Reminders tab** |
| `oge_fsThreshold` | **MOVE → Reminders tab** |
| `oge_fsMinFlightSec` | **MOVE → Reminders tab** |
| `oge_fsReminderOffsets` (schedule) | **MOVE → Reminders tab** |

Net: **10 fields move** into 2 existing tabs; AGR keeps the 11 essentials.

### Core technical constraint + the storage model (DECIDED)

`state/settings.js` persists every field to **`localStorage` under the
`oge_` prefix** — in the content script that's the **game-page origin's**
localStorage. The Dashboard is a separate extension page with its **own**
localStorage; it cannot see those keys. That's why per-universe config
(`galaxyScanConfig`, `scans`, `bodies`, `dailyRunRoutes`) already lives in
**`chrome.storage.local`** — the only backing shared across both worlds.

The moved settings are ALSO **synced across devices** today (via
`sync/settingsSync.js`): some **per-universe** (colony*, `fs*`,
`reminderNtfyToken`…), some **global** (`reminderSchedule`, `reminderEnabled`,
`adhocOffsetSec`…). **Decision: preserve that — per-server stays per-server,
synced stays synced (no regression).** Consequence on the storage model:

- **Per-universe moved settings → fold into a per-universe `chrome.storage`
  store that is ALREADY dashboard-edited AND gist-synced**, i.e.
  `state/galaxyScanConfig.js`. Its gist merge is whole-slot newest-wins
  (`sync/merge.mergeGalaxyScanConfig`), so new fields ride along with **zero**
  sync wiring. This is exactly what B2 did for the colony* fields.
- **Global moved settings (reminder schedules/enables) → need a GLOBAL
  `chrome.storage` store wired into the GLOBAL gist sync path.** No such store
  exists yet; B3 must build it (or fold the global reminder fields into an
  existing global-synced surface). This is the genuinely new plumbing.
- **A global, UNSYNCED store is the wrong model** — an earlier B1 attempt
  built one (`state/sharedSettings.js`) and it was **reverted** because it
  fit nothing under this decision.
- No localStorage→chrome.storage migration (single user — see "No data
  migration"): moved fields start at defaults and get re-set once.

Settings that **STAY** in AGR are untouched (still localStorage). No mirror,
no dual-write.

### Reminders config UX (Reminders tab)

Build a **friendly offset editor** instead of a raw `-10m, 0m, 15m` text
field: per-entry rows with a human-readable impact preview ("10 min **before**
landing", "**at** landing", "15 min **after**"). The humanization already
exists for the push payload in `src/sync/ntfyReconciler.js:660-661`
(`min before landing` / `min after landing` / `landing now`) — **extract it
into a small pure `domain/` helper** and share it between the push text and
the editor preview (single source of truth, unit-testable). Offset parsing
lives in `src/domain/fleetSave.js`.

### Phasing for B

- **B1 — global shared-settings store. ❌ REVERTED.** Built a global, unsynced
  `chrome.storage` store (`domain/sharedSettings.js` + `state/sharedSettings.js`);
  removed once the "per-server + sync, no regression" decision landed (it fit
  nothing). Git history keeps it if a global-synced store ever wants a head
  start. The **`radio` control type** added alongside it survives (used by Max
  expeditions per planet).
- **B2 — Colonization config (Galaxy Observations tab). ✅ DONE.** Folded
  `colonyMinGap` / `colonyMinFields` / `colonyPassword` into the per-universe
  `galaxyScanConfig` (domain shape + defaults + normalize); added a
  "Colonization" sub-section to the dashboard scan-config editor
  (`features/dashboard/scanConfig.js`); rewired consumers
  (`sendColony/domHelpers.js`, `abandon/index.js`, `abandon/overview.js` —
  `checkAbandonState()` now reads `galaxyScanConfigStore`, overview subscribes
  to it too); removed the fields from `settings.js`, `settingsSync.js`
  (`UNIVERSE_SCOPED_SETTINGS`), and the AGR `colonization` section (deleted —
  it was only those three). Sync rides the existing whole-slot merge for free.
  Tests + typecheck + lint green.
- **B3 — Reminders tab config. ✅ DONE.** The hard one: the moved reminder
  fields split by scope (see the storage-model decision above). Decided at start:
  per-universe `fs*` **fold into `galaxyScanConfig`** (B2 worked example);
  global fields → a **new global synced `chrome.storage` store** (nothing global
  to fold into). Landing as coherent green sub-commits:
  - **B3a — `humanizeOffset` helper. ✅ DONE.** Extracted the landing-relative
    impact phrasing (`min before landing` / `landing now` / `…after landing`)
    from `ntfyReconciler.fsBody` into a pure `domain/duration.js` helper, shared
    by the push body and the upcoming offset-editor preview. Output unchanged.
  - **B3b — Per-universe `fs*` fold. ✅ DONE.** Folded `fsEnabled` / `fsThreshold`
    / `fsMinFlightSec` / `fsOffsets` into `galaxyScanConfig` (domain shape +
    defaults + normalize); removed from `settings.js` + `UNIVERSE_SCOPED_SETTINGS`;
    rewired the reminders consumers (`producer.js`, `eventList.js` now read +
    subscribe to `galaxyScanConfigStore`); removed the four AGR reminder sub-rows;
    added a plain `fs*` editor to the dashboard **Reminders tab**
    (`features/dashboard/reminderConfig.js`). Both that editor and the scan-config
    editor read-modify-write the shared slot so neither clobbers the other. Sync
    rides the existing whole-slot merge for free. Tests + typecheck + lint green.
  - **B3c — Global fields. ✅ DONE.** `reminderEnabled`, `reminderSchedule`,
    `adhocOffsetSec` moved to a NEW global (non-universe) `chrome.storage` store
    `state/reminderGlobalConfig.js` (pure shape/defaults/normalize in
    `domain/reminderGlobalConfig.js`), wired into the gist-sync path as its own
    SINGLE-slot newest-wins field (`sync/merge.mergeReminderGlobalConfig`,
    `GistPayload.reminderGlobalConfig`, scheduler read/write/merge in BOTH
    download + upload + `gistIsCurrent`/slot-has-data guard). Removed the three
    fields from `settings.js` + `SETTINGS_SCHEMA`; rewired `producer.js` /
    `eventList.js` to read + subscribe to `reminderGlobalConfigStore`; removed
    the AGR wave-enable / wave-schedule / ad-hoc rows (AGR now keeps only master
    + token + status, plus a one-line "configure in the Dashboard" signpost —
    most of B4). Added the wave/ad-hoc rows to the dashboard `reminderConfig.js`
    (a `save()` that writes BOTH the per-universe fs slot AND the global slot,
    each with its own ts + one shared sync poke). Tests + typecheck + lint green.
  - **B3d — Friendly offset editor. ✅ DONE.** Replaced the plain wave + fleet-save
    offset text fields with a per-entry ROW editor (`makeOffsetEditor` in
    `features/dashboard/reminderConfig.js`): one duration input per offset with a
    live plain-English impact preview, plus add/remove. The value still stores as
    a canonical minutes-first comma string. Previews use the pure
    `domain/duration.humanizeOffset` (landing-relative, fleet-save) and the new
    `humanizeReturnOffset` (after-return, wave) — same helpers the push body uses.
    Tests + typecheck + lint green.
  - Reminders-tab intro copy (deferred from Workstream A) — ✅ updated in B3c to
    say every schedule is configured in the Dashboard, only master+token in-game.
- **B4 — Slim the AGR panel + signposts. ✅ DONE (in B3c).** The AGR reminders
  section is now just the master switch + token + the read-only status rows, plus
  the one-line "Schedules + fleet-save config live in the OG-E Dashboard →
  Reminders" static signpost under the master switch. Nothing in AGR still reads a
  moved key (verified: `settings.js` no longer declares them; the only readers are
  the dashboard editor + the producer/eventList, which read the new stores).
  (Colonization AGR rows already gone in B2.)

Each B-step is its own `feat:`/`refactor:` commit; `npm run test` +
`typecheck` + `lint` green before each (architecture invariants: stores own
persistence; features stay independent; no cross-feature imports).

---

## Workstream C — README marketing refresh

Keep one file. Target structure:

1. **Hook** — keep the "calm UI + zero automation" framing.
2. **Features — benefit-led.** One line per feature: the *problem it solves*.
   Add the currently-missing user-visible ones: **Send Lifeforms**, **Daily
   Run / fleet-save**, **event & trader menu highlights**, **expedition
   badges**, **fleet-dispatch keyboard shortcut**. Keep passive/internal
   modules (planet-bar capture, colony recorder, rewarding watcher,
   anti-flicker) out of the headline list or mention lightly.
3. **De-jargon pass:** `499-pixel maps` → "galaxy preview maps";
   `checkTarget`/`colPositions`/`usedFields` → plain language; "gist" → "your
   own private GitHub gist (cross-device sync)"; "ntfy topic" → "a push
   notification to your phone."
4. **Fix the stale Dashboard description:** tabs are Colony Sizes /
   <renamed-colonization-tab> (incl. Colony Scout) / Reminders / **Daily
   Run** — current text lists "Free Positions" and omits Daily Run.
5. **"Where settings live"** short note — finalize AFTER B: AGR = enable
   switches + required tokens; the Dashboard tabs hold the detailed config
   (Reminders schedules in the Reminders tab, colonize/abandon thresholds in
   the Colonization tab). Draft a placeholder now; fill in after B4.
6. **Dev sections** (Install / Development / Debug flags / Architecture) —
   keep, below the user-facing content.
7. Leave a marker for screenshots (AMO assets are a later, separate effort).

**Deliverable:** one `docs:` commit. Mostly independent of B; only the "where
settings live" note + the tab name wait on B.

---

## Suggested path order

1. **A** — dashboard copy review. ✅ done.
2. **C** — README refresh (minus the settings-location note). ✅ done.
3. **B** — the settings split. B1 reverted; **B2 + B3 (B3a–B3d) + B4 ✅ done.**
4. **C follow-up** — fill in the "where settings live" README note. ⏳ NEXT.
5. *(Later, out of scope here)* AMO listing copy + screenshots.

## Where a fresh session should start

**Workstream C follow-up — the README "where settings live" note.** This is the
only thing left in this plan; once it lands, DELETE `REFRESH-PLAN.md` (its cycle
is closed — git keeps the history; see CLAUDE.md §Documentation hygiene).

The settings split is finished: AGR now holds only master on/off switches +
required credentials (gist token, ntfy token) + display toggles + all expedition
settings; every detailed config lives in the Dashboard tabs:

- **Reminders tab** — wave enable/schedule + ad-hoc lead time (global, in
  `reminderGlobalConfig`) and the per-server fleet-save knobs (in
  `galaxyScanConfig`), both via the per-entry offset editor.
- **Galaxy Observations tab** — target positions + rescan policy + the
  colonize/abandon thresholds (per-server, in `galaxyScanConfig`).

Concretely: write the short **"Where settings live"** section in `README.md`
(point 5 of Workstream C — AGR = enable switches + required tokens; the Dashboard
tabs hold the detailed config), then delete this plan doc. Nothing else in B/C
remains.

## Open questions — resolved

- Within the Colonization config sub-section, abandon settings (min-fields /
  password) sit under their own sub-heading inside one *Colonization config*
  block. *(Resolved in B2.)*
