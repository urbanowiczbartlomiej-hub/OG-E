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
2. **Settings clean split** — give every setting exactly ONE home. AGR keeps
   quick in-game essentials + credentials; config-heavy options move to a new
   Dashboard *Settings* tab.
3. **README marketing refresh** — benefit-led, user-facing, every
   user-visible feature covered; dev sections kept but pushed lower.

## Decisions locked (2026-06-15 session)

- **Settings model:** *clean split, one home each.* No option editable in
  two places.
- **Stays in AGR (quick essentials + credentials):** floating button
  (on/off + size), credentials (gist PAT, ntfy token), master switches
  (cloud-sync, reminders), display toggles (readability, event/trader
  highlights).
- **README:** keep everything in one file; lead with marketing, dev
  sections lower down. (No move to CONTRIBUTING.md.)

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
  label). Keep all three — they're at different context depths — but make
  sure wording agrees after the settings split (Workstream B may relabel).
- Audit the **Reminders tab** intro (`src/dashboard.html:346-352`): today it
  says setup "lives in the OG-E settings panel inside the game." After B this
  becomes partly false (schedules/thresholds move here) — update copy as part
  of B6, not now.
- Pass over every intro paragraph and tooltip for residual references to
  features/labels that have since been renamed; fix verbatim.

**Deliverable:** one `docs:`/`fix:` commit touching `dashboard.html` +
`features/dashboard/*` strings. No logic change. Tests/typecheck/lint green.

---

## Workstream B — Settings clean split *(the core work; multi-commit)*

### Stay vs. move (the 21 AGR fields)

| Field (storage key) | Today | Decision |
|---|---|---|
| `oge_fabMode` | AGR | **STAY** (FAB essential) |
| `oge_fabBtnSize` | AGR | **STAY** |
| `oge_cloudSync` (master) | AGR | **STAY** |
| `oge_gistToken` (credential) | AGR | **STAY** |
| sync status (read-only) | AGR | **STAY** (also already surfaced) |
| `oge_remindersMasterEnabled` | AGR | **STAY** (master) |
| `oge_reminderNtfyToken` (credential) | AGR | **STAY** |
| ntfy account status + topic (read-only) | AGR | **STAY** |
| `oge_readabilityBoost` | AGR | **STAY** (display) |
| `oge_eventMenuHighlight` | AGR | **STAY** (display) |
| `oge_traderMenuHighlight` | AGR | **STAY** (display) |
| `oge_expeditionBadges` | AGR | **MOVE → Dashboard** |
| `oge_autoRedirectExpedition` | AGR | **MOVE** |
| `oge_maxExpeditionsPerPlanet` | AGR | **MOVE** |
| `oge_colonyMinGap` | AGR | **MOVE** |
| `oge_colonyMinFields` | AGR | **MOVE** |
| `oge_colonyPassword` | AGR | **OPEN** — it's a password (credential). Lean **STAY** in AGR with the other credentials; confirm before B3. |
| `oge_reminderEnabled` (exp-wave sub-enable) | AGR | **MOVE → Reminders tab** |
| `oge_reminderWaveOffsets` (schedule) | AGR | **MOVE → Reminders tab** |
| `oge_adhocOffsetSec` | AGR | **MOVE → Reminders tab** |
| `oge_fsEnabled` | AGR | **MOVE → Reminders tab** |
| `oge_fsThreshold` | AGR | **MOVE → Reminders tab** |
| `oge_fsMinFlightSec` | AGR | **MOVE → Reminders tab** |
| `oge_fsReminderOffsets` (schedule) | AGR | **MOVE → Reminders tab** |

Net effect: **AGR shrinks to** FAB (2) + sync master+token+status +
reminders master+token+status + 3 display toggles (+ maybe colony password)
— i.e. "turn features on, paste credentials." All *tuning* lives in the
Dashboard. The Reminders tab gains its own config (it already shows the
queue, so config + observability finally live together).

### Core technical constraint (the reason this is the big lift)

`state/settings.js` persists every field to **`localStorage` under the
`oge_` prefix** — and in the content script that's the **game-page origin's**
localStorage. The Dashboard is a separate extension page with its **own**
localStorage; it cannot see those keys (it doesn't even import the settings
store today). This is exactly why per-universe config (`galaxyScanConfig`,
`scans`, `bodies`, `dailyRunRoutes`) already lives in **`chrome.storage.local`**
— that's the only backing shared across both the content script and the
Dashboard page.

