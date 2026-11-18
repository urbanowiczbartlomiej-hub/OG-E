# OGame fleet mechanics — reverse-engineered reference

OG-E has no access to OGame's source or docs. Everything here is
reverse-engineered game knowledge that several features (fleet-save reminders,
planet status markers) depend on. This is the **single home for the game
*rules*** — in-code comments point here instead of repeating them. For the exact
marker classification, the authoritative source is the code:
[`src/features/badges/pure.js`](../src/features/badges/pure.js).

## The ajax token — TWO rotating values per session (13.0+)

Diagnosed 2026-07-27 from a HAR of a **13.0.0-r5** universe, re-checked against
the shipped bundle. The section below describes the **page** token; the chat
owns a second, independent one — see
[the next section](#there-are-two-token-namespaces-not-one), and read it first
if you are about to touch anything that reads or writes a token.

- Since 13.0 `action=checkTarget`
  **spends** the token it was sent and returns a fresh one as `newAjaxToken`.
  Replaying a spent value is refused with
  `{"error":100,"message":"LOCA_ERROR_INQUIRY_NOT_WORKED_TRYAGAIN"}` — the red
  "please try again" box on the fleet1→fleet2 step. The refusal says **nothing
  about the target**; the identical request with the rotated token succeeds, and
  the refusing response itself carries a usable fresh token.
- `eventlist/fetchEventBox` + `catchEvents` only **echo** the current token —
  they do not rotate it.
- The value lives in a **global `token`**: `FleetDispatcher.updateToken()`
  writes it, `appendTokenParams()` reads it. The constructor's
  `this.token = cfg.token` is the page-load copy and is **never refreshed**, so
  `fleetDispatcher.token` is permanently stale by design.
- `updateToken(data.newAjaxToken)` sits at the **END** of
  `FleetDispatcher.fetchTargetPlayerData`'s callback, after ~10 DOM-refresh
  calls (`refreshDataAfterAjax`, `refreshStatusBarFleet`, `validateMissions`,
  `refreshFleet2`, …). An exception in any of them **strands the rotation**: the
  page then keeps sending a retired token on every later request until a full
  reload. This is why a per-click retry cannot fix it — the repeat re-reads the
  same stranded value.
- Ordering fingerprint that identifies who sent a `checkTarget`: the game
  serialises `am*, galaxy, system, position, type, token, union` (token BEFORE
  union). A body with the token appended **last** is neither the game's nor
  OG-E's.
- **The refusal happens during page INITIALISATION**, which is what makes it so
  easy to miss. One measured load of a 13.0 universe (HAR, 2026-07-28), offsets
  from page start:

  | +ms | request | token |
  | --- | --- | --- |
  | 190 | `eventlist/fetchEventBox` | echoes `8d88fe` |
  | 244 | `fleetdispatch/checkTarget` (the game's own field order) | sends `8d88fe`, **rotates to `bcccc0`** |
  | 644 | `fleetdispatch/checkTarget` (token appended LAST — third party) | replays `8d88fe` → **error 100** |
  | 811 | `DOMContentLoaded` | — |

  Anything installed at `document_idle` arrives ~170 ms after the damage is
  done — hence OG-E's MAIN-world entry runs at `document_start`.

OG-E's answer is [`src/bridges/ajaxTokenKeeper.js`](../src/bridges/ajaxTokenKeeper.js)
— it learns each rotation from responses the page already made and keeps the
page's token holders in step (see that file's header, and
[`fair-play.md`](fair-play.md) for the classification).

### There are TWO token namespaces, not one

**We had this wrong until 2026-09-06**, and the wrong version is the intuitive
one, so it is written down here as well as the truth: reading the fleet code
(and this document's own earlier wording) it looks like a session owns exactly
one ajax token, rotated by whichever endpoint happens to spend it. It owns two.

| namespace | variable | rotated by | read by |
| --- | --- | --- | --- |
| page | global `token` | every ordinary component | everything: fleet dispatch, alliance, messages, empire, … |
| chat | `window.ajaxChatToken` | `game/index.php?page=ingame&component=chat&asJson=1` (the `chatUrl` global) — **only** this URL | the chat's own requests only |

What makes this a trap rather than a footnote:

- Both are 32-char hex strings — **shape tells you nothing** about which one a
  value is.
- Both live behind the **same** `game/index.php` entry point, so a URL filter
  written as "the game's ajax endpoints" catches both.
- The chat spells its value with the **same JSON field name** as everything
  else: `window.ajaxChatToken = data.newAjaxToken`. So a response scanner keyed
  on `newAjaxToken` cannot tell the namespaces apart on content either.

Cross-writing a chat token into the page global is **terminal for the tab, not
transient**, because of how the failure lands:

- The server answers a request bearing the wrong token with the HTML error page
  `An error has occured!` and **HTTP 200** (the same 200-on-refusal habit
  documented under [A refused send still answers HTTP 200](#a-refused-send-still-answers-http-200)).
- Callers use `$.getJSON`, so that body never parses, so the success callback —
  which is the only thing that would have adopted a fresh `newAjaxToken` and
  healed the global — **never runs**. One bad write locks the component out
  until a full page reload.

Observed on the alliance component (`component=alliance`), where every tab does
`$.getJSON(target.attr('rel'), { token: token }, …)`: `fetchOverview`,
`fetchManagement`, `fetchBroadcast`, `fetchApplications` and `fetchClasses` all
died together, all replaying the same wrong token, and stayed dead. The same
shape applies anywhere else the page token is sent.

Also worth knowing while you are in here: `Alliance.prototype.updateToken`
assigns the bare global (`token = newtoken`), and the page declares
`var token = "…"` **twice** in its inline scripts. Both are the same global —
there is no shadowing to exploit or worry about.

## Fleetdispatch hydrates in TWO stages — `fleetDispatcher` first, its ship list later

`window.fleetDispatcher` is constructed early: by `DOMContentLoaded` the object
exists and most of its scalar fields (`currentPlanet`, `fleetCount`,
`maxFleetCount`, `expeditionCount`) already read true. **Its `shipsOnPlanet`
array does not.** The game fills that from its own ready handler, which runs
after any listener registered at `document_start` — so a read taken on
`DOMContentLoaded` can hand you `shipsOnPlanet: []` on a planet with a full
hangar. Observed on slow/mobile loads, 2026-11.

- **The wrong intuition** (and it is a comfortable one): *"`fleetDispatcher`
  exists, therefore its ship list is real."* It is not. The presence of the
  object says nothing about the state of the array — the two arrive at
  different times, and nothing on the object flags which stage you caught.
- So **an empty `shipsOnPlanet` is ambiguous**: "not hydrated yet" and
  "this planet genuinely has nothing" look identical. The only cheap
  discriminator is time — on a planet that has ships the list fills within a
  few hundred ms of load, and once the page reaches
  `document.readyState === 'complete'` an empty list is the planet's real
  state.
- There is **no second chance by default**: the page re-publishes its
  dispatcher state on `action=checkTarget`, which only fires once somebody
  picks a target. A planet view nobody has aimed from never issues one, so a
  reader that caches the first read keeps the pre-hydration value for the
  entire page view — not for a moment, but until the next navigation.

Related timing, same page: the event-list XHR can land **~600 ms before**
`DOMContentLoaded` (see the measured HAR offsets in the ajax-token section
above — `fetchEventBox` at +190 ms, `DOMContentLoaded` at +811 ms). A
readiness gate keyed on the event list therefore opens while the rest of the
page is still hydrating; it is a statement about the event list, not about the
page.

## Event list — how OGame generates fleet rows

Every fleet movement shows as one or more rows in the event list
(`#eventContent`), each with a direction-stable `origin` (the launcher) + `dest`
(the mission target) and a `data-return-flight` flag.

- **Two-way missions** (attack, ACS attack, transport, espionage, recycle, moon
  destruction, expedition, discovery) return to the launcher by design, so they
  generate **two rows at send time**: an outbound (`return-flight=false`) and a
  return (`return-flight=true`). Expeditions/discovery hold at the target, so
  their return row's time only firms up once they start coming home.
- **One-way missions** — deployment ("Stacjonuj", type 4) and colonisation
  (type 7) — leave the fleet at the destination, so they generate **one row**
  (outbound only).

A fleet **lands** at the **dest** on an outbound leg, and back at its **origin**
(home) on a return leg. OG-E attaches a marker to *where the leg lands*.

### Counting FLEETS, not rows (measured on a live ticker)

Because a two-way mission owns two rows, **row count ≠ mission count**, and the
ratio changes with the mission's phase:

| phase | rows present |
| --- | --- |
| dispatched, still flying out | outbound **+** return (2) |
| arrived / holding at the target | return only (1) |
| flying home | return only (1) |

The **return row is the one invariant**: exactly one per in-flight two-way
mission, from dispatch until the fleet is home. So "how many are in the air" is
`count(return rows)` — never `count(rows)`, and never `count(outbound rows)`.

Two wrong models, both plausible, both measured false against a live account
(6 planets, 2 expeditions each — 18 rows, 12 expeditions, 12/12 slots):

1. *"One mission = one row."* Over-counts by 2× every mission still flying out.
   A per-planet cap of 2 therefore read as "full" after a **single** send.
2. *"The return leg swaps the cells, so attribute each leg to the end that is
   the planet."* The cells do **not** swap — they are direction-stable — so this
   under-counts to **zero** for anything holding or flying home, silently
   freeing a slot that is still occupied.

Third-party skins can make this harder to see: AntiGame Origin restyles the
game's return row (adding `ago_events_reverse`) rather than adding a row of its
own, and OGame numbers the two rows of one fleet as consecutive ids
(`eventRow-655960` / `eventRow-655961`), which reads like a duplicate at a
glance.

### Expedition slot accounting

An expedition occupies one of the account's expedition slots
(`Expeditions: n/max` in the fleet-dispatch header) for its **whole round trip**
— outbound, the hold at the expedition point, and the flight home — and the slot
is released only when the fleet lands. Its target is **position 16** of the
launching planet's own system, a slot no planet can occupy (a system holds
positions 1-15), so `[g:s:16]` in a `dest` cell is always the expedition point
and never somebody's body.

### An expedition's return time is NOT fixed at send

**The wrong intuition, and we held it in writing for several releases:** *"each
in-flight expedition has a fixed, deterministic return time the moment OGame
accepts the send; that timestamp never changes in flight."* It is false, and it
is the kind of false that survives a long time, because it is true of every
other mission.

An expedition resolves its outcome at the END of its hold at the expedition
point, and some of those outcomes change the flight home: the fleet comes back
faster, or it is delayed. When that happens the return row's
`data-arrival-time` **jumps** — by minutes, not seconds — part-way through the
flight. The row is updated in place; nothing else about it moves.

Consequences for anything that tracks expeditions:

- **The arrival time is an attribute of a leg, never its identity.** Anything
  keyed on it will see one fleet vanish and a different fleet appear at the
  moment the outcome lands.
- Two expeditions sent seconds apart, to the same point, with the same ships,
  can therefore come home far apart. "Sent together" does not mean "returns
  together", and it does not even mean "returns in send order".
- The jump can be large enough to leave any sensible grouping window, so a
  grouping threshold cannot be made wide enough to absorb it without also
  merging things that are genuinely unrelated.

**How often it happens (measured).** On one Discoverer account (s163-pl,
687 expeditions, 2026-10-01…05, no expedition item active) **7.6 %** of
expeditions came back **delayed** and **1.5 %** came back **early** — so roughly
**one return in eleven moves**. In a wave of 15 expeditions that is ~1.1 delayed
fleet per wave, which matches the player's own experience ("usually one or
two"). The full outcome table is in
[Expedition outcomes](#expedition-outcomes--measured-frequencies) below.

Still not measured: the MAGNITUDE distribution of the jump. We know it reaches
double-digit minutes; we do not know the shape.

### Expedition outcomes — measured frequencies

Source: one Discoverer-class account on s163-pl, from an OGame Tracker export
(~65 800 expeditions in total). The two windows compare the same account with
and without the bronze **Expedition Computer** item; *which* window had the item
is inferred from its expiry date, not read from the game, so treat the column
labels as very likely rather than certain.

| Outcome | without item (1–5 Oct 2026, n = 687) | with item (24–30 Sep 2026, n = 1207) |
|---|---:|---:|
| Resources | 35.2 % | 40.8 % |
| Ships found | 16.7 % | 20.6 % |
| Dark Matter | 7.4 % | 7.6 % |
| Nothing | 28.0 % | 21.0 % |
| Delay (late return) | 7.6 % | 4.6 % |
| Combat (pirates/aliens) | 2.0 % | 1.6 % |
| Fleet lost | 0.3 % | 0.3 % |
| Early return | 1.5 % | 2.3 % |

What the comparison shows about the game:

- **The Expedition Computer moves the odds, not the size of a find.** The
  average resource find was the same in both windows (~70 M in 3:2:1 metal
  units), and so was the average ship find (~28–29 M). The item shifts outcomes
  from *nothing* / *delay* into *resources* / *ships*.
- **An item that removes the delay does not necessarily remove the delay
  outcome.** The "100 % delay reduction" item sets the extra delay time to zero,
  so the fleet returns on schedule, but the expedition report may still say it
  was delayed. Anything that counts delays from reports will over-count them
  while such an item is active. (Reported by the player; not cross-checked
  against event-list timestamps.)
- **Ships found are budgeted on metal + crystal.** Over >60 000 expeditions,
  the deuterium value of the ships found ran at ~8.2 % of their M+C value with a
  Battlecruiser as the largest ship in the fleet, and ~9.2 % with a Destroyer or
  Reaper. So the cap on a ship find appears to count M+C, and the deuterium
  carried by the ships comes on top of it.

### Event rows: the event id and the fleet id are different things

Each in-flight leg is one `<tr class="eventFleet" id="eventRow-<n>">`. That
`<n>` is the **event** id, one per LEG; `data-fleet-id` is the **fleet** id,
shared by a fleet's outbound and return legs (which is why OGame numbers the
two rows of one fleet consecutively — see the note above about this reading
like a duplicate).

For a two-way mission the return row is the invariant: exactly one, from
dispatch until the fleet is home. Its event id is therefore the natural handle
for following one in-flight expedition across page loads.

**Not verified:** whether that event id survives a return-time change (the
outcome above). The expectation is yes — it is the same event record being
updated, and the row is rewritten in place rather than replaced — but nobody
has watched a specific id across the jump. If it turns out the id rotates, the
fallback handle is `data-fleet-id`, which is bound to the fleet rather than
the leg.

## A refused send still answers HTTP 200

`action=sendFleet` reports failure **in the body, not in the status code**: a
send the server declines comes back `200` with
`{"success":false,"errors":[{"error":<code>,"message":"…"}]}`, and the page
renders that message as the red banner above fleet2. So "the click went through"
and "a fleet left" are different facts, and only the response body separates
them — a caller that clicks the dispatch control and assumes a launch will
report sends that never happened.

Codes seen so far:

| code | meaning |
| --- | --- |
| `140026` | not enough deuterium for this flight (*Niewystarczająca ilość paliwa!*) |
| `140016` | target reserved for a planet move (24 h cooldown) |
| `140035` | no colony ship in the fleet |
| `140008` | player on vacation |
| `612` | every fleet slot in use |
| `100` | spent ajax token — see above; says nothing about the fleet |

Whether a refusal is worth retrying elsewhere depends on **what it is about**.
`140026` is about the launching body — its deuterium — so another planet may
well fly. A full slot list is about the account and will refuse identically
everywhere. The slot counters (`fleetCount` / `maxFleetCount`,
`expeditionCount` / `maxExpeditionCount` on `fleetDispatcher`) tell those apart
without needing a code for every server message.

## Recall ("Zawróć")

Only a leg still flying **to its target** (outbound, not yet arrived) can be
recalled. On recall the fleet reverses and flies home; the new home-arrival is
`now + time-already-elapsed-outbound`.

- **Two-way mission recalled:** the return row already existed — it **stays**
  (same id), only its arrival **time** moves earlier. The outbound is abandoned.
- **One-way mission recalled:** there was no return row — one is **created**
  (a new id). The fleet is now a return flight heading home.

So a return row is the norm for *every* two-way mission from the start; recall is
just an *extra* way a one-way mission acquires one. (Identity matters: a
two-way recall keeps the row id — any lock/marker tied to it survives, only the
time refreshes; a one-way recall is a brand-new id.)

## Phalanx — and the routes it can't see

The Sensor Phalanx lets another player scan a system and **read the exact arrival
and return times** of fleets moving to/from a body there. That lets an attacker
land an attack the *second* your fleet touches down — too fast for you to fire
another request to re-save it. The fleet is then destroyed and looted at that
instant. This is why the **landed** moment is the dangerous one.

Two locations **cannot be phalanxed**:

- **Moons** — a fleet leaving from / arriving at a moon is invisible to phalanx.
- **Position 16** ("boundless space" / the expedition slot) — no player can sit
  there and it can't be scanned.

## Fleet-save (FS)

A fleet-save keeps a valuable fleet *in motion* (or parked on a safe body) so an
incoming attack hits an empty planet. The dangerous moment is **touchdown**: the
instant the fleet lands it sits exposed until you move it again.

Because phalanx-visible landings can be timed by an attacker, good fleet-saves
use **undetectable routes**: launch from a **moon**, and/or send to **position
16** (the game allows only expedition or espionage there — a small espionage to
16 is a phalanx-proof fleet shuffle, **not** an aggressive scout). The fleet then
rounds-trips through deep space and comes home with a return time nobody else
can read.

## How OG-E maps this to planet markers

`features/badges` paints a tiny status marker beside each of your bodies, on the
body where each leg **lands** (return → home, outbound → target), if it is yours.
Authoritative logic lives in `pure.js`; this is the summary.

| Marker | Meaning |
|---|---|
| 🟥 red **square** | incoming attack — a foreign aggressive fleet (attack / ACS-attack / espionage / moon-destroy) landing at you |
| 🟡 "FS" (text) | fleet-save **in motion** — detected by ship-count + flight-time, OR any espionage → 16 |
| 🟠 "FS" (text) | a detected fleet-save that **landed** and sits exposed — durable (no timer), synced cross-device; clears only when the fleet re-saves/departs that body or you dismiss the landing |
| 🔴 red **circle** | your attack / spy on a real player |
| 💙 blue heart | your expedition |
| 🟢 green | logistics (transport / deploy / ACS defend) |
| 🔵 blue | recycle |

- **Mine = round** (plus a heart for expeditions, "FS" rendered as text); the
  **external threat = square** (the odd, angular, "from-outside" shape).
- **Priority** — one marker per category, **max 3 per body**, highest wins:
  `threat → FS → my-aggression → expedition → logistics → recycle`. Usually 1
  marker, sometimes 2, rarely 3 (the critical "landed FS + incoming attack" on
  one body always fits).
- **Excluded** (never marked): colonisation (7) and discovery (18) — sent in
  bulk, pure noise; and foreign *friendly* arrivals.
- **Position 16 rule:** a mission there targets no player, so it is never
  aggression — espionage → 16 is flagged FS (covert save), expedition → 16 is a
  heart. Below the FS detection threshold a small espionage → 16 still shows
  yellow "FS" (the maneuver), but the orange landed-state and ntfy reminders
  stay threshold-gated.

The markers are purely passive: every byte is read from the event list OGame
itself renders. OG-E never queries the server.

## The activity marker ("aktywka") — exact encoding

Confirmed on live payloads (2026-07-04); consumed by the Spyglass routine
tracker (`domain/routine.js`, `domain/activityObs.js`). OGame tracks activity
**per body** — a planet and its moon carry independent markers.

The galaxy view (`fetchGalaxyContent` JSON) exposes, per planet/moon, an
`activity: { showActivity, idleTime }` block:

| Game state          | JSON                               | Meaning                                    |
|---------------------|------------------------------------|--------------------------------------------|
| fresh dot, no digit | `showActivity: 15, idleTime: null` | interacted with **0–15 min** ago (exact minute hidden) |
| minute shown        | `showActivity: 60, idleTime: N`    | interacted with **exactly N minutes** ago (15 ≤ N ≤ 60) |
| no marker           | `showActivity: false`              | no interaction in the last **60 min** (or never) |

So the resolution is: a coarse "<15" band, the **exact minute** in the 15–60
band, nothing past 60 — the ceiling is 60, not 45/59. A spy report's
`data-raw-activity` mirrors the same encoding (`'*'` = <15 min, a number = the
minute, `-1` = none — **not** "1 minute ago").

**The marker means "this body was interacted with", NOT "the player is
online".** It fires on: the owner's own actions, the owner's fleet returning
(incl. a fleet-save landing), an incoming resource delivery or attack, and
**incoming espionage — including OG-E's own probes** (a re-scan within 15 min
shows the activity the previous probe caused). Any consumer must therefore
discount self-induced markers (see `domain/activityObs.js` / the read-side pass
in `domain/routine.js`) and must never label the signal "online".

## Catching a landed fleet-save via the activity marker (the aggressor's tell)

The single most common aggressor tactic: catch a **returning fleet-save that
landed on a moon while its owner is offline** — the fleet sits exposed until the
owner logs in to re-save it, so it can be spied and destroyed. The activity
marker gives it away, using the "activity ≠ online" asymmetry **offensively**:

- A human *playing* leaves marks on **several** bodies (they hop planets, use
  their main). So a lone fresh marker on **one moon**, with **every other body
  of that player quiet** (no marker, i.e. >60 min), is not a human at the
  keyboard — it's a **mechanical event on that moon**, and the most common one is
  a fleet-save touchdown.
- The signal is **NOW-only**: the moon marker fades after ~60 min, so it must be
  read fresh and acted on fast.
- It is a **candidate, not a certainty** — the same marker fires for a foreign
  attack/probe on that moon or a brief owner login. A probe (one deliberate tap)
  is what confirms the fleet. The tool's copy says *"possible fresh fleet — spy
  to confirm"*, never *"fleet is there"*.

**OG-E detection — `domain/fleetLanding.js` (`detectFleetLanding`).** Pure, over
the galaxy activity rings (`state/activityObs`) the player gathered passively.
Fires when: exactly ONE of a watched player's bodies is *fresh-active* (a
positive marker seen within `FRESH_LOOK_MS`), it is a **moon**, and ≥1 other body
is *recently-seen quiet* (a `-1` look within `QUIET_COVERAGE_MS`). Two honesty
gates are load-bearing: **coverage** (we can only call the other bodies "quiet"
if we LOOKED at them recently — bodies with a stale/no look are `unknown` and
lower the coverage the UI shows; never over-claim), and the **self-induced skip**
(a fresh moon we probed ourselves within `SELF_WINDOW_MS` is our own light, not a
landing — belt-and-braces over the ring's append-side discount). A hit boosts
that moon to the top of the probe plan (`scanPriority.STRIKE_BOOST`, past the
scan-bodies filter and the freshness gate) so the FAB proposes spying it first,
and flags it on the dashboard (🎯 row marker + dossier banner). It **respects
scan-'off'** (an explicit "don't probe this player" wins; the flag still shows)
and never auto-sends — the confirming probe is one deliberate tap.

## Colonization — position size re-roll & slot release

Colonizing an empty position generates a planet whose size (field count) is
**randomly drawn** from that position's range. The draw is **per-colonization,
not per-slot**: the *same* `g:s:p` gives a *different* size every time it is
colonized. So the standard strategy is to **abandon a small roll and
re-colonize the exact same slot** to roll for a bigger planet — the retained
old field count carries no information about the next roll. (OG-E has no
planet-size data from the public API — the API never exposes fields — so this
size knowledge only ever comes from visiting the planet.)

**A slot is not released the instant you give it up.** OGame frees an abandoned
position on its **daily cleanup sweep at 03:00** (server time), and only for
planets abandoned **at least 24h earlier**. Until that sweep a colony ship sent
there is refused; after it the position is colonizable again (a fresh re-roll).
OG-E's model: the slot re-enters the candidate pool at the **first 03:00 that is
≥ 24h after give-up** (see `domain/colonizeDecisions.abandonRecolonizableAt`).
The weekly `universe.xml` lags this by up to 7 days and may still list a freed
slot as ours, so the picker overrides that stale occupancy with the local
"freed" fact.

**Measured on a real universe** (s163-pl, 1474 recorded colonizations over 106
days): **375 distinct slots**, one of them re-colonized **9 times**, and **319
slots produced more than one distinct field count** across their re-rolls. Field
counts ranged **182–387**. That is the re-roll rule above, quantified — and the
reason the histogram keeps every observation including abandoned ones (small
rolls are abandoned fast, so pruning them would empty the left tail).

**The home planet is not a colonization draw.** Every account starts with one
planet handed out at registration; its field count comes from the game's starter
rules, not from the per-colonization re-roll above, and it sits at the small end
— nobody would keep a *colony* that size. It is also, at that moment, a
completely empty planet (`0/x` fields used), so it looks exactly like a fresh
colony to any "nothing built yet" test. That combination is a trap for a
field-size dataset: it is the one planet that passes such a gate on a brand-new
account, and it drags a young distribution down.

Two rules make it identifiable without reading names (which are localised and
renameable): **you cannot abandon your last planet, and the home planet cannot be
abandoned at all**. So an account showing exactly ONE planet in the planet bar is
always sitting on its starting planet, and the second planet an account ever owns
is by definition a colony.

**How a planet's field count is built up.** In order:

1. the **natural roll** for the position. For position 8 it is **156–252,
   mean 204, σ = 16**, and its shape is NOT normal (see below);
2. **diameter bonuses**, which multiply the planet's **diameter**, never its
   field count:
   - Discoverer player class: **+10 % diameter**. The Kaelesh lifeform tech
     *Discoverer Enhancement* raises Discoverer class bonuses by a summed
     percentage `E` (+0.2 % per level per planet, boosted by the lifeform tech
     multipliers), so this term is `+10 % · (1 + E)`;
   - Researcher alliance class: **+5 % diameter** (not boosted by `E`).

   The game rolls a **diameter**, and the field count is derived from it:
   **`fields = floor((diameter_km / 1000)²)`** before the server's bonus
   fields. Checked on eight bonus-free planets of another server (position 1,
   +30 bonus fields). Seven match to the field. Two of them, 152.87 → 182
   and 141.99 → 171, show the game **truncates** rather than rounds. The
   eighth had 19 extra fields from a level-3 Terraformer. Fields therefore
   grow with the **square** of the diameter, so

   ```
   m      = 1 + 0.10 · (1 + E) + 0.05      (diameter multiplier)
   fields ≈ natural · m²                    (before steps 3–6)
   ```

   Example: `E = 53 %` gives `m = 1.203` and `m² = 1.447`, so a +20 %
   diameter bonus means **+45 % fields**. The wrong model, *"the bonus
   percentage is added to the field count"*, underestimates big rolls by
   dozens of fields;
3. the server's flat **bonus fields** (+30 on s163-pl), added as a constant
   after the multiplier;
4. **items** that add fields;
5. the **Terraformer**, which adds fields as it levels and itself occupies one
   field per level. Two measurements, level 3 = **+19** and level 14 = **+91**,
   fit **+6 per level plus +1 on every even level**, i.e. `floor(6.5 · L)`.
   The variant *"+1 on every odd level"* also gives 91 at level 14 but 20 at
   level 3, so it is out. Hence level 15 = +97, not +98 (not yet observed);
6. the Kaelesh lifeform's **Bio-Modifier**: **+2 fields per level**, active only
   while that planet's lifeform is Kaelesh. Switch the lifeform away and the
   fields disappear. Existing buildings stay, but nothing more can be built
   while the planet is over capacity. (Wrong figure once used in a model:
   "+200 per level".)

Only step 1 is random. That is why a planet is re-rolled for its natural roll
and everything else is stacked on afterwards. Because step 2 stretches the
whole scale, a target "10 fields below the maximum" in final fields is only
`10 / m²` ≈ 7 natural fields below 252 — much rarer than it sounds (next
subsection).

**Confirmed by the player** (the class percentages and how `E` applies) and
**measured**: on one Discoverer + Researcher account on s163-pl, 1818 position-8
colonizations (Apr–Nov 2026, `E` rising from ~47 % to ~53 %) back-solved through
`(fields − 30) / m²` give a natural mean of **203.9** and σ **16.5** — the
published 204 / 16, which were not used in the fit — and a monthly mean that
stays flat while `E` grew. Under either wrong model the monthly mean would
drift.

**Relocating a planet keeps its field count — always** (confirmed by the
player). Only the **temperature** changes: it is set anew within the
temperature range of the destination position, exactly as for a planet
colonized there. The wrong belief, *"relocation can improve the size"*, is
false. Rolling a large planet
on a high-field position and relocating it to a cold one for deuterium is
therefore a normal strategy.

**A dispatched colonizer does not always become a colony.** The fleet may be
recalled, the account may be at its colony cap, or some other event may stop the
colony forming — in which case no size is ever recorded and the position was
never actually taken. OG-E therefore treats a colonize send as a **hold, not a
commitment**: if no colony is recorded within ~4h of dispatch (and after the
fleet would have arrived), the slot returns to the candidate pool
(`domain/colonizeDecisions.sentExpiresAt`).

### The natural roll is a sum of three uniform draws, not a bell curve

The position-8 roll behaves like the **sum of three independent uniform
draws** on the **field scale**, each about 32 fields wide (Irwin–Hall, n = 3, on 156–252). That
distribution has exactly mean 204 and σ = 96/√36 = 16, hard bounds, and a
**cubic** tail at each end:

```
P(natural ≥ x) ≈ (253 − x)³ / 202 800        near the top (x ≥ ~221)
```

(The 253 treats the drawn size as continuous on [156, 253), so a planet shown
as 252 is any draw in [252, 253).) Each field closer to the maximum is therefore
far harder than the last: relative odds 1 : 8 : 27 : 64 : 125 for 1, 2, 3, 4, 5
fields from the edge.

| Natural ≥ | One in (sum of 3) | One in (normal 204/16) |
|---:|---:|---:|
| 240 | ~90 | ~80 |
| 245 | ~390 | ~190 |
| 247 | ~940 | ~250 |
| 250 | ~7 500 | ~450 |
| 252 | ~203 000 | ~670 |

**The wrong intuition:** *"the roll is normally distributed with mean 204 and
σ 16"*. That describes the middle well, so it survives casual checks, but
it overstates the top: 250 by ~17×, 252 by ~300×. The same three numbers
(252 ≈ 200 000 tries, 250 ≈ 7 500, 247 ≤ 1 000) were posted independently
on the Polish forum by a player who had studied the distribution, and they
match the sum-of-three model almost exactly.

Measured on the same 1818 colonizations: **excess kurtosis −0.41** (sum of
three: −0.40; normal: 0), skew −0.02. Goodness of fit favours the sum of three
(KS 0.022 vs 0.030 for the normal, χ² 12.2/10 bins vs 26.0/12). The highest
natural roll in the set was ~249, and nothing reached 250. The normal model
expected ~4 such rolls, the sum of three ~0.07.

**On the field scale, not the diameter scale.** Since fields are diameter², a
sum of three draws on the *diameter* would be a different distribution of
fields: mean 201.4, skew +0.10. Simulated, it is rejected by the same data:
mean **203.9 ± 0.4** against 204.0 for the field-scale model, and skew −0.02
± 0.06 against +0.00. So the game draws a diameter in a way that makes
**diameter²** (the field count) a sum-of-three. In practice: compute odds on
fields, not on kilometres.

Position ranges known so far: **P8 156–252**, **P1 96–172**, both as natural
fields before any bonus.

## Planet identity — the `cp` counter

Every body OGame creates gets a **`cp` id from one server-wide, monotonically
increasing counter**. It is not per-player and not derived from coordinates.
Three consequences OG-E depends on:

- **`cp` is the only stable identity for a planet *instance*.** Coordinates are
  not, because the same `g:s:p` gets re-colonized repeatedly (see the re-roll
  section above) and each re-colonization is a *different planet* with its own
  field count. In the measured universe, 1474 colonizations occupied only 375
  distinct coordinate slots, and 319 of those slots carried conflicting field
  counts across re-uses. Any dedup or cross-device merge keyed on coords instead
  of `cp` would therefore collapse ~75% of the histogram dataset and silently
  bias it.
- **A re-colonization mints a NEW, higher `cp`.** So "same slot, new planet" is
  detectable without any timestamp.
- **Consecutive colonizations usually get consecutive `cp`.** Because the
  counter is global, other players' colonizations interleave — but on a quiet
  server a player colonizing several slots in a row lands on an unbroken run.
  Measured: **1178 of 1473 gaps between sorted `cp` values were exactly 1**,
  collapsing the whole set into **296 contiguous runs** (longest 24). This is
  what makes a run-length index over `cp` dramatically smaller than the ids
  themselves (13.3 KB → 1.4 KB in that dataset); see
  [`src/domain/cpRanges.js`](../src/domain/cpRanges.js).

Timestamps are **not** a substitute for `cp` as an identity: OG-E stamps its own
observation time, so two devices observing the same fresh planet produce two
different values, and a batch of planets recorded in one page-load shares a
single value.

## Flight distance — the arithmetic that ranks "who can reach me"

OGame's flight distance between two coordinates (the value that drives flight
time, and therefore every "is this neighbour a threat" judgement):

| relation | distance |
| --- | --- |
| different galaxy | `20000 × Δgalaxy` |
| same galaxy, different system | `2700 + 95 × Δsystem` |
| same system, different position | `1000 + 5 × Δposition` |
| same position | `5` |

Both axes wrap on a **donut** server (galaxy 9 → 1 is ONE hop; system 499 → 1 is
one step), and the game always flies the wrapped shortest path — so a naive
`Math.abs` delta hides exactly the closest aggressors. The server's own donut
flags say whether each axis wraps.

**The comparison that is easy to get wrong:** one galaxy hop costs 20000, which
equals `2700 + 95 × 183` — so **"1 galaxy away" is FARTHER than 182 systems away
inside your own galaxy**, and almost exactly as far as "200 systems" (21700).
A neighbour one galaxy over is not a near neighbour. OG-E got this wrong once,
colouring "1 gal" as near while "200 sys" read as far, by thresholding each axis
separately instead of reducing both to a distance first.

Constants and the reduction live in
[`src/domain/geometry.js`](../src/domain/geometry.js) (`GALAXY_STEP`,
`SYSTEM_BASE`, `SYSTEM_STEP`, `GALAXY_IN_SYSTEMS`, `flightDistance`) — that is
the ONE place coordinates become distance; never re-derive it per feature.

## Flight time and fleet speed — from distance to seconds

Flight time for one leg, in seconds:

```
t = round( ( 3500 / s · √(10 · d / v) + 10 ) / U )
```

- `d` — flight distance (section above);
- `v` — the speed of the **slowest ship in the fleet**: a fleet always flies at
  its slowest member, so a faster cargo ship gains nothing while a slower escort
  is in it;
- `s` — the speed setting as a fraction (`1.0` = 100 %, `0.9` = 90 %…);
- `U` — the server's fleet speed factor for that mission type (peaceful, war or
  holding). **Expeditions fly at the peaceful factor.**

