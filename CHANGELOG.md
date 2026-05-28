# Changelog

All notable changes to this project will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Deferred for a later release

- Stale rescan queue (one-click-per-jump) on the galaxy observations
  page. TOS allows at most one HTTP request per click, so this must
  take the queue-cursor shape (1 click → 1 nav to the next stale
  system), not a batch action.
- Keyboard shortcuts beyond ArrowRight on fleetdispatch.

## [1.3.1] — 2026-05-28

### Changed

- **Expedition reminders no longer need a Cloudflare Worker.** Setup is
  now three things: enable the toggle in the in-game OG-E settings, paste
  an ntfy.sh access token, subscribe to the auto-derived topic in the
  ntfy phone app. The extension publishes pre-scheduled messages to
  ntfy.sh using its `X-Delay` header — ntfy itself holds the queue and
  delivers each push at the right minute, even when the browser is
  closed. No `wrangler deploy`, no per-user server, no GitHub PAT for a
  Worker. The `worker/` directory has been removed.
- **Wave identity is now purely time-based.** Two clusters whose
  `nextWaveAt` are within five minutes of each other count as the same
  wave; planet-set tracking was dropped from identity (still shown on
  the dashboard for display). One consequence the user should know
  about: if you re-send your whole burst between extension scans, the
  old wave persists as "idle" until the full 70-minute reminder
  window passes — its lingering pushes will fire. Re-sending while the
  game tab is active (the common case) is unaffected.
- **ntfy topic is derived from the gist id** (SHA-256 prefix). No more
  random topic generation; both the extension and the (formerly) Worker
  arrive at the same channel by computing from `GIST_ID`. Existing
  configurations that still carry an old `ntfyTopic` field are silently
  ignored.
- **Reminders config moved to the in-game Settings panel** alongside
  cloud sync and the other preferences. The dashboard's Reminders tab
  is now observability-only: shows the derived topic, the live ntfy.sh
  queue per wave, and the per-wave fire times pulled directly from
  ntfy's queue endpoint (so you see "Fires at: 12:22, 12:32, …" with
  the actual scheduled moments).
- **Six reminders × 10 min per wave, hard-coded.** No more user-tunable
  repeat interval, allowed-hours window, per-wave cap, or gap-seconds
  knob — the Settings table is two rows (toggle + token), nothing else.
  Quiet hours are handled on the phone via ntfy's do-not-disturb.
- **Push priority escalates 3 → 4 → 5 across the six reminders**
  (default → high → max, two per band). First ping is normal so it
  doesn't yank you out of whatever you're doing; later ones get
  louder if you keep ignoring them.
- **Histogram page rebranded "OG-E Dashboard"** — the multi-tab layout
  (Colony Sizes, Galaxy Observations, Free Positions, Reminders) had
  outgrown the "histogram" label. File paths on disk are unchanged for
  backwards compatibility.

### Fixed

- **Overlap-aware wave reconcile + automatic orphan cleanup.** Earlier
  versions could leave stale reminders queued on ntfy.sh after schema
  changes or partial cancellations. Each sync now sweeps ntfy.sh and
  cancels any scheduled message that is not in the current state
  (filtered to future-only, so already-delivered cached messages are
  never DELETE-stormed). The dashboard's Refresh button does the same
  sweep client-side so users who only ever open the dashboard still
  get a clean queue.

### Added

- **Live ntfy.sh queue preview in the OG-E Dashboard.** Per-wave
  display of the exact fire times (`Fires at: 12:22, 12:32, …`),
  pulled from ntfy's `/json?poll=1&scheduled=1` endpoint, alongside
  the gist-stored wave list. Lets you confirm at a glance that the
  reminders are queued and when they'll arrive.

### Notes for ntfy.sh free-tier users

The free ntfy.sh tier rate-limits anonymous publishers by IP. Because
the extension publishes from your browser (your own IP) and is
authenticated with your account token, this is not an issue in
practice — but the prior Worker-based flow hit Cloudflare-shared edge
IPs and was effectively unusable without a paid account. The new
flow works reliably on the free tier for a single user.

## [1.3.0] — 2026-05-27

### Added

