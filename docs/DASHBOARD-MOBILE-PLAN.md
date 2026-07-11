# DASHBOARD-MOBILE-PLAN — mobile-first dashboard + the settings spirit

Transient plan doc (CLAUDE.md lifecycle: delete when the cycle closes).
Written from a full audit of `src/dashboard.html` + every dashboard render
module, and an inventory of the settings-panel design language this plan
transplants. Execution is meant for a SEPARATE session, phase by phase —
each phase ships independently (build → verify on a phone → commit).

## 0. Doctrine

- **Mobile-first becomes the primary verification target.** Design and test
  at 360–430 px / touch FIRST; desktop is the enhancement. This inverts the
  historical habit (desktop-first testing) — the codebase is closer to ready
  than the habit suggests (see §1 "already good").
- **Evolution, not redesign.** The dashboard and the settings panel already
  converge on one language (accent `#4a9eff`, dark `#0b…#12` surfaces,
  8px/999px radii, chip vocabulary, `@media (hover:hover)` discipline). The
  work is to (a) fix the real mobile breakage, (b) upgrade the dashboard's
  control clusters to the settings' newer idioms.
- **One hard new rule: data must never live ONLY in `title=`.** The
  settings' "keyword captions, sentence tooltips" rule survives, but on
  touch a tooltip does not exist — a tooltip may EXPLAIN, it must not be the
  only carrier of a number or a verdict. (Today it often is — §1.3.)
- **Non-goals:** no framework, no CSS preprocessor, no new tabs, no rewrite
  of the render modules' inline-style idiom (hoist a shared class into
  `dashboard.html` only when ≥2 modules repeat the style — mirrors the
  gameDom hoisting rule). No visual rebrand: same palette, same rhythm.

## 1. Ground truth (audit, 1.44.0 tree)

### 1.1 Already good — preserve and extend
- Correct `viewport` meta (dashboard.html:5).
- Base layout is genuinely mobile-first: every content grid defaults to ONE
  column and adds columns via `min-width` queries (`.spy-top` :412,
  `.dossier-grid` :470, `.gv-intel-row` :502, `.rem-pane-grid` :589,
  `.cfg-grid` :267-268); only one `max-width` rule exists (:591).
- All three canvas maps size to `hostEl.clientWidth` + dpr scaling
  (freeStreak.js:349/652, mapPrimitives.js:328) — responsive width.
- The Spyglass players table already has the correct pattern: an
  `overflow-x:auto` wrapper (targets.js:802-805).
- Touch discipline exists for chips: hover paint gated behind
  `@media (hover:hover)`, `:focus-visible` rings, transparent tap-highlight
  (dashboard.html:363-406). Extend, don't reinvent.
- Histogram chart shrinks to viewport instead of scrolling
  (dashboard.html:76-88).

### 1.2 The breakage, ranked (worst first)
1. **`.tabs` cannot wrap** (dashboard.html:32): 5 nowrap tab buttons ≈
   480 px intrinsic → the whole PAGE scrolls sideways on every phone.
2. **Top bar is not sticky** (dashboard.html:26-31): switching tabs from
   the bottom of a long tab (Spyglass table, open dossier) = a full scroll
   back up.
3. **Dossier per-body table** (7 cols, nowrap, NO wrapper —
   dossier.js:432-446): overflows horizontally at 380 px.
4. **Galaxy Viewer streak table** (9 cols — freeStreak.js:884-940) and
   **candidate table** (7 cols — freeStreak.js:1248-1301): no wrapper,
   squish/overflow at 380 px.
5. **Hover-only data**: exact military / res-per-ship / danger reasons only
   in `title=` (targets.js:196-254), census stats (freeStreak.js:995-1031),
   map readouts on `mouseenter`/`mousemove` only (freeStreak.js:198, 480,
   710; mapPrimitives.js:384-388) — all invisible on touch.
