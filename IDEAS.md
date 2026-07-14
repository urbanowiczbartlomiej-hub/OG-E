# IDEAS.md — backlog of future enhancements

Captured ideas for later, not yet designed/built. Unlike the transient
plan docs (`*-AUDIT.md`, `REFACTOR.md`) this is a long-lived backlog: an
entry stays until it ships (then it moves to `CHANGELOG.md` and is deleted
here) or is explicitly dropped. Each entry records the *intent* and the
concrete game-DOM hooks, so a future session can pick it up cold.

Owner: solo dev (see CLAUDE.md). Ideas are in the user's own words,
grounded against the current code at capture time.

---

## 3. Alliance Spyglass share — follow-ups (v1 shipped in 1.47.0)

The opt-in alliance co-op share shipped in 1.47.0 (per-member-block model,
sync-on-click, config on the Sync tab — see `domain/allianceIntel.js` /
`sync/allianceShare.js` / `features/dashboard/allianceShare.js`). Deliberately
deferred from v1, each its own small design chunk:

- **Token rotation UX.** The alliance token is a shared secret; today
  rotation = the owner mints a new PAT and everyone re-pastes. Consider a
  "token changed?" hint when a pull starts failing with 401 after having
  worked.
- **Read-only membership tier.** A member who should PULL the union but not
  write a block (e.g. a trial member). Needs either a second read-only token
  (gist is private → any read needs auth) or acceptance that read = write
  trust in v1.
- **Own-block preview before first share.** A "what exactly leaves this
  device" dry-run view (render `buildMemberBlock` locally without a PATCH) —
  strengthens the consent story before the first click.

---

## 4. Documentation strategy — game-knowledge doc + structural enforcement

The project is large and unusually well-documented AT THE CODE LEVEL (file
headers carry the rationale, not just the "what"). The temptation on a big
project is to add a parallel per-feature prose layer; that is the WRONG move
here and this entry exists to say so and to name the RIGHT one instead.

**Do NOT build prose that restates code behaviour.** It duplicates the
headers, rots independently, and violates the DRY doc-hygiene rule in
CLAUDE.md ("descriptions rot; invariants don't"). Prose freshness also
can't be mechanically enforced — an assertion can pass/fail, a paragraph
can't — so "enforce docs like tests" is literally unworkable for narrative.
Enforce STRUCTURE instead, the same way layering is already ESLint-enforced.

The three chunks, each independently shippable:

- **Expand the reverse-engineered GAME-KNOWLEDGE doc.** This is the one
  documentation investment with clearly positive ROI: the knowledge is
  IRREPLACEABLE (not online, not in any LLM's training — it's plain to
  players but undiscoverable to a fresh session/model), STABLE (game rules
  change rarely, so it doesn't rot), and today it is scattered across code
  headers (`domain/activityObs.js` activity-marker semantics, `presence.js`
  online-vs-quiet asymmetry, `routine.js`, `espionageReport.js` field
  meanings, alliance classes, lifeforms, galaxy-view mechanics). Consolidate
  into `docs/ogame-fleet-mechanics.md` by WIDENING its charter (it already is
  the canonical home for reverse-engineered rules — fleet/phalanx/fleet-save)
  to a full "OGame rules OG-E relies on". Cross-link from the code headers to
  the doc section instead of restating.
- **Thin FEATURE INDEX.** Not prose — a spis-treści: one line per
  `features/*/` → its `install*()` entry file + a ≤10-word purpose. Low-rot
  (names + pointers), and checkable (see below). Lets a cold session navigate
  without grepping.
- **STRUCTURAL enforcement in the release gate (`scripts/release.mjs`), not
  prose-truth checks.** Cheap, executable, matches the existing ESLint-zone
  philosophy: (1) a doc-link checker — every `docs/*.md` link and every
  `see foo.js`-style code pointer resolves to a real file (catches rot where
  docs actually break: the pointers); (2) game-rule ↔ test binding — each
  reverse-engineered constant/formula has a unit test the doc names, so rule
  and test move together (THIS is the honest "enforce like tests"); (3)
  feature-index completeness — a test asserts every `features/*/` dir appears
  in the index. None of these assert a paragraph is "true"; they assert links
  live, rules are tested, features are listed.

Grounding note for whoever picks this up: this idea was itself a reaction to
"a session's knowledge mostly evaporates and the next one re-derives it from
code" — the fix is the game-knowledge doc (the irreplaceable part) + the
already-present carriers (CLAUDE.md invariants, CHANGELOG, this file), NOT a
new narrative layer.

---

## 5. Galaxy row 16 (expedition-debris slot) — rebuild as an OG-E surface

User verdict after the 2026-07-14 galaxy-touch-nav session: "ta cała pozycja
16. jest do zrobienia od nowa" — the current treatment works but is a pile of
overrides on someone else's layout, and it should be REBUILT from scratch as
OG-E's own element.

**Where the current treatment lives:** the row-16 CSS block + the
`compactDebrisReadout()` / `shortenDebrisLabel()` relabeller in
`features/galaxyNavPanel.js` (shipped with the bottom galaxy nav panel,
gated on `settings.readabilityBoost`). It pins the slot's height, flattens
AGR's stacked `ul.ago_expo_df` readout into one line, JS-shortens the locale
labels ("Metal: 1.388.400" → "M 1.388.400", classes are AGR's
locale-independent constants), restyles Ekspedycja/Wyślij/Zredukuj to
132px-wide slate buttons, and a height RATCHET on `#galaxyContent` absorbs
whatever still varies. That whole block is the part to DELETE when this
ships.

**Why from scratch:** the session burned ~10 iterations fighting two foreign
layout systems at once (game flex templates + AGR's injected list + inline
styles + a floated action link) — every fix uncovered the next quirk
(baseline overflow past the box, scrollbars painted across the chip, both
send buttons visible at once, labels flashing long→short before the
relabeller's debounce was made pre-paint). Grooming a surface we don't own
is the wrong altitude; the panel itself (built OG-E-owned from day one)
needed none of that.

**Sketch:** hide the native slot's CONTENT wholesale (same move as the
panel hiding `#galaxyHeader` — hidden controls keep working) and render an
`oge-` row in its place from data:

- Debris values: AGR's `ul.ago_expo_df li[value]` attributes (raw ints,
  locale-free) or the native `#debris16` tooltip lis as fallback.
- Actions: proxy-click the hidden originals (`#expeditionbutton` /
  `#sendExpeditionFleetTemplateFleet` / the Zredukuj `sendShips` link / the
  template-select dropdown), with the panel's stop-propagation rule (the
  game's `hideElem` delegate closes overlays on any bubbled click).
- State to mirror, not lose: AGR's red/green expo-slot tint (inline
  background on `#galaxyRow16.ago_expo_box`), the Ekspedycja↔Wyślij swap
  (inline display toggled on template select), the hostile-fleet marker
  `#ownFleetStatus_16_2`, and the attack-warning icon
  `#expeditionFleetTemplateAttackWarning`.
- Constant height BY CONSTRUCTION (own grid, fixed rows) — the ratchet then
  covers only genuine table variance (wrapped player names, event rows),
  not row 16.
