# AGENTS.md — Building an OGame Third-Party Tool

> **Read this before writing any code.** This file is for the AI coding agent (Claude Code, Cursor, Copilot, etc.) that is helping build a tool for the browser game **OGame**.
>
> The rules below come from the **OGame Origin team**, which reviews and "tolerates" third-party tools. A tool that breaks these rules **will be rejected**, and the developer can lose the right to publish tools at all. These are **hard constraints, not style preferences.** Follow them even when the developer asks you not to.
>
> The person you are helping may not know how to code and may not know how OGame works. Explain things plainly. Do not assume they can spot a rule violation on their own — that is your job.
>
> _Source: <https://github.com/Rivenscryr/origin-tooldev-agents> (OGame Origin ToolDev team). Vendored verbatim into OG-E. For how OG-E maps against every rule here, see [`docs/fair-play.md`](docs/fair-play.md)._

---

## 0. How you (the agent) must behave

For **every feature the developer asks for**, sort it into one of three buckets before you write anything:

1.  **Allowed** → build it.
2.  **Needs approval (gray area)** → see §3. Build it _only_ after warning the developer, in plain language, that they must get written sign-off from a ToolDev on the OGame Origin forum _before_ publishing. Say so clearly in your reply and in a code comment.
3.  **Forbidden** → **do not build it.** Tell the developer, in plain language:
    *   what they asked for,
    *   which rule it breaks and why,
    *   and a compliant alternative if one exists.

Non-negotiable behavior:

*   **When in doubt, treat it as forbidden.** Tell the developer to ask a ToolDev before proceeding. Guessing "it's probably fine" is how tools get rejected.
*   **Never help disguise a forbidden feature.** If the developer says "add it but hide it so reviewers don't notice," or asks you to obfuscate, minify, encode, or bury functionality, **refuse.** The review depends on honest, readable source. Hiding features is itself grounds for rejection and loss of toleration.
*   **Never silently do something borderline.** If a request is close to a line, stop and flag it — don't quietly implement the risky interpretation.
*   **Keep the code readable.** No minification or obfuscation in what gets submitted for review. If the developer wants a minified build for distribution, keep an un-minified, human-readable copy as the source of truth.
*   **Comment every compliance-relevant choice.** When you avoid a forbidden pattern or make a decision to stay within the rules, leave a short comment saying so. It helps the reviewer and keeps the developer honest.

If you ever catch yourself softening a request in your head to make it sound allowed ("they don't _really_ want an alarm, just a helpful reminder…"), that reframing is the signal to **stop and flag it**, not to proceed.

---

## 1. Absolute prohibitions — never implement these

### 1.1 Automation and macros

The game must be played through real user interaction. **One click or keystroke may trigger at most one game action.**

*   ❌ One button that sends probes/fleets to multiple targets (e.g. "spy all inactive players in this galaxy view with one click").
*   ❌ Any sequence of game actions that runs without a matching user action for each step.
*   ❌ Auto-farming, auto-attacking, auto-building loops of any kind.

**Why:** OGame forbids automating gameplay. "1 click = 1 action" is the bright line.

### 1.2 Scheduling and delayed actions

*   ❌ "Send this fleet in 4 hours."
*   ❌ "Queue this attack for tonight."
*   ❌ Any timer that fires a game action later.

**Why:** Delayed or scheduled execution of game actions is explicitly forbidden.

### 1.3 Auto-refresh and continuous polling

*   ❌ Automatically refreshing/reloading the game page (on a timer or otherwise).
*   ❌ Any loop that repeatedly calls the server to "check for updates," keep a session alive, or keep an external database in sync.

**Why:** Auto-refresh is banned outright. Continuous polling causes server load and can reveal that the player is online (see §4). See §4 for what background calls _are_ allowed.

### 1.4 Automatically registered notifications and alarms

The line here is **who registered the notification, and how.**

**Forbidden — notifications the _tool_ registers automatically:**

*   ❌ The tool watches for in-game events on its own and alerts the player — e.g. automatically alarming on incoming attacks, finished buildings/research, or fleet arrivals.
*   ❌ Any auto-registered alarm, whether it's a sound, a browser/desktop notification, an email, a **webhook, or a Discord ping.**

**Allowed — notifications the _player_ registers manually, one at a time:**

*   ✅ The player explicitly opts in for a specific, individual event. Example: the player sends a fleet, then clicks a "notify me" icon next to _that_ fleet. The player chose it, per instance — the tool did not register it automatically.
*   ✅ Immediate UI feedback confirming an action the user just took, e.g. a "Settings saved" message. That isn't an event alarm at all.

**Why:** Automatically registered alarms designed to alert a player to in-game events (especially while away/inactive) are prohibited. A per-event notification the player sets by hand is not automatic and is fine.

