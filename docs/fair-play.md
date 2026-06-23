# OG-E fair-play & toleration classification

> Canonical compliance document (DRY: the forum submission and
> `amo-reviewer-notes.txt` link here instead of restating this). It maps
> **every** OG-E feature to GameForge's verbatim *Forbidden features* rules,
> with the fair-play justification and the residual risk. Produced from a
> full adversarial source audit (every non-GREEN finding was re-verified
> against the cited code). Delete/relocate this only if OG-E's compliance
> posture is folded elsewhere.

## The rules we are judged against (verbatim)

From the OGame Origin/PTS **[Forbidden features](https://forum.origin.ogame.gameforge.com/forum/thread/29-forbidden-features/)** thread:

1. **Monetization/chrome** — *"Blocking, hiding, obscuring (e.g., via CSS
   opacity, sizing, or off-screen positioning), or changing the images of
   banners, the top advertisement bar, premium/monetization content, or menu
   items like Merchant, Recruit Officers, Shop, and the footer."*
2. **Dark Matter** — *"Imitating features that are exclusively accessible with
   Dark Matter usage … is strictly prohibited."*
3. **Automation/macros** — *"Any kind of automation that executes a sequence
   of actions without corresponding user interaction is prohibited."* Incl.:
   *"A single user click cannot trigger multiple distinct game actions"*;
   *"Delayed or scheduled executions … are forbidden"*; *"Automatic refreshing
   of the game page is strictly prohibited."* (Batching non-tactical actions on
   your **own** planets *may* be tolerated case-by-case.)
4. **Alarms/notifications** — *"Automated alarms designed to alert a player to
   in-game events while they are away or inactive are prohibited. This includes
   acoustic or visual signals for incoming attacks, finished buildings, or
   fleet arrivals (including desktop notifications and automated external
   webhooks like Discord pings)."*
5. **Allowed** — *"Basic, immediate UI feedback confirming a user's action,
   such as a 'settings saved' text box, is permitted."*

## OG-E's three structural invariants (each verified in the audit)

- **Never originates or modifies a game *request*.** OG-E's MAIN-world
  bridges only **observe** the game's own XHRs and re-emit them as internal
  `oge:*` DOM events; the one `.send()` in the whole bridge tree is the native
  call forwarded verbatim (`bridges/xhrObserver.js`). Verified: grep for
  `xhr.open/send`/`fetch(` to a game host returns **zero** OG-E-originated game
  traffic. *(One nuance, see §Risk A: two redirect bridges rewrite the game's
  own **response** `redirectUrl` — a navigation target, not a request.)*
- **One user click → at most one game request.** Every fleet/action button is
  strictly 1:1; multi-step flows are multi-**tap**, never one-tap-many-sends.
  Verified per button below.
- **No background watching of the game.** No timer reloads the game page, no
  code reads the event list to alert about **hostile** fleets off-tab, no
  audio, no `document.title`/favicon mutation, no desktop `Notification`.
  Verified by a dedicated cross-cutting grep sweep.

---

## Classification summary

| Category | Count | Meaning |
|---|---:|---|
| 🟢 GREEN | 50 | Clearly allowed: display/calc/own-stats/manual 1-click-1-action. Ship as-is. |
| 🟡 YELLOW | 7 | Compliant on the merits but needs a doc disclosure, a small parity fix, or a ToolDev confirmation. |
| 🔴 RED | 5 | Literal violation of rule 4 (all the **same** ntfy push mechanism). Decision + ToolDev consult required before submission. |

The five REDs are one feature family (off-device push reminders) sharing one
code path (`sync/ntfyReconciler.js` `X-Delay`). The seven YELLOWs reduce to
**three** themes (A redirect-response rewrite, B synthetic-input disclosure,
C under-attack highlight). Everything else is GREEN.

---

## 🔴 RED — off-device push reminders (rule 4)

**Root cause (one code path):** `sync/ntfyReconciler.js` POSTs to `ntfy.sh`
with an `X-Delay` header, so the public push service holds the message and
delivers it to the player's phone **at a future time, while they are away from
the tab**. Rule 4 names this category explicitly: *"…fleet arrivals (including
desktop notifications and automated external webhooks like Discord pings)."*
ntfy.sh **is** an automated external webhook; an expedition/fleet **return** is
a *"fleet arrival"*. The audit returned RED on all four reminder kinds and the
adversarial verifier **could not refute any of them** — the *"it's an
alarm-clock the player could set themselves"* argument is morally real but is
**not a carve-out the rule grants**, and the rule says nothing about "your own
fleet."

