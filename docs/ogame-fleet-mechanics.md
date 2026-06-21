# OGame fleet mechanics — reverse-engineered reference

OG-E has no access to OGame's source or docs. Everything here is
reverse-engineered game knowledge that several features (fleet-save reminders,
planet status markers) depend on. This is the **single home for the game
*rules*** — in-code comments point here instead of repeating them. For the exact
marker classification, the authoritative source is the code:
[`src/features/badges/pure.js`](../src/features/badges/pure.js).

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
