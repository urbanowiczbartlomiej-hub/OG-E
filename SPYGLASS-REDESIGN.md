# SPYGLASS-REDESIGN.md — Spyglass v3 "Watchlist Workbench"

> **Status: DESIGN — validated concept + implementation plan (2026-07-04).**
> Produced from a deep multi-agent AS-IS analysis (7 area readers), a 3-proposal
> design panel with a 3-lens judge round (unanimous winner + grafts), and an
> adversarial validation pass (fair-play / architecture / code-seams / game-mechanics
> / storage + a completeness critic). Transient plan doc — delete after the last Etap
> ships (CLAUDE.md doc lifecycle).
>
> **Base assumption:** this design builds ON the uncommitted 1.34.0 state (danger model
> v2 E0–E7 + GV redesign, see `RELEASE-HANDOFF.md`). **Land 1.34.0 first**; nothing here
> touches `freeStreak.js` until it does, and Etap A is *blocked-on* (not merely
> "coordinated with") a green 1.34.0 on `main`.
>
> **Read §12 first if you only read one section** — it is the list of decisions that
> need your sign-off before engineering starts (two of them can invalidate whole Etapy).

---

## 0. SESSION HANDOFF (read this first — for the next session)

Implementation is **in progress on branch `feat/spyglass-v3`** (off `main` @ `chore(release):
1.34.0`). **Local only — not pushed, not released.** Tree is **green** (`npm run typecheck`
+ `npm run lint` + `npm run build` all pass) at every commit below. Work loop per CLAUDE.md:
change → build → user verifies in the browser → commit; **no unit tests during the loop**
(reconcile them at release, Etap-end). Publishing = bump `package.json`+`manifest.json` +
CHANGELOG + `chore(release): 1.35.0` pushed to `main` (`urbanowiczbartlomiej-hub`), **confirm
with the user first**.

### DONE this session (commits on `feat/spyglass-v3`)

| Commit | Etap | What shipped |
|---|---|---|
| `1ed2696` | 0a + 0b/E1 | fair-play addendum (§8); `lib/dangerColor.js` (de-drift); equal-ts ingest guard; **rich-field spy-report normalizer** (economy/research/lifeform scores, buildings/research/lf, characterClass, resources/metal/crystal/deut, loot%, counter-esp%, `revealed{}`, activity enum) — additive, gate unchanged |
| `4fdff3c` | (re-plan) | moved 0b's coverage-honesty (partial+moon admission, `revealed.defense` gating, bodies denominator) **into Etap F** — the newest-per-body store would let a partial re-scan evict a full report's defence; moon bodies entangle `playerPlanets`→`sendSpy`→coverage that F reworks |
| `3b560d8` | — | deleted stale `RELEASE-HANDOFF.md` (1.34.0 shipped) |
| `d777683` | A | table **14→7 cols** (⭐·Player·Danger·Fleet·Military·Ships·Intel), Intel glyph merges Scanned+Coverage, controls cleanup (drop Attack-range + More-filters; add "in range only" + "hide inactive"), intro rewrite, persist show-limit |
| `c4836f6` | B | **`domain/raidVerdict.js`** (raid-or-skip + loot) + **`dossier.js`** (rich drill-down: verdict banner, danger `mobileLo..mobileHi` interval bar, reasons, hidden-fleet math, planets grid + ⭐ hoard) replacing the thin expand-row |
| `9af13a1` | C | **`domain/civilBaseline.js`** — economy→ships decile-median curve → per-player combat-ship surplus; CIVIL BASELINE dossier section (weak prior / upper bound, never into D) |
| `2bd2915` | D-search | header **nickname search** over the whole set incl. excluded players (dimmed + reason + "show anyway" `forceInclude`) |
| `f41f4a5` | D-strip | "who's been near you" defensive strip from proximity reports (§6.10) — NEW `state/proximityReports.js` + proximity gate/normalizer + targetsIngest + `content.js` init + dashboard strip. Green, committed. **Not yet live-verified** — needs a real "obca flota dostrzeżona" alert to see the strip populate (verify next session) |

### DONE — session 2 (Etap F foundation + Etap E extraction & map start)

Etap F's unblocked core (store migration + coverage honesty, WITHOUT the consult-gated routine
visuals) THEN Etap E (map): the `freeStreak.js` extraction + the first slice of the Spyglass
map. Tree green at each commit. User verified E1 (GV renders identically) before E2a.