Checked against the game: a Reaper fleet at v ≈ 45 500 from position 15 to the
expedition point (position 16, `d = 1005`) on a peaceful ×2 server gives 827 s
= **13:47** each way, which is what the game shows. The fixed-speed RIP formula
in [`src/domain/geometry.js`](../src/domain/geometry.js) (`niszczHours`) is the
same equation with `v = 310`, `s = 1`, `U = 1`.

**An expedition's round trip** is `t_out + hold + t_back`. The hold is the
duration you choose at send, and it is **not divided by `U`**: with a 1 h hold
the same Reaper fleet needs 87:34 on peaceful ×2, ~78:24 on ×3 and ~73:48 on ×4.
The faster the server, the more the fixed hold dominates the cycle.

### Speed bonuses add up on the ship's BASE speed

```
v = v_base · (1 + drive bonus + lifeform bonuses + class bonuses)
```

Every bonus is a percentage of the ship's **base** speed, summed. None of them
multiplies a speed that already includes another bonus. Drive research gives
+10 % (Combustion), +20 % (Impulse) or +30 % (Hyperspace) of base speed per
level, so a Reaper (base 7 000) gains +2 100 per Hyperspace Drive level.

**The wrong intuition:** *"a lifeform speed bonus multiplies the final speed."*
It does not, and the difference was measured. With a test fleet whose
lifeform Telekinetic Drive bonus was +3.61 %, the additive model predicted a
4:01 flight and the multiplicative one ~3:58. The game showed **4:01**. The same
additive rule was confirmed for the Researcher alliance-class bonus, the
lifeform Plasma Drive and the Large Cargo Overclock.

**The Researcher alliance-class expedition speed bonus applies in BOTH
directions**: the flight out and the flight home. (It was once assumed to apply
only one way.)
