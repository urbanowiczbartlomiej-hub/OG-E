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
- **Colonization config → the Galaxy Observations tab**, which gets
  **renamed toward colonization** (scans were and still are mostly done for
  colonization; Colony Scout is a secondary use of the same data). Final name
  TBD — lean *"Colonization"*.

**Stays in AGR** (no home tab, or absolutely necessary): floating button
(on/off + size), display toggles (readability, event/trader highlights),
**all expedition settings** (no expeditions tab exists), cloud-sync master +
gist token, reminders **master** switch + **ntfy token** (token is required,
so it stays; add an annotation that the rest is configured in the Dashboard).

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

### Core technical constraint (the reason this is the big lift)

`state/settings.js` persists every field to **`localStorage` under the
`oge_` prefix** — in the content script that's the **game-page origin's**
localStorage. The Dashboard is a separate extension page with its **own**
localStorage; it cannot see those keys (it doesn't even import the settings
store). That's why per-universe config (`galaxyScanConfig`, `scans`,
`bodies`, `dailyRunRoutes`) already lives in **`chrome.storage.local`** — the
only backing shared across both worlds.

**Therefore every MOVED setting must migrate `localStorage` →
`chrome.storage.local`**, with:

- a seed-once migration reading the old `oge_*` localStorage value into the
  new chrome.storage key;
- consuming features switching from synchronous `safeLS` reads to the
  **async-init store pattern already used by `scanConfig`** (tolerate the
  pre-hydrate default for one tick);
- moved settings stay **global** (no `<universeId>:` prefix).

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

- **B1 — migration infra.** A global-settings store backed by
  `chrome.storage.local` (mirror the `scanConfig` store shape) + the
  seed-once localStorage→chrome.storage migration. Unit + behavioral tests.
- **B2 — Colonization tab.** Rename *Galaxy Observations* toward
  colonization; move min-gap / min-fields / password onto the B1 store;
  rewire the `sendColony` and `abandon` consumers to the async store. Update
  the tab's intro copy.
- **B3 — Reminders tab config.** Move sub-enables / schedules / thresholds
  onto the B1 store; build the friendly offset editor + extract the shared
  humanization helper; update the Reminders-tab intro (the A item deferred to
  here). Behavioral tests (edit → store → persisted value, and a fired push
  still reads correctly).
- **B4 — Slim the AGR panel.** Remove the 10 moved fields from their AGR
  sections; under the reminders master switch add a one-line "Configure
  schedules in the Dashboard → Reminders" annotation; keep the token. Verify
  nothing in AGR still reads a moved key.

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

1. **A** — dashboard copy review (quick win, no deps).
2. **C** — README refresh, minus the settings-location note + final tab name.
3. **B1 → B4** — the settings split.
4. **C follow-up** — fill in the "where settings live" note + tab name after B4.
5. *(Later, out of scope here)* AMO listing copy + screenshots.

## Open questions to resolve before the relevant step

- **Colonization tab name** — *"Colonization"* vs *"Galaxy / Colonization"*
  vs keeping "Galaxy Observations" with a colonization sub-heading. Lean
  *"Colonization"*. *(Blocks B2.)*
- Within the Colonization tab, do min-fields / password (abandon config) sit
  alongside min-gap, or visually grouped as an "Abandon small colonies"
  sub-block? Lean: one *Colonization config* block, abandon settings grouped
  under their own sub-heading. *(Cosmetic; resolve during B2.)*