| Commit | Etap | What shipped |
|---|---|---|
| `9aff5ff` | F (foundation) | **`{latest,history}` store migration** — NEW `domain/targetReports.js` (`latestOf`/`historyOf`/`toLite`/`HISTORY_CAP`, both-shape tolerant); shape-tolerant `normalizeReportTimestamps` (repairs `latest.timestamp` + each `history[].ts`); `recordReport` writes the ring with a **watched-only write-side retention gate** + equal-ts guard also blocking a duplicate history append; **all 4 read paths through `latestOf`** (3× dashboard `index.js` + in-game sendSpy FAB). Plus **coverage honesty**: `estimateHiddenFleet` gates each body on `revealed` (defence/fleet/`spiedCount` defence-covered only, so a partial's absent defence is never read as a real zero); `isEspionageReportBag` admits **partial** reports behind a scan-fingerprint (`hidden*`/numeric defence|fleet) so a combat-report loot line can't slip in. |
| `e798124` | F (moons) | **Moon bodies**: `parseUniverse` flags `ApiPlanet.hasMoon` (own-content scan up to next `<planet>`, O(n)); coverage denominator counts planets + moons; gate admits `type=3` moon scans; **planet↔moon coord-collision guards** in the sendSpy FAB `spiedCoordsByPlayer` + dashboard per-planet `byCoord` (a moon scan never marks the planet spied). |
| `ac59d2c` | E1 | **Map primitives extracted** — NEW `features/dashboard/mapPrimitives.js` (pure `computeComposite`/`computeScoreField` — window/farm as params, not DOM reads — + `buildSystemCard`/`dangerBadge`/`liveOverlay` moved verbatim). GV keeps its **caller-side** `compositeCache`/`scoreFieldCache` wrappers → each sub-tab owns its cache. Behaviour-preserving (GV renders identically). |
| `f34f5db` | E2a-1 | **Spyglass watchlist map (occupancy)** — `🗺` toggle + `#spyglassMapHost` in the Spyglass tab reusing `renderServerMap`; own `spyCompositeCache` + `spyMapHighlight`; `repaintSpyglassMap` wired to renderAll + the spyglass tab-switch + the toggle; extracted shared `gameLinkBase()`. |
| `1f24fa8` | E2a-2 | **⌖ spotlights on the Spyglass map** (in-tab) — new `showPlayerOnSpyglassMap`; **removed** the orphaned GV-jump `showPlayerOnMap` + the whole GV occupancy-lens spotlight machinery (`mapHighlight`, render params, `hiKey`/`lastMapPaint.hi`) → full decouple (§1.1); universe-switch/teardown now reset the Spyglass map state. |
| `99109a3` | E2b | **Watchlist colour overlay** — `mapPrimitives.playerColor(id)` (golden-angle stable hue); `renderServerMap`/`renderOccupancyMap` gain an optional `highlightColors` Map (watched player → colour; absent for GV → unchanged); each watched player's planets paint their colour; caption added. |

**Etap F foundation is DONE.** What remains of Etap F = the **routine visuals only** (activity
strip + galaxy-view activity capture + self-induced discount, weekday pattern, collection
callout, spy timeline) — **still ToolDev-consult-gated**. **Deferred test debt** (per CLAUDE.md,
reconcile at release): migration-cap / both-read-paths / retention-gate + equal-ts-no-dup-history
tests, partial+moon gate, `revealed` gating, `<moon>` parse, `mapPrimitives` compute.

**Etap E (map) is IN PROGRESS** (not deferred-to-1.36.0 as the plan assumed — user chose to
build it now; placement = a map SECTION in the current Spyglass tab, not the cards-landing view
toggle). **DONE: E1** (extraction) + **E2a-1** (occupancy map + toggle) + **E2a-2** (⌖ spotlight
in-tab, GV fully decoupled) + **E2b** (watchlist colour overlay). The Spyglass map now shows
whole-server occupancy + every watched player in their stable colour + **own planets in white
(reference frame)** + a **colour→player legend** + a click-⌖ focus (diamond markers + banner) +
system popovers (inherited from `renderServerMap`). Polish commit `b4334d9` (legend + own-white).
**Remaining E2 polish (optional, none release-blocking):** danger-scaled marker size; **click a
coloured cell → open that player's dossier** — deferred: the occupancy canvas click already
pins the system popover (`buildSystemCard` names the occupants), so a click→dossier would
conflict + needs canvas hit-detect→playerId; the table row/⌖ is the act-on-a-player path today.

### NEXT — future sessions, in order

*(Etap D-strip is committed `f41f4a5` but not live-verified — open the messages tab with a
real "obca flota dostrzeżona" alert and confirm the 🛡 strip populates; the code is green.)*

1. **Etap E — the Spyglass map** (its own release, likely 1.36.0): multi-player overlay. A
   genuine multi-day refactor — extract the private, state-glued `buildComposite`/
   `buildScoreField`/`showPlayerOnMap`/`buildSystemCard` out of the 1,826-line `freeStreak.js`
   into a shared `mapPrimitives.js`. See §6.9. Treat it as a big, isolated piece; `freeStreak.js`
   is now settled (1.34.0 shipped) so touching it is allowed.
2. **Etap F — routine VISUALS only** (foundation DONE — see the session-2 block above; **still
   needs the ToolDev consult first — see below**). The store now already carries the
   `{latest, history}` ring these visuals read (no schema change left). Remaining: galaxy-view
   activity capture (`parseActivity` in `classifyPosition` + a per-body activity ring,
   watched-only) with the **self-induced-activity discount** (§6.6bis); `domain/routine.js`;
   and the activity-strip (two sources) + coverage rows + weekday pattern (`resTotal`) +
   collection callout + spy timeline on the dossier + card. **Gated on the ToolDev OK.**
3. **Etap G — scan planner** (`windowBonus` **needs the ToolDev consult**): `domain/scanPriority.js`
   (danger×staleness×windowBonus), per-player `staleMs` cadence, FAB walks the order, "why next"
   strip, `shipAvailability()` pre-flight (note: it's LIVE code used by `dailyRun` — add a
   `sendSpy` consumer, don't "revive dead code"), `noShips`→"No probes!" label fix, rescan-map prune.
4. **Release 1.35.0** — reconcile tests (new pure modules `raidVerdict`/`civilBaseline`/`routine`/
   `scanPriority` + the store migration + `espionageReport` rich fields & proximity + `targets.js`
   search + `dangerColor` + `proximityReports`), CHANGELOG, bump `package.json`+`manifest.json`,
   `chore(release): 1.35.0`, push to `main`. Map/FS-bracketing/watchlist-sync → **1.36.0** (§12).

### Parallel USER action (do NOT block on it, but start it)

**Open the one consolidated ToolDev consult (YELLOW-D, see §8 + `docs/fair-play.md`)** — the
provenance-first question for the **routine tracker + `windowBonus`**. It is required before
Etaps **F and G** ship, and it can invalidate them, so ask before building those. Etap D-strip
and Etap E do not need it.

### Implementation gotchas learned this session (save future time)

- **Coordinator pattern that worked:** isolated/mechanical tasks → delegate to background
  subagents on **disjoint files** (dangerColor, equal-ts, the table-cut + controls, dossier.js,
  civilBaseline.js, the proximity strip); **keystone contracts and tightly-coupled UI↔domain
  wiring → drive directly** (espionageReport rich fields, raidVerdict, all the index.js plumbing).
  Always run the **authoritative tsc+lint+build yourself** after integrating (agents were told
  not to run npm).
- **Shell:** PowerShell only (the Bash tool errors "No suitable shell"). Multi-line commit
  messages → write to a scratch file + `git commit -F` (never inline heredocs). Commit trailer
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Large deletions fail the Edit tool** when the block has special chars (`·`, `↻`, backticks,
  curly `'`): matching a 100-line `old_string` mismatches. Use a PowerShell **regex on the raw
  text** and write back UTF-8 **without BOM** (`[System.IO.File]::WriteAllText($p,$t,(New-Object
  System.Text.UTF8Encoding $false))`) — that's how `detailRow` was removed.
- **"File modified since read"** trips after your OWN edits to a large file even when git shows
  it unmodified — just re-read the region and retry. **Line numbers drift** across edits;
  re-`grep` for anchors before each edit rather than trusting earlier line numbers.
- `protectionFactor: 0` = attack-band OFF (it was the old select's "off" value; domain already
  treats 0 as disable).
- **Old spy reports (pre-`1ed2696`) lack the new `resources`/`revealed` fields** → `lootNow`
  reads 0 and the raid verdict shows "scan first"/"empty" for previously-spied players until
  they are **re-spied on the new build**. Expected; mention it when the user tests loot.
- `raidVerdict.js` and `civilBaseline.js` carry **first-pass heuristic thresholds** (LOOT_FLOOR
  500k, FLEET_RISK_FLOOR 30k pts, fresh 12h/stale 3d; civil BASELINE_MAX 0.25/ELEVATED_MAX 0.6)
  — named consts, tune once the user has lived with them.

### Still deferred / not yet built (beyond E/F/G)

- The **watchlist-card landing IA** (§6.1, §6.3) — the current table is still the landing view;
  the raid verdict lives in the **dossier**, not yet on a glanceable card. The "card" half of
  the §6.4 jack-point is pending an IA step (fold into a later etap or its own).
- **pts/ship calibration** (§7 step 3) — the civil baseline ships the ship-surplus model; the
  spy-calibrated points-per-ship refinement is deferred.
- **Attack-range** is a per-request toggle now, not the per-planet ⚔ glyph on cards (cards
  pending). The dossier shows `⚔ in range` in its header.

---

---

## 1. AS-IS — the two surfaces and their engine

### 1.1 Galaxy Viewer — what it is and what it is FOR

GV (Colonizations → sub-tab "Galaxy Viewer", rendered by
`features/dashboard/freeStreak.js`, ~1,826 lines, driven by `index.js`) is a
**strategy-independent server analyzer**: "where are the threats, farms and quiet space"
(freeStreak.js:3-8). Three cards:

1. **Config card** — chip groups (Zone safe/farm/pvp, Find spots/streaks, Ignore-worst,
   Tolerance) + sliders (Offline window 4-16 h, Farm reach 4-60 sys), persisted
   device-local (`oge_colonyScoutPrefs`).
2. **Server map** — two lenses: the smoothed **threat/farm field** (per-player danger D
   spread by RIP-flight reach within the offline window, `domain/heatField.js`) and the
   sharp **occupancy canvas** (499×15×galaxies, `domain/cellClass.js` buckets
   free/mine/blocked/farm/threat).
3. **Results card** — zone-Fit-ranked windows/streaks with census groups, the "Top
   threats in window" panel, and pinnable system popovers (`buildSystemCard`).

Its *purpose* in the product: **colonization intelligence** (Big Colony Hunting feeds off
it) *plus* the general threat picture. The colonization layer
(slots/streaks/zone-fit/candidate pins) sits cleanly ON TOP of a colonization-agnostic
substrate — composite occupancy index + score field + danger profiles, all
identity-cached in `index.js:1285-1344` — which is the seam the new Spyglass map extracts
along (§6.5). **GV is not being replaced or shrunk; it keeps consuming the shared danger
engine.** The redesign only *decouples the view*: Spyglass stops hijacking GV's occupancy
lens for its "show player on map".

### 1.2 Spyglass — what it is today

One tab (`#spyglassSection`, `features/dashboard/targets.js`): a **14-column whole-server
table** (Scan, #, Player, Danger, Fleet, Military, Ships, Destr, Highscore, Defense,
Visible, Hidden, Scanned, Coverage; targets.js:671-688), default-sorted by Danger desc,
with filters (Military min/max, top-N, scan-list-only, Probes, and the "⚙ More filters"
block: **Attack range** ±5×/±10×/off + vacation/inactive/banned checkboxes). Row expansion
shows a per-planet scan-status grid. The "+ scan" chip feeds a per-universe watch config
(`state/watchList.js`: `{players, probes, rescan}`) shared with the in-game **Spy FAB**
(`features/sendSpy`), which proposes the next needs-scan planet and sends probes via the
two-tap courier ritual — one deliberate user tap per send.

**Original purpose:** find players with big military scores and discover, by spying their
defense, how much of that score is *fleet* (usually fleet-saved and unattackable) —
`hidden = military − defense − visible` (`domain/threatModel.js`).

### 1.3 The engine underneath (danger v2, uncommitted 1.34.0)

- **API layer** (`features/apiContext` + `domain/apiOccupancy.js`): 9 feeds —
  universe.xml (7 d), players.xml (1 d), serverData (1 d), highscore total/military/honour
  (1 h), economy/destroyed/lost (1 d). The military feed carries the **`ships` attribute =
  ship COUNT** (absent = 0 ships, guarded by `feedHasShips` against pre-ships caches).
  Refresh happens only on in-game page loads (same-origin fetch, `credentials:'omit'`); the
  dashboard reads the cache.
- **Danger engine** (`domain/dangerScore.js`): per-player DangerProfile — bounded **mobile
  military** (`ships=0 ⇒ 0` hard; floor 1 pt/ship; spy refinement collapses to exact only
  when coverage complete AND consistent with the fresh ships floor), PredatorScore
  (destroyed × ships percentiles), D 0–100, archetype labels (Apex hunter … Turtle/
  Economist), provenance ladder `prior → ships → spied`, human `reasons[]`.
- **Spy ingestion** (`features/targetsIngest` → `domain/espionageReport.js` →
  `state/targets.js`): a MutationObserver reads `.rawMessageData` **dataset only** on any
  game page; the store keeps the **newest report per body only**.

### 1.4 The waste inventory (data we already have and throw away)

This table is the redesign's raw material — almost everything below is *free*. Every row
was re-verified file:line in the validation pass; corrections are marked ⚠.

| Data | Status today | Grounding |
|---|---|---|
| Per-ship-type fleet & defense maps in every spy report | persisted, **zero consumers** | espionageReport.js:53-73; index.js:1037-1048 |
| `activityMin` (the ≤15-min activity star) per report | persisted, **zero consumers** | espionageReport.js (activity '*' → 0) |
| Report-time military/total/ranking snapshot | persisted, **zero consumers** | espionageReport.js:162 |
| Report **history** | destroyed — newest-per-body overwrite | state/targets.js:77-82 |
| On-planet **resources** (+metal/crystal/deut/pop/food), **loot %**, **counter-esp %**, **highscoreEconomy/Research/Lifeforms**, **characterClass**, **buildings/research/lf levels** | ALL in the `.rawMessageData` dataset (confirmed via `getMessagesList`), **never mapped by the normalizer** | targetsIngest/index.js:38-47; espionageReport.js:53-73 |
| Proximity "foreign fleet near your planet" reports (`sourcePlayerId` + coords) | **dropped at the gate** — but they are defensive intel (§6.10) | espionageReport.js:233 |
| Moon reports; **partial / resources-only reports** (fleet+defense hidden, `hidden*='1'`, but loot+scores+class present) | **dropped at the gate** — yet they carry the decisive loot number (§9bis) | espionageReport.js:230-236 |
| **economy** (type 1) + **lost** (type 6) highscore feeds | fetched daily, **zero consumers** | apiContext/index.js:226-250 |
| universe.xml `<moon>` children + planet id/name | **not parsed** (coords+owner only) | apiOccupancy.js:216-224 |
| Galaxy-view **activity marker** (per body: <15 / exact 15-60 / none) | observed by the bridge, **not extracted** (`classifyPosition` drops `activity`) then positions stripped on persist | galaxyHook.js:145-183; scans.js:273; state/scans.js §5 |
| Hourly API time dimension (ships/military series) | overwritten every refresh | apiCache single-snapshot |
| `mobileLo` (the honest lower bound) | computed on every profile, **no UI consumer** | dangerScore.js:48-67, 366 |
| `targetExclusionReason` (why a player is hidden) | computed, **discarded** to a boolean | domain/targets.js:67-118, 129 |
| `mineMinDist` (distance to own planets per region) | computed, **consumed nowhere** | regions.js:327-331, 450 |
| `deriveSpy env.staleMs` override (per-target cadence) | plumbed, **no caller** | spyScan.js:32; sendSpy/pure.js:76 |
| `shipAvailability()` pre-flight probe check | exported, **used by dailyRun — NOT by sendSpy** ⚠ | fleetCourier.js:332; dailyRun/index.js:69,237,256 |

> ⚠ **Validator correction:** `shipAvailability()` is *live code* (dailyRun paints
> readiness with it). "Wire it in" means **add a `sendSpy` consumer**, never "revive dead
> code". Do not remove it.

---

## 2. The strategic shift — why the redesign

The hourly `ships` count answers Spyglass's founding question — *who holds a fleet* — **for
the whole server, for free, with no spying**. The danger model already turns it into D
scores, archetypes and bounded fleet estimates, and GV paints it on the map. A 14-column
discovery table now competes with its own engine.

What spying still uniquely provides:

1. **Exactness** — a defense scan collapses `fleet = military − defense` from a wide bound
   to a point value (the provenance ladder already does this).
2. **Average points per ship** — the key valuation parameter; scans remove the defense
   contamination the API-only ratio suffers from.
3. **Time & behaviour** — a spy report is a *point-in-time snapshot* of resources, fleet
   presence and activity. A sequence of them is a routine.
4. **Per-planet resolution** — where the fleet sits, where resources gather.

**Therefore: Spyglass pivots from discovery to refinement + per-player intelligence over
time, and — the point of it all — to helping the user decide *raid or skip, and when*.**
Discovery stays in the Danger column + GV.

---

## 3. Problems worth fixing (consolidated, grounded)

1. **14 columns, a third of them `—`** for the un-spied majority
   (Defense/Visible/Hidden/Scanned/Coverage); no responsive strategy.
2. **Key intelligence is tooltip-only** (danger reasons, provenance, res/ship, hidden-fleet
   math) — invisible on touch, undiscoverable.
3. **No player search**; the GV→Spyglass deep-link silently no-ops when the player is
   filtered out (index.js:1093-1096).
4. **Exclusion reasons computed then thrown away** — players vanish with no explanation
   (always-on hidden filters: admin, own alliance).
5. **History destroyed** (newest-per-body) — no temporal signal survives.
6. **Coverage overclaims**: planets-only denominator; moon defense reads as hidden fleet
   (threatModel.js:17-19); "spied exact" can rest on an undercounted denominator.
7. **Scan cadence is one-size-fits-all** (7 d for a D-90 hunter and a dead farm alike); FAB
   order is star-order, not value-order.
8. **Equal-timestamp re-ingest churns** the store and repaints the dashboard
   (state/targets.js:80, strict `>`).
9. **No retention** — reports and rescan flags accumulate forever.
10. **fair-play.md has zero Spyglass entries** — the whole surface (scan FAB, targetsIngest,
    danger model) predates the compliance doc.
11. Assorted: `#` ordinal column is meaningless; watch/scan dual concept; `pl-PL` hardcoded
    locale; danger colour thresholds duplicated **and already drifted** in two files
    (freeStreak.js:136 `#5a8f5a/#e0b020/#d05a3a` vs targets.js:264
    `#7fd6a8/#e0b020/#e2726a`); stale intro copy (dashboard.html:747-755); `noShips` error
    paints a raw string instead of "No probes!" (sendSpy/index.js:214 tests the singular
    `'noShip'` but fleetCourier returns plural `'noShips'`, fleetCourier.js:372).

---

## 4. Assessment of the requested ideas (and panel additions)

| Idea (user) | Verdict | Design consequence |
|---|---|---|
| Drop the Attack-range filter, always "show every score" | ✅ adopt, with a twist | The **±5×/±10× band selector and the "More filters" block are removed**. The noob-band math is NOT deleted: it (a) inverts into a per-row/per-planet **⚔ "in your attack band"** indicator, (b) feeds search's exclusion explanations, and (c) powers **one** cheap top-level **"in-range only"** toggle (default off) — the completeness critic is right that "show me only who I can legally hit" is a real triage question and demoting it purely to a per-planet glyph forces a drill-in. |
| Spyglass gets its own multi-player map; decouple from GV | ✅ adopt, **defer to v3.1** | Map = a **view toggle of the watchlist** (not a tab, not a GV jump). Reuses GV's colonization-agnostic substrate; omits farm heat / free slots / pins. But the extraction is a genuine multi-day refactor of private, state-glued functions inside the 1,826-line `freeStreak.js` monolith — it is the highest-cost / lowest-daily-loop-value item, so it ships as its own isolated release **after** the actionable core. GV keeps its own map; the *engines* stay shared, the *views* decouple. |
| Routine tracker over spy reports; propose scans; visualize activity/resources/FS patterns | ✅ adopt (the new core justification), **honest + trimmed** | Built on **spy-report history** (a bounded ring per body), NOT on API deltas — this sidesteps the exact reason the API-delta tracker was parked (RELEASE-HANDOFF.md:169). Ships in v3: **hour-of-day activity strip (with a coverage row)**, **weekday resource pattern**, **collection-planet callout**, **plain spy-history timeline**. **FS-window interval bracketing is deferred to v3.1** (§5, §12) — it is the noisiest, least-verified, most fair-play-fraught visual and needs sampling density a solo fleeter rarely has. Honesty is a hard rule: windows and frequencies, never predicted instants; n-gated; hollow when under-sampled. |
| Avg pts/ship as the key parameter; civil-fleet baseline from economy | ✅ adopt | New pure `domain/civilBaseline.js` — the first consumer of the dead economy feed. Binned-median server curve → expected civil ships → combat surplus, spy-calibrated pts/ship. **Dossier verdict line only** in v3 (not a sortable table column, not fed into D) until calibrated. The eco-vs-ships scatter is a *nice-to-have* that never blocks a release. |
| Too many columns → strong simplification | ✅ adopt | 14 → 7 in the Finder; every spy-only column moves to surfaces where spy data actually exists (cards/dossier). |
| Player search by nick | ✅ adopt, extended | Header search over the FULL candidate set **including excluded players, with the reason shown** and a [show anyway] override. Matches nick + coords + alliance tag. |

**Panel additions adopted:** watchlist-first IA (cards as the landing view, Finder
collapsed); the dossier as the home of all tooltip-only intel; the honest
**[mobileLo–mobileHi] interval bar** (finally rendering `mobileLo`); the **Intel confidence
glyph** `○◐●⚠` merging Scanned+Coverage; **priority scan plan** (danger × staleness ×
active-window bonus) with a "why this is next" one-liner; per-player scan cadence via the
unused `staleMs` seam; **⭐ hoard flag** (the planet holding the most visible fleet/
resources); **Reach** fact from the dropped `mineMinDist`; `shipAvailability()` pre-flight
probes readout in `sendSpy`; **shared danger colour module** (reconciling the drifted
palettes); **addressable `{view, playerId}` route** replacing three ad-hoc module mutables;
data-honesty Etap 0 (moons, partial reports, equal-ts guard, retention) BEFORE any new UI.

**New — surfaced by the completeness critic, adopted (the actual jack points):**

- **A raid verdict on the card** — a single glanceable go/no-go line that *fuses* the
  signals we already compute (§6.4). A fleeter with 8 minutes will not read a dial; they
  need "GOOD TARGET NOW" / "fleet likely home" / "skip — freshly spied empty".
- **A loot-at-decision estimate** — last-spied resources grown to now × loot fraction —
  the number that actually decides raid-or-skip (§6.4). This is deliberately *not* the
  rejected "Worth" table column: it lives on the card/dossier, confidence-tiered and
  honest, exactly the moment the decision is made.

**Considered and rejected** (kombajn control): a sightings journal (debris/vacation-flip
events — marginal decision value); a routed *multi-view* IA (one addressable
`{view, playerId}` route + an accordion achieves the same reachability with less machinery);
a Threats/Prey global lens toggle (a sort preset in disguise); a "Worth" **sortable table
column** (uncalibrated model in the highest-visibility spot — the *card verdict* replaces it
honestly); the eco-vs-ships **scatter** as a release blocker (the verdict line carries the
actionable content); **hourly API series for non-watched players**; **full workspace
persistence** of open-dossier/map-selection (staleness bugs, speculative); **watchlist
sync** (re-opens the C6 multi-universe-wipe class — §10.4); the sr- API key (fetching it
would originate a game request — fair-play RED).

---

## 5. Settled mechanic: a flying fleet still counts in the `ships` count

The AS-IS analysis (and two of three design proposals) assumed hourly ships-count dips
reveal fleet-save windows. This is **wrong, and now confirmed on two independent grounds**:
the game-mechanics validator judged it wrong with high confidence, and the OG-E author
(a veteran OGame player) confirmed it empirically — **the public API returns a fleet's
ships even while it is in flight / on a fleet-save.** OGame highscore military points and
the `ships` count are computed from *owned* units; a fleet in flight (including looping
through position 16) is still owned, is never destroyed, ownership never changes — so the
military score and `ships` count are identical whether the fleet is docked, mid-flight, or
saved. **The API cannot see fleet movement at all** — only builds (`ships`↑) and losses
(`ships`↓ paired with `lost`↑). The digest's dip=departure claim confused "fleet absent
from a spied body" (a snapshot fact) with "fleet not owned" (a highscore fact); they are
unrelated. **No calibration experiment is needed — the mechanic is decided.**

**Rules baked into this design (now permanent, not provisional):**

- No user-facing copy may claim "fleet moved" from an API delta — that inference is
  *impossible*, not merely unproven. The §6.7 nudge reads *"ship count changed — losses or a
  new build? worth a re-spy"*, and prefers surfacing **ship-count decreases** (discrete,
  unambiguous — losses/scrap) over increases (contaminated by passive eco-driven builds —
  the exact ambiguity that parked the API-delta tracker).
- **FS/online-window timing comes exclusively from spy-report presence/absence bracketing**,
  never from API deltas — and there is no future branch where API deltas become a bracket
  source, because the mechanic that would have enabled it is confirmed false. Even the
  spy-report bracketing is deferred to v3.1 (§12): it has five named confounds (moon-parking,
  fleet-split, defense-only baseline, observation-age skew, sibling-planet relocation) and
  needs sampling density a solo fleeter rarely reaches.
- **Documentation:** write the "in-flight fleets still count in `ships`/military" verdict
  into `docs/ogame-fleet-mechanics.md` in Etap 0 (it is the designated home for
  reverse-engineered rules), alongside a new activity-star section (the doc currently has
  neither). This is a one-line doc edit now that the fact is settled — no user experiment
  to run.

---

## 6. Concept — Spyglass v3 "Watchlist Workbench"

> **Thesis:** Spyglass is a per-universe, device-local **intelligence workbench for a chosen
> set of players**. It refines the free API danger estimate with spy reports, remembers what
> it saw over time, and answers one question per target: **raid or skip, and when.** It does
> not rank the whole server — the Danger column and GV already do.

### 6.1 One screen, no sub-tabs

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 🔭 Spyglass      [ 🔍 search player… ]      ships data 2 h old · 47 spied │ ← header + per-feed freshness
├───────────────────────────────────────────────────────────────────────────┤
│ WATCHLIST (5)                                     [ ▦ cards ] [ 🗺 map ]  │ ← landing view + view toggle
│ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐      │
│ │ Yoxid       D 82   │ │ Krak        D 61   │ │ Nova        D 12   │      │
│ │ RAID NOW · ~180M 💰 │ │ fleet home? skip   │ │ 0 ships 🛡 farm    │      │ ← raid verdict + loot (§6.4)
│ │ hidden ~340M       │ │ fleet 120M ✓       │ │ —                  │      │
│ │ ▁▂▅▇▅▂▁ evenings   │ │ ▁▁▇▇▂▁▁ evenings   │ │ —                  │      │ ← activity sparkline
│ │ scan: 2 stale ⚔    │ │ fresh 6 h          │ │ —                  │      │ ← intel age + ⚔ in-band
│ └────────────────────┘ └────────────────────┘ └────────────────────┘      │
├───────────────────────────────────────────────────────────────────────────┤
│ ▸ SCAN NEXT (3 planets) · Yoxid 3:11:7 — stalest high-D · in-game Spy btn │ ← plan strip + "why next"
├───────────────────────────────────────────────────────────────────────────┤
│ ▸ FINDER — whole server   [ in-range only ]  show top 100 ▾  sort Danger ▾│ ← finder (collapsed)
└───────────────────────────────────────────────────────────────────────────┘
```

- **Watchlist cards are the landing view** (empty state: "Nobody watched yet — open the
  Finder below and ⭐ the players you care about").
- **Finder collapsed** behind a `<details>` — the 14-column wall stops being the first thing
  you see.
- **Clicking a card or row opens the Dossier** — a full-width accordion panel in place (one
  open at a time; **row-anchored insertion** so the grid doesn't jump). Navigation uses one
  addressable in-memory value `{view, playerId}` (replacing the three ad-hoc mutables
  `focusedTargetId` / `expandedTargets` / `mapHighlight`, index.js:1093-1104). It is **not
  persisted** across reloads — a stale persisted id renders an empty dossier; a routed id
  absent from the candidate set falls back to the watchlist view.
- **Map is a toggle** on the watchlist (v3.1) — same set, spatial rendering.
- **GV → Spyglass deep-link** (`openSpyglassFor`) opens the **dossier** directly — it can
  never silently no-op again. It does **not** auto-⭐ (navigation must not mutate the
  watchlist); the dossier carries the ⭐ button.

Flow: `FINDER —⭐→ WATCHLIST ←→ DOSSIER → SCAN STRIP → in-game FAB → messages page →
targetsIngest → estimates firm up` (the loop closes).

### 6.2 The Finder — 7 columns, and the fate of all 14

| # | Column | Shows | Sortable |
|---|--------|-------|----------|
| 1 | **⭐** | watch toggle (absorbs the "+ scan" chip — watched = tracked = on the scan list) | — |
| 2 | **Player** | name + status glyphs (v/i/b) inline; whole row = dossier click target | — |
| 3 | **Danger** | `D 82` coloured (shared `lib/dangerColor`) + archetype word inline (`raider`) | ✓ (default, desc) |
| 4 | **Fleet** | the interval: `≤340M` (bounded) or `120M ✓` (spied-exact) | ✓ |
| 5 | **Military** | compact score + `#rank` | ✓ |
| 6 | **Ships** | count, or `0 🛡` green (pure defense — cannot attack) | ✓ |
| 7 | **Intel** | `○` never / `◐` partial / `●` complete / `⚠` stale | ✓ |

Fate of the current 14: **Scan chip → merged into ⭐** · **# → CUT** (post-sort ordinal,
references nothing) · **Player → kept** (no caret/⌖ fight; ⌖ moves to dossier+map) ·
**Danger/Fleet/Military/Ships → kept** · **Destr, Highscore → dossier** (character facts,
not pick-who-to-watch facts) · **Defense, Visible → dossier** (spy-only) · **Hidden → the
watchlist card headline + dossier math** (never a whole-server column again) · **Scanned +
Coverage → merged into Intel glyph**.

