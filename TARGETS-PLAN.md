# Targets (hidden-fleet finder) — roadmap

Transient plan doc — delete when this feature's cycle closes (git keeps the
history). Background + locked design live in the AI memory
(`project_target_finder`); this file is just the remaining build sequence,
grounded in file:line so any session can pick it up cold.

## Status (2026-06-26 · branch `feat/hidden-fleet-targets` · commit `029c38c`)

**DONE & browser-verified:**

- **M1** — "Targets" sub-tab under Colonizations: universe-wide active-player
  list from the already-cached OGame highscore API (military + total), filtered
  (drop vacation/banned/inactive/admin/own-ally + noob-protection points band),
  sorted by military, with rank/points columns.
- **M2** — DOM ingestion of spy reports + per-player hidden-fleet estimate with
  `spied / total` coverage and a ⏱ provisional marker.

- **M3** — clickable column sort (Rank / Military / Hidden fleet) via pure
  `sortTargetList` in `domain/targets.js`; un-spied rows always sink under the
  hidden-fleet sort, military as tiebreak. Hidden-fleet cell is heat-coloured by
  magnitude (`heatColor(-frac)`, per-view max → grey→red). Sort persisted
  device-local in `oge_targetPrefs` (default = hidden-fleet desc).

- **M4** — watch-list. ⭐/☆ toggle column (leftmost) per row; "⭐ only" filter
  checkbox in the controls. Watched player ids are a per-universe device-local
  Set (`<universeId>:oge_watchedPlayers`, `safeLS`), loaded on boot + on universe
  switch, mutated in place, persisted on toggle → `repaintTargets`. Star = gold
  `★`, unwatched = grey `☆`.

**DONE (built + typecheck/lint/build clean; awaiting browser verify):**

- **M5** — spy deep-link buttons. Click a player → expandable detail row listing
  their planets (pure `playerPlanets` parses `universe.planets` by owner id),
  each un-spied body a `Spy N` `<a>` opening the in-game fleet dispatch pre-armed
  (pure `spyMissionUrl` → `mission:6 type:1 am210:N`; user presses send). Bodies
  with a report on file show ✓; a "next un-spied" quick link heads the list.
  Probe count is a controls input (default 20). Game origin derived from
  `apiCache.server.data.domain` (fallback `<universeId>.ogame.gameforge.com`) —
  NOT the extension origin. Expansion state is an ephemeral in-memory Set
  (`expandedTargets`), survives repaints, not persisted.

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

### M3 — Sort + colour by hidden fleet  ✅ DONE

Juicy targets float to top; magnitude visible at a glance. Shipped:
`sortTargetList` (pure, un-spied sinks, military tiebreak); clickable
Rank/Military/Hidden-fleet `<th>` with ▲/▼ arrow; hidden-fleet cell heat via
`heatColor(-frac)` (per-view max normalization); sort persisted in
`oge_targetPrefs`. **Resolved decisions:** colour = per-view max (not fraction
of military); reused `heatColor`'s negative half rather than a new ramp.

### M4 — Watch-list (star players)  ✅ DONE

Per-universe device-local Set (`<universeId>:oge_watchedPlayers`, `safeLS`),
expandedGalaxies-style (load on boot + universe switch, mutate in place, persist
on toggle → `repaintTargets`). ⭐/☆ toggle column + "⭐ only" filter checkbox.
**Decision:** `safeLS` (per the cited expandedGalaxies pattern), not a reactive
store — only the dashboard touches it, so a store would be pure overhead.

### M5 — Spy deep-link buttons (per-position confirm)  ✅ DONE

Shipped as described below. **Resolved decisions:** game origin = serverData
`<domain>` with `<universeId>.ogame.gameforge.com` fallback (didn't need
`serverData.domain` at a call site — it's already in the cache); `universe.xml`
occupancy was enough (no per-player `playerData.xml` fetch). Expansion state is
ephemeral (not persisted). Original spec retained below for reference:

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

### M6 — Polish / accuracy  *(optional; partially done)*

- ✅ "Spy his remaining planets" — covered by M5's per-planet list + "next
  un-spied" quick link.
- ✅ **Report freshness** (built + typecheck/lint/build clean; awaiting browser
  verify) — per-planet report age (`✓ 3d`), stale (> 7d, `STALE_MS` in
  `targets.js`) turns amber + gains a `↻` re-spy link; hidden-fleet cell gains a
  `⚠` when any underlying report is stale; the detail header re-spies the oldest
  stale body when all are spied. `spiedByPlayer` now carries coord→ts; `nowMs`
  passed from the feature (renderer stays clock-free for tests).
- ⏸ Moons (excluded): DEFERRED — needs `<moon>` parsing in the breadth-layer
  `apiOccupancy` parser + estimate/coverage changes (cross-cutting); revisit only
  if estimates look inflated by unseen moon defense.
- ⏸ Label / i18n to Polish: DEFERRED — the rest of the dashboard is English;
  localizing only this tab would be inconsistent. Do the whole dashboard or none.

## Open decisions

- `api/playerData.xml?id=` (fresh per-player planets incl. moons) vs
  `universe.xml` occupancy (cached, weekly) — `universe.xml` + report timestamps
  were enough through M6 freshness; add `playerData` only if the deferred moons
  item is picked up.
- Watch-list scope: device-local (shipped) vs gist-synced (later).

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
