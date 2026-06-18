# Changelog

All notable changes to this project will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

## [1.25.2] — 2026-06-18

### Added

- **Ad-hoc fleet reminders now follow a full schedule, not just one ping.**
  The Dashboard ▸ Reminders ▸ Ad-hoc tab gains the same chip-style schedule
  editor as fleet-save: a list of offsets relative to the fleet's arrival
  (`−` before, `0` at, `+` after). Arming a leg in the event list schedules
  every slot in that schedule, and editing the schedule re-times all
  already-armed reminders. Your previous single ad-hoc lead time carries over
  automatically.
- **More reminder wildcards.** Ad-hoc and fleet-save message bodies gain
  `{direction}` (outbound / return), `{index}` and `{total}` (this reminder #
  of how many), and ad-hoc also gains `{offset}` (before / at / after arrival)
  — so the two kinds now share one identical wildcard set.
- **"Currently queued" shows the exact message.** Each still-queued reminder
  on the Dashboard ▸ Reminders tab now lists its fire time alongside the
  precise push text that was registered, slot by slot.

### Fixed

- **Ad-hoc push bodies now fill their fleet wildcards.** `{origin}`,
  `{target}`, `{targetName}`, `{shipCount}` and `{direction}` were rendering
  blank in ad-hoc reminders because the per-leg metadata wasn't reaching the
  message renderer; they now resolve correctly.

### Changed

- **Floating command buttons: visual polish.** A single-zone button now dims
  its centre node along with the rest when it goes busy/disabled (no more lone
  bright "island"); long two-word labels (e.g. "All maxed!") wrap to two lines
  instead of crowding the rim; the Expeditions label size now matches the other
  buttons; bottom-zone labels on split buttons sit a touch higher; and a couple
  of redundant hint lines were removed.

## [1.25.1] — 2026-06-18

### Changed

- **Reminder message wildcards: a tidier, non-redundant set.** The
  customisable reminder bodies (Settings ▸ Reminders) drop two duplicate
  placeholders: `{label}` (which was only ever `{mission} → {coords}`) and
  `{landTime}` (an exact alias of `{arrivalTime}`). Ad-hoc and fleet-save now
  advertise an identical wildcard set, differing only by fleet-save's
  schedule-relative `{offset}`, and `{mission}` is now offered on expedition
  reminders too. The default messages were updated to compose `{mission} →
  {coords}` directly. Any custom message you saved earlier keeps working —
  the retired placeholders still render, they just no longer appear as chips.

## [1.25.0] — 2026-06-18

### Added

- **Trader reminder follows the "import refreshes 6× today" event.** On the
  special days when the Import/Export offer renews several times instead of
  once, OG-E detects the event from its in-game news message and lights the
  Trader reminder right away — no waiting until 14:00. After you take a
  container, it reads the page's "come back at HH:MM" time and re-lights the
  Trader menu exactly when the next offer is due, for each of the day's
  refreshes. Reverts to the normal once-daily behaviour the next day.

### Changed

- **Settings ▸ Reminders: tidier topic row.** "ntfy.sh — your topic" now shows
  the masked topic on the right with its Reveal and Copy buttons stacked neatly
  above it, and the separate "topic privacy" label is gone — its note now reads
  as a plain caption under the topic.

## [1.24.1] — 2026-06-18

### Fixed

- **Daily Run now reliably aims at the planet vs the moon you picked.** The
  first fleet you sent on a freshly-opened fleet dispatch page could ignore the
  chosen target type — firing at the planet when you wanted the moon, or the
  moon when you wanted the planet — because the game's AGR helper wasn't ready
  yet when OG-E set the type, and a single attempt was silently dropped.
  Going back to step 1 and tapping again worked around it. OG-E now confirms
  the type actually switched and retries until it sticks (in both directions),
  instead of waiting a fixed moment — so the first send goes to the right body.
  Most noticeable on mobile, where the page settles more slowly.

## [1.24.0] — 2026-06-18

### Added

