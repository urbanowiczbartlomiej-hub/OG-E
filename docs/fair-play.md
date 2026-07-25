# OG-E fair-play & toleration classification

> Canonical compliance document (DRY: the forum submission and
> `amo-reviewer-notes.txt` link here instead of restating this). It maps
> **every** OG-E feature to GameForge's verbatim *Forbidden features* rules,
> with the fair-play justification and the residual risk. Produced from a
> full adversarial source audit (every non-GREEN finding was re-verified
> against the cited code). Delete/relocate this only if OG-E's compliance
> posture is folded elsewhere.

## Cross-check against the Origin team's `AGENTS.md` guardrail (2026-07-25)

The OGame Origin ToolDev team published an **[`AGENTS.md`](../AGENTS.md)**
guardrail (`github.com/Rivenscryr/origin-tooldev-agents`) that distils the same
*Forbidden features* thread this doc is built on. It is now vendored at the repo
root. OG-E was re-audited against **every** rule in it; the mapping is clean —
nothing new to change beyond the YELLOW items already open below:

| `AGENTS.md` rule | OG-E status |
|---|---|
| §1.1 Automation / macros (1 click = 1 action) | ✅ Structural invariant; no multi-target/"spy-all" button exists. |
| §1.2 Scheduling / delayed **game** actions | ✅ No timer fires a game action. (ntfy `X-Delay` is a phone *reminder*, not a game action — §1.4 category, below.) |
| §1.3 Auto-refresh / polling the game | ✅ No timer reloads the game or polls the game server. The one `location.reload` (`features/abandon/index.js:270`) is a one-shot settle after the player's own 3-tap abandon, not a background loop — disclose, don't remove. |
| §1.4 Auto-registered alarms / webhooks | ⚠️ The known RED: ntfy `X-Delay` push. **ToolDev-consulted & conditionally APPROVED (2026-06-23)**; condition (never track the game while away) implemented via presence-gating. Grep-verified zero `Notification`/`chrome.notifications`/`document.title`/favicon/audio. |
| §1.5 Alt UI / shortcuts / lobby bypass | ✅ None. Redirect bridges rewrite only the game's own **response** navigation target (YELLOW-A). |
| §1.5.1 Direct probing (`miniFleet`/`sendFleet`) | ✅ **Zero `miniFleet`; OG-E never originates a `sendFleet`.** `sendSpy` = 1 tap → pre-fill + one native dispatch for **one** planet. The dashboard scan plan has **no send control** and must never grow one — data display is deliberately separated from the probe action, exactly the AGENTS.md model. |
| §1.6 Dark Matter imitation | ✅ No Commander-queue imitation. |
| §1.7 Blocking / altering monetization | ✅ No hide/opacity/off-screen of any ad/banner/Merchant/Officers/Shop/footer; menu highlights are *additive*. |
| §1.8 Paywalls / fees / injected ads | ✅ Free, open-source, no injected ads. |
| §1.9 Silent scraping | ✅ Only opt-in, token-configured egress (GitHub gist, ntfy); documented in `PRIVACY.md`. No covert exfiltration. |
| §4 Background calls fire only on page load | ✅ `apiContext` hydrates on load with a TTL cache, then reads the DOM as the player navigates — the exact "hydrate once, read the DOM" pattern §4 *recommends*. |
| §4.1 `accountInfo` polling | ✅ **Zero uses of `accountInfo` anywhere.** |
| §4.2 `cp` in background calls | ✅ `cp` is only ever **read** from the current URL for navigation; never injected into a background fetch. |
| §5 Toleration needed? | ✅ Correctly self-assessed as needing toleration; submission tracked in `toleration-plan.md`. |
| §6 API / community proxy | ✅ Only the public `/api/*.xml` files (which §6 permits **directly** per-universe), `credentials:'omit'`, TTL-cached — never polled. No non-public/report endpoint is touched, so the `ogapi.faw-kes.de` proxy is not required. |

**Bottom line:** the guardrail confirms the day-one design. Every technical
red-flag vector it names — `accountInfo` polling, `cp`-in-background, `miniFleet`
direct probing, off-tab attack alarms, ad hiding, Dark-Matter imitation,
auto-refresh, multi-action clicks — is **already absent in current code**, and
the single borderline feature (ntfy push) was already formally cleared. The open
items are the pre-existing YELLOWs in "Open items before submission" below.

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