Filters: Military min/max stays (small, useful); top-N stays and **persists** (fixes the
loses-on-reload bug, index.js:1176-1186); a single default-on "hide inactive" toggle
replaces the three include-checkboxes; a top-level **"in-range only"** toggle (default off,
band math already computed); **Attack range selector and the whole "⚙ More filters" block
are deleted**. No watched-only checkbox (the watchlist IS the watched view). Default sort
Danger desc. `militaryRank` (parsed, never used, targets.js:311) is dropped from the
candidate shape; `pl-PL` (targets.js:41) → the UI locale.

### 6.3 Watchlist cards

Per card, top to bottom: name + D badge + archetype · **the raid verdict + loot line**
(§6.4) · the headline number (hidden/fleet estimate, `✓` when spied-exact; or `0 ships 🛡`)
· a 7-bin **hour-of-day activity sparkline** + one-word label ("evenings") · intel age +
`⚔` when the player is in your legal attack band. Card colour-accent = the player's stable
colour (id-hash, so it's consistent when the map ships — §6.5). Click → dossier.

### 6.4 The raid verdict + loot estimate (the jack point)

This is the single most important *new* surface: the daily loop ends in one decision, so the
card must answer it. A pure `domain/raidVerdict.js` composes signals we already compute into
one confidence-tiered line — **no new data, honest bounds**:

```
verdict(player) from: dangerToMe (can he hit back?), fleetHome? (spied fleet present
recently vs likely saved), lootNow (last-spied resources grown to now × loot fraction),
intelAge (how stale is this?), inBand (legal to attack?)
```

- **`lootNow`** = the last spy report's on-planet resources (`data-raw-resources`, now known
  to be in the dataset — §9) **projected forward by the target's ACTUAL mine output** (from
  the report's `buildings` levels — metal mine id 1, crystal id 2, deut synth id 3, plus
  boosters) over the elapsed hours, capped at storage, × the **report's real `loot` fraction**
  (75%, or more on honourable targets — no longer an assumed ½). Shown as `~180M 💰` with a
  confidence tier from intel age (`~` widens as the report ages; hollow if never spied). This
  is a *grounded* estimate, not a guess, because the mine rate and loot % come straight from
  the report. **This is what the user asked for** — "atak na surowce, wtedy kiedy jest ich
  dużo". (The mine-rate projection is optional polish; a flat "last-spied resources, aged"
  value works on day one.)