6. **Sub-36 px tap targets**: `.smap-pin` 13 px (dashboard.html:539),
   `.strip-cell` 2-6 px (:130,:152), dossier `⊘/⟳` + `↻`
   (dossier.js:527-535, 860-866), `+ watch` chip (targets.js:151), routes
   `✕/▲/▼` (routes.js:208-227), `.rem-cancel ✕` (:675), offset-chip `✕`
   (:279).
7. **`serverMapSep` slider**: range 2–250 on a 260 px track
   (dashboard.html:855) — needs single-system precision, unusable by finger.
8. **Presence heatmap**: 24 columns + 9 px axis crush at ≤380 px
   (dossier.js:1123-1133).
9. **`.region-pop`** absolute popover can cover content above the strip on
   short viewports (dashboard.html:159-170; freeStreak.js:165-172).
10. **10 px meaningful text** in dossier tables/timelines, histogram labels,
    threat tags (dossier.js:451/923/959/1140-1267, dashboard.html:105-106,
    :531).

### 1.3 The settings spirit — what to transplant (inventory pointers)
- **Fused command block**: related controls in ONE rounded box read
  top-to-bottom, no floating rows (settingsUi/controls.js:214-232).
- **Keyword captions / sentence tooltips** as an encoded rule
  (sections/preferences.js:10-11) — amended here by §0's no-data-in-title.
- **Two-tier colour discipline**: ONE neutral accent everywhere; signature
  colours reserved for a single hero element (controls.js:253-258,
  fabModules.js:52-81).
- **Self-indicating tiles**: `.on` = tinted bg + 2 px inset bottom accent +
  caption brightening (controls.js:278-289, 634-690).
- **Restyled native range slider**: slim track, lit progress, ringed thumb,
  live readout (controls.js:171-194).
- **Muted captions + hairlines** instead of loud headers
  (controls.js:271-289).
- Dashboard already owns the substrate these graft onto: `.gv-card`,
  `.chip-group`(+`.seg`), `.toggle-chip`, `.fresh-chip`
  (dashboard.html:317-406).

## 2. The plan — five independent phases

Ordered by user-visible value per effort. Each phase: implement → `npm run
build` → verify on a real phone (or 390×844 emulation) → commit. Tests for
any new pure helpers follow the usual release-time reconciliation.

### Phase A — Skeleton: navigation you can hold (small, do first)
- `.tabs`: `flex-wrap: wrap` (mirror `.subtabs` :307). If two rows offend,
  fall back to `overflow-x:auto` with scroll-snap — wrap is simpler; try it
  first.
- `.top-bar`: `position: sticky; top: 0; z-index` + opaque bg + a subtle
  bottom hairline when stuck. Keep it ONE row high on phones: tools cluster
  (server select + Export/Import) collapses under a single `⋯` disclosure
  below ~520 px, or wraps below the tabs — decide in-browser.
- Tab buttons: `min-height: 40px` (they're the most-tapped control).
- Body padding 20px → 12px below ~520 px (reclaims 16 px of width).

### Phase B — Tables & density: nothing overflows the page (mechanical)
- ONE shared idiom: `.table-scroll { overflow-x:auto }` wrapper class in
  dashboard.html (hoisted from targets.js:802-805), applied to: dossier
  per-body table, GV streak table, GV candidate table. The page itself must
  never scroll horizontally — only these wrappers.
- Column policy for narrow screens (only where cheap): streak table can drop
  `Gaps`/`Nbrs` below ~500 px via a `.gt-md` utility class; DON'T build a
  responsive-table framework — the scroll wrapper is the baseline fix.
- Typography floor: bump the §1.2(10) sites from 10px → 11px; presence-axis
  9px → 10px is acceptable (decoration). No global font change.
- Tap-target pass over §1.2(6): padding-based hit-area growth to ≥36 px
  visual/44 px effective (padding + negative margin trick where layout must
  not shift); `.smap-pin` gets an invisible ::after hit pad.
- `serverMapSep` (and the other GV ranges): pair each slider with a compact
  number input (the two bind to one value) — precision by typing on touch,
  drag stays for desktop.

### Phase C — Touch parity: hover is an enhancement, never the carrier
- Shared "readout line" idiom for the three map surfaces: the readout that
  today updates on `mousemove`/`mouseenter` (freeStreak.js:480/710/198)
  also updates on `pointerdown`. One helper, three call sites.
- `.region-pop`: on `pointer: coarse` (or ≤620 px) render the same content
  as an INLINE detail block under the strip instead of the absolute popover.
- Tooltip triage across targets.js / freeStreak.js / chips: for each
  `title=` decide (a) value belongs inline (danger reasons → the dossier
  already shows them; exact figures → short inline text), (b) tap-to-reveal
  (reuse the dossier-open / pinned-card affordances that already exist), or
  (c) genuinely optional explanation → stays a tooltip. Deliverable: no
  NUMBER or VERDICT reachable only via hover anywhere on the dashboard.
- Positions-map markers (mapPrimitives.js:384-388): tap selects the body
  and prints its `title` content into the map's caption line (the reach
  line already exists — extend it).