> **These counts predate the Spyglass tab.** The Spyglass v3 intelligence-workbench
> family (one-tap scan, `targetsIngest`, danger model, routine tracker, scan plan,
> defensive strip, own map) is classified separately in its own section below — mostly
> GREEN, with one **YELLOW-D** ToolDev item (routine tracker + `windowBonus`) to be
> confirmed before those ship. See "🟢/🟡 Spyglass intelligence workbench (v3)".

---

## 🔴 RED → ✅ approved (conditional) — off-device push reminders (rule 4)

> **Resolved 2026-06-23.** ToolDevs **approved** the off-device "alarm clock"
> push, conditional on OG-E **never tracking the game while the player is away**
> — now implemented via presence-gating (Tier 1 `313545c`, Tier 2 `07268c7`).
> Reminders kept (incl. fleet-save / guardian). Feature renamed
> `reminders`→`alarmClock`. The assessment below stands as the original risk
> analysis that drove the consult.

### Wording discipline (binding — part of the approval condition)

The push is permitted **only** as a player-set alarm clock, never a monitor. So
the user-facing vocabulary must never imply that OG-E watches the game, runs
while the player is away, or holds a notification it "fires" on a timer. Under
rule 4 the *appearance* of an away-monitor is itself the risk, so this wording
is part of staying inside the granted carve-out — it is not cosmetic.

The mental model every string must reinforce: the player **sets** a reminder —
at send time, for a return time the game already showed them — and the reminder
**rings** at that time. OG-E's job ends the moment the reminder is set; the
player can close the browser. ntfy (a generic push service, like a phone's clock
app) **delivers** it.

A deliberate noun split carries the fair-play meaning. The **device** is the
"**alarm clock**" (= a *budzik* you set yourself — the exact phrase ToolDevs
approved). An **individual buzz** is a "**reminder**". We never use bare
"**alarm**" as the countable unit: standalone "alarm" reads as the *alert* rule
4 forbids ("automated **alarms** … to alert a player to in-game events"),
whereas "alarm clock" and "reminder" both read as player-set.

- **Banned** in user-facing copy: *fires / fired / fires at*, *queue / queued /
  currently queued / queued on ntfy*, *pending*, *live* (as a status line),
  any "schedule/scheduled" **attributed to OG-E**, and **bare "alarm"** as a
  noun (an *alarm* you'd "get" — use "reminder"; "alarm **clock**" the device is
  fine).
- **Use** instead: noun **"reminder"** for the unit, **"alarm clock"** for the
  device/feature name, **"Reminder times"** for the offset list; verbs
  *set / armed / rings / rang / rings at / to go / as of*; and describe ntfy as
  **delivering**, never OG-E as dispatching.
- **Exempt** (never shown to a player, so unchanged): internal identifiers —
  variable/function names (`adhocFireTimes`, `reconcileWaveQueue`), CSS `cls`
  hooks (`.rem-badge.queued`/`.scheduled`/`.fired`), gist filenames
  (`oge-alarmClock-*.json`), and storage keys. Only **rendered** strings are
  governed by this rule.

Last reconciled in the alarm-clock vocabulary pass (2026-06-24): replaced
"Fires at"→"Rings at", "Currently queued"→"Reminders set", the `live · … queued
on ntfy` status line→`as of … N reminder(s) set`, badge
`queued/fired/scheduled` labels→`set/rang/armed`, the countable unit
"alarm"→"reminder" everywhere (keeping "alarm clock" the device name), and
removed every `alarmClock` camelCase leak from rendered copy.

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

## 🟢/🟡 Spyglass intelligence workbench (v3) — new surface classification

The 50/7/5 counts above predate the Spyglass tab entirely: this whole family
(one-tap espionage scan, `targetsIngest`, the danger model, and everything the
v3 redesign adds) had **zero** entries. This section classifies it. The load-bearing
argument is a single **provenance guarantee**, and every item below inherits it:

> **Provenance guarantee.** Every Spyglass surface is built only from (a) spy/galaxy
> reports the player **opened during normal play** (passive `MutationObserver` /
> XHR-observe of the game's *own* rendered content — the same basis as
> `planetBarCapture` and `galaxyHook`), and (b) the deliberately-public `/api/*.xml`
> read **only while a game tab is open** (`credentials:'omit'`, TTL cadence). OG-E
> **never** fetches or samples on the player's behalf while they are away, **never**
> originates a game request, **never** sends without a deliberate user tap, and
> **never** alerts. One-tap-one-scan is preserved throughout.