- **Colony Scout reads far more about your neighbours.** As you scan the galaxy,
  OG-E now keeps a per-server player roster (de-duplicated by player id) holding
  the signals the galaxy view exposes but the per-system map dropped — active vs
  merely on-vacation, strong, newbie, buddy, outlaw, alliance rank, and whether a
  player is in **your** alliance. Colony Scout surfaces these in the Top-region
  summary and the per-region tooltip (e.g. "2 strong · 1 active-on-vac · 1
  outlaw") and folds them into the strategy ranking: the **Peaceful settler** /
  **Farmer** presets now avoid strong and "active-on-vacation" neighbours (a live
  player hiding behind vacation mode, not a safe farm), and the PvP presets prefer
  outlaws (fair-game targets). Older scans are unaffected; the data fills in as you
  re-scan.
- **Neighbour ranks are now shown relative to you.** OG-E reads your own highscore
  rank off the in-game header bar, so the Top-region card annotates the strongest
  neighbour as e.g. "#11 (239 above you)" instead of a bare number — instantly
  telling you whether the area's top player out-guns you or not.
- **Reminder pushes can carry far more fleet detail — one shared wildcard set.**
  Ad-hoc and fleet-save message templates now expose the SAME `{wildcard}` set,
  read from the event list when the reminder is armed / detected: alongside
  `{mission}` / `{coords}` you can now use `{origin}` / `{originName}` (the
  launching planet or moon), `{target}` / `{targetName}` (the mission target),
  and `{shipCount}` (ad-hoc gained it; fleet-save already had it). Expedition-wave
  reminders keep their series wildcards (`{returnTime}` / `{index}` / `{total}`) —
  a wave's pushes are queued before the burst's makeup is known.
- **Reminder schedules now print a plain-language summary.** Under the offset
  chips, OG-E spells out what the whole schedule adds up to — e.g. "15m & 5m
  before landing · at landing · 20m after landing" — so you can sanity-check the
  set at a glance instead of decoding each chip.
- **Your ntfy topic is now explained and protected.** The Reminders tab shows how
  the topic is derived (a one-way hash of your access token — unguessable and not
  listable) and how to lock it down further; the topic is masked by default
  behind a show/hide toggle and treated as the secret it is. The in-game Settings
  panel carries the same masked topic plus a short privacy note.

### Changed

- **Galaxy Observations folded into the Colonizations tab.** The dashboard now
  has a single **Colonizations** tab with three sub-tabs — **Planet sizes** (the
  field-size histogram), **Scanned data**, and **Colony Scout** — mirroring the
  one in-game Colonizations button that both scans positions and colonizes.
  The two separate ⚙ Settings panels (colonization / abandon knobs + scan
  re-scan policy) are now one combined panel below the sub-tabs, with a single
  Save / Reset.
- **Colony Scout "Top region" graphic now matches the rest of the dashboard.**
  The region strip used its own ad-hoc colours that disagreed with the galaxy
  map (empty looked like debris, "fleet sent" looked free, etc.). It now uses
  the canonical status palette, gains a **legend**, draws a thin divider
  **between systems**, and each cell's hover shows the **full per-slot
  breakdown** (status, flags, owner with rank + alliance tag) instead of just
  the system number. The summary line also reports distance to your nearest
  colony. The sub-tab is now tagged **experimental** while its scoring
  heuristics and neighbourhood intel keep evolving.
- **The Colony Scout "Ally tag" field is gone — alliance proximity is automatic
  now.** You no longer type your alliance tag: the galaxy view already tells OG-E
  which neighbours are in *your* alliance, so the proximity bonus applies on its
  own (and self-corrects when alliances change, no re-typing). The "Longest
  streak" preset stays pure length; the other strategies gain the auto bonus.
- **Reminder schedule chips are slimmer; the icon & priority pickers are
  redesigned.** The offset chips dropped their redundant inline phrase (the value
  already reads as text), so they hug their content like the Daily Run chips. The
  message **icon** is now picked from real-image swatches — you see the actual
  push icon, not a dropdown label — and **priority** is a 1–5 segmented control
  with a calm→alarm colour ramp and the level's name.
- **"Currently queued" badges describe the ntfy state and sit by the date.** They
  now read one consistent vocabulary across waves / ad-hoc / fleet-save — queued
  / fired / scheduled / not scheduled / cancelled / "> 3 days out" — instead of
  the wave-only "in flight" / "overdue", and sit next to the date (the cancel ✕
  moved to the right) rather than stranded in the middle of the row.

### Fixed

- **"Set password" from the abandon flow now opens the right tab.** It used to
  deep-link to the old Galaxy Observations tab, which never held the password
  field; it now opens the Colonizations tab, whose ⚙ Settings hold the abandon
  password.
- **Colony Scout no longer shows "nothing" when free slots are scattered.**
  Typing a single slot (e.g. `8`) returned no results unless five+ systems in
  a row had it free — common to never happen once you start colonising that
  slot. When no such region exists, Colony Scout now lists every **individual
  free system** (scored and strategy-ranked), with a clear note explaining why.
- **The dashboard Copy-topic button no longer sticks on "Copied!".** It used to
  overwrite the topic field with its own feedback and then read that back on the
  next click, jamming the display; the feedback now lives on the button and copy
  always uses the real topic.
- **The "Urgent" reminder icon now shows in the dashboard picker.** Its image was
  never bundled into the built extension, so the swatch came up blank; it now
  ships alongside the other icons.
- **The in-game Settings ntfy rows no longer overflow their column.** The masked
  topic plus its show/hide and Copy buttons used to spill past the narrow value
  column into a horizontal scroll, and the topic-privacy note was squeezed into a
  sliver; both rows now span the full panel width with the label as a heading.

## [1.23.0] — 2026-06-17

### Added

- **"Prefer farthest systems first" colonization toggle.** A new per-server
  switch (Galaxy Observations → ⚙ Settings) controls how the Colonize button
  orders free systems *within your home galaxy*. On (the default, unchanged
  behaviour) it proposes the farthest free system first, spreading colony-ship
  arrival times; turn it off to colonize the nearest free system first. Other
  galaxies stay in their usual order.

### Changed

- **Galaxy Observations split into two sub-tabs.** The per-system scan summary
  ("Scanned data") and the Colony Scout settlement analysis now live on
  separate sub-tabs instead of one long stacked page.
- **Reminder schedules shown as compact chips.** Expedition-wave and Fleet-save
  reminder offsets now render as a wrapping row of labelled chips (e.g.
  "10m before", "at landing", "15m after") — full description on hover, invalid
  entries flagged in red — instead of stacked rows of long inline text. Each
  reminder sub-tab also lays its settings beside its message template on wider
  screens (stacking on narrow ones).
- **Galaxy rescan-timing fields packed into a responsive grid** (1–3 columns)
  instead of one tall single-column list.

### Fixed

- **Colonize button no longer gets stuck on a planet it can't settle.** When the
  next free coordinates turn out to be un-colonizable — the slot is now
  occupied, the player is on vacation, it's reserved for a planet-move, or the
  server refuses for any other reason — the button marks that spot, drops it
  from future picks, and on your next tap retargets to the next free slot in
  place (without leaving the fleet screen) instead of looping forever on
  "Wait… / Stale".
- **Galaxy scans no longer bleed between servers when Cloud Sync is on.** With
  sync enabled and more than one universe on the same account, each server's
  scan database is now kept separate. Before, scans from one server could merge
  into another, so the Colonize button could propose coordinates that were empty
  on a different universe but already taken on yours. (Existing mixed data heals
  itself as you re-scan; nothing is deleted.)

### Removed

- **"Clear observation data" button.** The bulk button that wiped all galaxy
  observation data for the current server has been removed; clear per galaxy
  with the per-galaxy ✕ reset buttons instead.

## [1.22.0] — 2026-06-17

### Added

- **Hold the Explore button to skip a planet.** Long-pressing the floating
  expedition button (a 2-second hold, with the ring filling as you press) jumps
  to the next planet still under the per-planet cap *without* sending — for
  deliberately passing over the planet you're on. The round-robin walk then
  carries on from there.

### Changed

- **Artifact Shop event highlight stops once you're done.** The pulsing
  left-menu highlight for the Artifact Shop event now switches off as soon as
  every reward rank is claimed — even though the event keeps running for days
  afterwards. It lights up again automatically when the next Artifact Shop
  event begins.
- **Expedition auto-redirect spreads sends evenly (round-robin).** With "Max
  expeditions per planet" set to 2, the after-send hop now tops every planet up
  to one expedition first, then comes back round for the second — instead of
  stopping after a single pass once every planet had one. It still skips
  planets that have reached the cap and continues to the nearest one that
  hasn't, so manually skipping a planet just moves on. (No change at the
  default of 1.)
