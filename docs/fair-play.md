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
| §1.5 Alt UI / shortcuts / lobby bypass | None. Two redirect bridges rewrite only the game's own **response** navigation target (a URL the player could type). The ajax-token keeper repairs a variable the game itself failed to update — a broken credential corrected, not a shortcut, and not a request. |
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
  verbatim (`bridges/xhrObserver.js`). The request count leaving the browser is
  always exactly what the page decided on. *(Two nuances, both narrow and
  documented: two redirect bridges rewrite the game's own **response**
  `redirectUrl` — a navigation target, not a request; and
  `bridges/ajaxTokenKeeper.js` writes the server's freshest ajax token into the
  page's **own variables** — see below. Neither touches an outgoing request.)*
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

## The ajax-token keeper — classification (GREEN, with one honest carve-out)

`bridges/ajaxTokenKeeper.js` exists because of a **game** bug, not a feature
wish: since 13.0 every `checkTarget` spends the session's single ajax token, and
the game applies the rotation at the very end of a long DOM-refresh callback —
one exception there and the page keeps sending a retired token until a reload,
refusing the player's every further target check
([mechanics](ogame-fleet-mechanics.md#the-ajax-token--one-rotating-value-per-session-130)).

Verdict per `AGENTS.md`: **Allowed.** Nothing in §1 or §4 is engaged —

| Concern | Why it does not apply |
| --- | --- |
| §1.1 automation / macros | No action is taken on the player's behalf. One tap still equals one action. |
| §1.2 scheduling | No timer, no queue, no deferred action. |
| §1.3 auto-refresh / polling | **Zero requests added.** Every request it touches was already going out. |
| §1.5 shortcut / advantage | None. A page reload produces the same fresh token by hand; the keeper only spares the player the reload. |
| §6 / §4 background calls | Not a network client — it never opens a connection of its own. |

**What ships touches no request.** The keeper writes the fresh token into the
page's own variables — `window.token` (what the game's `appendTokenParams()`
reads), the stale-by-design `fleetDispatcher.token`, the hidden `token` inputs —
i.e. it finishes the job the game's own `updateToken()` was interrupted doing.
The game then builds its requests exactly as it always did, and OG-E's
"never originates **or modifies** a game request" invariant stands unchanged.

There **is** a dormant second half, and it is written down rather than hidden: a
`checkTarget`-only substitution of a provably spent `token` inside an outgoing
body, for the case where some sender keeps a PRIVATE copy that no amount of
repairing shared state can reach. It ships **disabled** (`NORMALISE_OUTGOING =
false`) because the verification run settled the question — repairing the page's
variables alone made the refusal disappear (`repairs: 5`, `rewrites: 0`), which
means the third party reads the page's token rather than caching it. The
detection counter (`staleOutgoing`) stays live, so the day a private cache does
appear it shows up in `__ogeToken()` instead of being guessed at. If it is ever
enabled it stays scoped to the one endpoint that spends the token (never
`sendFleet`, so no repair can be part of a fleet leaving), only ever writes a
value the server itself issued this session, refuses tokens whose provenance it
cannot vouch for, and disarms itself permanently if a request it repaired is
refused anyway — and enabling it is the point at which a ToolDev sign-off is
worth asking for, since it would be the first time OG-E edits a request field.

## What OG-E never does (all grep-verified)

- No origination or modification of a game **request** (only the response
  *navigation-target* rewrite in two bridges; the ajax-token keeper writes the
  page's own variables, and its request-side half ships disabled — above).
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
