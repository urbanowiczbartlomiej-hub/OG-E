# Changelog

All notable changes to this project will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- **Fleet-send buttons no longer complete someone else's fleet2.** Each
  button (Expeditions, Colonization, Daily Run) now tracks ownership of the
  fleet1→fleet2 transition it initiated. A button that finds the dispatch
  form already on step 2 — because you armed a manual send, AGR's routine
  prepared an expedition, or another OG-E button got there first — blocks
  instead of firing the foreign fleet, and routes to a fresh fleetdispatch
  page so its own flow starts cleanly from step 1. Expeditions prepared by
  AGR's routine-7 outside OG-E are still recognised (target position 16 +
  a Pathfinder aboard, read from the game's own checkTarget request) and
  remain one-tap sendable from the Expeditions button.

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