### 🟢 GREEN (ship as-is — each extends an existing category)

- **`targetsIngest`** — passive read of the *dataset* on the player's own rendered
  messages page (`.rawMessageData`); originates nothing. Same class as
  `planetBarCapture`/`colonyRecorder` (Scraping/data, GREEN). *Now includes:* the
  richer fields already in that dataset (resources, loot %, counter-esp %, class,
  scores, buildings/research), **partial/resources-only reports**, and the
  **proximity "foreign fleet near your planet"** reports — all the same passive read.
- **Galaxy-view activity capture** — reads the per-body activity marker out of the
  `fetchGalaxyContent` the player themselves browses; identical basis to the existing
  GREEN `galaxyHook` observer. No extra fetch (the player drives the galaxy view).
- **Always-on galaxy activity + galaxy-look proposal (`galaxyWatch`)** — galaxy activity
  is tracked for EVERY watched body (planet + moon), always, purely by reading the
  `fetchGalaxyContent` the player's own navigation loaded (undetectable by the target — no
  espionage-log entry, no counter-espionage). To keep that coverage fresh the Spy FAB may
  propose **one system**, and a single tap navigates there (`navigateGalaxyInPage` — the
  same 1-tap-1-navigation as `sendLifeform`'s shipped discovery walk). No probe is sent,
  no request is originated, the player drives every step, and it is *strictly less* game
  traffic than probing. Galaxy-capture + 1-tap-nav classes (GREEN).
- **Per-body / per-player scan toggle + cadences (dashboard prefs)** — device-local intent
  (whether to ALSO send probes for a body/player — galaxy activity is never gated; the
  staleness thresholds that reorder the plan). Read **in-tab only** to rank/label; no send,
  no timer, no background actor. Same display/prefs class as the sort/limit/open-dossier
  workspace state (GREEN).
- **Spy FAB (`sendSpy`)** — 1-click-1-send; each tap pre-fills + one native dispatch
  for **one** planet. Shipped precedent (v1.31.0: "you press send each time, nothing
  is automated"). Fleet-send-buttons class (GREEN).
- **Danger model, Finder table, per-player Dossier, civil-fleet baseline, player
  search, own player-centric map** — pure read/calc/display over the public API + the
  player's own reports. No game traffic, no send, no hiding of any ad/menu/premium.
  Display/calc class (GREEN).
- **Scan plan (proposes + ranks)** — the dashboard only **reorders which single planet
  the one existing manual FAB tap proposes next**, and shows the plan as a read-only
  strip. It is display logic over one already-permitted tap; the dashboard has **no
  send control** and must never grow a "send"/"send all" affordance, and the re-rank
  must never auto-advance past the send click. Display class (GREEN).
- **"Ship count changed — worth a re-spy" chip** — a passive hint over public-API data
  read while a tab is open; triggers no send and no alert (the player taps to re-spy).
  It must never claim "fleet moved" (that inference is impossible — a flying fleet
  still counts; see `docs/ogame-fleet-mechanics.md`). Display class (GREEN).
- **"Who's been near you" defensive strip** — passive read of the player's own
  proximity reports; names a scout the player can then watch. No alert, no send.
  Display class (GREEN).

### 🟡 YELLOW-D — routine tracker + "good moment" nudge (one ToolDev consult)

Two items are defensible on the provenance guarantee but sit in the same *symbolic*
zone rule 4 polices (YELLOW-C: opponent-state-derived signals) and so want an explicit,
written ToolDev green-light **before they ship** (Etaps F/G), exactly as the ntfy push
was gated:

1. **Routine tracker** — summarising a watched opponent's activity/wealth *pattern over
   time* (hour-of-day activity, weekday resources, collection planet) from reports the
   player opened + tab-open public API.
2. **`windowBonus`** — a passive re-rank that surfaces "good moment to scan" when *now*
   falls inside that observed pattern. It is never a toast, never a timer, never a send.
3. **Presence heatmap (offline-window analysis)** — the SAME routine data, aggregated
   into a day/hour temperature map of when a watched opponent is reliably *not*
   interacting, to time an attack. Same provenance (reports the player opened + galaxy
   views they browsed), same in-tab display, no send/alert/timer. It is the **sharpest
   form** of the same question items 1–2 raise — opponent-activity-over-time — so it sits
   inside the SAME consult, not outside it. Its copy says **"offline windows"** /
   **"based on the intel you gathered"** / **"no activity seen"**, and NEVER
   "online"/"logged in" (the marker is *any* interaction — a foreign fleet, a probe, our
   own; §6.6bis). The map deliberately shows **coverage** (unobserved ≠ offline) so it
   cannot fabricate a certainty the samples don't support.
4. **Fleet-landing "strike" signal** (`domain/fleetLanding.js`) — the instantaneous
   cousin: a lone fresh moon marker + all other bodies quiet ⇒ *"possible fresh
   fleet-save landed while the owner is away"*, boosting that moon to the top of the scan
   plan so the FAB proposes spying it. Same provenance (the galaxy views the player
   browsed), same in-tab display, **no send/alert/timer** — the confirming probe is one
   deliberate tap, and there is deliberately **no in-game highlight** (that would be the
   YELLOW-C visual-signal zone; kept off). It is the closest thing to a "strike now"
   nudge OG-E has, so it belongs to this consult too. Copy is a **candidate** —
   *"possible fresh fleet — spy to confirm"* — never *"fleet is there"*, and it shows the
   coverage basis (never over-claims "all others quiet" beyond what was looked at).

**Consult (open ONE, provenance-first):** *"Is a device-local intel workbench that
summarises an opponent's activity/wealth pattern — up to and including a heatmap of their
likely-offline windows — **purely** from spy reports the player opened during normal play
+ public-API data read **only while a game tab is open** — no background fetch, no send,
no alert, one-tap-one-scan preserved — a permitted display of intel the player gathered,
or does summarising opponent activity-over-time itself trip rule 4?"* Ship F/G (incl. the
presence heatmap AND the fleet-landing strike signal) only after the OK. Nothing in user
copy is named "monitor", "watcher", "tracker-of-\<player\>", or "alarm"; "Watchlist" (the
player's *own* list) is fine.

### Wording discipline — Spyglass extension (binding, extends §"Wording discipline")

The banned-vocabulary rule (never imply OG-E watches the game or fires on a timer)
applies verbatim to every Spyglass string. Concretely:

- **Banned** (rendered copy): *track / tracking / monitor / monitoring / watching
  \<player\>*, *live* (as a status), *queue / queued*, *scheduled / due / fires*, bare
  *alarm*. The scan plan is a **"scan plan"** / **"suggested order"** / **"next
  suggested"** / **"stalest first"**, never a "queue".
- **Use**: routine visuals read **"from the reports you've opened"** / **"intel you
  gathered"**; the `windowBonus` reads **"good moment — based on intel you gathered"**,
  never "scan now"/"due"; activity reads **"activity"** / **"interacted"**, never
  "online"/"logged in" (the marker is *any* interaction, including our own probe —
  §6.6bis of `SPYGLASS-REDESIGN.md`, git history). "Watchlist" is the tab; a player is "watched"
  (on the player's own list), never "being monitored".
- **Exempt** (never rendered): internal identifiers — `scanPriority.js`, `windowBonus`,
  `targetReports`, `.target-focus`, storage keys. Only rendered strings are governed.

### Persistence invariant (keeps it out of RED)

No Spyglass state may ever hold a **"send at" / "rescan at" timestamp that a background
path acts on**. The plan's persisted workspace state (sort, limit, open-dossier id) is
display/prefs only. All timing is in-tab and visibility-gated (`lib/clock`); there is no
service worker and no `chrome.alarms` — verified unchanged by this redesign. The
galaxy-watch additions keep the line: the `scanMode` map holds no timestamps, and the
`cadence` values are in-tab **staleness thresholds** that only reorder/label the plan
(exactly like the existing per-danger cadence), never a background-acted "rescan at".
The presence engine reads timestamps purely to compute an in-tab display; nothing acts
on them off-tab.

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
6. **Run the Spyglass ToolDev consult** (YELLOW-D) — the one provenance-first question
   for the routine tracker + `windowBonus`; required before Etaps F/G of the Spyglass v3
   redesign ship. See "🟢/🟡 Spyglass intelligence workbench (v3)".
