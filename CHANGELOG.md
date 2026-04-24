# Changelog

All notable changes to this project will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

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

## [Unreleased]

Deliberately deferred for the first minor release:

- i18n framework (English only for 1.0.0; PL/DE/FR planned later).
- Dark-mode CSS toggle.
- Bulk "rescan all stale" action on the galaxy observations page.
- Keyboard shortcuts beyond ArrowRight on fleetdispatch.
- Per-galaxy stale-count summary in the galaxy observations header.
