# Targets (hidden-fleet finder) — roadmap

Transient plan doc — delete when this feature's cycle closes (git keeps the
history). Background + locked design live in the AI memory
(`project_target_finder`); this file is just the remaining build sequence,
grounded in file:line so any session can pick it up cold.

## Status (2026-06-25 · branch `feat/hidden-fleet-targets` · commit `ec7180e`)

**DONE & browser-verified:**

- **M1** — "Targets" sub-tab under Colonizations: universe-wide active-player
  list from the already-cached OGame highscore API (military + total), filtered
  (drop vacation/banned/inactive/admin/own-ally + noob-protection points band),
  sorted by military, with rank/points columns.
- **M2** — DOM ingestion of spy reports + per-player hidden-fleet estimate with
  `spied / total` coverage and a ⏱ provisional marker.

**Reused** (no new network fetching): `features/apiContext` cache
(`players`/`total`/`military`/`universe.xml`), dashboard render scaffolding.
**New code:** `domain/{unitCosts,espionageReport,threatModel,targets}.js`,
`state/targets.js`, `features/targetsIngest/`, `features/dashboard/targets.js` +
wiring in `content.js` / `dashboard.html` / `features/dashboard/index.js`.

## Hard-won facts (do NOT re-derive)

- The messages component fetches the inbox via **`fetch()`**, not
  `XMLHttpRequest` — so `observeXHR` can't see it. Ingestion is a **DOM
  MutationObserver** on `.rawMessageData` (`features/targetsIngest`). (Galaxy
  data still uses `observeXHR` because `fetchGalaxyContent` IS an XHR.)
- **HTML lowercases attribute names** → reading `data-raw-*` via `element.dataset`
  yields lowercase keys (`data-raw-playerName` → `playername`,
  `targetPlayerId` → `targetplayerid`). `domain/espionageReport.js` reads every
  field lowercase.
- The espionage tab also lists **proximity "spotted near you" alerts** that share
  the `rawMessageData` shape but describe OUR planet (carry `sourceplayerid`,
  `defensevalue='-'`). `isEspionageReportBag` rejects them; it also skips moons
  (`targetplanettype === '3'`) — planets only.
- The inbox **LIST renders every report's `rawMessageData` into the DOM at once**,
  so opening the Szpiegostwo tab bulk-ingests — no need to open each report.
- **Hidden fleet** = `militaryScore(API) − Σ(defenseValue + visibleFleetValue)/1000`
  over the player's spied planets. The base-cost table is validated (it
  reproduces a report's `data-raw-defenseValue` to the resource). Coverage
  denominator = the player's planet count from `universe.xml`.
- **Deep-link to pre-arm a fleet** is built by `domain/ogameUrl.js`
  `ingameComponentUrl(href, 'fleetdispatch', params)`. Spy = `mission: 6`
  (`MISSION_ESPIONAGE`, `domain/rules.js`), `am210: <probes>`, `type: 1`. Pattern
  to copy: `features/sendColony/pure.js:193`.
- A target's planet coords are already in the cache:
  `apiCache.universe.planets` is `ApiPlanet[]` with `coords="g:s:p"` + `player`
  id — filter by id. (`state/apiCache.js`, `domain/apiOccupancy.js` ApiPlanet.)

## Next milestones

### M3 — Sort + colour by hidden fleet  *(small; do first)*

Juicy targets float to top; magnitude visible at a glance.

- `domain/targets.js`: add pure `sortTargetList(list, key, dir)` (keys:
  `hiddenFleet` | `military` | `totalRank`).
- `features/dashboard/targets.js`: clickable `<th>` (`th.dataset.sortKey`);
  default = hidden-fleet desc (rows with an estimate first, then by military).
  Needs the `estimates` map (already passed in) to sort by hidden fleet.
- Colour the hidden-fleet cell by magnitude with `palette.js heatColor()`
  (`:157`) — normalize `hiddenFleetPoints` to `[0,1]` (per-view max, or fraction
  of `militaryScore`) → amber→red; gray for ~0 / not spied.
- Persist the sort choice in a small device-local pref (`safeLS`, like
  `SCOUT_PREFS_KEY` in `index.js:100/354/1085`).

