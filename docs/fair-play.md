# OG-E fair-play & toleration classification

> **The source of truth is the OGame Origin ToolDev team's own guardrail,
> [`AGENTS.md`](../AGENTS.md)** (vendored verbatim from
> `github.com/Rivenscryr/origin-tooldev-agents`). This document is *not* a
> parallel rulebook — it only records **how OG-E maps onto that guardrail**, plus
> a short list of OG-E's **own, stricter** internal rules. Where this file and
> `AGENTS.md` ever seem to conflict, `AGENTS.md` wins.
>
> Canonical compliance doc (DRY: the forum submission and
> `amo-reviewer-notes.txt` link here instead of restating it).

## Cross-check against `AGENTS.md`

OG-E was audited against **every** rule in `AGENTS.md`; the mapping is clean.

| `AGENTS.md` rule | OG-E status |
|---|---|
| §1.1 Automation / macros (1 click = 1 action) | Structural invariant — every fleet/action button is strictly 1:1; no multi-target / "spy-all" button exists. |
| §1.2 Scheduling / delayed **game** actions | No timer fires a game action. |
| §1.3 Auto-refresh / polling the game | No timer reloads the game or polls the game server. The one `location.reload` (`features/abandon`) is a one-shot settle after the player's own 3-tap abandon, not a loop. |
| §1.4 Auto-registered alarms / webhooks | No auto-registered alarm on in-game events. The alarm-clock push is a **player-set, per-instance reminder** (§1.4's allowed case) whose fire time is derived from the player's own action; it is **presence-gated** so OG-E never tracks the game while the player is away. Grep-verified zero `Notification` / `chrome.notifications` / `document.title` / favicon / audio. |
| §1.5 Alt UI / shortcuts / lobby bypass | None. Two redirect bridges rewrite only the game's own **response** navigation target (a URL the player could type), never a request. |
| §1.5.1 Direct probing (`miniFleet` / `sendFleet`) | **Zero `miniFleet`; OG-E never originates a `sendFleet`.** The Spyglass `sendSpy` button is 1 tap → pre-fill + one native dispatch for **one** planet. The dashboard scan surfaces are **display only** and carry **no send control** — data display is deliberately separated from the probe action, exactly the `AGENTS.md` model. |
| §1.6 Dark Matter imitation | No Commander-queue imitation, no premium-feature rebuild. |
| §1.7 Blocking / altering monetization | No hide / opacity / off-screen / image-swap of any ad, banner, Merchant, Officers, Shop, or footer; OG-E's menu highlights are purely *additive*. |
| §1.8 Paywalls / fees / injected ads | Free, open-source, no injected ads. |
| §1.9 Silent scraping | Only opt-in, token-configured egress (GitHub gist, ntfy); documented in `PRIVACY.md`. No covert exfiltration. |
| §4 Background calls fire only on page load | `apiContext` hydrates on load with a TTL cache, then reads the DOM as the player navigates — the exact "hydrate once, read the DOM" pattern §4 recommends. |
| §4.1 `accountInfo` polling | **Zero uses of `accountInfo` anywhere.** |
| §4.2 `cp` in background calls | `cp` is only ever **read** from the current URL for navigation; never injected into a background fetch. |
| §5 Toleration needed? | Yes (a browser extension running in the game page) — correctly self-assessed as needing toleration. |
| §6 API / community proxy | Only the public `/api/*.xml` files (which §6 permits **directly** per-universe), `credentials:'omit'`, TTL-cached — never polled. No non-public/report endpoint is touched. |

## OG-E's three structural invariants (each verified in the audit)

- **Never originates or modifies a game *request*.** The MAIN-world bridges only
  **observe** the game's own XHRs and re-emit them as internal `oge:*` DOM
  events; the one `.send()` in the bridge tree is the native call forwarded
  verbatim (`bridges/xhrObserver.js`). *(Nuance: two redirect bridges rewrite the
  game's own **response** `redirectUrl` — a navigation target, not a request.)*
- **One user click → at most one game request.** Every fleet/action button is
  strictly 1:1; multi-step flows are multi-**tap**, never one-tap-many-sends.
- **No background watching of the game.** No timer reloads the game page, no code
  reads the event list to alert about **hostile** fleets off-tab, no audio, no
  `document.title` / favicon mutation, no desktop `Notification`.

## OG-E's own, stricter internal rules (kept because they proved correct)

These go **beyond** what `AGENTS.md` requires — they only ever tighten the screw:

- **Presence-gating for the alarm clock.** The player-set reminder push is only
  ever armed while the player is present; OG-E never watches the game on their
  behalf while they are away. (More restrictive than §1.4, which permits
  player-set per-instance notifications outright.)
- **Wording never implies away-monitoring.** User-facing copy for the alarm clock
  says the player *sets* a reminder that *rings*; it never says OG-E "watches",
  "tracks", "monitors", or "fires on a timer". The appearance of an away-monitor
  is treated as a risk in itself, so the vocabulary stays on the player-set side.
- **Display is separated from the probe action.** The Spyglass dashboard shows
  intel (built only from reports the player opened + the public API read while a
  tab is open) but has **no** send/"send-all" control, and must never grow one —
  new probe targets always go through the game's own galaxy-view flow (§1.5.1).
- **Truth-in-wording on redirects.** OG-E never originates or modifies a game
  *request*; it rewrites only the *navigation target* of the game's own
  *response*. Docs state it that precise way rather than the looser "never touches
  a request".

## What OG-E never does (all grep-verified)

- No origination or modification of a game **request** (only response
  *navigation-target* rewrite in two bridges).
- No automatic page refresh / meta-refresh / reload-on-timer.
- No audio (`new Audio` / `.play()` / `AudioContext` — zero occurrences).
- No `document.title` / favicon mutation.
- No browser/desktop `Notification` / `chrome.notifications`.
- No reading of the event list to alert about **hostile** fleets off-tab.
- No hiding / obscuring / resizing / opacity / off-screen of any OGame banner, ad
  bar, premium/Dark-Matter content, Merchant/Officers/Shop, menu item, or footer.
- No Dark-Matter feature imitation.
- No telemetry/analytics; the only outbound hosts are the game's public API
  (read-only), the user's GitHub gist (opt-in), and ntfy.sh (opt-in).
