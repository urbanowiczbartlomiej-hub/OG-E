# Gameforge toleration — work plan & session handoff

> **Transient plan doc** (per CLAUDE.md's "plan docs have a lifecycle"): delete
> this once OG-E is submitted and tolerated. Git keeps the history.

## Goal

Get OG-E onto Gameforge's **tolerated tools** list. Every add-on running in an
OGame tab is forbidden until explicitly tolerated, so this is required to keep
users safe from bans. OG-E was built fair-play from day one (no bots, no action
automation), so the work is mostly **framing + documentation**, plus removing
the one off-tab "attack alarm" signal that historically trips Gameforge.

## Gameforge rules (from the official OGame Origin forum)

- [Read first: Submitting tools](https://forum.origin.ogame.gameforge.com/forum/thread/43-read-first-submitting-tools/)
- [Information: Community Tooldevs](https://forum.origin.ogame.gameforge.com/forum/thread/33-information-community-tooldevs/)
- [About toleration and tolerated tools](https://forum.origin.ogame.gameforge.com/forum/thread/320-important-for-users-about-toleration-and-tolerated-tools/)

Key points: toleration covers only the **current** state of a tool (consult the
responsible ToolDev *before* shipping new/borderline features); **allowed** =
display, calculators, report colouring, manual convenience, UI tweaks, galaxy
scraping; **forbidden** = automation that performs game actions without keyboard
input, and **attack alarms / monitoring that notifies a player about events
while they are away from the keyboard**. Process: new thread in *Submissions &
API Requests* → thread starts disabled (normal) → ToolDevs activate & review →
moved to *Tolerated Tools*. Per-version changelog required; only the latest
published version is legal.

## Fair-play line for "alarms" (the core justification)

OK = an alarm the player could set themselves because they know the time (a
phone alarm). FORBIDDEN = monitoring the game and notifying about an event the
player otherwise wouldn't know while away. OG-E's ntfy alarms all derive from a
time computable from the player's **own** action (an expedition / fleet they
sent), delivered via ntfy's `X-Delay` (server-side "ring at time X") — never a
monitor for incoming attacks, never wired to attack detection.

## Fair-play audit result (full adversarial source sweep)

> Superseded the earlier hand-sweep. Full per-feature classification (goal /
> mechanism / category / justification, file:line) now lives in
> **[`fair-play.md`](fair-play.md)** — the canonical compliance doc the
> submission links to. Summary of the corrected verdict below. **Tally: 50
> GREEN / 7 YELLOW / 5 RED**, every non-GREEN finding re-verified against the
> cited code.

**The earlier plan rated reminders "YELLOW — frame as alarm clock." Against the
verbatim [Forbidden features](https://forum.origin.ogame.gameforge.com/forum/thread/29-forbidden-features/)
text that is too optimistic.** Rule 4 forbids automated alarms about *"fleet
arrivals (including … automated external webhooks like Discord pings)"* while
the player is *"away or inactive."* The ntfy `X-Delay` push is **exactly** that
category. The adversarial verifier returned **RED on all four reminder kinds and
could not refute any** — the "alarm-clock the player could set themselves"
argument is morally real but is **not a carve-out the rule grants**.

- **🔴 RED (5, one root cause):** wave / ad-hoc / fleet-save / guardian ntfy
  pushes — all the same `sync/ntfyReconciler.js` `X-Delay` path. **This is the
  one real blocker.** Fleet-save + guardian are weakest (they enable AFK
  fleet-saving, the rule's *intent*); ad-hoc + wave are the defensible cases for
  a consult. The Dashboard Reminders tab inherits this verdict.
- **🟡 YELLOW (7 → 3 themes):** (A) `expeditionRedirect`/`deployRedirect` rewrite
  the game's own **response** `redirectUrl` — 1-click-1-action holds, but our
  "never modifies a request" wording is response-inaccurate, and the daily-run
  redirect lacks the opt-out toggle the expedition one has; (B) synthetic-input
  + double-click **disclosure** for `fleetCourier`/`fleetExecutor`/`agrRoutine`/
  `agrLogo` (verified not violations — needs a reviewer note, no code change);
  (C) the under-attack in-tab highlight — off-tab signals already removed, but
  rule 4 lists "visual signals for incoming attacks" with no active-tab
  exception, so **remove it or get an explicit green-light**.
- **🟢 GREEN (50):** all fleet-send buttons (1-click-1-action verified), all
  MAIN-world observers (originate nothing), all display/readability/FAB (touch
  only OG-E's/AGR's own DOM), the menu highlights (additive, never hide),
  scraping + gist sync + dashboard (own-data, read-only, no auto-scan, no
  auto-refresh). See `fair-play.md`.

**Host permissions to disclose** (`manifest.json`): `*://*.ogame.gameforge.com/*`
(game content scripts + read-only public `/api/*.xml`), `https://ntfy.sh/*`
(reminder queue — opt-in; the RED), `https://api.github.com/*` (opt-in gist
sync + update checks); `permissions: ["storage"]`.

## Done in this session

1. **Renamed "Reminders (ntfy.sh)" → "Alarm clock"** (user-facing strings only;
   internal dirs/keys/`reminderConfig` deliberately unchanged — not a contract):
   - `src/features/settingsUi/sections/reminders.js` — section title + note.
   - `src/dashboard.html` — tab label, `<h1>`, intro, master-toggle label.
   - `src/features/reminders/eventList.js` — per-fleet bell tooltips.
2. **Reframed + renamed the attack alarm → "Under-attack highlight"** and
   **removed the off-tab signals** (the part Gameforge forbids):
   - `src/features/settingsUi/sections/display.js` — label + comment.
   - `src/features/attackAlarm/index.js` — deleted `ALARM_TITLE` /
     `ALARM_FAVICON`, `swapFavicon`/`restoreFavicon`, all tab-title flipping and
     favicon state; the 1s tick now only refreshes the in-banner ETA. Banner +
     vignette in the **open tab** stay (just a louder rendering of what OGame
     already shows a player at the keyboard). `id: 'attackAlarm'` kept as the
     legacy persisted key so existing users' toggle survives.

`npm run typecheck` + `npm run lint` both pass. Build verified.

## Test-server access (Origin PTS) — where to test safely

The submission forum **is** the Public Test Server forum: "Origin" is OGame's
official PTS. So testing and submission share one home.

- **Access:** copy a live account into the **Alpha PTS** in-game via *Options →
  Extended → Alpha* (V10 servers, one account per lobby, ~24 h cooldown after a
  delete), or register fresh — see
  [Alpha – the new PTS server](https://forum.origin.ogame.gameforge.com/forum/thread/128-alpha-the-new-pts-server/).
- **Caveat (be honest about it):** the rules say an un-tolerated *installed*
  tool *"is illegal to use and may result in a ban"* — and that applies on PTS
  too, in writing. PTS is not a rules-free sandbox. The clean path: **uninstall
  from live now** (done), test the in-dev build **only on a throwaway PTS
  account**, and **disclose to ToolDevs (via Discord / the submission thread)
  that you're the developer testing your own build to prepare the submission** —
  the expected, normal dev workflow. Frame it as developer transparency, not a
  guilty confession.

## Contact channel / open-source

- **Open-source GitHub tools are already tolerated** (PTRE, EasyPTRE are
  open-source; OGameX is MIT) — OG-E is **not** a pioneer here, which is good
  (precedent exists). Open source is an **advantage**: ToolDevs can read the
  source and verify the fair-play claims directly.
- **GitHub covers Website + Download + Support** (repo + Releases + Issues).
  **But** the usergroup-role step explicitly asks you to *"Add your discord
  handle on the request"* — so a **Discord handle is still needed** for the
  ToolDev role assignment even if GitHub is the primary home. Recommend: GitHub
  as the home, plus a minimal Discord handle to be reachable.

## Remaining work (next sessions)

**Decisions — RESOLVED.**
- [x] **Reminders — APPROVED by ToolDevs (conditional), 2026-06-23.** Condition:
      OG-E must never track the game while the player is away. **Implemented**
      via presence-gating (Tier 1 `313545c` + Tier 2 `07268c7`); reminders kept.
      See [`toleration-consult.md`](toleration-consult.md).
- [x] **Renames done** for framing consistency: `reminders`→`alarmClock`
      (`ddd1552`), `attackAlarm`→`threatHighlight` (`d35651d`). UI labels read
      "Alarm clock"; genuine attack-detection vocabulary kept (it is truthful).
- [x] **Under-attack highlight (now "threat highlight").** Kept, default-off,
      renamed away from "alarm", and now presence-gated (does not observe the
      attack flag while the tab is hidden). Off-tab signals already gone.

**Code (after the decisions, via the build-and-verify loop):**
- [ ] **Parity opt-out** for the daily-run deploy redirect (mirror
      `oge_autoRedirectExpedition`); YELLOW-A.
- [ ] **Correct the "never modifies a request" wording** to be response-accurate
      across README/PRIVACY/CONTRIBUTING; YELLOW-A.
- [ ] Whatever the reminders/attack-highlight decisions imply (remove/gate code).

**Docs / submission:**
- [x] **`docs/fair-play.md`** — canonical per-feature classification (done).
- [ ] **Synthetic-input disclosure** paragraph in `amo-reviewer-notes.txt`
      (YELLOW-B) — how the form is pre-filled (synthetic events) + the
      double-clicks that are one game action.
- [ ] **`docs/toleration-submission.md`** — forum post draft (English): Info,
      Author, Website, Support, Download, Screenshot, Browser, Compatibility,
      Languages + intro, usage, full feature list (link `fair-play.md`),
      screenshots.
- [ ] **Browser-verify** the under-attack reframe (in-tab only, no title/favicon)
      + the redirect opt-out + Alarm-clock UI in Settings/Dashboard.
- [ ] **At release time only** (per CLAUDE.md "How we work"): reconcile the test
      suite, then the normal release path (CHANGELOG + version bump in
      `package.json`+`manifest.json` + `chore(release):` to main).

## Process checklist (user, on the forum — outside the repo)

1. Create/confirm the **Discord handle**; keep GitHub as Website/Download/Support.
2. **Screenshots** of each feature (mobile FAB, dashboard, settings).
3. **ToolDev consult FIRST** (Discord) on the two borderline items —
   reminders model + under-attack highlight — *before* posting. The rules
   require clearing borderline features before shipping.
4. Open the *Submissions & API Requests* thread (it starts disabled — normal);
   include the required fields and link `fair-play.md`.
5. Respond to ToolDev review; keep a per-version changelog (only the latest
   published version is legal).
6. After acceptance: apply to the Community Projects usergroup (link the forum
   entry + Discord handle).
