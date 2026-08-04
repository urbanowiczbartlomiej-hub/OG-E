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
| §1.5 Alt UI / shortcuts / lobby bypass | None. Two redirect bridges rewrite only the game's own **response** navigation target (a URL the player could type). The ajax-token keeper repairs a variable the game itself failed to update, and corrects the same spent credential in an outgoing `checkTarget` when a sender replays one — a broken credential fixed, not a shortcut; a page reload achieves the same by hand. |
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

- **Never originates a game *request*, and modifies exactly one FIELD of one.**
  The MAIN-world bridges only **observe** the game's own XHRs and re-emit them as
  internal `oge:*` DOM events; the one `.send()` in the bridge tree is the native
  call forwarded verbatim (`bridges/xhrObserver.js`). The request count leaving
  the browser is always exactly what the page decided on. *(Three nuances, all
  narrow and documented: two redirect bridges rewrite the game's own **response**
  `redirectUrl` — a navigation target, not a request;
  `bridges/ajaxTokenKeeper.js` writes the server's freshest ajax token into the
  page's **own variables**; and that same keeper corrects the spent `token` field
  of an outgoing `checkTarget` when some sender replays one — a session
  credential, never a game input, never on `sendFleet`. See below.)*
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

**The main path touches no request.** The keeper writes the fresh token into the
page's own variables — `window.token` (what the game's `appendTokenParams()`
reads), the stale-by-design `fleetDispatcher.token`, the hidden `token` inputs —
i.e. it finishes the job the game's own `updateToken()` was interrupted doing.
The game then builds its requests exactly as it always did.

**The carve-out: one request FIELD, since 2026-07-29.** There is a second half
that substitutes a provably spent `token` inside an outgoing `checkTarget` body,
for the case where a sender keeps a PRIVATE copy that no amount of repairing
shared state can reach. It shipped **disabled** while the evidence said that case
did not occur here; the 2026-07-29 capture on s163-pl proved it does — the game's
own `checkTarget` spent `948c4f…` at +185 ms, and a third-party serialiser
(`am203,…,union,token`, token appended last — not the game's field order, not
ours) replayed the same value at +3257 ms and was refused. Three seconds is not a
race: nothing but the request itself was left to correct. So
`NORMALISE_OUTGOING` is now `true`, and **this is the one place OG-E edits a
field of a game request** rather than only reading it.

Why it stays inside `AGENTS.md`'s Allowed bucket:

- **It is a credential, not a game input.** `galaxy` / `system` / `position` /
  `type` / `union` / the ships — everything that expresses player INTENT — is
  passed through untouched. The one field corrected is the session's rotating
  anti-replay token, and it is corrected to the value **the server itself issued
  to this tab seconds earlier**.
- **No advantage, no automation.** The request count is unchanged (§1.3), no
  action is taken for the player (§1.1), nothing is scheduled (§1.2). The
  player's alternative today is to reload the page — which produces the same
  fresh token by hand. The keeper only spares them the reload (§1.5).
- **Scoped to the endpoint that spends the token.** `checkTarget` only — never
  `sendFleet`, so no repair can ever be part of a fleet leaving. Worst case is a
  re-validated target.
- **It can only move the token FORWARD.** It refuses a token whose provenance it
  cannot vouch for, and refuses to write a value that is not provably LATER in
  the observed issue sequence than the one being sent, so a keeper that has
  fallen behind declines instead of guessing.
- **It gives up rather than persist.** Three repaired-yet-refused requests and
  the substitution disarms itself for the rest of the page's life; `__ogeToken()`
  reports the counters and a masked decision trail for exactly this audit.

This is the point flagged earlier as **worth a ToolDev sign-off**, and that flag
stands: the classification above is OG-E's own reading, not an approval.

## Home watch, the huddled filter, the homeworld tag — classification (all GREEN)

Three 1.56 additions, sorted into `AGENTS.md`'s buckets before any code was
written:

- **Home watch** (`domain/homeWatch.js`, `features/homeWatch/`) — **Allowed**
  (§1.5.1 galaxy-view intel, §1.2 display). It proposes the player's OWN systems
  as ordinary Look targets and, when the player browses one, diffs the occupants
  against what the previous browse recorded. Every part of that is already in the
  Allowed set: the observation IS the player's own galaxy view (no request is
  originated — the count leaving the browser is unchanged), the diff is arithmetic
  over `state/scans`, and the output is display.
  The rule it must not trip is the third structural invariant, **no background
  watching of the game** — so, deliberately: no timer looks anything up, nothing
  reloads a page, the alert is a card on the dashboard plus the wording on the Spy
  FAB's own Look face, and there is no desktop notification, no push, no sound,
  and no off-tab hostile-fleet read. A player who never opens the game is never
  told anything. The feature is defensive-only and never proposes an attack.
- **Huddled ("miners") filter** (`domain/dangerScore.isMinerProfile`) — **Allowed**
  (§1.2). It is one boolean over geometry OG-E already computes from the public
  API's own `universe.xml`, used to filter a list the player is looking at. No new
  data source, no request, no automation.
- **Homeworld tag** (`domain/targets.playerPlanets`) — **Allowed** (§1.2). Reads
  the `id` attribute already present on each `<planet>` row of the public
  `universe.xml` and marks the lowest one. An inference over a published feed,
  rendered as a label; nothing is collected that the feed does not publish.

## What OG-E never does (all grep-verified)

- No origination of a game **request**, and no modification of one beyond the
  response *navigation-target* rewrite in two bridges plus the ajax-token
  keeper's single `checkTarget` **credential** field — above. No game input
  (target, mission, ships, resources) is ever rewritten anywhere.
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
