# OG-E

**A calm, mobile-first UI helper for OGame.** One friendly floating
button for the moves you make every day, a local galaxy database for the
decisions that need data, and **zero automation**. Your clicks stay your
clicks — OG-E never talks to the game server on your behalf.

> **The rule:** one user click → at most one HTTP request to the game.
> No bots, no auto-clicks, no background traffic. We only make the page
> you already use easier to read and faster to tap. See
> [`CONTRIBUTING.md`](CONTRIBUTING.md) §Compliance.

---

## One button, your daily routine

Most of OG-E lives behind a single **draggable floating button**, built
for one-thumb play on a phone. Switch it between four modes — each is one
tap per intention:

- **🚀 Send expeditions** — fire an expedition from a rotating list of
  eligible planets. No menus, no typing.
- **🧬 Discover lifeforms** — run the lifeform discovery scan across your
  planets, stopping before you hit your artifact cap.
- **🪐 Colonize** — send a colony ship to the next genuinely-free spot,
  picked automatically from your own scan data (and it tells you exactly
  why it won't fire: no ship, reserved, stale, waiting on the gap…).
- **🔁 Daily Run** — collect your daily production in seconds: scatter a
  fixed micro-fleet from a moon to your target planets, then pull
  everything (ships + resources) back to one collect point — all from the
  same button.

---

## What else OG-E does for you

- **Find the best place to settle.** The **Colony Scout** ranks the
  emptiest neighbourhoods in your scanned galaxies and re-sorts them for
  how *you* play — farms, PvP, or a quiet eco corner — so a new colony
  lands somewhere worth living.
- **Never miss a landing.** Optional **push notifications to your phone**
  a few minutes before a fleet returns: expedition waves, ad-hoc fleets,
  and fleet-save returns. Delivered through [ntfy.sh](https://ntfy.sh);
  off until you turn it on.
- **Don't forget the daily stuff.** Gentle **highlights** nudge you about
  things easy to miss on mobile: live **events** and the **merchant /
  trader** (auction bids, import-export containers).
- **Read your screen at a glance.** A **readability boost** declutters
  OGame's tiny top-bar labels so the numbers that matter pop on a small
  screen — the countdown to your next mission, how many missions are in
  flight, and your free expedition slots.
- **Spot fresh planets.** A draggable banner flags a freshly colonized
  planet (zero buildings) so you can decide whether to keep it; it
  vanishes the moment you build a single field.
- **Drop the duds.** On a colony below your size threshold, a big,
  mobile-safe overlay offers a three-tap abandon.
- **Your data, synced your way.** Opt-in **cloud sync** mirrors your scan
  database and colony history through *your own* private GitHub gist —
  no OG-E server, ever.

## The Dashboard

A full-page companion (one OGame universe at a time) for the data behind
the buttons:

- **Colony Sizes** — a histogram of the field sizes you've personally
  visited.
- **Galaxy Observations** — galaxy preview maps of everywhere you've
  scanned, plus the **Colony Scout** settlement-area analysis and the
  per-universe scan settings.
- **Reminders** — a live look at every push reminder currently queued.
- **Daily Run** — point-and-click editor for your collection routes
  (pick sources and targets from your own planets and moons — nothing to
  type).

Export / import everything as JSON. No telemetry, no accounts.

---

## Fair play, by design

OG-E is a **UI layer**, not a bot. Every action is something you
triggered with a tap; each tap produces at most one request that the game
itself would have made. OG-E reads the pages you're already on, watches
the network calls the game already fires, and follows links you chose to
follow. It never originates game traffic, never clicks for you, and runs
no servers of its own. The two features that leave your browser
(cloud sync, push reminders) are both opt-in and both point at a service
*you* control. Full statement: [`PRIVACY.md`](PRIVACY.md).

**Hard dependency:** [AntiGameReborn](https://antigame.de/). OG-E mounts
its settings panel inside AGR's menu and reuses its visual grammar.
Without AGR the floating button still works, but the settings panel has
nowhere to live.

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
npm run test          # vitest
npm run typecheck     # tsc --noEmit, JSDoc-as-types
```

The reproducible production build (`npm run build:prod`) and how its
output maps to the uploaded extension are documented in
[`REVIEWERS.md`](REVIEWERS.md).

**Debug flags** (set in DevTools Console):
- `localStorage.oge_debugSendCol = 'true'` — log Send/Scan click context.
- `localStorage.oge_debugMinGap = 'true'` — log min-gap inputs/outputs.
- `localStorage.oge_debugLoggerEnabled = 'true'` — turn on the diagnostic
  logger: echoes `[OG-E]` events to the console and keeps the last ~500
  in an in-memory ring buffer (`logger.getEntries()` to grab them).

---

## Architecture in five minutes

```
src/
├── content.js     isolated-world entry  (document_start)
├── page.js        MAIN-world entry      (XHR hooks)
├── dashboard.js   extension page entry  (the OG-E Dashboard)
│
├── lib/           pure helpers: store, storage, dom, gzip, debounce...
├── domain/        pure logic: scans, positions, registry, scheduling
├── state/         observable stores + persistence wiring
├── bridges/       MAIN-world XHR observers → DOM events
├── features/      UI modules: sendExpedition, sendColony, dailyRun, ...
└── sync/          gist round-trip (gzip + debounce + anti-loop) and
                   the ntfy reminder scheduler
```

**Data flow.** Bridges (MAIN world) observe the game's XHRs and dispatch
custom DOM events (`oge:galaxyScanned`, `oge:checkTargetResult`, …).
State stores (isolated world) subscribe to those events and update.
Features subscribe to the stores and re-render their DOM. Sync reads the
stores, merges with the remote gist, writes the result back.

The layering rules that keep this testable (dependency direction, the
pure-core rule) are spelled out for contributors in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## FAQ

**Is this an automation tool?** No. Every feature is triggered by a user
tap, and each tap produces at most one HTTP request to the game. See
§Compliance in [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Is my account at risk?** OG-E never originates game traffic. It reads
game pages, observes the network calls the game already fires, and
follows navigations you initiated. To GameForge's servers your browser
behaves like a normal browser with an AGR-style UI on top.

**Why is AGR required?** We mount our settings panel inside AGR's options
menu and reuse its colour palette for mission-type semantics. Building a
separate panel would mean reinventing UX that AGR already does well.

**How does cross-device sync work?** You create a GitHub Personal Access
Token with `gist` scope and paste it into OG-E. Your scan database +
colony history compress into a single *private* gist. Every device with
that token syncs to it (debounced, merge-on-write). The gist is yours;
OG-E has no server.

**How do reminders work?** When enabled, OG-E reads the return times the
game already shows you and schedules a phone notification a few minutes
before each landing via ntfy.sh. You install the ntfy app, create a
token, and paste it into OG-E. Reminders never send game traffic — they
only notify *you*. The payload carries low-sensitivity flight data, so
treat your notification topic as a secret. See [`PRIVACY.md`](PRIVACY.md).

---

## Privacy

No servers of our own, no telemetry. The two features that leave your
browser are both opt-in and both point at a service *you* control:
gist-based sync (a GitHub token you supply) and push reminders (an
ntfy.sh token you supply). Full statement: [`PRIVACY.md`](PRIVACY.md).

## License

[MIT](LICENSE). Do what you want, but remember: this code works alongside
someone else's game, on their terms. OG-E is not an official GameForge
product.