**Therefore every MOVED setting must migrate `localStorage` →
`chrome.storage.local`**, with:

- a one-time migration that reads the old `oge_*` localStorage value and
  seeds the new chrome.storage key (then the old key can be ignored/cleared);
- consuming features switching from synchronous `safeLS` reads to the
  **async-init store pattern already used by `scanConfig`** (init returns a
  promise / store hydrates async; features must tolerate the pre-hydrate
  default for one tick);
- moved settings stay **global** (not universe-scoped) — chrome.storage keys
  without the `<universeId>:` prefix.

Settings that **STAY** in AGR are untouched (still localStorage). No mirror,
no dual-write.

### Phasing for B

- **B1 — migration infra.** A small global-settings store backed by
  `chrome.storage.local` (mirror the `scanConfig` store shape) + a
  localStorage→chrome.storage seed-once migration. Unit + behavioral tests.
- **B2 — Expeditions category.** Move the 3 expedition settings onto B1's
  store; switch `badges` / `sendExpedition` consumers to the async store;
  drop those fields from the AGR expeditions section.
- **B3 — Colonization category.** Same for min-gap / min-fields (resolve the
  `colonyPassword` open question first).
- **B4 — Reminders detail.** Move sub-enables + schedules + fleet-save
  thresholds; keep master + token in AGR.
- **B5 — Dashboard *Settings* tab.** New tab in `dashboard.html` /
  `features/dashboard/` rendering the moved settings (Expeditions /
  Colonization groups) + fold reminder config into the existing Reminders
  tab. Behavioral tests for the editor (write → store → persisted value).
- **B6 — Slim the AGR panel + signposts.** Remove moved fields from AGR
  sections; where useful leave a one-line "Configured in the Dashboard →"
  link. Update the Reminders-tab intro copy (the Workstream-A item deferred
  to here).

Each B-step is its own `feat:`/`refactor:` commit; `npm run test` +
`typecheck` + `lint` green before each (architecture invariants: stores own
persistence; features stay independent; no cross-feature imports).

---

## Workstream C — README marketing refresh

Keep one file. Target structure:

1. **Hook** (keep the "calm UI + zero automation" framing — it's good).
2. **Features — benefit-led.** One line per feature: *the problem it solves*,
   not the implementation. Cover the currently-missing user-visible ones:
   **Send Lifeforms**, **Daily Run / fleet-save**, **event & trader menu
   highlights**, **expedition badges**, **fleet-dispatch keyboard shortcut**.
   Keep passive/internal modules (planet-bar capture, colony recorder,
   rewarding watcher, anti-flicker) out of the headline list or mention
   lightly.
3. **De-jargon pass:** `499-pixel maps` → "galaxy preview maps";
   `checkTarget`/`colPositions`/`usedFields` → plain language; "gist" →
   "your own private GitHub gist (cross-device sync)"; "ntfy topic" → "a push
   notification to your phone."
4. **Fix the stale Dashboard description:** tabs are Colony Sizes / Galaxy
   Observations (incl. Colony Scout) / Reminders / **Daily Run** — current
   text lists "Free Positions" and omits Daily Run.
5. **"Where settings live"** short note — finalize AFTER B lands: AGR =
   essentials + credentials, Dashboard = detailed config. (Draft a
   placeholder now; fill in once B6 is merged.)
6. **Dev sections** (Install / Development / Debug flags / Architecture) —
   keep, but below the user-facing content.
7. Leave a marker for screenshots (AMO assets are a later, separate effort).

**Deliverable:** one `docs:` commit. Can mostly proceed independently of B;
only the "where settings live" note waits on B6.

---

## Suggested path order

1. **A** — dashboard copy review (quick win, no deps).
2. **C** — README refresh, minus the settings-location note (independent).
3. **B1 → B6** — the settings split, one category per commit.
4. **C follow-up** — fill in the "where settings live" note after B6.
5. *(Later, out of scope here)* AMO listing copy + screenshots.

## Open questions to resolve before the relevant step

- **`colonyPassword`** — stay in AGR (credential) or move with colonization?
  Lean stay. *(Blocks B3.)*
- Should the Dashboard *Settings* tab and the Reminders-tab config be **two
  surfaces** or should all moved settings sit under one *Settings* tab with
  the Reminders tab staying read-only? Current lean: reminder *config* folds
  into the Reminders tab (config + queue together); everything else under a
  new *Settings* tab. *(Blocks B5.)*
