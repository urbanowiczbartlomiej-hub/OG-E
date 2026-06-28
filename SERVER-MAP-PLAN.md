# Server map / points-temperature — plan (WIP)

Transient plan doc (delete when the cycle closes; git keeps history).
Redesign of the legacy **"Scanned data"** sub-tab into a **points-temperature
server map**, folded into Colony Scout.

## Why

Pre-1.30 "Scanned data" answered "is this position free?" from MANUAL scans.
Post-1.30 the API (`universe.xml` + highscores) gives server-wide occupancy
automatically, AND Colony Scout already does the colonisation decision better.
So the old tab is doubly redundant. The API also makes a *meaningful* server
heat-map newly possible (complete data, not a sparse manual-scan blank).

New framing: a **zoom-agnostic instrument** (server ↔ galaxy ↔ system) — players
mix scales (whole-server expanders, single-galaxy, single-system). Colony Scout
is the telescope; the map is its wide end.

## Locked decisions

- **Structure:** ONE stacked grid, 9 galaxy rows × up-to-499 system cells. Whole
  server + a single galaxy visible at once; click a system → existing Colony
  Scout detail.
- **Lens = active strategy** (re-tints on switch) + a "show free positions"
  toggle. No separate metric dropdown.
- **Points temperature model (4 rules):**
  1. Per-ACCOUNT, not per-planet (distinct player counts once; banned excluded).
  2. Neighbourhood smear — reuse the area-mode radius window (don't add a slider).
  3. total vs military = same map, two sources; SIGN decided by strategy
     (peaceful/settler reads high total = avoid; aggressor reads high military =
     seek — no "military desert").
  4. Default safety read is RELATIVE to you (`% / count stronger than me`), via
     `ownProfile.rank`. Absolute average is the secondary read.
- **Placement:** inside Colony Scout. The old "Scanned data" sub-tab is absorbed
  (its galaxy strip becomes the recoloured galaxy-zoom) and removed; the
  whole-universe free-slot count moves to a header / settings line.
- UI labels stay ENGLISH (match existing presets), even though we discussed in PL.

## Status

### DONE — Step 1: plumb points (commit this session)
Points (total + military) were parsed from the highscore API then DISCARDED at
the index boundary. Now retained end-to-end:
- `domain/apiOccupancy.js` — `OccupiedSlot` keeps `score` + `militaryScore`;
  `buildOccupancyIndex` takes a `military` feed (highscore type 3) and joins it;
  `buildScanMapFromIndex` copies both onto each position's `player`.
- `features/apiContext/index.js` — passes `military` into `buildOccupancyIndex`
  (the `cache.military` feed was already fetched, type 3).
- `domain/scans.js` — `PositionPlayer` gains `score` / `militaryScore`
  (API-synthesised map only; live galaxy scans don't expose points).
- `domain/regions.js` — `scoreRegion` aggregates `avgTotal` / `avgMilitary`
  (per-account, banned excluded) onto `RegionScore`.
- `features/dashboard/freeStreak.js` — `buildScoreCards` renders "Avg points" /
  "Avg military" cards (shown when ≠ 0); `fmtPts` compact formatter.

### DONE — Step 2: weakerNearby signal + Safe expansion preset (commit this session)
- `domain/regions.js` — `StrategyWeights.weakerNearby`; `rankRelative(ranks,
  ownRank)` helper; wired into BOTH `scoreForStrategy` (rate `/n`) and
  `systemIntentHeat` (count). `SortOptions.ownRank` added. New `safe_expansion`
  preset: `{ free:1, weakerNearby:1.5, inactive:0.6, occupied:-0.2, bandit:-2,
  strong:-1.5, length:0.1 }`.
- `features/dashboard/freeStreak.js` — `ownRank` forwarded into `sortByStrategy`
  and `buildInteractiveStrip` → `systemIntentHeat`.
- `src/dashboard.html` — "Safe expansion" `<option>` added (the select is
  HARDCODED here, not generated from `STRATEGIES`).
- `ownRank` source: `ownProfile.rank`, already passed by `repaintFreeRegions`
  (`index.js`). `weakerNearby` has no weight SLIDER → like existing
  `strong`/`outlaw`, it's dropped only once the user moves a slider
  (`readCustomWeights` returns the 5 `WEIGHT_FIELDS` only, else `undefined`).

## NEXT — Step 3: the stacked 9×499 map (resume here)

Build the server map view inside Colony Scout, colour each cell by the active
strategy's per-system heat.

- **Data:** reuse the `composite` scan map already built in
  `index.js repaintFreeRegions` (`buildScanMapFromIndex(apiIndex, …)` +
  `liveOverlay(scans)`). Per cell call
  `systemIntentHeat(scans, g, s, weights, { players, ownRank })` →
  `heatColor(...)`. Iterate `g = 1..apiBounds.galaxies`, `s = 1..apiBounds.systems`.
- **Render:** reuse `heatColor` + the strip CSS; the per-galaxy 499-cell strip
  already exists in `features/dashboard/galaxy.js` (today coloured by occupancy
  STATUS) — either generalise it to take a per-cell colour fn, or add a compact
  new renderer. 9 strips stacked = the server view.
- **Interaction:** click a system → existing Colony Scout system detail
  (`buildSystemCard` / the area detail). "Show free positions" overlay toggle
  (cells with a free target slot get a dot — see the mockup).
- **Aggressor military heat (deferred from step 2 — do it here):** add a
  `fleetMass` weight on `avgMilitary` NORMALISED relative to own military points.
  Get own points from the API highscore by `ownPlayerId`
  (`total.ranks[id].score` / `military.ranks[id].score`) at the dashboard and
  thread `ownTotal`/`ownMilitary` into `systemIntentHeat`/`scoreForStrategy`
  opts (parallels `ownRank`). Centre the total signal at own level (weak = green,
  strong = red); military direct (more = hotter for the aggressor).
- **Free count:** `apiIndex.occupiedByPosition` already gives the whole-universe
  free-slot count → header line (covers the "settings" idea).
- **Remove** the old "Scanned data" sub-tab once the map covers it; move the
  free-count there/header. (Sub-tabs live in `dashboard.html` ~line 489; galaxy
  renderer in `features/dashboard/galaxy.js`, `index.js renderGalaxyMap`.)
- **Perf check:** 9×499 ≈ 4.5k `systemIntentHeat`→`scoreRegion` calls per
  repaint. Cheap per call but verify; memoise per system if needed.

## Deferred (after step 3)

- `weakerNearby` weight SLIDER (and consider exposing `strong`/`outlaw`).
- **Alliance-territory** map mode (categorical: cell = dominant alliance).
- **Trend** map from weekly `universe.xml` snapshots (which systems decay vs
  grow) — needs snapshot storage + diff; the deepest, costliest option.

## Test reconciliation (at RELEASE only, per CLAUDE.md)

Not done during build-and-verify. At release, add/fix unit tests for: point
retention (`apiOccupancy` score + military feed), `scoreRegion`
`avgTotal`/`avgMilitary`, `rankRelative` + `weakerNearby` in
`scoreForStrategy`/`systemIntentHeat`, the `safe_expansion` preset.
NOTE: `npm run typecheck` is currently RED but only in `test/` and only for
`DailyRunRoutes` (`collectMission`/`collectShips`/`collectResources`) — a
PRE-EXISTING, unrelated drift, not from this work. `src/` is clean.