- **Expedition return reminders (push to phone / smartwatch).** OG-E now
  records, per *wave*, when your expedition fleets land back home and
  publishes that to your private gist; a small companion Cloudflare
  Worker (shipped in `worker/`, deployed separately) watches the clock
  and sends a push via [ntfy](https://ntfy.sh) when a wave is overdue —
  so you remember to re-send even with the browser closed. The extension
  is a pure state producer: it sets the deadline and stops watching.
  - A **wave** is a cluster of expeditions sent together. Return-flight
    rows are read passively from the in-game event list (`#eventContent`,
    the same source as the green planet dots — no traffic to the game)
    and clustered by return-time proximity, so a single 14-ship burst is
    one wave and a deliberate two-batch send becomes two independent
    waves, each reminded on its own. Backed by a new pure helper
    `domain/waves.js` (clustering, origin-set wave identity, re-send
    reconciliation, allowed-hours window) with 25 unit tests.
  - Wave identity is the **set of origin planets**, so re-sending from
    the same planets is recognised as the same wave (its counters reset)
    and a returned-but-idle wave survives a page reload instead of being
    dropped.
  - New **Expedition Reminders** tab on the histogram page: enable/disable,
    repeat interval, allowed-hours window (in your timezone), per-wave
    push cap, ntfy topic generator, step-by-step setup guide, and a live
    preview of the gist state (config, outstanding waves, push counts).
- **Reminder configuration store** (`state/reminderConfig.js`) — a single
  global config persisted in `chrome.storage.local` so the histogram tab
  can author it and the game-side content script can read it and push it
  to the gist. 8 unit tests.

### Changed

- Reminder state lives in a **separate, uncompressed gist file**
  (`oge-reminders.json`) alongside the existing compressed sync payload,
  so the Worker can read it with a plain `JSON.parse` and the schema-3
  sync reader is never affected. Field ownership is split — the extension
  owns `config` + `waves`, the Worker owns `notifyState` — and each side
  preserves the other's block on write.
- The gist token is now also mirrored into `chrome.storage.local` (in
  addition to its existing game-origin `localStorage` home) so the
  extension-origin histogram page can fetch the gist for the live
  reminder preview. `chrome.storage` is extension-private; no new
  network destination and no new permission (`api.github.com` was
  already in `host_permissions`; ntfy is contacted only by the Worker).

## [1.2.0] — 2026-05-24

### Added

- **Tabbed navigation on the histogram page.** The data viewer is now
  split into three independent tabs — `Colony Sizes`,
  `Galaxy Observations`, `Free Positions` — instead of one long
  scrollable page. The active tab is remembered per device in
  `localStorage` under `oge_histogramTab`. Existing content is
  unchanged; only the surrounding shell wraps each section in
  `<section class="tab-section">` plus a `.top-bar` row at the top
  that anchors navigation on the left (tabs) and technical
  operations on the right (server selector, Export / Import JSON).
  Single horizontal row when the viewport is wide enough; wraps to
  two rows on narrow viewports via `flex-wrap: wrap`.
- **Free Positions analyzer.** New tab that scans the per-universe
  galaxy data for the longest contiguous runs of systems whose chosen
  slot is confirmed `empty`. Position-selector lets the player pick
  any of the 15 slots (defaults to 15 — the classic colonise-row
  use case). Results table lists the top 20 runs across all scanned
  galaxies plus the absolute record. Wrap-around at the 499 → 1
  boundary is handled, and an unscanned (or scanned-but-non-matching)
  system breaks the run — reported lengths are a lower bound that
  only grows with more scans. Backed by a new pure helper
  `domain/freeStreak.js#findLongestStreaks(scans, { position, status })`
  with 14 unit tests covering wrap-around, gaps, multi-galaxy
  independence, malformed keys, and tie-breaking.
- **Per-universe data isolation.** Colony history and galaxy scans —
  previously stored under shared `chrome.storage.local` keys
  (`oge_colonyHistory`, `oge_galaxyScans`) — are now namespaced per
  OGame universe (`s163-pl:oge_colonyHistory`, ...). Each server keeps
  its own dataset, statistics, and (via the already-per-origin
  `localStorage`-backed gistId / gistToken) its own cloud-sync target,
  even for the same account. The settings-mirror `oge_colPositions`
  and the sync-scheduler tombstones (`oge_syncRequestAt`,
  `oge_clearRemoteAt`, `oge_resetGalaxyAt`) are namespaced on the
  same scheme. New module `lib/universeId.js` extracts the universe
  short id (e.g. `s163-pl`) from `location.host`; key composition
  goes through `historyKeyFor` / `scansKeyFor` / `colPositionsKeyFor`
  / `syncRequestKeyFor` / `clearRemoteKeyFor` / `resetGalaxyKeyFor`
  exported from the modules that own each base suffix.
- **One-shot legacy → per-universe migration.** New
  `state/migrate.js` runs once at content-script bootstrap (before
  the persist `load`s fire) and lifts pre-1.1.0 un-namespaced
  `oge_colonyHistory` / `oge_galaxyScans` into the active universe's
  slot. The first server opened post-upgrade inherits the legacy
  dataset; subsequent servers start empty (matching the per-server
  isolation the rest of this release adds). Idempotent — re-runs are
  no-ops because the legacy keys are removed at the end of the move.
- **Server selector dropdown on the histogram page.** New
  `<select id="universeSelect">` at the top of the data viewer lists
  every universe found in storage; the page hydrates against the
  selected universe and Export / Import / Clear / Reset-galaxy all
  scope to that selection. The Settings panel's "Open histogram"
  button now appends `?host=<universeId>` so opening the page from
  server X auto-selects X. Export filenames embed the id
  (`oge-s163-pl-2026-05-23.json`, `oge-s163-pl-colony-history.csv`).
- **`chromeStore.getAll`** helper on the storage wrapper — wraps the
  canonical `chrome.storage.local.get(null, cb)` enumeration. Used by
  the histogram to discover which universes have data, but exposed as
  a general primitive.

### Fixed

- **OG-E no longer loads on forum or lobby subdomains.** The
  `content_scripts[0].matches` entry in `manifest.json` was widened
  to `*://*.ogame.gameforge.com/*` in earlier releases, which pulled
  the content script (and its floating UI) onto
  `forum.*.ogame.gameforge.com` and `lobby.ogame.gameforge.com` —
  pages where the OG-E buttons have no game context. The match is now
  scoped to `*://*.ogame.gameforge.com/game/index.php*`, matching the
  page-script entry (`page.js`).
- **CSP violation when clicking a banner link for an OGame menu item
  whose href is `javascript:`.** The event-menu highlight feature
  (added on this branch) copied OGame's anchor `href` onto its banner
  link, which for some premium-menu items is `javascript:return
  false;` paired with an `onclick` listener. The page's `script-src`
  policy blocks `javascript:` URL navigations, so the banner click
  surfaced as a Content Security Policy error and did nothing.
  `eventMenuHighlight` now delegates clicks to the original anchor
  via the existing `safeClick` helper (which strips the `javascript:`
  href and fires the click event so OGame's own listener still
  runs); plain `http(s)` hrefs are still copied through unchanged so
  middle-click / right-click "open in new tab" keep working.
- **CSP violation from AGR-anchor `.click()` callsites.** Three
  remaining bare `.click()` invocations targeted AGR-shipped anchors
  (`agrLogo.js` clicking AGR's menu button + the OG-E tab header;
  `settingsUi/index.js` collapsing sibling AGR tabs when the OG-E
  one is opened). AGR ships those as `<a href="javascript:...">` —
  the same shape the event-banner fix above addressed. Routed every
  remaining call through `safeClick` so the page CSP no longer logs
  blocked `javascript:` navigations from any OG-E codepath.
- **`safeClick` no longer strips AGR menu CSS.** The original
  `safeClick` removed the `javascript:` href before dispatching the
  click but never restored it, which silently broke AGR's
  attribute-selector styling (`a[href]`, `a[href^="javascript:"]`)
  — the menu lost its background and shifted left whenever any
  OG-E codepath clicked an AGR anchor. The helper now strips the
  href, dispatches the click (synchronous; the CSP-blocked
  navigation never fires), and immediately writes the original href
  back. AGR sees its menu CSS intact again.
- **Vertical count labels above each colony histogram bar.** The
  per-bar count label was horizontal, which overflowed the bar
  width as soon as a bucket reached two digits (very common — most
  fields-size buckets have at least 10 colonies once the player has
  more than a handful of planets). Switched to `writing-mode:
  vertical-rl` to match the existing field-label rotation below the
  bar; single-digit counts look unchanged (one glyph either way),
  multi-digit counts now stack vertically inside the bar's own
  column instead of bleeding into neighbours. Reduced the per-bar
  height budget from 240 px to 220 px to reserve room for the
  taller count text (capped at 36 px tall — enough for 4 digits,
  which covers every realistic case).
- **Colony histogram re-bins on window resize.** A debounced
  (150 ms) `resize` listener on `window` triggers a full
  `renderAll()` cycle so the adaptive binning re-evaluates against
  the new chart width. The galaxy map and Free Positions table
  repaint along with it — they're width-agnostic but the render
  pass is DOM-only and the cost is negligible. Debouncing keeps the
  render rate sane during a slow window-edge drag (one render after
  the user pauses for 150 ms, instead of ~60 per second).
- **Colony Size Histogram fits the viewport instead of horizontal
  scroll, with adaptive binning at high bucket counts.** The chart's
  `.bar-group` was `flex: 1 0 18px; min-width: 18px`, which at ~140
  distinct field-size buckets forced ~2.5k px of layout width and a
  horizontal scrollbar on most laptops. Switched to
  `flex: 1 1 0; min-width: 0` plus `overflow: hidden` on the chart
  container so the full bucket range always fits the available
  width. On top of the pure-CSS fit, the renderer now measures the
  chart's on-screen width and adaptively bins consecutive field
  values together so each rendered bar stays at least ~8 px wide —
  e.g. on a 1366 px laptop the 140-bucket distribution renders as
  ~150 bars at 1× binning, but a narrower viewport or even-more
  distinct fields triggers `binSize=2`, `3`, ... bins labelled
  `200-201`, `300-302` with summed counts. Per-bar tooltip carries
  the bin range and total when binning is active, the exact value
  when it isn't. Backed by a new pure helper
  `domain/histogram.js#binFieldBuckets(buckets, binSize)` with 8
  unit tests covering empty input, binSize edge cases (≤ 1,
  fractional, larger than input), tail bins, and order preservation.

### Removed

- **"Refresh" buttons on the histogram page** (two of them: one above
  the colony chart, one above the galaxy map). Both called
  `triggerSync` + a manual local reload; the local reload is already
  handled automatically by `chrome.storage.onChanged` whenever the
  selected universe's data lands, and an explicit "Sync now" button
  is already available in the Settings → Cloud sync section. The
  histogram surface gains no real affordance from the duplicate
  trigger, so the buttons are gone.

## [1.0.6] — 2026-05-20

### Fixed

- **Colony record loss on Firefox/Android (hydration race).** When
  `chrome.storage.local` resolved after `DOMContentLoaded`, the
  recorder's first `tryCollect` read an empty `historyStore`, passed
  the dedup check, and appended the new entry to `[]`. The subsequent
  async hydrate then overwrote the just-written entry via
  `store.set(stored)`. Fixed by gating every `tryCollect` on
  `whenHistoryHydrated()` — a `Promise` that resolves once
  `persist`'s `onHydrate` callback fires. Pre-resolved in unit tests
  that bypass `initHistoryStore`.
- **Draggable button Y-axis clamping for non-square elements.** The
  `installDrag` helper accepted a `size` parameter (button diameter)
  that callers measured at construction time. Non-square elements (the
  freshPlanet banner, split-button wraps) were clamped against their
  *width* on both axes, letting the banner drift below the viewport.
  The helper now reads `getBoundingClientRect()` on each drag-start,
  clamping width and height independently. The caller-supplied `size`
  parameter is gone.
- **AGR fleet-status link unstyled on fleetdispatch step 2.** AGR
  renders the same link in two DOM shells: step 1
  (`a.ago_movement.tooltip` in `#planet`) carries the `ago_movement`
  class; step 2 (anchor inside `#ago_summary_fleets`) drops it. A
  single selector only caught step 1, leaving the step-2 link without
  the stacked-line layout and colour tint. Both selectors now share
  the same CSS rule blocks.

## [1.0.5] — 2026-04-27

### Fixed

- **Stale/timeout click on fleetdispatch advances to the next
  candidate instead of looping back to galaxy view.** When
  `checkTarget` reported an occupied slot (stale) or the 15 s
  watchdog expired (timeout), the Send button navigated to the galaxy
  view of the *original* target instead of moving on. The handlers
  now call `findNextColonizeTarget` — if a candidate exists it
  navigates directly to its `fleetdispatch` URL; if none remain it
  paints "No more candidates" and returns without navigating.

## [1.0.3] — 2026-04-26

### Removed

- **`autoRedirectColonize` setting + post-send hop** ("After sending
  colonize, open the next target"). In practice the user reaches for
  Scan/Send themselves and the auto-redirect just got in the way. The
  `oge:colonizeSent` reactor now only marks the sent slot
  `'empty_sent'` in `scansStore`. Setting key, schema entry, UI row,
  and dead state-mutation in the redirect path are all gone.

### Fixed

- **Expedition badges no longer flicker the planet list.** The badges
  feature's `MutationObserver` was firing on its own `clearBadges` +
  `appendChild` writes, which scheduled another debounced render
  (200 ms), which fired the observer again — a tight feedback loop
  that re-created `.ogi-exp-dots` elements every 200 ms forever. Fixed
  by pausing the observer around our own renders
  (disconnect-render-reattach). Bug present since v1.0.0; surfaces
  visually as the planet list "jumping" while an expedition is in
  flight. Locked in by a regression test that asserts cluster
  identity is preserved across multiple debounce cycles.

### Added

- **Per-galaxy stale-count badge** in the galaxy observations header —
  amber pill showing how many systems in that galaxy are past their
  rescan threshold. Mirrors the amber inset ring on stale pixels in
  the map below; hidden when the count is zero so fully-fresh galaxies
  stay uncluttered. Backed by a new pure helper
  `domain/histogram.js#countStaleByGalaxy(scans, now)` with seven
  tests covering empty input, multi-galaxy binning, malformed keys,
  and null entries.

### Changed

- **Build: `tar -a` used consistently for forward-slash ZIP entries.**
  Both `scripts/package.mjs` and `scripts/package-source.mjs` now use
  `tar -a -c -f` on all platforms, superseding the earlier
  Compress-Archive workaround from v1.0.2 and closing the last
  remaining path-separator edge case on Windows.
- **`.nvmrc` + `.gitattributes` added.** Node version pinned; line
  endings normalised for reproducible builds across platforms.

## [1.0.2] — 2026-04-26

### Fixed

- **`npm run package` now produces ZIPs with forward-slash entry
  paths.** The previous Windows path shelled out to PowerShell's
  `Compress-Archive`, which writes `icons\icon16.png` (backslash)
  instead of `icons/icon16.png` (forward slash). The ZIP spec
  mandates forward slashes; AMO's validator rejects the archive with
  "invalid characters in filename" and reviewers had to repack the
  bundle by hand to get it through review. Both `scripts/package.mjs`
  and `scripts/package-source.mjs` now invoke
  `C:\Windows\System32\tar.exe` (bsdtar, which ships with Windows
  10/11) and force `--format=zip`. POSIX behaviour is unchanged
  (`zip -r`).

### Added

- **`REVIEWERS.md` shipped inside `source.zip`.** A dedicated build-
  and-verify guide for AMO / Chrome Web Store reviewers — Node version
  requirements, exact `npm install && npm run build:prod` flow,
  reproducibility notes, and a compliance summary on the no-traffic
  guarantee.

## [1.0.1] — 2026-04-26

### Fixed

- **Send Exp button no longer locks for 15 s after a too-eager tap on
  fleetdispatch.** OGame fetches its fleet-event list via an async XHR
  shortly after the page itself loads. A user tapping the floating
  button before that XHR landed entered Phase 2 polling against a
  half-hydrated DOM (`#eventContent` empty, AGR's routine state stale)
  and the button stayed locked for the full 15 s `POLL_TIMEOUT_MS`
  window before recovery. Added a new MAIN-world bridge
  (`bridges/eventBoxHook.js`) that observes the eventbox refresh XHR
  and dispatches `oge:eventBoxLoaded`; the click handler gates Phase
  1/2 on that signal and falls back to an 8 s safety timer so a
  missed XHR can never lock the button forever. Pre-readiness clicks
  paint a transient "Loading..." cue and bail without locking.
- **Movement-link readability rule now fires when the fleet count is
  capped (37/37).** AGR swaps the anchor's status colour between
  `ago_color_lightgreen` (slots free) and `ago_color_palered` (capped).
  The previous selector required the green class, so once the user
  hit the cap the stacked-line layout disappeared. Layout (flex
  column + bold + bigger font) now lives on the bare
  `a.ago_movement.tooltip` selector and applies regardless of the
  colour modifier; the green tint is opt-in via a sibling rule that
  leaves the native red alone.

### Changed

- **Eventbox countdown is bigger and right-anchored to the box edge.**
  Bumped `#eventboxFilled .next_event .countdown` from 35 px to 50 px
  and reset its `right` inset from 12 px to 0 — the countdown is the
  primary focal point, so it now genuinely dominates the row instead
  of competing with the mission-type label.
- **Mission-type label ("Rodzaj") bumped from 13 px to 20 px** for
  legibility on small screens; still distinctly smaller than the
  50 px countdown to preserve the focal-point asymmetry.
- **Fleet-movement link font bumped from 15 px to 18 px** so the
  stacked "Floty: X/Y" + "Ekspedycje: X/Y" lines read at a glance
  on mobile.

## [1.0.0] — 2026-04-24

First public release.

### Added

- **Send Exp** + **Send Col** floating buttons — draggable,
  mobile-first, one tap per game intention.
- **Smart colonize flow** — auto-target using `colPositions` and
  `colMinGap`, pre-send `checkTarget` dry-run. Button states for
  `ready`, `reserved` (DM slot), `noShip`, `stale`, `timeout`, and
  `waitGap` are explicit in a discriminated union.
- **Galaxy scan tracker** — local database (chrome.storage.local)
  with per-status rescan policy. The `abandoned` branch follows the
  game's own 3 AM cleanup sweep for correct one-cycle coverage. The
  Scan button surfaces the count of remaining systems.
- **Fresh-planet banner** — highlights colonies with `usedFields === 0`.
  Stateless; reads `#planetList` tooltips on mount. Banner is
  draggable (position persists). Click navigates to overview.
- **Galaxy observations marker** — systems whose scan age crosses
  their rescan threshold get an amber inset ring on the pixel map,
  plus a "STALE — rescan recommended" tooltip line.
- **Abandon overlay** — three-click flow with buttons injected inside
  the game's own popups for mobile-safe input handling. Paints a red
  overlay on a colony's overview page when below `colMinFields`.
- **Histogram + galaxy map** — extension page with colony-size bar
  chart and per-galaxy 499-pixel observation maps. Per-galaxy reset,
  JSON export/import, no telemetry.
- **Cloud sync via GitHub Gist** — user-owned private gist, gzip-
  compressed payload (~6× reduction), 15 s debounce, anti-loop via
  `changed` flag, concurrent-round-trip lock.
- **Readability boost (optional)** — targeted CSS fix for the fleet
  event-box and `ago_movement` link. Toggleable from settings.
- **AGR integration** — settings panel inside AGR's options menu,
  AGR logo rewired to open that panel, fleetdispatch ArrowRight
  keyboard shortcut, shared colour palette for mission-type semantics.
- **~650 unit tests** (vitest + happy-dom), full `@ts-check` on JSDoc
  typedefs, rollup + terser build pipeline.

### Architectural decisions

- Vanilla JS, zero runtime dependencies. Types via JSDoc + `tsc --noEmit`.
- `lib/` and `domain/` are pure — no DOM, no storage, no side effects.
- MAIN-world XHR observer → DOM event → isolated-world listener.
  OG-E never originates requests to the game server.
- Two-tier storage: `localStorage` for synchronous writes (the
  pre-nav registry race matters on mobile), `chrome.storage.local`
  for the larger assets (scans, history).

### Compliance

OG-E is a UI modification, not an automator. Every click produces at
most one HTTP request to the game. No background work, no cycles, no
CAPTCHA bypass. See [`CONTRIBUTING.md`](CONTRIBUTING.md) §Compliance
for the full guarantee and review checklist.