### M4 — Watch-list (star players)

- Device-local **Set of watched playerIds** (per-universe; `safeLS`/`chrome.storage`).
  Pattern: `expandedGalaxies` Set in `index.js` (load on boot, mutate in place,
  persist on toggle) and `galaxy.js:362` header-toggle.
- `targets.js`: ⭐ toggle per row + a "only watched" filter checkbox in the
  controls (`dashboard.html`). Toggle → persist → `repaintTargets`.

### M5 — Spy deep-link buttons (per-position confirm)

Send 20 probes to each of a target's planets — one click per body (locked:
per-position confirm, planets-only).

- **Planet enumeration** (pure): `playerPlanets(universePlanets, playerId)` →
  `{galaxy,system,position}[]` parsed from `ApiPlanet.coords` (`split(':')`),
  filtered by player id. `apiCache.universe.planets` is already loaded in
  `loadAll`.
- **Spy URL** (pure): add `spyMissionUrl(gameHref, {galaxy,system,position}, probes)`
  to `domain/ogameUrl.js` → `ingameComponentUrl(gameHref, 'fleetdispatch',
  {galaxy, system, position, type: 1, mission: 6, am210: probes})`.
- **UI**: expand a target row → list its planets, each a `Spy N` `<a href>`
  (opens the game pre-armed; user presses send). Probe-count input (default 20)
  + a "next un-spied" stepper. Mark planets already in `targetReports` as spied.
- **GOTCHA**: the dashboard is extension-origin, NOT the game origin, so the
  link base can't be `location.href`. Derive the game origin from the **selected
  universe** (`https://<universeId>.ogame.gameforge.com/game/index.php`) or
  `serverData.domain`, and pass that as `gameHref`.
- **Fair-play**: user-initiated links only, no auto-send; wording per
  `docs/fair-play.md`.

### M6 — Polish / accuracy  *(optional)*

- "Spy his remaining planets": list bodies not yet in `targetReports`.
- Report freshness: show report age; flag stale (> N days) for re-spy.
- Moons (currently excluded): optional toggle to include moons for tighter
  estimates — revisit only if estimates look inflated by unseen moon defense.
- Label / i18n: "Targets" → Polish if desired.

## Open decisions

- M5 link base-origin (dashboard ≠ game origin) — universe-id-derived vs
  `serverData.domain`.
- M3 colour normalization reference (per-view max vs absolute bands vs fraction
  of military).
- `api/playerData.xml?id=` (fresh per-player planets incl. moons) vs
  `universe.xml` occupancy (cached, weekly) — `universe.xml` is enough for M5;
  add `playerData` only if we want moons / freshness.
- Watch-list scope: device-local (default) vs gist-synced (later).

## Test reconciliation (at release — `npm run test` green is the AMO gate)

- `domain/unitCosts`: cost-table sums (defense reproduces `2,768,761,000`),
  `pointsOf`, `sumResourceValue`.
- `domain/espionageReport`: `normalizeSpyReport` (lowercase keys, value fallback
  from JSON), `isEspionageReportBag` (report vs proximity vs moon), `bodyKey`.
- `domain/threatModel`: `estimateHiddenFleet` (dedup newest, clamp ≥ 0,
  coverage / provisional).
- `domain/targets`: `targetExclusionReason` (each cause), `buildTargetCandidates`
  union, `buildTargetList` sort; + `sortTargetList`, `playerPlanets` when added.
- `features/targetsIngest`: DOM-observer behavioral (inject `.rawMessageData` →
  recorded; proximity / moon ignored) via happy-dom.
- `features/dashboard/targets`: render + estimate column + (later)
  sort/colour/watch/spy-link.
- `state/targets`: store init/dispose, `recordReport` newest-per-body, hydration
  gate.

## Release (later · separate)

Merge `feat/hidden-fleet-targets` → `main`; **minor** bump (new user-visible
feature) in `package.json` + `manifest.json`; add the dated `## [X.Y.0]` section
to `CHANGELOG.md`; commit `chore(release): X.Y.0`; push `main` → `release.yml`
publishes to AMO. See the release checklist in `CLAUDE.md`.