- **Verdict labels** (glanceable): `RAID NOW` (loaded, fleet likely home/small, in band,
  low danger-to-me) · `fleet home? skip` (big hidden fleet present recently — bounce risk) ·
  `skip — empty` (freshly spied, nothing to take) · `scan first` (no/old intel) · `can't hit`
  (out of band). Never a bare number without a tier; never claims certainty the data can't
  support.

This is deliberately **not** the rejected sortable "Worth" column — it is a card/dossier
verdict at the decision moment, with explicit tiers, not a precise number racing to the top
of a table.

### 6.5 The Dossier — everything tooltip-only today, given a place (Etap B)

Full-width accordion, row-anchored, one open at a time. Reuses the GV accordion
identity-key pattern (freeStreak.js:1587-1669). Sections:

```
┌ Yoxid · s163-pl · #14 military · ⭐ watched · Reach: 2 sys · ⚔ in band · 🗺 map ──┐
│ RAID VERDICT   RAID NOW · loot ~180M 💰 (report 6 h old, medium)                  │ ← §6.4, repeated as depth
│ DANGER 82/100  "Bandit raider"                                                    │
│  Mobile fleet  [██████████░░░░]  120M ─────────── 340M   (spied floor → ceiling)  │ ← mobileLo..mobileHi bar
│  why: · 8,400 ships · destroyed 2.1B (top 3%) · bandit tier 2/3                    │ ← reasons[] as bullets
│       · planets across 3 galaxies · spied 4/6 (defence floor)                     │
│ CIVIL BASELINE  Economy #40 → expected ~2,100 civil ships. Has 8,400 →            │
│  ~6,300 look like COMBAT fleet. ⚠ upper bound until spied · medium confidence.     │ ← §7 verdict line only
│ HIDDEN FLEET   military 620M − defence 180M − visible 100M = ~340M hidden          │ ← the subtraction shown
│  coverage 4/6 bodies (2 moons unscanned)                                           │ ← honest, moon-aware (Etap 0)
│ PLANETS (6) · 2 need a scan                                                        │
│  [1:203:4 ● 6h ⭐hoard F 340M ⚔] [2:44:12 ⚠ 9d [scan]] [3:11:7 ○ [scan]] …         │ ← ⭐hoard, ⚔, per-planet scan
│ ACTIVITY  ▁▁▁▂▅▇█▇▅▂▁▁  evenings 19-22   · coverage ▁▁▁▂▃▃▂▂▂▁▁▁ (n=12)            │ ← strip + mandatory coverage row
│ COLLECTION PLANET  usually 1:203:4  (5 of 7 spies with high resources)            │
│ SPY HISTORY   6h 1:203:4 def 90M fleet 340M (fleet home!) · 9d 2:44:12 def 40M f 0 │ ← timeline, per-ship deltas
└───────────────────────────────────────────────────────────────────────────────────┘
```

Reused with zero domain work: the interval bar renders `mobileLo`/`mobileMil`/`mobileHi` +
`provenance` (already on every profile, dangerScore.js:366); `reasons[]` as bullets;
`buildSystemCard` for a "who else lives here" popover. The dossier's view logic follows the
**pure-core rule** from the start (interval-bar math, subtraction math, scatter binning in a
pure helper; thin DOM renderer) — `freeStreak.js` is already 4× the ~400-line orchestrator
guideline and must not spawn a second monolith.