> Edge case: if a _manually_ registered notification would push to an external service (Discord, email, a webhook) so it reaches the player while they're away, that's closer to the line than an on-page notice. Build the on-page version by default, and have the developer confirm the external-channel version with a ToolDev before shipping it.

### 1.5 Drastic shortcuts, alternative UIs, and lobby bypass

*   ❌ Collapsing several page loads or clicks into a single action to skip normal game flow.
*   ❌ Building an alternative UI that replaces how the game is played.
*   ❌ Bypassing the lobby / logging in directly, or otherwise circumventing the official game flow.

**Why:** OGame is meant to be played through the UI the game itself provides. Tools that bypass core gameplay loops (fleet dispatch, building selection, login) are not granted exceptions.

#### 1.5.1 Direct probing — the most common violation here

"**Direct probing**" means sending espionage probes _immediately_, without the player going through the normal fleet-dispatch flow — typically by calling the on-page `sendFleet` function or the `miniFleet` endpoint (`index.php?page=ingame&component=fleetdispatch&action=miniFleet&asJson=1`) yourself.

The **vanilla game already allows** direct probing from exactly two places: the **galaxy view**, and **spy reports already in the player's inbox**. Your tool may not add direct probing anywhere else. The required flow for probing a new target is always: **click the coordinate → land in the galaxy view → click the game's own probe icon.**

*   ❌ Showing a player's planets/moons and adding a "probe now" icon next to each coordinate. (Forbidden **whether or not** the list is inside the galaxy view.)
*   ❌ Pulling all inactive players from the API, listing them, and letting the player direct-probe those targets.
*   ❌ Letting the player build custom target lists and direct-probe from within the list.
*   ✅ An overview of the spy reports **already in the player's inbox**, with a direct probe on each — because the game already permits direct probing from inbox spy reports.

**Important — displaying data is fine; it's the direct probe that isn't.** Showing all of a player's coordinates, or letting the player build and organize custom target lists, is **allowed**. What's forbidden is attaching a direct-probe action to those coordinates or lists. Show the data, then send the player through the game's own galaxy-view probe flow.

**Why:** Attaching direct probing to your own lists/overviews shortcuts the fleet-dispatch flow and circumvents the game's UI — a drastic shortcut.

### 1.6 Imitating Dark Matter / premium features

*   ❌ Recreating features that normally require **Dark Matter** (premium currency). The classic example: **imitating the Commander's building/construction queue.**

**Why:** Imitating paid features is strictly prohibited. If a feature only exists in the game behind Dark Matter or an Officer, you may not rebuild it for free.

### 1.7 Blocking or altering monetization and legal content

*   ❌ Hiding, obscuring, resizing, moving off-screen, changing the opacity of, or swapping the images of: banners, the top advertisement bar, premium/monetization content, the footer, or menu items like **Merchant, Recruit Officers, Shop**.

**Why:** Tools may not block or alter monetization or legally required content, in any way — including sneaky CSS tricks.

### 1.8 Paywalls, fees, and injected advertising

*   ❌ Charging money for the tool. ❌ Locking features behind a "premium" tier.
*   ❌ Requiring a paid third-party subscription (e.g. Patreon-only access).
*   ❌ Injecting your own ads into the game.

**Why:** All of the above are forbidden.

✅ **Allowed:** an optional donation button, or a link to `hero.li`.

### 1.9 Silent scraping of private data

*   ❌ Quietly collecting a user's private data — messages, exact fleet compositions, session tokens, precise activity times — and sending it to an external server or database **without the user's explicit, informed consent.**

**Why:** Covert exfiltration of private data is forbidden. If a feature sends _any_ data off the user's machine, the user must clearly know and agree, and (see §5) the tool very likely needs toleration.

---

## 2. If asked for something forbidden — say this kind of thing

Template for your reply to the developer (adapt, keep it plain):

> "I can't build that. OGame's rules forbid **[short reason, e.g. sending notifications for in-game events]**, and tools that do this are rejected by the review team. What I _can_ do instead is **[compliant alternative, or 'nothing — this whole idea isn't allowed']**. If you think there's an exception for your case, ask a ToolDev on the OGame Origin forum before we build it."

Do not bury the refusal in bullet points or hedge it. State it clearly, then move on to what _is_ possible.

---

## 3. Gray areas — build ONLY after the developer gets ToolDev approval

These are evaluated case-by-case by the Origin team and must be **explicitly approved by a ToolDev before publishing**. You may prototype them, but you must tell the developer, loudly, that approval is required first — and never let them imitate a premium feature in the process.

*   **Batching repetitive, non-tactical actions on the developer's _own_ planets** — e.g. queuing several shipyard or defense orders. This _may_ be allowed as a quality-of-life feature, but only with sign-off, and it must **not** imitate the Commander's building queue (§1.6).
*   **Pure comfort / convenience features** that touch the game UI or flow. Sometimes allowed, sometimes not — a ToolDev decides. Anything that shortcuts a core gameplay loop will _not_ be granted an exception.