### Phase D — The settings spirit: control clusters become command blocks
Targets, in order of visibility:
1. **Spyglass scan prefs footer** (`.spy-scan-prefs`, dashboard.html:914):
   today a wrapping row of mixed labels/inputs/chips. Becomes ONE command
   block: muted captions (`Scan`, `Moon strike`, `Patrol`, `Cadence`),
   chips + number inputs aligned on a 2-col grid that stacks at ≤520 px;
   hairline dividers, no prose labels (sentences → tooltips).
2. **Galaxy Viewer config row** (`.cfg-grid` + sliders,
   dashboard.html:846-856): same block treatment; sliders restyled with the
   settings' slider look (track/fill/thumb) — hoist that CSS into
   dashboard.html as `.range` (source: settingsUi/controls.js:171-194).
3. **Sync tab cards** (dashboard.html:692-717): the checkbox+button rows
   adopt the tile/pill vocabulary (toggle-chip + corner action pill).
4. **Alarm-clock config panes** (alarmClockConfig.js): already
   chip-heavy; align caption/hairline rhythm only. Light touch.
- Colour discipline stays two-tier: `#4a9eff` accent only; the lone
  signature-colour hero on the dashboard remains the Spyglass gold eye +
  module colours where they already exist (map relationship hues are data,
  not chrome — untouched).

### Phase E — Polish (optional, cheap wins only)
- Presence heatmap: wrap in `.table-scroll` at ≤380 px (don't rebucket).
- Stat-card row (`.stats`): 2-col grid on phones instead of wrap-with-gaps.
- Sticky sub-tab bars inside Colonizations/AlarmClock if Phase A's sticky
  top-bar proves its worth.
- Audit leftover 10px decorations for contrast (#77848f on #121922 is
  borderline at 10px).

## 3. Verification (each phase)

- Chromium device emulation: 390×844 (iPhone-ish) and 360×800 (Android-ish),
  `pointer: coarse` emulated. Checklist per phase:
  - no page-level horizontal scroll on ANY tab (A, B);
  - every table reachable by swipe inside its own scroller (B);
  - every number/verdict visible without hover (C);
  - thumb-tap every control on a real phone once per phase (the user works
    from a phone today — real-device verification is finally natural).
- Keep `npm run typecheck` + `npm run lint` green per commit as always; the
  test suite reconciles at the next release (render modules are behavioral —
  the phases are CSS/DOM-shape heavy, so expect few test touches outside
  freeStreak/dossier snapshot-ish assertions if any exist).

## 4. Effort & sequencing guess

A: ~half a session. B: one session. C: one session (tooltip triage is the
long tail — timebox it to the "no number hover-only" bar, not perfection).
D: one to two sessions (blocks are mostly CSS + small DOM reshuffles in
render modules). E: opportunistic. A+B together already fix the daily
phone experience; D is where the "settings feel" lands.