| Reminder kind | Trigger | Defensibility | File |
|---|---|---|---|
| **Ad-hoc per-fleet** | User taps a bell on one fleet row (opt-in, manual, own fleet) | **Strongest** "could set it themselves" case | `reminders/eventList.js`, `sync/ntfyReconciler.js:715` |
| **Expedition-wave** | Auto-scheduled when an own expedition wave is detected returning | Convenience only (no defensive/AFK advantage) | `sync/reminders.js:654` |
| **Fleet-save auto-detect** | Auto-classified by ship-count/flight-time; **no user click** | **Weakest** — and it enables AFK fleet-saving, the exact behaviour the rule's *intent* targets | `sync/reminders.js:709` |
| **Bare-fleet guardian** | Auto-escalation push (priority 5) at landing+interval | Weak — same AFK-fleetsave intent | `sync/ntfyReconciler.js:871` |

**Why the "own fleet" defence is weakest exactly where it's most tempting:**
the *purpose* behind rule 4 is to keep fleet-saving an at-the-keyboard
activity. The **fleet-save** and **guardian** pushes exist precisely to let you
re-save while away — that is the AFK advantage the rule is designed to remove,
even though it's your own fleet. The **expedition-wave** and **ad-hoc** pushes
are pure convenience (idle fleets home / a generic timer) and carry no
defensive advantage, so they are the better candidates to argue for.

**Resolution paths (decision required — see `toleration-plan.md`):**

- **Consult-first (recommended).** The rules require consulting ToolDevs on
  borderline features *before* shipping. Open the consult on the narrow
  question: *does an opt-in, own-fleet-only, time-derived-from-the-player's-own-
  action reminder qualify as a permitted alarm-clock, or is any off-device
  push about a fleet return forbidden?* Lead with the **ad-hoc** + **wave**
  cases; be ready to **drop fleet-save + guardian** push outright.
- **In-tab-only fallback (guaranteed compliant).** Remove the `X-Delay`
  external-push path entirely; keep the in-tab badges, the dashboard queue
  preview, and an at-keyboard visual. This is rule-4-safe but removes the
  phone-while-away value that is the feature's whole point.
- **Submit-without, add-later.** Submit the 50-GREEN tool now (fast path to
  toleration), keep reminders out of the tolerated scope until ToolDevs rule.

Dependent surface: the **Dashboard Reminders tab** + config editor are
themselves clean (extension-origin, read-only toward the game) but inherit this
verdict — they configure/preview the push feature, so they ship or don't ship
with it.

---

## 🟡 YELLOW — three themes

### A. Redirect bridges rewrite the game's own response `redirectUrl`

`bridges/expeditionRedirect.js` and `bridges/deployRedirect.js` let the
post-send page reload land on the **next** planet the workflow needs, instead
of the game's default. Mechanically: after the player's **single** native
dispatch click, the bridge installs a getter that swaps `resp.redirectUrl` on
the game's **own** `sendFleet` response (`expeditionRedirect.js:283`,
`deployRedirect.js:104`). **It originates zero requests and adds zero sends** —
1-click-1-action holds — it only changes a *navigation target* to a URL the
player could have typed.