### 6.6 Routine tracker — spy-report history, sample-honest (Etap F)

**The one schema change** (§10.1) turns `targetReports[pid][bodyKey]` from a single report
into `{ latest, history }`. `history` is a bounded ring (≤24/body) of
`SpyReportLite = { ts, activityMin, resTotal?, fleetValue, defenseValue }`. `activityMin`
and `ts` are already parsed and persisted — we only stop the overwrite from discarding them.

Visuals, each **n-gated** (hint <5 / pattern ≥5 & ≥70% consistent / strong ≥10 & ≥80%) and
each with a **mandatory coverage row** (samples per bin) — the coverage row is a fair-play
*asset*: it visibly proves the tool only knows what the user sampled, and it exposes the
user's own evening-biased sampling so an "evening player" read can't be an artifact:

- **(a) Hour-of-day activity strip** — fed by **two** sources now (§6.6bis): the spy report's
  activity field AND the far denser galaxy-view activity marker. Encoding is now **known
  exactly** (user-confirmed, no calibration needed): the game exposes activity per body as
  `active <15 min` (a dot, exact minute hidden), `15–60 min` (the **exact** idle minute is
  exposed), or `none` (>60 min / never). Modelled as `{ ACTIVE_LT15, MINUTES(15..60), NONE }`.
  Per-body markers are **OR-ed across the player's bodies** for the account read, keeping the
  per-body marker for (c) and the deferred FS work. **Critical honesty caveat (see §6.6bis):
  "activity" is not "online" — it is "this body was interacted with", and one of those
  interactions is our own probe.** Every activity visual is labelled "activity", never
  "online", and self-induced markers are discounted.
