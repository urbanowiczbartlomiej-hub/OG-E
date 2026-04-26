# Changelog

All notable changes to this project will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

## [Unreleased]

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

### Deferred for a later release

- Stale rescan queue (one-click-per-jump) on the galaxy observations
  page. TOS allows at most one HTTP request per click, so this must
  take the queue-cursor shape (1 click → 1 nav to the next stale
  system), not a batch action.
- Keyboard shortcuts beyond ArrowRight on fleetdispatch.

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

