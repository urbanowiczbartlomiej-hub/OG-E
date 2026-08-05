# SPYGLASS-REDESIGN.md — plan for the Spyglass tab's UX rebuild

**Transient plan doc** (same lifecycle as `REFACTOR.md` / `*-AUDIT.md`, see
CLAUDE.md's documentation-hygiene rule): it lives while the cycle is open and is
**deleted** when the last phase ships — git keeps the history. Captured
2026-08-04 from the user's own read of the tab; grounded against the code at
that date.

---

## 1. Why — the tab now does four jobs in one scroll

`#spyglassSection` (`src/dashboard.html`) carries, top to bottom:

| # | Panel | Job |
|---|-------|-----|
| 1 | h1 + alliance line + `Alliance sync` / `⟳ Refresh` | plumbing |
| 2 | Watchlist cards (hero) | hunt |
| 3 | `Settings` fold — 8 cells (Probes · Scan · Probe from · Re-scan · Re-look · Home · Moon strike · Patrol) | config |
| 4 | Who's spying on you | defence |
| 5 | Home watch | defence |
| 6 | Patrol | hunt |
| 7 | Positions map | hunt |
| 8 | Players — finder + filters + table + inline dossier | hunt |

Four unrelated jobs, ~8 panels, one vertical scroll. Every panel added since
1.50 has been *correct* and has made the tab *worse*: nothing tells you where to
look first, and the answer to "what should I do now?" has to be assembled by
reading the whole page. That is the overload — not any single panel's design.

Two symptoms the user named, both fixed in phase 1 but both *structural* in
origin: a panel that renders its full body while it has nothing to report, and a
verdict (⭐ / 🏦) that only exists inside a hover.

## 2. Principles — apply to EVERY panel from here on

These come out of this session's feedback. They are the acceptance criteria for
each phase below, and they belong to the tab as a whole, not to one card.

1. **Quiet folds.** A panel with no news shows ONE state word on its bar
   (`quiet · 3/5 fresh`) and keeps its body behind the fold. Only news unfolds
   it, and only when the news is *new* (key on the item set, never on the
   repaint).
2. **The verdict is painted on the cell that earned it.** A badge beside a name
   is not a verdict — it is a hover waiting to happen, and on touch the hover
   does not exist. Colour the number that decided it, name the colour ONCE in a
   legend under the table. (`⭐`/`🏦` → gold `fleet` / `loot` cell + one legend
   line; done in `features/dashboard/dossier.js`.)
3. **Every number reachable without hover.** Tooltips may EXPLAIN; they may
   never CARRY. Verify at 360–430 px first.
4. **Nudges expire by themselves.** No state in the UI may require finding a
   button on another surface to clear. (The home-watch FAB boost is now
   one-shot: `domain/homeWatch.js`'s `alerts` contract.)
5. **FAB hint ≤ 18 chars.** The 0.34em line crosses a round rim; longer text
   leaves the outline. `shared/button.js` steps it down as a backstop, but the
   call site is where it must be short.
6. **Keywords, not sentences** (CLAUDE.md). One sentence is allowed where it
   states a *consequence* the user must act on (the fleet-save line) — nowhere
   else.
7. **No invented vocabulary in a glance surface.** If a word is not in the game
   and not guessable, it belongs in the dossier with its evidence, or nowhere.
   A term whose only definition is its own tooltip is decoration.
8. **An input takes what the player would write.** Magnitudes accept `15M` /
   `2.5b` / `15kk`; a control never silently rewrites what was typed — it reads
   the parse back instead.
9. **A filter must be able to explain itself.** Everything the list silently
   drops is named in the panel. An invisible exclusion is indistinguishable from
   a bug — that is exactly how `hide inactive` came to be suspected of one.
10. **Report CHANGES, not state.** A panel earns attention by saying what is
    different since last time. Once the user knows a fact, repeating it is spam:
    "no news" is a count, never a list of rows each saying nothing happened.
11. **Acknowledgement is permanent.** Anything the user has cleared may never
    come back, whatever re-derivation happens upstream. Store the FIRST-seen
    timestamp and never let a later pass refresh it.
12. **Every watcher owns its cadence.** Do not borrow another feature's window
    because the unit matches. The right interval follows the event being watched
    (a fleet moves in an hour; a neighbour colonises over days).
13. **Group by the ACTOR, not the address.** A list of places hides the thing
    that escalates a threat: the same account in three of our systems. Rows are
    per player; the places become that row's evidence.
14. **One colour language per surface.** Hue means exactly one thing on a card
    (here: Danger). A second meaning for the same hue makes both unreadable, and
    every visual code gets named once in a legend — never only in a tooltip.

## 3. Phase 1 — landed (this session)

### 1a — the FAB and the defensive column

- FAB: home look hint `your system · who moved in?` → `who moved in?`; the
  shared label spec shrinks any hint > 18 chars instead of bleeding outside the
  button.
- FAB: the home-alert boost is **one-shot** — it expires on the first sighting
  newer than the arrival, so the Look proposal can no longer wedge on one
  system. (Was: it hung on `dismissedAt`, cleared only from the dashboard.)
- Settings: `Re-look` and `Home` are ordinary cells — 4 clean rows of 2, every
  cell the same width as `Moon strike` / `Patrol`.
- Home watch moved into the defensive column under "Who's spying on you"
  (`.spy-side`), became a fold, and its bar carries the state word; the left
  edge turns red while an arrival is unread.
- Home watch text: shorter summary, `Moved in (N)` head, one-line fleet-save
  consequence, `seen it` → `clear NEW`, coverage numbers moved into the body.
- Dossier: `⭐`/`🏦` badges → gold on the deciding cell + one legend line.
  Players table: the `⭐` column header → `watch`.

### 1b — the Players panel (same session, second pass)

- **Danger column: the archetype name is gone.** `Apex hunter` / `Bandit raider`
  / `Turtle` / `Economist` were invented vocabulary in the column the eye reads
  first, and each needed a hover to mean anything. The buckets are real logic, so
  the taxonomy stayed — reworded into plain keywords (`fleet-heavy`,
  `defence only`, `active bandit`, `miner`, …) and shown in exactly ONE place,
  the dossier's DANGER line, directly above the reasons that produced it. Also
  removed from the three other at-a-glance surfaces it had leaked into (map
  badge tooltip, free-streak threat rows, the home-watch pill).
- **Player column:** the alliance `[TAG]` moved off the name line down to the
  dim second line beside `#rank` — the name line identifies the player, the line
  under it is context.
- **One finder instead of two.** The player box and the alliance box became a
  single `find player, alliance or tag…`, matched as nickname ∪ alliance
  membership over the same string (`domain/targets.playerMatchesQuery` +
  `matchAllianceMembers`). Two boxes made the user classify their own query
  before typing it. `+ watch all N` now covers whatever the search lists.
- **Military range takes human magnitudes.** `lib/humanNumber.js` parses `15M`,
  `2.5b`, `800k`, `15kk`, `1 250 000`, `1,25M`; the boxes are text (a spinner on
  such a value is meaningless), what was typed is never rewritten under the
  cursor, and a note line reads back the parse (`15M – 2.5B` / `15M and up` /
  `any military score`). An unparseable box is marked and treated as "no bound",
  never as zero. Bounds persist as parsed numbers.
- **Filters panel restyled as a command block** (`.cmd-grid` cells with keyword
  caption + control + one-line note, bled to the card edges) so it reads as the
  same interface as the scan Settings block instead of a loose chip row in an
  inline-styled box. `huddled (miners)` → `miners`, and the 😴 / ⭐ chip prefixes
  are gone (CLAUDE.md iconography).
- **`hide inactive` verified, not guessed.** The domain filter was exercised
  directly over synthetic candidates: ON keeps `active,noStatus`, OFF keeps
  `active,inact7,inact28,noStatus` — both directions correct end to end (status
  is parsed in `apiOccupancy.parsePlayers`, carried by `buildTargetCandidates`,
  honoured in `targetExclusionReason`). The one thing that looked like a bug: an
  inactive account ALSO flagged vacation stays hidden either way, because
  vacation/banned/admin exclusion is hard-coded on. That is now stated in the
  panel instead of being invisible.

### 1c — Home watch reported noise instead of news (third pass)

The card was announcing the same four neighbours after every galaxy walk, and its
standing list read `4:469 looked 0m ago · alone in the system` sixteen times.
Both came from ONE misread, plus two design mistakes:

- **The misread (the bug).** `state/scans` deliberately persists only each
  system's look TIME — the 15-slot `positions` map is ephemeral. So after every
  page load (i.e. every click in OGame) each system reads
  `{scannedAt: <last look>, positions: {}}`. Home watch read that as *"I looked
  and the system is empty"*: the baseline was re-seeded with nobody in it, and
  the next real look re-announced every neighbour as a fresh arrival — while the
  dashboard painted "alone in the system" over a system whose four arrivals it
  was listing directly above. An empty slot map now means "no occupancy
  information" on both sides (`domain/homeWatch.diffHomeSystems`, and the
  dashboard's live-vs-snapshot pick), exactly as `state/scans`' own header warns.
- **Acknowledgement did not stick.** `mergeHomeArrivals` let a re-derived arrival
  overwrite the stored one, refreshing `atMs` — and `atMs` is what "clear NEW"
  compares against, so a cleared neighbour came back as new. The stored entry now
  wins every collision: an arrival ages, it never returns.
- **Home watch had no cadence of its own.** It rode `galaxyHours` (hourly — right
  for a watched player's sighting, absurd for "who lives next to me", which
  changes when somebody colonises). It is now `homeHours`, its own box in hours
  with `0` = off, defaulting to 24 h, same grammar as Patrol. The pre-1.57
  `homeWatch` boolean migrates (`false` → 0, anything else → 24).
- **The standing list was noise.** Systems where you are alone are the expected
  state and are now a count in the foot line, not a row each; only systems that
  actually have a neighbour get a line.
- **"Who's spying on you" folds too**, sharing one class set (`.spy-fold-*`) with
  Home watch so the two defensive cards read identically: the bar carries the
  verdict, an unread-worthy state paints the left edge red, and only a prober in
  your OWN system unfolds the card by itself on load. Its date-range chips and
  Coords/Names toggle moved into the body — controls inside a `<summary>` fight
  the fold for the click.

### 1d — Home watch reads the THREAT, not the address (fourth pass)

- **Every neighbour was green.** `lib/dangerColor` works in the 0..100 the rest of
  the app rounds to; this card handed it the raw 0..1 fraction, so `D 0.91` hit
  the `d <= 15` branch and painted the same safe green as `D 0.02`. One
  conversion helper (`dangerHue`) now owns it, and it was the ONLY call site in
  the codebase with that mistake.
- **One row per NEIGHBOUR, not per system** (`domain/homeWatch.rankHomeNeighbours`).
  The escalation the old layout hid: an account in THREE of our systems is not
  three ordinary neighbours, it is one fleet permanently inside our space, able to
  run a moon destruction on its own in three places. Row = danger-coloured left
  rule + danger-coloured name + `×N` reach pill (only past one system) + the coord
  list. `N bodies` is gone; the coords are the presence.
- **Coalitions = REACH, not headcount** (`domain/homeWatch.findHomeCoalitions`).
  The first cut of this got the model wrong: it treated "two members of one
  alliance inside the same system of ours" as the sharp case. It is not an
  escalation at all — the capability that being in-system buys (instant arrival on
  a moon there) is already bought by either one of them, and doubling the fleets
  in one place widens nothing. Corrected rule, one gate: report an alliance only
  when its members TOGETHER cover more of our systems than its best member covers
  alone (`lift = |union| - soloBest ≥ 1`). Three accounts holding one or two of
  our systems each, four between them, is the real thing: none of them could
  reach that far solo. A member whose systems are a subset of an ally's is
  reported nowhere — their ally's `×N` already says it.
  Emphasis scales with the jump: `×3+ reach` or `lift ≥ 2` gets the amber box with
  the reach comparison spelled out, the mild `×2 vs ×1` gets one dim line. Capped
  at 3 with the remainder stated. A neighbour row's `[TAG]` chip lights only for
  an alliance that passes the gate — a tag lighting for "two of them live here"
  would train the eye to ignore it.
- **One colour language across the card**: hue = Danger, everywhere (arrival names
  included). A three-part legend names the codes once — edge colour, `×N`, lit tag
  — so none of them depends on a hover.
- Ordering stays the app-wide "worst Danger first", reach as the tiebreaker: a
  D 0.9 in one system outranks a D 0.2 in four, and the `×N` pill makes the
  entangled rows findable wherever they sit.

Still open on this card (deliberate): a known neighbour colonising a SECOND body
in a system they already occupy is not re-announced — `mergeHomeArrivals` dedups
on (system, player), and being in-system is what mattered. Their appearance in a
DIFFERENT system of ours does fire, because that is the reach escalation.

### 1e — acknowledgement, exclusions, and one end-of-sweep pointer (fifth pass)

- **Own alliance + buddies excluded** (`domain/homeWatch.friendlyNeighbourIds`).
  A neighbour is only news if they might come for you. Filtered on BOTH sides: the
  in-game diff drops them before they enter the stored baseline (otherwise leaving
  the alliance would resurrect every one of them as an arrival), and the dashboard
  drops them again from the arrival log and the occupant picture, for logs written
  before this rule. Three sources feed the rule so a cold one cannot open a hole:
  the `friendly` verdict on the danger profiles, the game's own
  isBuddy/isAllianceMember flags in the player cache, and the alliance id on the
  public players feed.
- **"clear NEW" is gone.** The flag's job is "you have not read this", which
  reading settles — asking for a click afterwards is asking the user to maintain
  our bookkeeping. The dashboard stamps `shownAt` when it paints an UNFOLDED card,
  the flag expires 24 h later (`NEW_ARRIVAL_TTL_MS`), and a hard 7-day ceiling
  (`NEW_ARRIVAL_MAX_MS`) covers the player who never opens the dashboard. The
  legacy `dismissedAt` is still honoured on read so an install that had cleared
  its arrivals does not see them light up again.
- **The FAB points at the dashboard exactly once, at the END of the sweep.** New
  `homeReport` proposal: fires only when every own system is looked at (no home
  look left in the plan), there is unread news, and nothing else is proposed —
  the same "idle button only" rule the pending-reports nudge already followed, so
  it can never take the button away from real work or wedge it. One tap opens
  `?tab=spyglass`, which paints the card, which stamps the arrivals — the nudge
  retires itself.
- **The in-game "Who's spying on you" panel folds too**, with the same colour
  language as the dashboard pair: gold edge + folded when quiet, alarm-red +
  unfolded by itself when an alert newer than `settings.spySeenTs` lands, back to
  gold once read. The red is LATCHED per panel instance — the messages page
  repaints on its own churn, and an edge that flicked back to gold mid-visit
  would hide the alert it just announced. The header is the toggle; the
  Coords/Names button and the range chips stop propagation so using them never
  folds the panel under the user's finger.

### 1f — the docs site documents it, from the real component

`site/content/spyglass-home.mjs` (+ the EN mirror) is the feature's first page.
Its picture is not a screenshot: the new optional `demo` field names a module in
`site/demos/`, which renders the ACTUAL card (`features/dashboard/homeWatch.js`)
over a fixture in a headless DOM at site-build time. A hand-written mock drifts
from the component the day after it is written; this one cannot. It fails soft —
if the headless DOM or the component signature is unavailable the figure is simply
omitted and the page shows its screenshots, because a docs build must not die on a
decorative element.

The fixture data is **fiction**: invented nicknames, invented alliance tags and
coordinates that belong to nobody. Documentation must never publish a real
player's position — not the author's, not anyone else's.

Note: `node site/build.mjs` is currently RED for a pre-existing reason unrelated
to this work — the 1.55 chapter split added six PL Spyglass pages without their
`content/en/` mirrors, and the build enforces a 1:1 mirror. This round added the
seventh page WITH its mirror. Writing the six missing translations is its own
task.

Test debt for release: `rankHomeNeighbours`, `findHomeCoalitions` and
`friendlyNeighbourIds` are pure and untested (exercised by hand during the build
loop), as is the `shownAt` expiry in `state/homeWatch`. First thing to cover in
step 1 of the release checklist.

## 4. Phase 2 — sub-tabs inside Spyglass *(the actual fix; do this next)*

A segmented control under the `h1` — the same `.chip-group.seg` language the
Settings cells already use:

```
[ Hunt ]  [ Defence ]  [ Map ]  [ Plan ]
```

- **Hunt** — watchlist cards, Players (finder + filters + table + dossier),
  Patrol. The finder and the row cap ride this view's header; ⚙ Filters keeps
  its fold (the command block from phase 1b) so the table still owns the height.
- **Defence** — Who's spying on you, Home watch (both unfolded here: this view
  exists to be read).
- **Map** — Positions map, full height.
- **Plan** — the 8 Settings cells + `Alliance sync` / `⟳ Refresh`.

Each chip carries its own state dot (red = unread arrival / prober this week,
gold = scan work queued, dim = nothing). Cheap by construction: the panels are
already independent cards with independent repaint functions, so the switch is a
`display` toggle plus a device-local key (`safeLS`, exactly like
`PROX_NAMES_KEY` in `features/dashboard/index.js`). No data flow changes; no
repaint changes.

Acceptance: no view longer than ~1.5 screens at 390 px; the tab opens on the
view with news (Defence when an arrival is unread, else Hunt).

## 5. Phase 3 — one situation bar above the sub-tabs

Four pills, always visible, each a jump into its view:

```
12 to scan   ·   1 moved in   ·   3 probed you (7d)   ·   looks 4/6 fresh
```

This is the answer to "what do I do now?", which today has to be assembled by
reading eight panels. All four numbers already exist in `repaintTargets` /
`repaintHomeWatch` / the proximity digest — this is a projection, not new data.

## 6. Phase 4 — merge the two defensive reads into one card

"Who's spying on you" and "Home watch" answer one question through two channels
(they probed me / they moved in next to me). One `Threats` card with two
labelled bands, sharing the coords↔names toggle and the date window, beats two
cards with two head tool-slots. Do it after phase 2, when they live side by side
in one view and the duplication is visible.

## 7. Phase 5 — dossier as a drawer

The inline row expansion makes the table jump and forces the dossier to be
narrow. A right-hand drawer (full height, own scroll, ESC to close) gives the
bodies table room for its 7 columns, removes `.table-scroll` gymnastics on
phones, and lets the row stay put. Biggest single win for the Players panel;
biggest phase, hence last.

## 8. Explicitly out of scope

- No new observation, no new request, no new automation. Every phase here is a
  projection of data OG-E already holds — the fair-play classification of the
  Spyglass features does not change (`docs/fair-play.md`).
- The `💀` RIP-range flag keeps its glyph (long-standing FUNCTIONAL marker with
  a footnote legend, carved out by CLAUDE.md). `🌙` / `🪐` stay where they sit
  beside a word. `🚚` in the dossier's "no longer here" line is the next
  candidate for principle 2, but it is not a verdict — leave it.

## 9. Verification per phase

Build → verify in the browser at 360–430 px FIRST (`.table-scroll` wrappers
scroll, the page never does), then desktop. `npm run typecheck` + `npm run lint`
before every commit; the test suite is reconciled at release (CLAUDE.md).
