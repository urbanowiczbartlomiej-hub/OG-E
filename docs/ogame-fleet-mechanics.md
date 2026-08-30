# OGame fleet mechanics — reverse-engineered reference

OG-E has no access to OGame's source or docs. Everything here is
reverse-engineered game knowledge that several features (fleet-save reminders,
planet status markers) depend on. This is the **single home for the game
*rules*** — in-code comments point here instead of repeating them. For the exact
marker classification, the authoritative source is the code:
[`src/features/badges/pure.js`](../src/features/badges/pure.js).

## The ajax token — one rotating value per session (13.0+)

Diagnosed 2026-07-27 from a HAR of a **13.0.0-r5** universe, re-checked against
the shipped bundle.

- The session holds **one** ajax token. Since 13.0 `action=checkTarget`
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

**A dispatched colonizer does not always become a colony.** The fleet may be
recalled, the account may be at its colony cap, or some other event may stop the
colony forming — in which case no size is ever recorded and the position was
never actually taken. OG-E therefore treats a colonize send as a **hold, not a
commitment**: if no colony is recorded within ~4h of dispatch (and after the
fleet would have arrived), the slot returns to the candidate pool
(`domain/colonizeDecisions.sentExpiresAt`).

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
