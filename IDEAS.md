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

## 5. Live component demos across the whole docs site (v1 shipped in 1.57.0)

The Home watch page (`site/content/spyglass-home.mjs`) does not illustrate itself
with a screenshot. It declares `demo: { id: 'home-watch', caption }`, and
`site/demos/home-watch.mjs` renders the **real component**
(`features/dashboard/homeWatch.js`) over a fixture in a headless DOM at
site-build time; `site/build.mjs` inlines the markup into the figure. The idea:
do that for every feature page — replacing the screenshots we have and filling
the pages that have none.

**Why it is worth the work.** A screenshot rots the day the component changes and
nobody notices; a generated one cannot drift, because it IS the component. It also
solves two problems the screenshots have quietly: they carry real nicknames and
real coordinates (ours and other players'), and re-taking two dozen of them by
hand after a UI pass is work nobody will do. Generated demos are diffable, they
cost nothing to refresh, and their data is invented by construction.

**Blocker — SOLVED (pre-render + commit).** `.github/workflows/pages.yml` runs
`node site/build.mjs` with **no `npm ci`** (the generator is deliberately
zero-dependency), while a demo module imports `happy-dom`, a devDependency — so
on Pages the live render never succeeds. The build now renders live when it can
and writes the markup to `site/demos/_generated/<id>.html`, which is committed;
CI inlines that file. Consequence for every new demo: **build the site and commit
whatever changes under `_generated/` after touching a component** (the build
prints `↻ demo "…" odświeżone`). Rejected alternatives: `npm ci` in the workflow
(gives up the zero-dependency property) and a hand-written ~50-line DOM shim
(must keep pace with what the components use — a maintenance trap).

**Which components can be rendered as-is.** The pure-ish DOM builders that take
every input as an argument and emit inline styles: `dashboard/homeWatch.js`
(done), `dashboard/patrol.js`, `dashboard/cards.js` (watchlist cards),
`dashboard/targets.js` (the Players table + a row's dossier),
`dashboard/dossier.js`, `dashboard/mapPrimitives.js` (positions map / server
map), `dashboard/legend.js`. The FAB faces are a second family worth doing: the
paint is already pure (`sendSpy/pure.js` `renderSpy` → `shared/button.js`
`labelLines`), so a demo can show the real Look / Strike / Home faces instead of
prose describing them.

**What needs a wrapper or is out of scope.** Anything that reads a store or
`chrome.*` on render (the dashboard's `index.js` orchestration), and the in-game
panels that graft onto OGame's own DOM (`whosSpyingPanel.js`, badges,
`galaxyNavPanel.js`) — those need a fake host element with the game's classes,
which is a bigger fixture but not impossible; do them last, if at all.

**Rules any demo must keep.**
- **Invented data only** — nicknames, alliance tags and coordinates that belong to
  nobody. The docs must never publish a real player's position, ours included.
- **Fail soft** — a docs build must not die on a decorative element (the current
  generator already warns and falls back to the screenshots).
- **Self-contained markup** — the site does not carry the dashboard stylesheet, so
  a demo either relies on the component's inline styles or ships its own frame
  (see the `frame()` helper in `site/demos/home-watch.mjs`).
- **Theme.** The site has a light/dark switch; the components are dark-only, so a
  demo sits in its own dark "product" scene (`.shot-demo`). If a future page wants
  demos to follow the site theme, that is a component-level change, not a docs one
  — do not fork the components' palette for the docs.
- The `demo` field is OPTIONAL and language-independent (markup is shared, the
  caption is per locale) — keep it that way; the EN mirror stays a caption
  translation, not a second render.