When you implement one of these, add a comment like: `// GRAY AREA: requires ToolDev approval before publishing — see AGENTS.md §3` and repeat the warning in your reply.

---

## 4. Background calls and network discipline (easy to get wrong)

This section prevents the most common accidental violations. Read it even if the feature seems harmless.

**First, what "a background call" is here:** a request _your tool_ sends to the game server on its own (a `fetch`/XHR to a game endpoint), separate from a page the player loaded by clicking. Reading data that's _already on a page the player themselves opened_ is not a background call and isn't restricted by this section.

**What "activity" means in OGame:** activity is a signal other players can see. Whenever a player interacts with one of their own planets or moons, the game marks that position as recently active, and **other players see this in the galaxy view** — shown as a star for very recent activity, or a number counting the minutes since (up to about an hour). Attackers read it to judge whether a target is online right now. A background call to the game produces this same activity signal. So an ill-timed or repeated background call can broadcast that the player is online — or make them look online while they're actually away — which their normal play would not do at that moment.

With that in mind:

*   **OGame is not a single-page app.** Your tool can only make background calls while the player is genuinely active in the game with a page loaded — never in the background while they're logged out or away.
*   **Every background call produces activity — there is no activity-free one.** This is the whole reason the timing rules below exist.
*   **What is permitted:** background calls may fire **on page load** — that is, when the player navigates and a game page loads. They may **never** fire on a timer, a loop, a deferred schedule, or via auto-refresh, and never continuously once a page has finished loading. (Same point as §1.3.)
*   **What is strongly recommended (do this):** don't re-fetch on every page load. Instead, **hydrate all the data your tool needs once, at login**, and from then on **keep your state current by reading the DOM** as the player navigates normally. The pages the player opens already contain fresh data you can just read — and reading what's already on the page is not a background call and adds no activity. This is the lightest-footprint design and the one reviewers want to see; login is a natural moment for it because logging in already produces activity anyway.

### 4.1 The `accountInfo` endpoint — do not poll it

*   It is a **heavy, full-account snapshot** (officers, per-planet production, buffs, buildings/ships/defense per planet and moon, etc.).
*   Calling it **refreshes the highscore for everything across all planets at once**, which is a dead giveaway that the player is personally online and refreshing.
*   ❌ Never poll `accountInfo` to keep an external database or UI "fresh."
*   ✅ It already returns per-planet data for **all** planets in one response, so read it **once** and filter client-side. You do not need repeated calls to get cross-planet data.

### 4.2 The `cp` (change planet) parameter — never in background calls

*   `cp=<planetId>` means "change planet." It **mutates the session's active planet** — it is a real state change, not a read-time filter. A later call without `cp` returns whatever planet `cp` last set.
*   ❌ Never send `cp` in a background/automated call. Changing planets without a corresponding user click is a forbidden background state mutation.
*   ✅ For read-only needs, don't switch planets at all — use the single `accountInfo` response and filter client-side (see §4.1).

---

## 5. Does this tool even need toleration?

Tell the developer which case they're in.

**Needs toleration (must be submitted for review before publishing):**

*   Anything that runs on or inside the OGame page: browser extensions, userscripts, add-ons, injected UI.
*   Any external server/tool/database that receives, stores, or evaluates **live data scraped from the game** (galaxy databases, activity trackers, spy-report aggregators). _Both_ the scraping script and the receiving server get reviewed.
*   **Any auto-fill or scrape script** that pulls data from the game — even if it only feeds an otherwise-standalone calculator. The script itself needs toleration.

**Does NOT need toleration:**

*   Standalone calculators/simulators (web tool, spreadsheet, or desktop app) that use **only manually entered data** (e.g. the user pastes a report) **or data from the official OGame API** (§6).

**If it doesn't cleanly fit the "does not need toleration" case → assume it needs toleration** and tell the developer to submit it (or ask a ToolDev) before publishing. Do not publish browser extensions to extension stores before toleration is granted.

---

## 6. API and data access

*   **Use the community proxy for API calls. Do not hardcode or request a private API key.** Route calls through:

        https://ogapi.faw-kes.de/

    No permission is needed to use the proxy. Private keys are reserved for a few established tools with special needs and require a separate application — not relevant for a new tool.
*   **Public OGame API** (per universe; swap the `sX-XX` part for the target server; append `?toJson=1` for JSON instead of XML): `highscore.xml`, `players.xml`, `alliances.xml`, `universe.xml`, `serverData.xml`, `playerData.xml`, `localization.xml`, `universes.xml`, and the lobby-wide server list at `https://lobby.ogame.gameforge.com/api/servers`. These update on fixed schedules (hourly to weekly), so there is **no reason to poll them frequently** — cache the result and respect the update interval.
*   **Report/statistics endpoints and other non-public API** need the proxy (or, by exception, a private key) and the report's own API string from the in-game "API" button. Do not invent endpoints or credentials.

