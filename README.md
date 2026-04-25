# OG-E

**A calm UI helper for OGame.** Floating buttons for the actions you
repeat most, a local galaxy-scan database for the decisions that need
data, and zero automation. Your clicks stay your clicks — OG-E never
talks to the game server on your behalf.

> **The rule:** one user click → at most one HTTP request to the game.
> We observe XHRs the game already fires; we never originate traffic.
> See [`CONTRIBUTING.md`](CONTRIBUTING.md) §Compliance before touching
> the code.

---

## Features

- **Send Exp** / **Send Col** — draggable floating buttons. Mobile-first
  layout, one tap per intention (dispatch expedition, dispatch colony
  ship).
- **Smart colonize** — auto-target based on your `colPositions`,
  per-arrival min-gap, dry-run `checkTarget` before the send. Explicit
  states for `ready`, `reserved`, `no ship`, `stale`, `timeout`, and
  `waitGap` so the button tells you exactly why it won't fire.
- **Galaxy scan tracker** — local database of scanned systems with a
  per-status rescan policy (fresh `empty_sent` for 4h, `occupied` for
  30d, `abandoned` follows the game's 3 AM sweep, ...). The Scan button
  surfaces how many systems still need refreshing.
- **Fresh-planet banner** — draggable banner highlighting freshly
  colonized planets (`usedFields === 0`). One click opens the overview;
  the moment you build a single field the banner disappears. No state
  to sync, no "known planets" database.
- **Abandon overlay** — on a colony's overview page, if it's under
  your `colMinFields` threshold, a big red overlay offers abandon in
  three clicks. The buttons are injected inside the game's own popups
  for mobile safety.
- **Histogram + galaxy map** — extension page with colony-size bar
  chart and 499-pixel galaxy observation maps. Per-galaxy reset,
  export/import JSON, no telemetry.
- **Cloud sync** — cross-device sync through *your own* private GitHub
  gist. gzip-compressed payload (~6× smaller), 15 s debounce, anti-loop
  via a `changed` flag.
- **Readability boost** — optional CSS tweak for the fleet event-box
  and the fleetdispatch movement link. Toggle in settings.

Hard dependency: [AntiGameReborn](https://antigame.de/). OG-E injects
its settings panel into AGR's menu and reuses its visual grammar.
Without AGR the floating buttons still work, but the settings panel
has nowhere to mount.

---

## Install

### Firefox
1. `npm install && npm run build:prod`
2. `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. Select `dist/manifest.json`.

### Chrome / Edge
1. `npm install && npm run build:prod`
2. `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.

For a packaged release, see [`CONTRIBUTING.md`](CONTRIBUTING.md)
§Release workflow.

---

## Development

```bash
npm install
npm run dev           # rollup watch, rebuilds dist/ on save
npm run test          # vitest, ~650 tests
npm run typecheck     # tsc --noEmit, JSDoc-as-types
npm run build:prod    # minified dist/ (terser, console dropped)
```

**Debug flags** (set in DevTools Console):
- `localStorage.oge_debugSendCol = 'true'` — log Send/Scan click context.
- `localStorage.oge_debugMinGap = 'true'` — log min-gap inputs/outputs.

---

## Architecture in five minutes

```
src/
├── content.js     isolated-world entry  (document_start)
├── page.js        MAIN-world entry      (XHR hooks)
├── histogram.js   extension page entry
│
├── lib/           pure helpers: store, storage, dom, gzip, debounce...
├── domain/        pure logic: scans, positions, registry, scheduling
├── state/         observable stores + persistence wiring
├── bridges/       MAIN-world XHR observers → DOM events
├── features/      UI modules: sendExp, sendCol, badges, abandon...
└── sync/          gist round-trip (gzip + debounce + anti-loop)
```

**Data flow.** Bridges (MAIN world) observe the game's XHRs and dispatch
custom DOM events (`oge:galaxyScanned`, `oge:checkTargetResult`, …).
State stores (isolated world) subscribe to those events and update.
Features subscribe to the stores and re-render their DOM. Sync reads
the stores, merges with the remote gist, writes the result back.

**Purity contract.** `lib/` and `domain/` have zero DOM, zero storage,
zero `Date.now()` without an explicit parameter — which makes them
testable in Node's vitest runner with no mocks.

---

## FAQ

**Is this an automation tool?** No. Every feature is triggered by a
user click, and each click produces at most one HTTP request to the
game. See §Compliance in [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Is my account at risk?** OG-E never originates game traffic. It
reads game pages, observes XHRs the game already fires, and dispatches
navigations you initiated. As far as GameForge's servers are
concerned, your browser behaves like a browser with an AGR-ish UI
layer on top.

**Why AGR as a hard dependency?** We mount our settings panel inside
AGR's existing options menu, and we reuse AGR's colour palette for
mission-type semantics. Building a separate panel would mean
reinventing UX that AGR already does well.

**How does cross-device sync work?** You create a GitHub Personal
Access Token with `gist` scope and paste it into OG-E's settings. Your
scan database + colony history gzip-compress into a single private
gist. Every device that knows the same token syncs to that gist
(15 s debounce, merge-on-write, anti-loop). The gist is yours; OG-E
has no server.

---

## License

[MIT](LICENSE). Do what you want, but remember: this code works
alongside someone else's game, on their terms. OG-E is not an
official GameForge product.