- **Clearer "not scheduled yet" fleet-save reminders.** A fleet-save more than
  3 days out can't be queued yet (ntfy schedules at most 3 days ahead). The
  in-game event-list badge now dims and explains it'll be set automatically
  once the fleet is within 3 days of landing, and the dashboard's Reminders
  queue shows "> 3 days out" with the same note — instead of a bare,
  unexplained "Set automatically" / "not scheduled".
- **Dashboard Reminders & Daily Run polish.** The Reminders queue drops the
  redundant server name (it's already chosen in the Server selector) and its
  status line now reflects the selected server; the stale ntfy setup hint was
  trimmed. The Daily Run description matches the button's current labels.

## [1.21.0] — 2026-06-16

### Changed

- **Reminders are now per-server.** Expedition-wave cadence, ad-hoc lead time,
  and the message templates are configured per OGame server (the server comes
  from the Dashboard's top switcher), matching fleet-save. The brief
  "all servers / this server" override toggle is gone — every server simply has
  its own reminder config.
- **Dashboard restructure.** The "Colony Sizes" tab is now **Colonizations**,
  and every tab follows one pattern: the data view leads, with its options
  tucked into a collapsed **⚙ Settings** panel at the bottom. The colonization
  knobs (target positions, prefer neighbouring, arrival gap, abandon threshold,
  abandon password) moved from Galaxy Observations into Colonizations → Settings.
- **In-game settings panel slimmed.** The Dashboard launcher is now its own
  named section, and the redundant reminders signpost row was removed — enable +
  token + topic is the whole minimum; the rest is discoverable in the Dashboard.
- **Polished, responsive settings.** The ⚙ Settings panels (Colonizations,
  Galaxy Observations, Reminders) now share one clean input / select / chip
  style, and the Reminders settings split into three sub-tabs — Expedition
  waves, Ad-hoc, Fleet-save. Lays out cleanly on narrow screens too.
- **New abandon icon.** The Abandon button now shows a snapped colony flag —
  a clearer "this place is being let go" than the old lift-off rocket.

### Added

- **Lifeform artifact-cap badge.** The lifeform discovery button no longer
  blocks at the artifact cap — it keeps discovering and shows a small badge,
  refreshing its counter only when it has drifted.

### Fixed

- **Floating button size now applies to the Abandon button live**, like the
  other FAB modules, when you change the size in settings.
- **Colony histogram now syncs to your other devices.** Colony-size history is
  stored per server, but it synced as one shared blob — so on a second device
  the data landed under the wrong server and the histogram looked empty. History
  now syncs per server, matching where it is stored and shown.
- **The floating button's progress / charge ring no longer leaves a stray dot**
  when empty (a Chrome round line-cap artifact).

## [1.20.0] — 2026-06-16

### Added

- **Custom reminder messages.** In the Dashboard's Reminders tab you can now
  shape the push for each of the three reminder kinds — expedition waves,
  ad-hoc fleet, and fleet-save — choosing the message text, the icon, and the
  priority. Drop in wildcards like server, time, mission, coordinates or ship
  count (click a chip to insert one) and watch a live preview update as you
  type. Defaults match the previous built-in messages, so nothing changes
  until you edit it.
- **Per-server reminder scope.** Expedition-wave and ad-hoc reminders were
  global before; now a server can override the whole group (enable, schedule,
  lead time, and the messages) just for itself, with an "all servers / this
  server" toggle.

### Changed

- **Colony abandon is now one button on the floating action button.** The
  separate "new planet" banner and the red abandon overlay are gone. Instead,
  a freshly-colonized colony that's too small to keep surfaces a red **Abandon**
  button on the FAB (with its field count read straight from the planet list);
  tapping it jumps to that colony, and on its overview the same button walks
  the give-up steps one tap at a time. If no abandon password is set yet, the
  button opens the Dashboard so you can set it.
- **Dashboard tidy-up.** *Target positions* and *Prefer neighbouring galaxies*
  moved into the Colonization section of the Galaxy Observations tab, next to
  the rest of the colonize settings.

## [1.19.5] — 2026-06-15

### Changed

- **Configuration moved into the Dashboard.** The in-game settings panel now
  holds only the essentials — the on/off switches, your sync + ntfy tokens,
  the display toggles, and the expedition options. The detailed config lives in
  the OG-E Dashboard now, next to the data it shapes:
  - **Galaxy Observations tab** — the colonization knobs (arrival gap, the
    abandon field-threshold, and the abandon password) join the per-universe
    scan settings.
  - **Reminders tab** — the expedition-wave + ad-hoc schedules and the
    per-server fleet-save thresholds/offsets, edited through a friendly
    per-entry offset editor that shows each reminder in plain language
    ("10 min before landing", "at landing", …).

  Nothing is editable in two places any more. *After updating, set these once
  in the Dashboard* — they start at defaults (no automatic carry-over from the
  old in-game values).
- **Max expeditions per planet is now a simple 1 / 2 choice** instead of a
  1–20 slider — as a rule you shouldn't send more than two from one planet.

## [1.19.4] — 2026-06-15

### Changed

- **Stronger Trader highlight.** The Trader menu entry and the Auctioneer /
  Import-Export overview tiles now pulse with the same punchy glow as the event
  highlight — the previous outline was so faint it was easy to miss. (Event
  highlights are unchanged.)

## [1.19.3] — 2026-06-15

### Fixed

- **Dashboard Reminders topic really shows now.** The 1.19.2 fix wrote the
  ntfy-token mirror inside the reminder sync, but that sync is skipped on an
  ordinary page reload when the event list hasn't changed — so the dashboard
  still read "set your ntfy.sh access token". The push-topic mirror is now
  refreshed on every producer pass, before that short-circuit, so the topic
  appears whenever ntfy is configured in-game. (Per-wave cards still come from
  cloud sync.)

## [1.19.2] — 2026-06-15

### Fixed

- **Dashboard shows your ntfy topic without cloud sync.** The Reminders tab
  could read "set your ntfy.sh access token" even with a valid token set
  in-game, because the topic mirror was written only after the cloud-sync
  (gist) step. The token is now mirrored independently, so the topic appears
  whenever ntfy is configured. (Per-wave preview cards still need cloud sync —
  that's where wave state lives.)

### Changed

- **Brighter button edge.** The outermost pixels of each command button now
  carry a crisp, vivid state-coloured edge (like the FAB menu orbs), instead of
  fading into the dim fill gradient — single- and split-zone alike.
- **Larger colonization glyph.** The lander now fills its node / menu orb to
  match the other glyphs (it read small and sat low before).

## [1.19.1] — 2026-06-15

### Changed

- **Larger button node.** The "oczko" inside each command button is ~20%
  bigger for better glanceability. On single-zone buttons it's nudged slightly
  up so the larger node grows upward and keeps clear of the label below.

## [1.19.0] — 2026-06-15

### Changed

- **Floating-button menu is always on.** The FAB's module picker is no longer
  hidden behind a +/× handle — the other modules now ride permanently as small
  satellite orbs around the button. Tap one to switch; the picked module flies
  into the button and the previous one drops back into orbit. Orb captions are
  gone (the glyph speaks for itself).
- **Button "oczko" matches its orb.** The node inside each command button now
  wears the same module-coloured dome as that module's satellite orb (no more
  gold medallion), so switching reads as the orb sliding into the button. The
  retired gold node now marks the settings "Open Dashboard" button.
- **Brighter rim filament.** The thin state-coloured thread just inside each
  button's chrome edge now glows instead of sitting dim.
- **Tidier labels.** Tighter line spacing keeps a two-line primary (e.g. "All
  maxed") clear of the node, and the split-button labels sit closer to centre.
- **Simpler Reminders settings.** Dropped the read-only "fires at" preview
  rows (the schedule fields already carry the offsets). Ad-hoc per-fleet
  reminders are now always on — the enable toggle is gone; the lead-time field
  stays.

## [1.18.1] — 2026-06-14

First public (listed) build of the 1.18 line — same features as the 1.18.0
test build, plus packaging and lint fixes.

### Added

- **Configurable Galaxy-Scan strategy (dashboard → Galaxy Observations).**
  Per-status freshness windows for the Scan button — e.g. `6h`, `5d`, or `0`
  (never re-scan). The target-positions list and "prefer neighbouring
  galaxies" preference moved here too. Per-universe and cloud-synced.

### Changed

- **OG-E mark on floating buttons.** Each button's glyph now sits in a small
  gold "glass node" framed by the OG-E orbit symbol; the rim still carries the
  live state colour.
- **Gold FAB handle** that rides the FAB edge facing the screen centre and
  re-aims live as you drag or resize; picker orbs keep their per-module
  colours.
- **Buttons wait for page load before responding** — all four (Expeditions,
  Colonization, Daily Run, Lifeforms), not just Expeditions — with a
  consistent disabled look across single and split shapes.

### Fixed

- **Fleet-send buttons no longer fire someone else's fleet.** Each button
  tracks ownership of the fleet1→fleet2 transition it started and routes to a
  fresh dispatch page if step 2 is already claimed by a manual send or AGR.
- Inline SVG is now built without `innerHTML`, clearing the add-on linter's
  "unsafe assignment" warnings.

## [1.18.0] — 2026-06-14

### Added

- **Configurable Galaxy-Scan strategy (dashboard → Galaxy Observations).**
  Per-status freshness windows for the Scan button — e.g. `6h`, `5d`, or `0`
  (never re-scan). Suits farm-hunting, slot-finding, or watching active
  players. Target-positions list and "prefer neighbouring galaxies" also moved
  here from the AGR panel. Per-universe and cloud-synced.

### Changed

- **OG-E mark on floating buttons.** Each command button's glyph now sits in
  a small gold "glass node" — a convex cabochon framed by the OG-E orbit
  symbol (three gold arcs + three beads). The rim still shows live state
  colour; the node stays gold in all states. On split buttons (Colonization,
  Daily Run) the node sits centred on the seam with the dividing line
  inverted to frame it; on single buttons (Expeditions, Lifeforms) the node
  sits in the upper section.
- **Gold FAB handle.** The floating-button picker handle now shows a gold
  ring + gold "+" (rotating to "×" when open) instead of tinting to the
  active module's colour. Picker orbs keep their per-module colours.
- **FAB handle tracks the screen centre.** The "+"/"×" handle rides the FAB
  edge facing the viewport centre — the same side the picker orbs fan toward
  — and re-aims live as you drag or resize the window.
- **Floating buttons wait for page load before responding.** All four buttons
  (Expeditions, Colonization, Daily Run, Lifeforms) sit visibly disabled
  until OGame's event list finishes loading on the fleet-dispatch page, then
  enable themselves. Previously only Expeditions guarded this, and only by
  flashing "Wait…" after tapping.
- **Consistent disabled appearance.** A greyed-out button dims only its inner
  face and label; rim, progress ring and gold node stay bright — same on
  single-face and split buttons.

### Fixed

- **Fleet-send buttons no longer fire someone else's fleet.** Each button
  tracks ownership of the fleet1→fleet2 transition it started. If step 2 is
  already claimed by a manual send, AGR, or another OG-E button, the button
  blocks and routes to a fresh fleetdispatch page instead of continuing the
  foreign fleet. AGR routine-7 expeditions (position 16 + Pathfinder) are
  still recognised and remain one-tap sendable.

## [1.17.0] — 2026-06-10

### Added

- **Subtle background glyphs on the floating buttons.** Each command button
  now carries a faint, monochrome line-glyph behind its label as a
  glanceability cue — a comet for Expeditions, a landing craft for
  Colonization, a planet-with-flight-arc for the Daily Run, and a DNA helix
  for Lifeforms. The glyph is tinted to the button's current state colour
  (so it stays quiet in the amber "wait" / rose "error" states and brightens
  with the active colour) and sits below the label, ring and charge arc so
  it never competes with them. Single-zone buttons show one half-size glyph
  tucked toward the top; split buttons carry a smaller glyph in the lead zone
  only.

### Changed

- **Hold-to-confirm is now 2s (was 3s)** on the two buttons that use it — the
  Colonization "skip/scan" hold and the Daily Run "set collect target" hold.
- **Lifeforms button labels tidied.** "Empty → next" → "Empty", "To galaxy" →
  "Discover", and the "(N left)" counter is gone (with thousands of systems
  always pending, the number carried no useful signal).

### Fixed

- **Cross-device sync no longer drops lifeform discoveries.** A plain galaxy
  rescan on one device could overwrite a lifeform discovery recorded on
  another after a sync round-trip, because scans merged as a whole unit keyed
  on the regular scan timestamp. Lifeform markers now reconcile independently
  (newest discovery wins; discovered positions are unioned), so a routine
  rescan can't erase a discovery from another device.

## [1.16.5] — 2026-06-10

### Added

- **Floating "Lifeforms" button** (violet, single zone). Automates OGame's
  system-discovery action across the whole universe — one tap per system,
  TOS-safe (the button clicks the game's own `#discoverSystemBtn`; it never
  originates an HTTP request itself).
  - Off galaxy view → navigates to the galaxy page.
  - On galaxy, current system undiscovered → clicks the game's discover
    control; the result is observed via the new `discoveryHook` bridge and
    `lfScannedAt` / `lfPositions` are stamped in the scan store.
  - On galaxy, current system already covered → in-page hops to the
    **nearest** still-undiscovered system (wrap-aware: dist(499, 1) = 1).
  - `shipsSent: 0` (game reports system fully sent) → still marks the system
    as covered so the button advances cleanly.
  - Fleet-cap rejection ("Maksymalna liczba flot") → surfaces "Max fleets",
    marks nothing; the system remains queued.
  - 7-day per-system retention gate (same store as colonisation scanning;
    colonisation rescans do not wipe lifeform markers).
  - Enabled by default. Settings: "Floating Lifeforms button" toggle +
    size slider (40–560 px, default 320 px).

## [1.16.4] — 2026-06-10

### Added

- **Per-button identity colours.** Each floating button now has its own
  colour signature: expedition in cerulean blue (`#4aa8ff`), colonisation
  in cyan (`#13d1de` ready / `#12b3c2` idle) with a muted cyan scan zone
  (`#3a9fb0`), daily-run in pure green (unchanged). Status colours (amber
  wait, rose error, slate disabled) remain shared and unchanged.
- **`--glow` intensity multiplier.** A new `--glow` CSS variable (default
  `1`) scales the button's resting and hover glow radius. Expedition is
  set to `1.3` for a visibly stronger glow; other buttons stay at `1`.

### Fixed

- **Mobile keyboard no longer pops up on button tap (split buttons).**
  `mousedown.preventDefault()` in the tap-wire layer prevents the browser
  from focusing `<button>` elements on touch without suppressing the click
  event. Complements the `tabIndex=-1` fix from 1.16.3.
- **Mobile keyboard no longer pops up on page load after navigation.**
  `installFocusPersist` now skips programmatic `button.focus()` on
  `pointer:coarse` devices, where focus restoration has no UX value and
  could trigger the virtual keyboard.

## [1.16.3] — 2026-06-09

### Added

- **Symmetrical planet prime function in fleet executor.** Mirror of the moon
  prime logic — `primeAgrPlanet()` ensures AGR's planet flag is set before
  writing coordinates (needed because AGR guards planet-type clicks with
  `isTrusted`, blocking synthetic events).

### Fixed

- **Daily-run button label now shows correct next target on page load.** Added
  1 Hz ticker (matching send-colony pattern) to refresh labels even if
  `#eventContent` populates late — ensures "N left" counter and target name
  are accurate from the moment the page loads.
- **Mobile keyboard no longer pops up when tapping floating buttons.** Changed
  button `tabIndex` from `0` to `-1` — buttons remain clickable but exit tab
  flow, preventing unwanted focus on touch.

### Changed

- **Button touch-action CSS.** Changed from `none` (blocks all gestures) to
  `manipulation` (allows tap, blocks auto-zoom and system tap highlights) for
  better mobile UX.
- **Daily-run dim state now uses controller API.** Replaced manual `dimZone()`
  calls with `controller.setDim()` for consistency with expedition/colony
  buttons and reliability.

## [1.16.2] — 2026-06-09

### Added

- **Progress arc on colonization wait.** While waiting for the colony-ship
  min-gap (the "Wait Xs" state), a visual progress arc fills proportionally
  as the wait elapses — giving real-time feedback on how much longer until
  the send becomes available.

### Fixed

- **Moon page home-planet detection.** On moon pages where OGame places the
  highlight marker on the moon-link rather than the row element, the
  colonization button now correctly identifies your home planet.

### Changed

- **Colonization "Send Colony" label shortened to "Send".** Shorter label
  fits the new HUD-style button design while coords remain visible below.
- **Fleet dispatcher integration.** The send-colony hook now reads the
  target from `window.fleetDispatcher.targetPlanet` when available,
  allowing fleet-courier links to work without encoding coords in the URL.

## [1.16.1] — 2026-06-09

### Added

- **Event highlight auto-silences when all daily tasks are done.** Once you
  complete every task on the Rewards page the orange pulse on the event menu
  button disappears for the rest of the day (14:00 reset). It comes back
  automatically the next game-day, when a fresh batch of tasks is available.
- **Daily-action state syncs across devices.** "Rewards done today", last
  trader bid, and last import trade are now included in the Gist sync — so
  completing tasks on one device silences the highlights on all others within
  the next sync cycle.

### Changed

- **Button "Wait…" state is now consistent and grayed out.** All three
  floating buttons (expedition, colonization, daily-run) now show **Wait…**
  while an async operation is in progress and dim to 50 % opacity for the
  duration — replacing the earlier mix of "Loading…" and "Preparing…" labels
  on the expedition button.
- **Colonization button label hierarchy flipped.** The action label is now the
  large primary line; coordinates and hints appear smaller below it.
  Send zone: **Send Colony** (large) → `[g:s:p]` → *(hold to skip)*.
  Scan zone on galaxy view: **Scan** (large) → `[g:s]` → *(N left)*.
  Scan zone elsewhere: **To galaxy** (large) → *N left*.

## [1.16.0] — 2026-06-09

### Added

- **Per-universe settings sync via Gist.** Each universe you play now gets
  its own section in the Gist — expedition/colonization slots, daily route,
  fleet-save and reminder settings — so switching universes no longer
  overwrites your other accounts. One Gist, all universes, fully
  independent.
- **Expedition fleet memory.** After landing on fleet1 for an expedition,
  long-press the button to save the current ship selection as your preset.
  Every subsequent tap replays that preset at 51 % of available ships (as
  before). No preset saved yet? The button shows "Hold to set" so you
  always know where you stand.
- **Colonization: skip a blocked target with a 3-second hold.** If the
  colony-ship is already flying toward a slot, you can hold the Send zone
  to jump past that target and queue the next candidate instead of
  waiting for it to clear.

### Changed

- **Expedition and Colonization buttons are now independent of AGR.**
  OG-E drives the fleetdispatch page directly — no `#ago_routine_7` or
  `#sendall` hooks — so the buttons continue to work even when AGR is
  disabled or absent. Target coordinates are written straight into the
  native form inputs; the game fires its own `checkTarget` as normal.
- **Daily Run button** (formerly "Daily Resource Run") renamed to the
  shorter "Daily Run" across the dashboard tab, hover tooltip and settings
  panel.
- **Reliable fleet-dispatch readiness.** All three buttons now wait for
  the game's own `#dispatchFleet` element to be ready (absence of the
  `.off` class) before firing — eliminating the race condition where an
  early click would lock the button without sending.
- **Moon targets supported.** The courier correctly fills in planet-type 3
  when the configured destination is a moon, fixing a silent no-send for
  moon-to-moon operations.
- **Colonization re-entry wait.** After a colony-ship dispatch OG-E pauses
  until fleetdispatch reloads before resetting the button, preventing a
  double-click from landing on a stale page.

### Fixed

- Daily Run: ship-count edits in the settings panel now correctly activate
  the Save button.
- Daily Run: moon planet name is now read from the icon `alt` attribute
  instead of `.planet-name`, matching what the game sets in that context.
- Fleet: `setTargetType` also calls `fd.setTargetType` to bypass AGR's
  `isTrusted` guard that was silently dropping the call.
- Multiple smaller bugs in the Colonization / Daily Run send flow
  (galaxy/system/position not wiring, mission not being armed, result not
  being awaited).

## [1.15.5] — 2026-06-04

### Changed

- **Engraved button title sits on the ring.** The curved title now rides
  along the ring band near its top, instead of dropping onto the lit
  button face — so each button's name reads as cut into the ring itself.

## [1.15.4] — 2026-06-04

### Changed

- **Floating buttons get a tactile tap effect.** Tapping a button now
  sends a light ripple out from the exact touch point and briefly
  brightens the pressed area. On the two split buttons (Colonization,
  Daily Resource Run) the ripple starts in whichever half you pressed,
  so it is obvious which action you triggered.
- **Engraved title ring.** Each button now carries a thicker ring with
  its name engraved along the top of the ring itself —
  `EXPEDITIONS`, `COLONIZATION`, `DAILY RESOURCE RUN` — in a dark,
  cut-in style that stands out against the band.
- **Deeper outer shadow.** The buttons cast a stronger, layered shadow
  for a clearer floating look, with a tight rim that keeps them defined
  against bright backgrounds.

## [1.15.3] — 2026-06-04

### Changed

- **Floating buttons redesigned to match the OGame look.** The three
  draggable buttons — **Expeditions**, **Colonization** and **Daily
  Resource Run** — share a new decorative layer drawn on top of their
  state colours: a thin light rim, a darkened edge vignette and a soft
  top sheen give each one a glassy, game-native finish instead of the
  flat technical look. Drop shadows are deeper for a clearer sense of
  the buttons floating above the page.
- **Each button now has a hover title.** A subtle native tooltip names
  the button (`Expeditions`, `Colonization`, `Daily Resource Run`) on
  hover, so its identity is discoverable without cluttering the face.
- **Daily Resource Run polish.** Zone colours are now semi-transparent
  to match the other two buttons, labels use sentence case (`Dispatch`,
  `Send All`, `Send`) instead of shouting capitals, and holding the
  collect zone shows a radial sweep that fills as the long-press arms.

## [1.15.2] — 2026-06-04

### Changed

- **Button label redesign — three-level layout.** All in-flight and idle
  states now use a consistent *main / subtitle / micro-hint* hierarchy
  (same small font for every secondary line):
  - **DISPATCH idle (has route):** `SETUP` + `Collectors (no routes)` at
    hint size (no middle subtitle). `DISPATCH` + `Collectors (n)` when a
    route exists.
  - **DISPATCH in-flight:** `Collectors route` + `to G:S:P 🌙/🪐` +
    `Next` (step 1) or `Send` (step 2).
  - **SEND ALL idle:** `SEND ALL` + `to G:S:P 🌙/🪐` + `(Hold to change
    target)`, or `(Hold to set target)` when no target is chosen yet.
  - **SEND ALL in-flight:** `Collect All` + `to G:S:P 🌙/🪐` + `Next`
    (step 1) or `Send` (step 2).
- **SEND ALL state detection fix.** The button no longer activates its
  collect sequence states when the player manually navigates to the bare
  `?component=fleetdispatch` page — only a URL generated by clicking
  SEND ALL (which carries `galaxy` / `system` / `position` params) now
  triggers the intermediate labels and auto-dispatch logic.

## [1.15.1] — 2026-06-04

### Changed

- **Daily Transport renamed to Daily Resource Run.** The feature, its dashboard
  tab, and its settings section are now consistently named "Daily Resource Run"
  across all UI surfaces.
- **Button labels refreshed.** The top zone now reads **SETUP** (no routes
  configured) or **DISPATCH** with a *Collectors (n)* subtitle. The bottom zone
  now reads **SEND ALL** with a *to G:S:P [moon]* destination line and
  *(Hold to change/set target)* micro-hint.

## [1.15.0] — 2026-06-04

### Added

- **Body inventory capture and route picker.** OG-E now reads your planet and
  moon list from the in-game left bar on each page load and persists a
  snapshot. The dashboard's **Routes editor** now shows a clickable picker for
  both route source and destination instead of manual coordinate entry; you
  see body names (P1, K1) with icons and can click to select. Dead-body
  reconciliation runs automatically — if you abandon a colony or destroy a
  moon, any routes using it as a source or target are pruned, and a route
  that loses all sources or targets is dropped entirely.

- **Fleet-save routes redesign — multi-source + automatic migration.**
  Routes can now depart from **any of your planets or moons** instead of a
  single hardcoded source. Old single-source routes from 1.14.0 are
  automatically migrated. Each route independently tracks its departure
  bodies, so a route can use multiple sources; the collect sequence sends
  from each in turn.

- **Daily Transport button — unified three-zone design.** The floating button
  now combines micro-fleet, target pick, and collect actions in a compact
  two-zone layout with new micro-navigation:
  - **Micro zone** (top-left): send a single small cargo to the route
    destination, if a route exists.
  - **Collect zone** (bottom-right): run the full multi-source fleet-save
    sequence.
  - Current route destination displays under each zone; tapping "no route" on
    the Collect zone opens the dashboard route editor.
  - Real-time **send counter** shows in-flight vs total targets (e.g. `2 ⇄ 5`).
  - **Long-press hint** on smaller viewports to aid mobile discovery.

- **Cross-device route sync.** Your fleet-save routes now sync across devices
  via your private GitHub gist, alongside the other settings and data that
  already sync — set up a route on one device and it appears everywhere.

- **Dashboard fleet-save Routes editor** — full-featured management UI:
  - Click routes in the list to edit or delete.
  - Clickable **source picker** (any of your planets/moons) with names + icons.
  - Clickable **target picker** (any coordinates, any body type).
  - **Save button** with dirty-state indicator — unsaved changes are
    highlighted visually.
  - Reconciliation feedback — removed routes are logged to console when bodies
    disappear.

### Changed

- **Daily Transport button renamed** — previously labeled "Fleet Save" (v1.9.0);
  now correctly named to reflect what it does. The button sends daily cargo
  fleets to your designated target, not a "fleet save" per se.
- **Ship names now display in English** — routes show ship types as "Small
  cargo", "Large cargo", "Pathfinder" instead of Polish (małe, duże, zwiadowca).

### Fixed

- **Dashboard routes remove button styling** — aligned with the button row
  layout.

## [1.14.0] — 2026-06-03

### Added
- **Fleet-save reminders can now be cancelled — but only at the last
  moment.** A 🛡 reminder becomes clickable only in the final **2 minutes**
  before each slot fires (before that it stays the passive auto badge). One
  click cancels just that nearest reminder; any later ones in the series stay.
  The exception: cancelling the **last reminder before landing** also drops
  every at/after-landing reminder — if you're in-game seeing it, the
  post-landing pings are pointless. The cancellation is local and
  self-expiring, and survives the fleet being re-detected on the next scan.

### Fixed
- **Your ntfy topic (and the account-status line) now show on load** in
  Reminders settings, ready to copy — they used to stay blank until you
  edited the token. The async status rows fired their first probe while the
  row was still detached from the page, which then suppressed the real
  paint once it was attached.

## [1.13.0] — 2026-06-02

### Added
- **Trader red glow clears from the Import/Export page.** Opening
  Import/Export and seeing "no more offers today" (the daily container is
  already taken) now clears the red glow for the rest of the day — you no
  longer have to take the container *through* OG-E in the same session for
  the reminder to settle.
- **Trader yellow glow follows the auction clock.** On the Auctioneer page
  between auctions, OG-E reads the "next auction in …" countdown and keeps
  the yellow glow quiet until that auction actually opens — a precise
  replacement for the old fixed ~30-minute guess. While an auction is live,
  the glow is left alone so it still nudges you to bid.

### Changed
- **Reminders settings — "Check now" moved to the master row.** The ntfy
  account-status re-check button now sits on the *Reminders — master switch*
  row (right-aligned, like *Sync now* in Multi-device sync); the status line
  below it is read-only.
- **Reminders settings — per-group gating.** Each reminder group's options
  now grey out when that group's own *enable* is off: the expedition-wave
  schedule follows *Expedition-wave reminders — enable*, the ad-hoc lead time
  follows *Ad-hoc reminders — enable*, and the fleet-save threshold / min
  flight time / schedule follow *Fleet-save reminders — enable*.

## [1.12.0] — 2026-06-02

### Added
- **All your settings now sync across devices.** Cloud sync used to carry
  only scan/colony data; it now also syncs your OG-E preferences through
  your private GitHub gist — **including the ntfy token** — so a second
  device picks up your configuration. Each setting merges independently
  (most-recently-changed wins per setting). Per-device exceptions that never
  sync: the two floating-button sizes and the GitHub token itself.
- **ntfy.sh account status** under the token field: today's usage vs your
  daily limit (`✓ 12 / 250 messages used`) with a **Check now** button, and
  explicit feedback for a wrong/rejected token (`✗ Not a valid token`,
  `✗ Token rejected by ntfy.sh`) instead of silent failure.
- **Your ntfy topic** is now shown in the Reminders settings too (was
  Dashboard-only) — the topic to subscribe to in the ntfy app on your phone,
  right where you enter the token.

### Changed
- **Expedition-wave reminder schedule is now free-form** (default
  `0m, 10m, 30m, 60m`), and **all reminder time fields share one
  minutes-first format** with an optional `s`/`m`/`h` suffix (a bare number
  is minutes). Lead time / min flight read `1m` / `10m`; fleet-save offsets
  read `-10m, 0m, 10m`.
- **Section master switches**: a section's top toggle now greys out the rest
  when off. Multi-device sync (`Sync across devices`) gates the token +
  status; Colonization gates its options. (Expeditions stays independent —
  badges and auto-redirect aren't tied to the floating button.)
- **Multi-device sync layout + feedback**: the **Sync now** button moved onto
  the master row (right-aligned); the status line gets its own full-width row
  with upload/download on one line, updates the **instant** a sync settles
  (a failed sync shows `⚠ HTTP 401: Bad credentials` right away instead of
  after a delay), and the GitHub error is condensed to one line instead of a
  multi-line JSON dump.
- **Reminders settings relabelled** to a consistent `Group — attribute`
  scheme; value input fields widened.
- **Max expeditions per planet** is now a 1–20 slider instead of a text box.
- **Colonization tidied**: the target-positions field documents its range
  syntax (`8,10-12,15`), the "prefer neighbouring galaxies" toggle moved
  above it, and its label was shortened so it no longer wraps.

### Note
- The wave schedule and fleet-save offsets **reset to their defaults** on
  this update (the old formats are incompatible with the new free-form one).
  Re-enter a custom series if you had one.
- Synced settings include your **ntfy token and — if set — the abandon
  password**, stored in your **private** GitHub gist. Private gists are not
  encrypted: anyone with your GitHub token could read them. The GitHub token
  itself is never synced.

## [1.11.1] — 2026-06-02

### Fixed

- **Fleet-save reminders now appear on the Dashboard.** The Reminders tab
  listed expedition waves and ad-hoc fleet reminders but silently omitted
  the auto-detected fleet-saves added in 1.11.0 — the preview had no
  fleet-save section at all, so a detected 🛡 save showed nowhere even
  though its pushes were queued.
- **The Dashboard no longer cancels its own fleet-save pushes.** The tab's
  orphan sweep (which deletes ntfy messages that belong to no live
  reminder) only recognised wave and ad-hoc messages as "ours", so it
  treated every queued fleet-save reminder as a stray and deleted it from
  ntfy — quietly undoing the feature whenever the Dashboard was open. It
  now claims all three reminder kinds.

### Changed

- The extension page is now named **dashboard** on disk (`dashboard.html` /
  `dashboard.js`), retiring the legacy `histogram` filename — it has been
  the multi-tab "OG-E Dashboard" for several releases, not just a
  histogram. Purely an internal/asset rename; the visible name, tabs, and
  data are unchanged, and your saved active-tab preference carries over.

## [1.11.0] — 2026-06-02

### Fixed

- Long fleet-saves now actually fire. A fleet-save detected while its
  landing was still **more than 3 days out** got its 🛡 badge but never a
  push: ntfy.sh refuses delays beyond 3 days, so every reminder slot was
  filtered out at detection — and because the producer skips the sync
  whenever the event list looks unchanged, nothing rescheduled it once the
  fleet finally crossed into the 3-day window (the row's id and arrival
  never change as time passes). The scan signature now tracks when a
  fleet-save's earliest slot enters ntfy's range, so it re-syncs and queues
  the pushes exactly once at that moment. This also closes the matching gap
  for a fleet recalled mid-flight whose return leg is retimed past — or back
  inside — the 3-day cap.

### Changed

- Reminder tooltips now spell out the exact clock times that were
  registered with ntfy, matching the expedition-wave tooltip:
  - **Fleet-save** hover now reads `Fleet-save reminders at: HH:MM, …` (the
    slots actually queued, inside the 3-day cap) followed by `Set
    automatically — can't be cancelled`. The mission, coordinates and ship
    count are dropped from the hover — you already see them in the row; they
    still ride along in the push itself. A save still beyond the cap shows
    the bare auto hint until its first slot comes into range.
  - **Ad-hoc** hover now reads `Reminder at HH:MM — click to cancel` instead
    of the time-less `Reminder armed`.
## [1.10.0] — 2026-06-01

### Changed
- Trader reminder reworked. The Auctioneer and Import/Export reminders are
  now separate glows, and each one clears only when you actually do the
  thing — place a bid / take the container — rather than just by opening
  the Trader menu.
  - Yellow (Auctioneer): glows during auction hours; placing a bid quiets
    it for about half an hour, then it reminds you about the next auction.
  - Red (Import/Export): glows from 14:00 until you take the daily
    container, then resets at midnight. It deliberately stays dark before
    14:00 so it never tempts you to spend your one daily import before the
    afternoon tasks that may need it.
- The glows now also light the matching tiles on the Trader overview
  screen, and the Trader menu button steps aside for OGame's own
  hover/selected styling instead of overriding it.

---

Older releases (≤ 1.9.3) live in [`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md).