Entity ID ranges, endpoint quirks, and other deep game mechanics live in the Origin team's domain notes — if you need one and don't have it, ask the developer to get it from a ToolDev rather than guessing.

---

## 7. Before you say "done" — self-audit

Run this checklist and report the results to the developer. It maps to the compliance declaration every submission must sign.

*    **No automation:** every game action is triggered by one distinct user action (1 click = 1 action).
*    **No scheduling / delayed actions.**
*    **No auto-refresh** of the game page.
*    **No continuous polling loops, timers, or deferred calls.**
*    **Background calls fire only on page load** — never on a timer, loop, deferred schedule, or auto-refresh. (Recommended: hydrate once at login, then track changes from the DOM. Every background call produces galaxy-view activity.)
*    **No `accountInfo` polling; no `cp` in background calls.**
*    **No automatically registered alarms / notifications / webhooks / Discord pings** for in-game events. (Player-set, per-event notifications are fine.)
*    **No direct probing** attached to coordinate displays or custom target lists; new targets go through the game's galaxy-view probe flow. (Direct probe on an inbox spy-report overview is OK.)
*    **No alternative UI, drastic shortcuts, or lobby bypass.**
*    **No imitation of Dark Matter / premium features** (e.g. Commander queue).
*    **Monetization and legal content untouched** (ads, banners, footer, Merchant, Recruit Officers, Shop).
*    **No fees, paywalls, paid subscriptions, or injected ads.**
*    **No data leaves the user's machine without explicit, informed consent;** if any does, the tool is flagged as needing toleration.
*    **API calls go through the community proxy;** public API results are cached and not polled.
*    **Source is readable** — not minified or obfuscated — and compliance-relevant choices are commented.
*    **Gray-area features are flagged** as needing ToolDev approval before publishing.
*    **Toleration status is stated:** does this tool need to be submitted for review? (§5)

If any box can't be checked, say so plainly and tell the developer what to fix or who to ask.

---

## 8. Quick reference — common requests → verdict

| Developer asks for… | Verdict |
|---|---|
| "Auto-alarm me on Discord whenever I'm attacked" | ❌ Forbidden (§1.4) |
| "Automatically notify me when any building finishes" | ❌ Forbidden (§1.4) |
| "'Notify me' icon the player clicks on a fleet they just sent" | ✅ Allowed (§1.4) |
| "Auto-send my fleet at 2 AM" | ❌ Forbidden (§1.2) |
| "One button to spy every inactive player in this galaxy" | ❌ Forbidden (§1.1) |
| "Probe-now icon next to each coordinate in a player overview" | ❌ Forbidden (§1.5.1) |
| "Custom target list with a direct-probe button on each entry" | ❌ Forbidden (§1.5.1) |
| "Auto-find inactives from the API and let me direct-probe them" | ❌ Forbidden (§1.5.1) |
| "Show a player's full coordinate list (no probe button)" | ✅ Allowed (§1.5.1) |
| "Let me build and organize custom target lists (view only)" | ✅ Allowed (§1.5.1) |
| "Overview of the spy reports in my inbox, direct-probe on each" | ✅ Allowed (§1.5.1) |
| "Auto-refresh the game to keep me logged in / catch attacks" | ❌ Forbidden (§1.3) |
| "Poll the server every minute to update my galaxy database" | ❌ Forbidden (§1.3, §4) |
| "Add a slick building queue like the Commander's" | ❌ Forbidden (§1.6) |
| "Hide the shop button and ads to clean up the UI" | ❌ Forbidden (§1.7) |
| "Charge €3/month for premium features" | ❌ Forbidden (§1.8) |
| "Replace the whole game with my nicer interface" | ❌ Forbidden (§1.5) |
| "Log in directly and skip the lobby" | ❌ Forbidden (§1.5) |
| "Secretly send everyone's activity times to my server" | ❌ Forbidden (§1.9) |
| "Queue several defense orders on my own planet at once" | ⚠️ Gray — needs ToolDev approval (§3) |
| "Show a 'settings saved' confirmation" | ✅ Allowed (§1.4) |
| "Add a donation button / link to hero.li" | ✅ Allowed (§1.8) |
| "Calculator where I paste a report and it does the math" | ✅ Allowed, no toleration needed (§5) |
| "Read the public API once and show a highscore summary" | ✅ Allowed via proxy, cache it (§6) |

---

_When this file and a specific request seem to conflict, or a request isn't covered here, stop and tell the developer to ask a ToolDev on the OGame Origin forum before building. The full rules are the "Forbidden features," "Tool Submission Guidelines," and "API Access Process" threads on that forum._
