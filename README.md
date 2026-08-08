# OG-E

**A calm, mobile-first UI helper for OGame.** One friendly floating
button for the moves you make every day, a local galaxy database for the
decisions that need data, and **zero automation**. Your clicks stay your
clicks — OG-E never talks to the game server on your behalf.

> **The rule:** one user click → at most one HTTP request to the game.
> No bots, no auto-clicks, no background traffic. We only make the page
> you already use easier to read and faster to tap. See
> [`CONTRIBUTING.md`](CONTRIBUTING.md) §Compliance.

📖 **Feature documentation (PL/EN):**
<https://urbanowiczbartlomiej-hub.github.io/OG-E/> — every feature, what it
does, why it helps and how it stays inside OGame's fair-play rules.

---

## What OG-E does

Most of OG-E lives behind a single **draggable floating button**, built
for one-thumb play on a phone: expeditions, lifeform discovery,
colonization and the daily collection run, each just a tap or two. A
full-page **Dashboard** turns your scan data into decisions — where to
settle, who's watching you, and what your fleet is doing — plus optional
push reminders (ntfy.sh) and opt-in cross-device sync through your own
private GitHub gist.

Every feature, what it does, why it helps, and how it stays inside
OGame's fair-play rules is documented at
**<https://urbanowiczbartlomiej-hub.github.io/OG-E/>** — that page is the
canonical feature list; this README stays focused on the code.

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

The contributor dev loop (`npm run dev` / `test` / `typecheck` / `lint`) is
documented in [`CONTRIBUTING.md`](CONTRIBUTING.md) (§Dev workflow) — its
canonical home. The reproducible production build (`npm run build:prod`) and
how its output maps to the uploaded extension are documented in
[`REVIEWERS.md`](REVIEWERS.md).

**Debug flags** (set in DevTools Console):
- `localStorage.oge_debugSendCol = 'true'` — log Send/Scan click context.
- `localStorage.oge_debugMinGap = 'true'` — log min-gap inputs/outputs.
- `localStorage.oge_debugLoggerEnabled = 'true'` — turn on the diagnostic
  logger: echoes `[OG-E]` events to the console and keeps the last ~500
  in an in-memory ring buffer (`logger.getEntries()` to grab them).

---

## Feature documentation site

The public docs at
<https://urbanowiczbartlomiej-hub.github.io/OG-E/> are generated from data
files in [`site/`](site/) (one `.mjs` per feature, PL base + EN mirror) by a
zero-dependency Node generator:

```bash
npm run site:preview
```

That builds `site/dist/` and serves it on <http://localhost:4173/>
(`npm run site:build` builds only). The build **fails** on missing or invalid
content, so it doubles as the consistency test.

The output is **not committed** — [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
rebuilds it on every push to `main` that touches `site/**` and deploys the
artifact to GitHub Pages, so the published page always matches the content in
the repo. Publishing the site is independent of the extension release
(no version bump needed). Content model, the i18n layers and how to add a
feature page live in [`site/README.md`](site/README.md).

---

## Architecture in five minutes

```
src/
├── content.js     isolated-world entry  (document_start)
├── page.js        MAIN-world entry      (XHR hooks, document_start)
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

**Build wiring.** Those three top files are the rollup entry points — each
bundles in everything it imports (one self-contained IIFE per execution
context). `content.js` is the isolated-world boot and calls every feature's
`install*()` (order is not load-bearing); `page.js` installs the MAIN-world
bridges; `dashboard.js` boots the Dashboard page.

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
