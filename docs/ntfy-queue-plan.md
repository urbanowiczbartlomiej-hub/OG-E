# Plan: ntfy queue as the single shared reminder state

Transient plan doc (delete when the cycle closes). Decision 2026-11-28: the
alarm clock stops keeping its state in the GitHub gist; the ntfy queue becomes
the one state every device reads and converges on. Post-landing reminders keep
today's rule: **swept when a device sees the leg gone** (the player is back).

## Why

- Today every reminder round is gist READ → ntfy reconcile → gist WRITE, gated
  on the GitHub token (`syncAlarmClock`: `no-token` ⇒ nothing scheduled).
  GitHub's gist write limit (100/h) or any GitHub outage therefore blocks the
  phone alarms — seen live 2026-11-27.
- The gist exists only so two devices don't fight: each reconcile CANCELS every
  queued message of its title it does not know. Without shared state the phone
  would cancel what the desktop armed.

## Core mechanism

1. **Every message carries its identity** in its click URL (`X-Click`; returned
   by the poll, invisible in the notification, and tapping it opens the
   universe's fleet movement):
   `https://<uni>.ogame.gameforge.com/game/index.php?page=ingame&component=movement#oge=<payload>`
   with `payload` = `v1.<kind>.<key>.<slot>.<anchor>.<gen>[.<extra>]`
   - `kind`: `ad` (ad-hoc) · `fs` (fleet-save) · `wv` (expedition wave) · `fr`
     (fleet reminder / guardian)
   - `key`: event row id (`ad`, `fs`), wave id (`wv`), body key (`fr`)
   - `slot`: signed offset seconds from `anchor`
   - `anchor`: arrival / wave base / landing epoch seconds
   - `gen`: series generation (see 4)
   - `extra`: `fs` → landing body key (feeds landing detection)
2. **Read everything the queue knows**: poll `scheduled=1` AND the cached,
   already-fired messages (ntfy.sh keeps ~12 h). Fired messages still prove a
   series existed (armed / classified / dismissed state), only future ones are
   acted on.
3. **A device cancels a series only for a provable reason:**
   - an explicit act on THIS device (disarm, cancel a slot, dismiss a wave,
     clear an FR mark, re-save);
   - the series' flight row is gone from the event list (`ad`, `fs`: row id
     absent; `wv`: no member return left) — the event list is the same on
     every device, so this is shared truth;
   - a message of an OLDER generation of the same series.
   Messages it cannot decode (other universes, old format) are never touched;
   old-format ones are simply left to fire (one-time migration).
4. **Generations instead of tombstones.** The slot set of a series is decided
   by whoever (re)writes it: cancelling one slot / changing offsets re-posts
   the remaining future slots with `gen+1`; every device then sweeps lower
   generations and only completes MISSING slots of the highest generation
   (a reload mid-post converges). A device never re-adds a slot the newest
   generation does not list — so a cancelled slot stays cancelled everywhere.
5. **Dismissals are best-effort, no markers** (decided 2026-11-28: "better too
   many than too few"). A wave dismiss / FR clear deletes the series on this
   device; another device that still sees reason for it may re-create it. The
   FR mark itself is data-synced, so its re-creation stops once the clear
   syncs.
6. **The intended slot set travels with the series** (`p` = the offsets list of
   that generation), so a device completes only slots the newest generation
   lists — a slot cancelled on one device is never re-added by another, while
   a reload mid-post still converges.

## Per kind

| | key | created by | gone when | user acts |
|---|---|---|---|---|
| ad-hoc | row id | arm (local intent queue, reload-safe) | row absent | disarm → delete series |
| fleet-save | row id | first device whose gates classify it (threshold, min flight, send hint) — the queue IS the lock | row absent (landing detection reads `extra` = landing body) | cancel slot → new gen |
| wave | wave id + anchor | committed wave on any device; another device ADOPTS a queued wave whose anchor is within tolerance instead of posting its own | no member return left | dismiss → marker (5) |
| FR / guardian | body key + landing time | auto landing or manual mark | never by the event list | clear / re-save / ack → delete (+ marker 5) |

The FR *mark* shown at the planet stays in the data sync (display state, a
minute of latency is fine); its pushes live in the queue like the others.

## What changes in code

1. `sync/ntfyReconciler.js` — identity encode/decode, poll incl. fired
   messages, keyed reconcile (generations, adopt, provable-cancel only).
2. `sync/alarmClock.js` — no gist read/write; state = decoded queue + local
   pending intents + DOM; returns the same `{fleetSave, landings, failedKinds}`
   to the producer. Gated on the ntfy token only.
3. `features/alarmClock/producer.js` — drop the `no-token` (GitHub) gate.
4. Dashboard Reminders view — read the queue live (ntfy token is already in
   `chrome.storage`), drop the "enable cloud sync" text.
5. Tests per step (critical path — not deferred to release).

## Stages

All five landed together on 2026-11-28 (`src/domain/ntfyQueue.js`, `syncAlarmClock`,
the dashboard preview); kept here as the design record until the cycle closes.

1. Identity + keyed reconcile (pure, unit-tested), behind the old orchestration.
2. Orchestration switch (no gist), FS + ad-hoc first.
3. Waves (adoption + dismiss).
4. FR / guardian.
5. Dashboard preview, remove the alarm-clock gist file code.