- **(b) Weekday resource pattern** — median total resources by weekday ("richer on
  Wednesday", the user's explicit ask). Fed by `resTotal` (`data-raw-resources`), now
  **confirmed present in the dataset** (§9) — no spike, no fragility. Populates slowly; hollow
  until ≥2 samples/weekday. Framed as secondary intel, not the primary decision number (that's
  `lootNow`, §6.4).
- **(c) Collection-planet callout** — one sentence: the body most often holding the max
  resources ("gathers onto 1:203:4, 5 of 7 spies"). Serves "does he gather onto one planet
  before fleet-save".
- **(d) Plain spy-history timeline** — newest first, with per-ship deltas between
  consecutive obs (from the persisted-but-unused fleet/defense maps). This gives the same
  present/absent data as FS-bracketing **without** the strike-timing framing/confounds — it
  is the honest v3 substitute for the deferred bracketing visual.

**FS-window interval bracketing is v3.1** (§12): departure arcs from (present,absent) pairs
are the highest-value strike-timing output but ride five confounds; ship it only once real
sampling density justifies it, and only with same-bodyKey pairing + sibling-body relocation
checks + moon-gate downgrades + defense-only suppression, always as an interval never an
instant. (The ships-in-flight question that would have offered an API-based bracket source is
settled — §5 — so this stays spy-report/galaxy only, permanently.)

### 6.6bis The activity marker — exact semantics, a third data source, and its trap

The activity marker (aktywka) is now fully understood (user-confirmed 2026-07-04), and it
turns out to be a **third, denser, probe-free intel source** that OG-E already observes and
throws away.

**Exact encoding** (per body — planet AND moon independently). The galaxy
`fetchGalaxyContent` JSON carries `activity: { showActivity, idleTime }` per planet/moon:

| Game state | JSON | Meaning |
|---|---|---|
| Fresh dot (no number) | `showActivity: 15, idleTime: null` | interacted with in the last **0–15 min** (exact minute deliberately hidden) |
| Number shown | `showActivity: 60, idleTime: N` (15 ≤ N ≤ 60) | interacted with **exactly N minutes** ago |
| No marker | `showActivity: false, idleTime: null` | no interaction in the last **60 min** (or never) |

The spy report's `activity` field mirrors this (`'*'` = <15 min, else the minute), already
parsed to `activityMin` (espionageReport.js:151). So the resolution is: **exact minute in the
15–60 band, a coarse "<15" for the freshest band, nothing past 60 — ceiling 60, not 45/59.**
This closes the open question the validator flagged; **no calibration experiment is needed**.
Record it in the new activity-star section of `docs/ogame-fleet-mechanics.md`.

**The third data source — galaxy-view activity, already observed, currently discarded.** The
MAIN-world bridge `bridges/galaxyHook.js` already observes every `fetchGalaxyContent` the user
browses, but `domain/scans.js classifyPosition` (scans.js:273) **does not extract `activity`**,
and `state/scans.js` strips positions to lifeform-markers on persist anyway (verified). So the
activity marker flows through OG-E and is dropped. Capturing it is a small parse add
(`parseActivity(planet.activity)` in the galaxy path) + a compact persisted per-body activity
observation. **This is what makes the hour-of-day strip actually viable** — the user browses
galaxy constantly (colony hunting, checking systems) for **zero probes**, so galaxy activity
is far denser than the handful of spy reports a week; it covers whole systems, not just spied
planets. Fair-play: it's the same passive-observation-of-your-own-rendered-galaxy the bridge
already does — GREEN, and cleaner than spying (no game request originated).

**The trap — "activity" is NOT "player online".** The marker fires on *any* interaction with
a body, and the design must never conflate the two (validated by the user's own examples):

- A genuine **login/action** by the owner — the read you *want*.
- The owner's **own fleet returning** from a flight (possibly an FS landing).
- **Incoming espionage — including OUR OWN probe** (self-induced!). Re-scanning a body within
  15 min shows "activity" in the report that *we* caused — trivially misread as "he's online".
- **Incoming resource delivery** or **an incoming attack**. On a long-inactive account (the
  Gebels example: idle 28+ days, yet 42-min activity), the marker is almost certainly *someone
  farming him*, not the owner — a genuinely different, also-useful signal ("this farm is
  contested — someone is already on it").

Design consequences, all mandatory:

1. **Never label it "online".** Copy reads "activity" / "interacted", never "online"/"logged
   in". The routine strip is "activity by hour", honestly caveated.
2. **Discount self-induced activity.** If OG-E caused an interaction with that body recently
   (our own probe/attack — known from the sent-coords set / rescan map / our fleet dispatch),
   drop the resulting marker from the routine — otherwise the tool literally measures its own
   scanning rhythm. This is the single most important honesty rule of the whole tracker.
3. **Read activity on a known-inactive account as farm-contention, not owner presence** — and
   surface it as such ("actively farmed") where it helps target selection.
4. **A genuinely-playing account shows activity across MANY of its bodies in bursts** during
   its play hours; a farmed idle shows activity only on the farmed bodies at the *farmer's*
   hours. The pattern-over-many-bodies is the honest signal; a single active body is weak.

### 6.7 Scan plan — proposes + ranks; the FAB still sends one probe per user tap (Etap G)

The current FAB proposes planets in watch-list order then g→s→p (arbitrary,
sendSpy/pure.js:74-98). v3 ranks the needs-scan set by a pure, testable priority:

```
priority(planet) = dangerWeight(D) × stalenessWeight(status, age) × windowBonus(now, routine)
  dangerWeight    = 0.3 + 0.7·(D/100)
  stalenessWeight = never→1.0, rescan→0.9, stale→0.3+age-ramp, fresh→0 (excluded)
  windowBonus     = ×1 default, ×~1.3 when NOW falls inside the target's observed active
                    window (passive re-rank only — never a toast, never a timer; framed
                    "good moment, based on intel you gathered")
```

Per-player cadence spends the plumbed-but-unused `deriveSpy env.staleMs`: `D≥60 → 2 d,
D≥30 → 4 d, else 7 d` (hot targets go stale sooner). The FAB walks *this* order — a one-
function change (feed `deriveSpy` the comparator + `staleMs`). The dashboard shows the plan
as a **collapsed strip** with a **"why next" one-liner** ("stalest high-D target" / "active
window open now") — plans only, **no send buttons** (fair-play: the dashboard is
extension-origin and can't send; one-tap-one-send must stay a deliberate in-game tap). A
pre-flight **`shipAvailability()`** readout (probes on hand vs needed) prevents the failed
tap. The never-deleted rescan map is **pruned on hydrate**, and the `noShips` label bug is
fixed (compare the plural, keep the distinct singular `noShip` case).

### 6.8 Player search (Etap D)

A **header search box**, visible across the whole tab. Substring/case-insensitive over the
FULL candidate set — matches **nick + coords + alliance tag**. Results render as the same
card component, each with inline ⭐ and click-to-dossier. **Crucially it finds EXCLUDED
players and says why**, consuming the `targetExclusionReason` causes the domain computes and
currently reduces to a boolean (targets.js:129): each hit shows `hidden: inactive / admin /
your alliance` + a **[show anyway]** override. No player is ever silently dropped, and the
GV deep-link resolves through the same path so it can't no-op.

### 6.9 The Spyglass map (v3.1, isolated release)

Multi-player overlay reusing GV's colonization-agnostic substrate — **but this is a refactor,
not a reuse**: `buildComposite`/`buildScoreField`/`showPlayerOnMap` are private in
`index.js` and `buildSystemCard` is private in `freeStreak.js`, all glued to module-local
mutables. The pure pieces (composite, score field, `cellClass`) are already in `domain/` —
import directly. The DOM pieces (popover, spotlight overlay, pin↔row linking) get lifted into
a **new `features/dashboard/mapPrimitives.js`** (both Spyglass and GV are sub-tabs of the
*same* dashboard feature, so this crosses no import zone). Overlay: per-player **stable
colour by id-hash**, danger-scaled marker size, own planets as bright white rings (the
reference frame); click a system → popover, click a player marker → dossier; omit farm heat
/ free-slot pins / zone-fit. Optional opt-in "can reach me tonight" overlay inverts the
`reachThreat` kernel (spends the dropped `mineMinDist`). Extract as a thin module, not by
threading GV's 21-param options bag.

### 6.10 "Who's probing me" — defensive intel from proximity reports (Etap D, small)

Fills the completeness-critic's flagged gap ("defensive reciprocity is absent"). OGame emits
**"foreign fleet spotted near your planet"** reports (sender "dowódca floty") whenever a fleet
is detected near one of your bodies — the user-provided payload shows several, carrying
`sourcePlayerId`, `sourcePlayerName`, `sourcePlanetCoordinates`, `sourcePlanetType`, the
`targetPlanet*` (your body), a `counterEspionageChance` and an `active` flag. OG-E **drops
them today** (the gate rejects `sourceplayerid`, espionageReport.js:233). They are pure
defensive intel — *who is scouting/attacking me, from where, how often*.

- **New second ingest path** (`isProximityReportBag` alongside the espionage gate): record
  `{ ts, byPlayerId, byPlayerName, fromCoords, atMyCoords }` into a small device-local
  "incoming" feed (bounded ring, watched-independent).
- **Surface** a compact **"Who's been near you"** strip on the Spyglass header (collapsed):
  "Mqres probed K13 · 17 h ago · from 4:494:8" with a ⌖/dossier link — so a scout becomes a
  named, locatable player you can watch, and a *repeat* prober (someone casing you before an
  attack) becomes visible. Cross-links to the same dossier/danger machinery.
- Still passive (reports the user opened while playing) → **fair-play GREEN**, same basis as
  the espionage ingest; classify it in the Etap-0a addendum with the others.

This is deliberately a *small* strip, not a second workbench — it answers "who's coming for
me" at a glance and hands off to the existing per-player surfaces.

---

## 7. Civil-fleet baseline / pts-per-ship (Etap C) — spend the dead economy feed

`domain/civilBaseline.js` (pure, `nowMs`-free — no time needed):

1. **Server civil standard** — for every player with both economy score (from the cached
   economy highscore feed) and ships (military feed), `expectedCivilShips ≈ median(ships |
   economy decile)` (a **binned median**, robust to the fleeters we're hunting).
2. **Per-player estimate** — `combatShips = max(0, ships − expectedCivil)`;
   `combatRatio = combatShips / ships`.
3. **Sharpen with scans** — for spied players, `military − defense = fleet pts`, `÷ ships =
   real pts/ship`; averaged across spied players → a **server pts/ship calibration** far
   better than the current `militaryScore×1000/ships` tooltip (which lumps in defense +
   probe swarms). Then un-spied `estimatedFleetPts ≈ combatShips × serverPtsPerShip`.
4. **De-bias the confounds using report-time fields (§9), for spied players** — the spy
   report now gives, per player: `highscoreEconomy`, `highscoreLifeforms`, and
   `characterClass`. So the model can (a) subtract/flag **lifeform-driven economy**
   (`highscoreLifeforms` large ⇒ eco is inflated without civil ships ⇒ don't read the residual
   as combat fleet — this is the validator's #1 named confound, now *measurable*); (b) use
   **class** as a prior (a *Zbieracz*/miner leans builder/farm, a warrior/general leans
   fleeter); (c) cross-check the report's own economy against the API feed to date score jumps.

**Honesty (validator-confirmed, must not be softened):** the eco↔civil-ship correlation is a
legitimate **weak prior**, broken by lifeform economy, deut/research-heavy accounts,
crawler-skippers, and probe swarms (each ~1 pt, dilute the ratio). So: **dossier verdict line
only**, never a table column, never fed into D until a calibration loop exists, always
confidence-tiered (high spied+complete / medium wide margin / low within one decile of noise),
always an **upper bound until spied**. The LF-heavy flag (now backed by `highscoreLifeforms`,
not guesswork) keeps a builder's residual from reading as hidden combat fleet. The eco-vs-ships
scatter (grey server cloud + decile-median line + this player) is an optional dossier nicety,
never a release blocker.

---

## 8. Fair-play — the compliance spine (Etap 0a, a HARD GATE)

`docs/fair-play.md` has **zero** Spyglass/spy/probe/espionage entries today — the whole
existing surface predates it. The addendum classifying the new surfaces **must land in the
first shipped Etap, before any new UI**, and Etap 0 does not close until it classifies each
new surface GREEN against an existing category. Validator-confirmed positions:

- **Public-API reads are GREEN** (`credentials:'omit'`, read-only, TTL cadence,
  fair-play.md:269-274). No new fetches are introduced. Restate the GREEN basis for the
  ships-attr / economy / destroyed / lost feeds (they post-date the classification).
- **One-tap-one-send is the shipped precedent** (v1.31.0, CHANGELOG.md:99-105). `scanPriority`
  only reorders which single planet the *one existing manual tap* proposes next — not a new
  game action. **Guard against drift:** the plan strip must never grow a "send"/"send all"
  affordance; `windowBonus` must never auto-advance past the send click.
- **Routine tracker + `windowBonus` "good moment" nudge** are the concept's highest
  *appearance* risk (they read like "OG-E watches this opponent over time"), though not a
  literal violation. They are defensible **only** on provenance: built from spy reports the
  user opened *while playing* (targetsIngest MutationObserver on the user's own rendered
  messages page) + public API read *while a tab is open* — never a background fetch, never a
  timer, never an alert-while-away. That defense lives entirely in framing + provenance, so
  it must be written into the addendum and enforced by wording discipline and a presence-gate.
- **Wording discipline** (extends the binding ntfy list, fair-play.md:99-119) — user-facing
  copy: "scan plan" / "suggested order" / "next suggested" / "stalest first" (never
  *queue/queued/pending*); the nudge reads "good moment based on intel you gathered" (never
  "scan now"/"due"/"scheduled"); routine visuals read "from reports you've opened" (never
  *track/monitor/watch/live/fires*). "Watchlist" as the tab name is fine (it's the player's
  own list); "watching \<player\>" is not. Internal identifiers/CSS/keys stay exempt.
- **Presence-gate is a hard invariant**, not a description: any tightened API cadence fires
  **only on a visible/foreground tab** (piggyback `lib/clock`'s visibility-aware tick, which
  already pauses when hidden), never via a background/timer path.
- **One consolidated ToolDev consult** — open it **before** engineering Etap F/G, framed
  provenance-first: *"Is a device-local intel workbench that summarizes an opponent's
  activity/wealth pattern purely from spy reports the player opened during normal play +
  public-API data read only while a game tab is open — no background fetch, no send, no
  alert, one-tap-one-scan preserved — a permitted display of intel the player gathered?"* If
  the answer is "summarizing opponent activity-over-time itself trips rule 4", Etap F/G's
  centerpieces are dead — so ask *before* building (§12).

No RED is present anywhere in the concept: no auto-send, no scheduled/delayed execution, no
background service worker, no `chrome.alarms`, no off-tab alerting (all validator-confirmed
absent).

---

## 9. RESOLVED — resources (and much more) are already in the dataset; normalizer-only

The earlier open question ("are resources in the inbox-row DOM or only the opened report?")
is **resolved by the raw `getMessagesList` response (user-provided 2026-07-04)**: the whole
inbox is fetched as `page=componentOnly&component=messages&asJson=1&action=getMessagesList`,
a JSON array of message-HTML strings, each carrying the full `.rawMessageData` dataset — and
**resources are right there as `data-raw-resources` plus per-type `data-raw-metal / crystal /
deuterium / population / food`.** OG-E's existing DOM observer already sees every one of these
attributes (the ingest bag is schema-free, targetsIngest/index.js:38-47); the normalizer just
never mapped them. So the resource feature is a **`domain/espionageReport.js` normalizer-only
change — zero new selector, zero body-DOM parse, zero fragility, no live spike needed.** This
**removes the concept's single biggest technical risk.**

**And it is not just resources.** The same dataset carries a pile of fields OG-E drops today,
each now free (all verified in the user's live payload):

| `data-raw-*` field | Value → use |
|---|---|
| `resources` + `metal`/`crystal`/`deuterium`/`population`/`food` | exact on-planet stock → `lootNow` (§6.4), weekday heatmap (§6.6b) |
| `loot` | the **exact loot %** (75, or higher on honourable targets) → `lootNow` uses the real fraction, not an assumed ½ |
| `counterEspionageChance` | probe-loss risk → scan-safety / "how many probes" advice |
| `highscoreEconomy` / `highscoreResearch` / `highscoreLifeforms` | **all four score axes at report time** → the civil-baseline model (§7) gets per-spied-player economy directly, plus a **lifeforms score to detect the LF-heavy accounts that break the eco↔ships correlation** |
| `characterClass` (miner / warrior / general / …) | the player's chosen class → a *Zbieracz*/miner is a builder-farm, a warrior/general is a fleeter: a direct civil-vs-combat and danger signal |
| `buildings` (`{1:mine,2:mine,3:synth,…}`) | **mine levels → real hourly production** → `lootNow` projects resources forward from the last spy with the actual mine rate, not a guess |
| `research` / `lfbuildings` / `lfresearch` | fleet/defense/drive tech + LF tech → combat-sim accuracy, astro (max planets), LF-economy confirmation |

`resTotal` (and the richer fields) stay **optional** in `SpyReportLite` (omitted when a report
lacks them — e.g. a partial scan), so routine (c)/(d) and the danger/hidden math still work
without them; graceful degradation, never fatal.

**Three mechanics notes from the live payload, to bake into the parser:**

1. **Partial / resources-only reports are common, valuable, and DROPPED today (§9bis).** A
   low-probe or high-counter-espionage scan reveals *only some sections*. The user's payload
   shows a report with `fleetValue='-'`, `defenseValue='-'`, no `fleet`/`defense`/`buildings`/
   `research` keys at all, but full `resources`/`metal`/`crystal`/`deuterium`/`population`/
   `food` + scores + class — and explicit `hiddenShips='1'`, `hiddenDef='1'`,
   `hiddenBuildings='1'`, `hiddenResearch='1'` flags (empty string `''` in a full report =
   section revealed; `'1'` = withheld). The **current gate rejects it** (it requires
   `defensevalue` to be numeric, espionageReport.js:230-236), so its loot number — the single
   most decision-relevant fact — is thrown away. **This is the report that feeds `lootNow` and
   the weekday-resource heatmap**, so admitting it (§9bis) is not a nicety; it is load-bearing.
2. **Activity in a report is `data-raw-activity`, encoded `-1` = ">60 min / none"**, `0`/`*` =
   active <15 min, positive integer = recently active (the report renders it "<N min", e.g.
   `18`→"<18 min"). Matches §6.6bis. The current parser
   (`raw.activity === '*' ? 0 : toNum(raw.activity)`, espionageReport.js:151) stores `-1`
   verbatim — so the enum mapping must treat `-1` as `NONE`, not "1 minute ago". Fix in the
   same normalizer pass.
3. **Proximity / "foreign fleet spotted near your planet" reports** carry `sourcePlayerId`,
   `sourcePlayerName`, `sourcePlanetCoordinates`, `sourcePlanetType` and are **dropped today**
   (the gate rejects `sourceplayerid`, espionageReport.js:233). They are **defensive intel** —
   *who is scouting/attacking me, from where* — and directly fill the completeness-critic's
   "defensive reciprocity is absent" gap. **New feature (§6.10):** a second ingest path records
   them into a device-local "who's probing me" feed, surfaced as a small defensive strip. Still
   passive (reports the user opened), still fair-play GREEN.

The `getMessagesList` endpoint is a `fetch()` (not XHR), so a MAIN-world XHR bridge won't see
it — but the DOM observer already captures the rendered `.rawMessageData`, so **no bridge
change is needed**; parsing more of the dataset is the whole job.

### 9bis. Partial reports — admit them, but keep the hidden-fleet math honest

The gate change is small; the *correctness* rule around it is the subtle part.

- **Admit a report when it carries usable intel of ANY kind** — replace the "defensevalue must
  be numeric" requirement with "has coordinates + targetPlayerId + at least one revealed
  section (resources OR defense OR fleet)". Record per-section completeness from the `hidden*`
  flags on the `SpyReport`: `revealed = { resources, fleet, defense, buildings, research }`
  (each = the corresponding `hidden*` attribute is empty, not `'1'`).
- **A partial report contributes to loot / routine / activity / scores, but its ABSENT
  defense and fleet must NOT be read as zero in the hidden-fleet subtraction.** Today
  `estimateHiddenFleet` sums `defenseValue + fleetValue`; if a resources-only report were
  admitted naively with those as `0`, it would report the player's *entire* military score as
  "hidden fleet" — a dangerous over-estimate in the unsafe direction. So `estimateHiddenFleet`
  and the coverage denominator must count a body as "defence-covered" only when
  `revealed.defense` (and ideally `revealed.fleet`) is true; a resources-only report advances
  loot/routine coverage but **not** defence coverage. (This composes cleanly with the danger
  engine's existing spied-vs-ships-floor gate — a partial report simply never claims the
  "spied-exact" provenance.)
- **Scan-economics signal for the planner (§6.7):** the `hidden*` outcome + `counterEspionageChance`
  tell you whether the last scan was too thin. A "just the loot" 1-probe check and a "full
  intel" many-probe scan are different intents; the planner can flag "resources seen, fleet
  still hidden — send more probes to firm up" without any new data. This is also why the
  `SpyReportLite` history entry keeps `resTotal` even from partial reports (loot rhythm), while
  defence/fleet history only accrues from reports that actually revealed them.

---

## 10. Data model changes (validation-corrected)

### 10.1 `state/targets.js` — the history ring, as a **read-time projection** (the one big change)

```
// BEFORE:  targetReports[pid][bodyKey] = SpyReport
// AFTER:   targetReports[pid][bodyKey] = { latest: SpyReport, history: SpyReportLite[] }  // ring cap 24
```

> ⚠ **Blocker corrected from the panel draft.** The claim "`latest` = verbatim old shape →
> all consumers untouched" is **false**: two dashboard consumers iterate the bucket **values
> as raw `SpyReport`s** — `index.js:1030` (`Object.values(bucket)` → `estimateHiddenFleet`)
> and `index.js:1039` (`Object.entries(bucket)` → per-planet table). After migration each
> value is `{latest, history}`, so `.defenseValue`/`.fleetValue`/`.timestamp` read `undefined
> → 0`, **silently zeroing every hidden-fleet estimate and danger spy-refinement server-wide**
> (verified: index.js:1030-1045). This is a data-corruption-class bug, not churn.

The correct mechanism — ship all of this in the **same commit** as the shape change:

- A pure `domain/targetReports.js` with `latestOf(entry) = entry.latest ?? entry` and
  `historyOf(entry) = entry.history ?? []`. Route **both** dashboard loops (index.js:1030,
  1039) and the store through it. `estimateHiddenFleet` still takes `SpyReport[]` unchanged —
  only the extraction in front of it changes.
- **Both read paths** (the reactive store hydrate, state/targets.js:98-106, AND the dashboard
  raw `chromeStore.get`, index.js:835/883-887 — which runs *no* shape migration by design)
  import the same projection. A hydrate-only rewrite would leave a dashboard-only device
  reading the new shape with old-shape code permanently.
- **Rewrite `normalizeReportTimestamps`** to descend into `.latest` + each `.history[]` when
  the value is the new shape (post-migration the top-level value has no `.timestamp`, so the
  current `r.timestamp > 1e11` test silently stops repairing ms values — a latent regression
  of the E0 fix). Keep the old-shape branch for back-compat; both paths call the same
  normalizer, closing the divergence.
- **`recordReport`**: on a strictly-newer report, replace `latest` **and** append a
  `SpyReportLite` to `history` (ring-trim to 24). **Equal-ts guard = `>=` returns `cur`
  unchanged** (no store write, no history append, no `onChanged` fire) — kills the re-ingest
  churn and prevents duplicate history entries; leave `dedupeNewest`'s `>=` tie-break alone
  (separate read-time pass). Add a unit test: ingest the same report twice → exactly one
  history entry, one `onChanged`.
- **Retention as a WRITE-side gate, not a destructive sweep:** in `recordReport`, if the
  player is **not** in the watched set (`watchListStore.get()`, same isolated world), set
  `latest` but **do not append to history**. So history only ever accumulates for watched
  players; `latest` is structurally untouchable; un-watch→re-watch never wipes coverage; and
  there's no hydrate-time race against the async watchList load. Migration-cap unit test drives
  a mixed old/new bucket through both read paths.

### 10.2 New pure modules (no state, `nowMs` passed in)

- `domain/civilBaseline.js` — server curve + combat estimate + confidence tiers (§7).
- `domain/routine.js` — `history[]` → hour/weekday/collection summaries + n-gates + coverage
  rows (§6.6). Takes `nowMs` (matches `waves.js`); unit-tested with zero mocks.
- `domain/scanPriority.js` — priority comparator + `staleMs(D)` + `windowBonus` (§6.7).
- `domain/raidVerdict.js` — the go/no-go + `lootNow` composition (§6.4).
- `domain/targetReports.js` — `latestOf`/`historyOf` + shape-tolerant normalizer (§10.1).
- `lib/dangerColor.js` — `dangerColor(d) → hex`; reconcile the two drifted palettes
  (freeStreak.js:136 vs targets.js:264) to one. Palette belongs in `lib` (zero-dep
  foundation both sub-tabs import legally). Land in Etap 0.

### 10.3 `state/apiCache.js` — economy consumer + optional prior-value stash

Wiring the economy feed needs no shape change (already cached). If the "was-in-combat-this-
hour" activity signal is pursued (§10.5), add only a `prevScore` per destroyed/lost feed
entry (they are monotonic-cumulative, so `delta = score − prev` is exact from two adjacent
snapshots — no full series, no ambiguity, +1 number/player/feed). **Do not** build a general
persisted per-feed time series (that's the parked ambiguous-delta trap; it applies to
military/ships, not to the monotonic destroyed/lost).

### 10.4 `state/watchList.js` — **stays device-local; sync DEFERRED out of v3**

Splitting `{players, probes}` into gist sync re-opens the **C6 silent multi-universe-wipe**
class (a device that hydrates an empty `players[]` before the legacy migration runs, then
uploads it with a fresh Ts, clobbers the other device's real list). There is **zero
functional dependency** — routine, dossier, finder, verdict, plan all work fully device-
local. So watchlist sync is **cut from v3 entirely** (not "optional"). If ever added, it is
its own isolated Etap with its own user confirmation, a C6-safe "never upload a just-hydrated
empty list with a newer Ts" guard, and **union** (not replace) merge since starring is
monotonic intent.

### 10.5 Storage budget (validator-recomputed) & safety

- `SpyReportLite` ≈ 96 B JSON. Realistic worst case: 20 watched × ~9 bodies × 24 × 96 B ≈
  **~432 KB history**. The **dominant term is `latest`** — a full `SpyReport` with two
  per-ship count maps is 400–1500 B; 20 × 9 × ~800 B ≈ **~144 KB**. So **~580 KB per
  universe**, per device; a 5-universe player ≈ **~2.9 MB across keys**.
- **No `unlimitedStorage`** is granted (manifest.json grants only `"storage"`) → the Firefox
  ~5 MB `storage.local` floor is the ceiling, and `apiCache` (multi-MB universe.planets + 6
  highscore maps) **co-tenants the same pool**. Margin is real but thinner than it looks.
- **Hold the line on `SpyReportLite`** — never let per-ship maps leak into `history` (that's
  why `latest` keeps them and `history` doesn't).
- **Write amplification:** both stores are wholesale write-through. Growing each body to
  `{latest + 24 history}` multiplies the `targetReports` serialised payload ~10–25× per
  write; keep the 200 ms persist debounce (do not lower it). **Do not tighten destroyed/lost
  TTL** toward hourly without first splitting `apiCache`'s hot hourly feeds (military/honor/
  total) into a **separate key** from the cold multi-MB universe.planets blob — otherwise it's
  a multi-MB write per hour (§12). Default: **defer the TTL tightening**.
- **Quota safety:** `chromeStore.set` rejects on quota but persist is fire-and-forget →
  quota failure is **silent data loss**. Catch it in the save closure and drop oldest history
  first.

---

## 11. Implementation phases (Etapy) — validation-corrected, ordered, each shippable

All Etapy are **blocked-on** a green, merged 1.34.0 (not "coordinated with"); Etap A rewrites
the exact `targets.js` / `index.js` hot zones the in-flight GV-UX work also edits, and the
map refactor stays off `freeStreak.js` until 1.34.0 settles.

> **Progress: Etapy 0, A, B, C, D-search DONE + committed on `feat/spyglass-v3` (tree
> green). Full commit-by-commit status + the next-session plan is in §0 (top).**
> **Re-sequencing (design met code):** Etap 0b's *coverage-honesty* items — admit
> **partial** + **moon** reports, gate `estimateHiddenFleet` on `revealed.defense`, and the
> **bodies (moon) coverage denominator** — were **moved into Etap F** (the newest-per-body
> store would let a partial re-scan *evict* a full report's defence; the `{latest,history}`
> ring in F fixes it, per §9bis; moons entangle `playerPlanets`→`sendSpy`→coverage F reworks).
> **rescan-map prune** moved to Etap G. The rich-field normalizer, `revealed{}` map,
> `dangerColor` unify, and equal-ts guard shipped in 0b as the safe additive foundation.

| Etap | Goal | Key files | Store change? |
|---|---|---|---|
| **0a** ✅ | **Fair-play addendum** classifying all new surfaces GREEN (+ wording checklist). **Hard gate.** | `docs/fair-play.md` | no |
| **0b/E1** ✅ | Safe additive foundation: shared `lib/dangerColor.js` (reconcile drifted palettes); equal-ts `>=` ingest guard; **rich-field normalizer** — `resources`/metal/crystal/deut, `loot`, `counterEspionage`, `economy/research/lifeform` scores, `characterClass`, `buildings/research/lf`, `revealed{}` (from `hidden*` flags), `parseActivityMin` (`-1`→none). Gate UNCHANGED (partials/moons still rejected → deferred to F). | `lib/dangerColor.js` (NEW), `state/targets.js`, `domain/espionageReport.js`, `freeStreak.js`+`targets.js` (colour sites) | small (additive) |
| **A** | Collapse table 14→7 + cuts + Finder-collapsed + "in-range only" toggle + intro rewrite + persistence fixes. | `targets.js`, `dashboard/index.js`, `dashboard.html`, `domain/targets.js` (return exclusion causes; drop `militaryRank`) | no |
| **B** | Dossier (routed `{view,playerId}`, pure-core view logic): interval bar (`mobileLo`), reasons, hidden math, planets grid + ⚔/⭐hoard/[scan]/Reach; **raid verdict + loot proxy** on card+dossier. | NEW `dossier.js`, NEW `domain/raidVerdict.js`, `targets.js`, `index.js` | no |
| **C** | Civil baseline + spy-calibrated pts/ship; dossier verdict line (+ optional scatter). | NEW `domain/civilBaseline.js`, `index.js` (thread economy feed), `dossier.js` | no |
| **D** | Header search over full set incl. excluded players + reasons + [show anyway]; GV deep-link → dossier; **"who's probing me" defensive strip** (§6.10 — second ingest path for proximity reports). | `index.js`, `dashboard.html`, `domain/targets.js`, `domain/espionageReport.js` (proximity gate), `targetsIngest/index.js` | small (proximity feed) |
| **F** | Routine tracker + **coverage honesty** (consolidated from 0b): **`{latest,history}` migration as read-time projection on BOTH paths** (`latestOf`/`historyOf` + normalizer rewrite + write-side retention gate + migration test); **admit partial + moon reports** (gate change) with the ring preserving per-section defence; parse universe.xml `<moon>` → **bodies coverage denominator**; gate `estimateHiddenFleet` on `revealed.defense`; **capture galaxy-view activity** (`parseActivity` in `classifyPosition` + per-body activity ring, watched-only) with **self-induced-activity discount** (§6.6bis); `domain/routine.js`; activity strip (two sources) + coverage rows + weekday pattern (`resTotal`) + collection callout + spy timeline. **Gated on the ToolDev OK.** | NEW `domain/targetReports.js`, `state/targets.js`, `domain/espionageReport.js` (gate), `domain/threatModel.js`, `apiOccupancy.js`+`index.js` (moon denominator), `targetsIngest/index.js`, `bridges/galaxyHook.js`+`domain/scans.js` (activity), NEW `domain/routine.js`, `dossier.js`, card | **yes (the one migration)** |
| **G** | Scan plan visibility + priority: `domain/scanPriority.js` (danger×staleness×windowBonus) + `staleMs` cadence + FAB walks the order + "why next" strip + `shipAvailability()` pre-flight + `noShips` label fix + **rescan-map prune** (moved from 0b). **`windowBonus` gated on the ToolDev OK.** | NEW `domain/scanPriority.js`, `sendSpy/pure.js`+`index.js`, `index.js` (strip), `state/watchList.js` (prune) | no |
| **v3.1** | Spyglass **map** (extract `mapPrimitives.js`; multi-player overlay; reach overlay) + **FS-window bracketing** (if sampling density justifies) + optional watchlist sync (isolated, C6-safe). | NEW `mapPrimitives.js`, `index.js`, `domain/routine.js` (brackets) | maybe |

**Release**: v3 core = Etapy 0,A,B,C,D,E1,F,G → **minor 1.35.0**. Reconcile tests (the 1.34.0
debt per RELEASE-HANDOFF.md:93-116 + the new pure modules `raidVerdict`/`civilBaseline`/
`routine`/`scanPriority`/`targetReports` + the migration-cap + both-read-paths test), add the
dated CHANGELOG section, bump `package.json` + `manifest.json`, `chore(release): 1.35.0`, push
to `main` (confirm first — public auto-updating release). Map + bracketing + sync land as
**1.36.0**.

---

## 12. Decisions that need your sign-off (read this)

Six choices shape scope; I've recommended each, but they're yours — two can invalidate whole
Etapy, so decide before engineering starts. (Your galaxy + messages-list payloads already
settled two former risks: the ships-in-flight mechanic and the resource-parse source — both
resolved in the design's favour, so they are *not* on this list any more.)

1. **Leaner v3 cut line.** **Recommend:** ship 0/A/B/C/D/E1/F/G (watchlist + finder-collapse +
   dossier + raid-verdict + civil-verdict + search + defensive strip + rich-field parse +
   activity/weekday/collection routine + scan-plan), and **defer the map, FS-window bracketing,
   and watchlist-sync to 1.36.0**. This drops two unanimous judge-grafts (map, FS-bracketing)
   in favour of shipping the actionable core sooner — hence your call.
2. **FS-window bracketing: cut from v3?** **Recommend cut** (→ v3.1). Heaviest, noisiest, five
   confounds, rides the undocumented activity star, and needs sampling density a solo fleeter
   rarely has; the plain spy-history timeline (§6.6d) gives the same data honestly. Overrides
   the intel-proposal graft, so flagging it.
3. **ToolDev consult — now vs build-then-ask.** **Recommend consult NOW**, before Etap F/G.
   The routine tracker + `windowBonus` are defensible on provenance, but if the ToolDevs rule
   that "summarizing opponent activity-over-time" itself trips rule 4, two whole Etapy die —
   cheaper to ask first (the ntfy precedent was gated exactly this way).
4. **Raid verdict + loot on the card.** **Recommend adopt** — it's the actual jack point and
   your stated goal ("atak na surowce, kiedy jest ich dużo"). It's kept honest (confidence
   tiers, bounds) and is *not* the rejected sortable "Worth" column. Flagging it because it
   partially reverses a panel concern-fix that kept economy-derived value out of prominent
   surfaces.
5. **destroyed/lost hourly-TTL tightening.** **Recommend DEFER** unless the `apiCache` hot/cold
   key-split lands first — otherwise it's a multi-MB write per hour and the strongest
   "monitoring" appearance, for a marginal "was-in-combat-this-hour" signal.
6. **The store migration is bigger than the panel draft said.** **Confirm** it ships as the
   dual-path `latestOf`/`historyOf` projection + normalizer rewrite + write-side retention +
   migration test, all in one commit (§10.1) — a blocker inside Etap F, not a follow-up.

---

## 13. Risks & open questions

- **Migration data-corruption (Etap F)** — now the biggest technical risk (the resource-parse
  risk it used to share the top with is gone); mitigated by the read-time projection on both
  paths + the migration-cap test (§10.1). Never ship the shape change without the accessor
  refactor in the same commit.
- **`resTotal` source — RESOLVED (§9).** Resources (and loot%, counter-esp%, economy/research/
  lifeforms, class, buildings/research) are all in the `.rawMessageData` dataset, confirmed via
  the `getMessagesList` payload — a normalizer-only change (Etap E1), no spike, no fragility.
  This retires what was a top risk.
- **Activity-marker semantics — RESOLVED** (§6.6bis, user-confirmed): `<15 min` dot / exact
  minute in the `15–60` band / none past 60, per body. No experiment needed; write it into
  `docs/ogame-fleet-mechanics.md` in Etap 0. The *residual* risk is interpretation, not
  encoding: activity ≠ online. The **self-induced-activity discount** (don't count markers our
  own probes/attacks caused) is a mandatory correctness feature of the routine tracker, not a
  nicety — without it the tool measures its own scan rhythm.
- **Fair-play appearance** — the routine tracker's defense is provenance + wording + presence-
  gate; all three are load-bearing and enforced in Etap 0a. The coverage rows are a compliance
  asset (they prove the tool only knows what the user sampled) — keep them mandatory.
- **Storage headroom** — ~2.9 MB across 5 universes shares a ~5 MB pool with `apiCache`; hold
  `SpyReportLite` lean, catch quota rejections, drop oldest history first.
- **Map extraction cost (v3.1)** — a multi-day refactor of private, state-glued functions in a
  1,826-line monolith; treat it as its own release with its own test pass.
- **1.34.0 entanglement** — Etap A and the in-flight GV-UX work edit the same files; hard-gate
  Etap A on a merged, green 1.34.0.

---

## Appendix — one-paragraph pitch

Spyglass stops being a 14-column discovery wall (the free `ships` feed already does discovery)
and becomes a **watchlist workbench** answering one question per target — *raid or skip, and
when*. The handful of players you track are fat cards with a **glanceable raid verdict + loot
estimate**, an activity sparkline, and the one fleet number that matters; a per-player
**dossier** finally gives a home to everything that's tooltip-only today (the honest fleet
interval, the civil-fleet verdict, the hidden-fleet subtraction, the spy timeline, the
routine). A shrunk 7-column **Finder** (collapsed) feeds it; **search** finds anyone — even
the excluded — and says why they're hidden; a **priority scan plan** ranks who to spy next by
danger × staleness × active-window and hands it to the existing one-tap in-game button. Every
number pays rent, the danger model keeps all its bounded-honesty depth, it stays strictly
inside fair-play (one-tap-one-send, no watching-while-away), and it runs entirely on data OG-E
already downloads and throws away.