Two actions:
- **Truth-in-wording:** OG-E's public invariant says *"never sends **or
  modifies** an HTTP request."* That's not literally true for the **response**.
  Fix the wording everywhere (README/PRIVACY/this doc already says "request,
  not response") to: *"never originates a request, and never modifies a
  request; it rewrites only the navigation target of the game's own response."*
- **Parity opt-out:** the expedition redirect is gated by a Settings toggle
  (`oge_autoRedirectExpedition`); the **daily-run deploy redirect has no
  toggle**. Add one for parity, so every auto-navigation is user-disableable.
- **Consult:** confirm with ToolDevs that rewriting your own post-send redirect
  to another in-game page is treated as *navigation* (allowed), not *scheduling
  the next action*.

### B. Synthetic-input & double-click disclosure (no behaviour change)

These are verified **not** violations, but a source-reading reviewer must be
told how the form is driven so nothing looks hidden:

- **`shared/fleetCourier.js` + `bridges/fleetExecutor.js`** pre-fill the game's
  fleet form with **synthetic** `MouseEvent`/`KeyboardEvent`s (`isTrusted=false`),
  functionally identical to a user's keystrokes/clicks, and the actual send is a
  single `safeClick(#dispatchFleet)` on tap 2. Disclose: "form is pre-filled via
  synthetic events; the one server send is a synthetic click on the native
  dispatch button, on a separate deliberate user tap."
- **`shared/agrRoutine.js:88`** fires a second `safeClick` on AGR's **own**
  routine element 50 ms later to un-stick a half-idled fleet1→fleet2 transition.
  Two clicks, **one** game action (advancing the form), zero extra sends.
- **`features/agrLogo.js:225`** one user click → two synthetic clicks, both UI
  toggles on AGR's/OG-E's own panels — no game action at all.

Fix: a paragraph in `amo-reviewer-notes.txt` + the submission. No code change.

### C. Under-attack in-tab highlight (rule 4 borderline)

`features/attackAlarm/index.js` renders a loud in-tab banner + screen-edge
vignette when OGame's own `#attack_alert` flag trips. The off-tab signals are
**already removed** (audit-confirmed: no `document.title`, no favicon, no
audio, no notification, no webhook — `index.js:13,17,220`). It can only reach a
player **looking at the open tab** (i.e. at the keyboard, not "away/inactive").

Residual: rule 4 lists *"visual signals for incoming attacks"* with no explicit
active-tab exception, and the feature **does** read hostile attack legs to
build the banner. This is the single most *symbolically* risky feature (its
internal name is literally `attackAlarm`). Options, in order of safety:
1. **Remove it.** Lowest-value, highest-symbolic-risk feature; removing it
   makes the submission unambiguous.
2. **Keep, default-off, get an explicit ToolDev green-light** that an
   in-tab-only re-emphasis of state the game already shows — with provably no
   off-tab channel — is permitted. Rename away from "alarm" entirely.

(Also disclose: the 25 s `setInterval` at `index.js:336` re-reads the DOM flag;
it never calls `location.reload`, so it is **not** rule-3 auto-refresh.)

---

## 🟢 GREEN — allowed (50; grouped)

All verified: 1-click-1-action where a send exists; pure read/observe/display
otherwise; no hiding/obscuring of any ad/menu/premium/footer; no auto-refresh;
no off-tab alarm.

**Fleet-send buttons (each tap = at most one of {navigate | pre-fill | one
native dispatch click}):** Send Expedition*, Send Colony, Send Lifeform/Discovery,
Daily Run micro-fleet, Daily Run collect, Abandon-colony 3-step (3 taps→3
requests, own planet), Fleetdispatch ArrowRight accelerator, Fleet-guardian
in-game re-save button. *(*Send Expedition is YELLOW-B only for the agrRoutine
double-click disclosure; its send behaviour is GREEN.)*

**MAIN-world observers (read the game's own XHR, emit internal events, originate
nothing):** xhrObserver, galaxyHook, checkTargetObserver, fleetDispatcherSnapshot,
eventBoxObserver, sendFleetResultHook, systemDiscoveryObserver, sendFleetHook,
traderActionHook.

**Display / readability / shells (touch only OG-E's own DOM, or AGR's — never
OGame ad/menu/premium/footer):** readabilityBoost (the only `display:none`
targets AGR's own event-detail chevrons), antiFlickerBackground (root bg colour
for ~300 ms), agrLogo (restyles AGR's own logo button), agrGuard (adds OG-E's
own "install AGR" banner), unifiedFab + draggableButton + button/buttonChrome/
buttonGlyphs (OG-E's own floating buttons; user-draggable; never restyle game
chrome), settingsUi (OG-E tab inside AGR's menu), eventBoxGate.

**Menu highlights (purely *additive* emphasis — the opposite of hiding):**
event-menu highlight (box-shadow/animation on time-limited entries; never
`display:none`), trader-menu highlight (glows that draw *more* attention to the
Merchant — opposite of rule 1).

**Scraping / data / sync (own-data, read-only, no game traffic, no auto-scan):**
apiContext (reads GameForge's deliberately-public `/api/*.xml`, weekly TTL,
`credentials:'omit'`), ownProfile, colonyRecorder, planetBarCapture, the scans
store, rewarding & artifact-shop watchers (these *suppress* an OG-E pulse once
chores are done — anti-alarms), Dashboard data I/O (local export/import/CSV),
Dashboard galaxy map + sync diagnostics, GitHub gist sync (download-only 5-min
backstop hits *GitHub*, never the game; visibility-gated).

**Event-list reminder badges & suppression controls:** the in-tab bell/shield
badges and arm/cancel/dismiss controls are GREEN (passive cell restyle +
1-click-1-intent). They become useful only if the push channel (RED, above) is
permitted; the *cancel/dismiss* controls only ever **remove** notifications.

---

## What OG-E never does (all grep-verified)

- No origination or modification of a game **request** (only response
  *navigation-target* rewrite in two bridges; see Risk A).
- No automatic page refresh / meta-refresh / reload-on-timer.
- No audio (`new Audio`/`.play()`/`AudioContext` — zero occurrences).
- No `document.title` / favicon mutation.
- No browser/desktop `Notification` / `chrome.notifications`.
- No reading of the event list to alert about **hostile** fleets off-tab.
- No hiding/obscuring/resizing/opacity/off-screen of any OGame banner, ad bar,
  premium/Dark-Matter content, Merchant/Officers/Shop, menu item, or footer.
- No Dark-Matter feature imitation.
- No telemetry/analytics; the only outbound hosts are the game's public API
  (read-only), the user's GitHub gist (opt-in), and ntfy.sh (opt-in; the RED).

## Open items before submission

1. **Decide the reminders path** (RED) and run the ToolDev consult.
2. **Decide the under-attack highlight** (YELLOW-C): remove or get a green-light.
3. **Add the daily-run redirect opt-out toggle** (YELLOW-A parity).
4. **Correct the "never modifies a request" wording** to be response-accurate
   (YELLOW-A).
5. **Write the synthetic-input disclosure** paragraph for reviewers (YELLOW-B).
