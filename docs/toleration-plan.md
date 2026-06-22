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

## Fair-play audit result (full feature sweep)

**Zero automation of game actions.** Every fleet/action feature is strictly 1:1
— one user click/tap/key = one request the native game code initiates. Verified
explicitly: `sendColony`, `sendExpedition`, `sendLifeform`, `dailyRun`,
`abandon`, `fleetdispatchShortcut` all pre-fill/navigate but the player clicks
the native dispatch button (e.g. `sendLifeform/domHelpers.js:112` "we never
originate it"; `dailyRun/pure.js:22-29`).

- **GREEN (22 features):** display/overlay/CSS, calculators, manual buttons,
  keyboard shortcuts, own-stats scraping. No gameplay monitoring-to-notify, no
  automation.
- **YELLOW (frame in the submission, not violations):**
  - `reminders` core (wave / ad-hoc / fleet-save) — ntfy `X-Delay` alarms on
    times computable from the player's own action. Frame as alarm clock.
  - `reminders/guardian` — offline push "at landing + interval" for the
    player's **own** landed-but-unsaved fleet-save (`guardian.js:21-29`). Landing
    time is known from the player's own send, but the **interval escalation** is
    the part nearest the line. **Consult ToolDevs before submitting**; be ready
    to drop the escalation to a single ping if they object.
  - `apiContext` — weekly read of OGame public `…/api/*.xml` + `api.github.com`
    release checks. Read-only; frame as offline occupancy hints, not real-time
    monitoring.
- **RED → addressed (see Done below):** `attackAlarm`'s off-tab title/favicon
  blink was the historical "attack alarm" pattern. Removed; kept the in-tab
  banner only and renamed.

**Host permissions to disclose** (`manifest.json`): `*://*.ogame.gameforge.com/*`
(game), `https://ntfy.sh/*` (alarm queue), `https://api.github.com/*` (update
checks); `permissions: ["storage"]`.

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

## Remaining work (next sessions)

- [ ] **Browser-verify** the reframed feature: under-attack banner still shows
      in-tab, no longer touches tab title / favicon; Alarm clock UI reads
      correctly in Settings + Dashboard; ntfy alarms still fire.
- [ ] **`docs/fair-play.md`** — canonical compliance justification (the line
      above + the per-feature classification + explicit "what we never do" +
      Gameforge rule citations). One source of truth (DRY); the submission links
      to it.
- [ ] **`docs/toleration-submission.md`** — forum post draft (English) with all
      required fields: Info, Author, Website, Support, Download, Screenshot,
      Browser, Compatibility, Languages + intro, usage, full feature list with
      fair-play annotations, screenshots.
- [ ] **Pre-submission ToolDev consult** on `reminders/guardian` interval
      escalation + the ntfy alarm-clock model (rule: clear borderline features
      before shipping).
- [ ] **At release time only** (per CLAUDE.md "How we work"): reconcile the test
      suite for the renamed labels, then the normal release path (CHANGELOG +
      version bump in `package.json`+`manifest.json` + `chore(release):` to main).

## Process checklist (user, on the forum — outside the repo)

1. Public tool page + support channel (Discord?).
2. Screenshots of each feature.
3. (Recommended) Contact ToolDevs about the alarm-clock + under-attack highlight
   before posting.
4. Open the *Submissions & API Requests* thread (it starts disabled — normal).
5. Respond to ToolDev review; keep a per-version changelog.
6. After acceptance: apply to the Community Projects usergroup (link the English
   forum entry + Discord handle).
