# SPYGLASS-PASSIVE-PLAN — galaxy watch + presence heatmap

Transient plan doc (delete when shipped; git keeps history). Two features, one
machine: **galaxy watch** collects presence samples without revealing the
observation (no probes = no espionage log entry on the target's side), the
**presence heatmap** turns those samples into "when is this player reliably
NOT playing" — the attack-window question.

> **Model revised 2026-07-07 (user feedback — the tri-state was overcomplicated).**
> Galaxy ACTIVITY is now ALWAYS on for every watched body (planet + moon) —
> passive/undetectable, nothing to gate. The only per-body/-player choice is
> whether to ALSO send probes: `scanMode` ('on'|'off', default 'on'), replacing
> the old `watchMode` ('probe'|'galaxy'|'off'). The dossier is ONE table with
> two always-present columns — **Scan** (probe freshness + an integrated on/off
> toggle, no separate action column) and **Activity** (galaxy last-active). The
> per-body re-scan ↻ was dropped (whole-player ↻ stays in the targets table).
> **Activity honesty fix:** the Activity column shows time since the last
> POSITIVE marker (`galaxyWatch.bodyActivityReadout`), never the look time — a
> quiet look (m=−1) means "inactive ≥1 h at that look", so it must not read as a
> small recent age; only-quiet rings show "no activity", and the dossier shows a
> player-level "last active (any body)" headline. The sections below predate this
> note where they still say `watchMode`/probe-vs-galaxy — read them through it.

## Why this works with what we already have

- `bridges/galaxyHook.js` already projects per-position activity (planet AND
  moon separately) from every galaxy system the player browses:
  `0` = "*" (<15 min), `15..60` = exact idle minute, `-1` = looked, no marker.
- `state/activityObs.js` already persists per-body rings (`{t, m}`, cap 48,
  45-day sweep) for watched players, with append-time honesty rules
  (self-induced discount, same-interaction dedup, quiet throttle). The `-1`
  quiet entries are the load-bearing negative evidence for both features.
- `domain/scanPriority.js` already ranks needs-scan bodies; the FAB proposes
  exactly `entries[0]`. Galaxy proposals slot into the same propose-top-1
  contract.

## Fair-play frame (hard limits, docs/fair-play.md)

- RED, never: timer-driven probe sends; auto-paging the galaxy; any background
  actor reading a "rescan-at" timestamp. Cadence marks are read IN-TAB for
  ranking/display only.
- GREEN, the whole design: passive capture of pages the user opens; 1 tap =
  1 navigation (precedent: sendLifeform's one-tap-per-system walk).
- Wording: never "due/scheduled/monitor/tracking/online". Use
  "stale / re-scan / watch / look / sighted". "Activity" means "someone
  interacted with the body", NOT "the player is online" — every presence
  surface must carry that caveat.

## Data contracts

### watchList (state/watchList.js, per-universe, local-only)

```
watchMode: Record<string, 'probe'|'galaxy'|'off'>
  key = playerId (player default) or bodyKey "g:s:p" / "g:s:p:3" (override).
  Absent = 'probe' (status quo). Same key shape as `rescan`.
cadence: { hotDays: 2, warmDays: 4, coldDays: 7, galaxyHours: 24 }
  Defaults literally today's constants; edited in the dashboard Spyglass
  config row; consumed by scanPriority (probe plan) and galaxyWatch (look plan).
```

Resolution (pure): body override ?? player default ?? 'probe'.
`'off'` removes a body from BOTH plans; passive ring capture continues
(mode gates proposals, not collection).

### domain/galaxyWatch.js (new, pure)

- `effectiveWatchMode(watchMode, pid, bodyKey)` → mode.
- `galaxySightStatus({ lastSightSec, nowMs, rescanAtMs, staleMs })` →
  `'none'|'fresh'|'stale'|'rescan'` — mirror of `scanStatus`, source = last
  ring entry time (any m, including -1). Ring lag ≤ ~60 min (quiet throttle /
  same-interaction dedup) — irrelevant at hour-scale cadence; min cadence 2 h.
- `buildGalaxyPlan(env)` → `{ entries: [{galaxy, system, bodies, worst,
  priority, why}] }` — galaxy-mode bodies grouped by system (one visit covers
  all watched bodies there), priority = max over member bodies of
  dangerWeight × stalenessWeight(galaxy cadence). Deterministic sort like
  buildScanPlan.

### domain/presence.js (new, pure) — the heatmap core

- `buildPresenceProbes(bodies, nowMs)` → chronological player-level samples
  `{ tSec, online: boolean }`: reuse routine.js's per-body event extraction
  (self-discount + dedup), then collapse per ~60-min bin: any interaction
  anywhere → online sample at τ; only quiet looks in the bin → offline sample.
- `buildPresenceGrid(probes, nowMs, { scale: 'week'|'day' })` → per cell
  (dow×hour or hour): weighted looks L, hits H (exp decay, half-life 21 d),
  `p = (H+α)/(L+α+β)` (α≈0.6, β≈2.4), `conf = 1 − e^(−L/3)`, hour-kernel
  [.25,.5,.25] smoothing on H and L before the divide; plus raw counts for
  honest tooltips ("N looks · M with activity").
- `pickOfflineWindow(grid, { minLen: 3 })` → best contiguous block where every
  cell has conf ≥ θc and p ≤ θp; returns span + pooled look count + one-off
  exceptions (down-weighted, still reported). No fabricated percentages — the
  UI shows the observed basis, gated none/hint/pattern/strong style.
- Scale choice: per-weekday peak divergence ⇒ 'week'; else 'day'; too little
  structure ⇒ 'occasional' (no grid claim — show raw recent looks only).

## Phases

1. **Model + passive value** — watchList fields; galaxyWatch domain;
   scanPriority takes cadence from env + filters mode='probe'; dossier: mode
   toggles (per body + player default), galaxy freshness line, cadence inputs
   in the Spyglass config row. After this phase probes stop being proposed for
   galaxy-mode bodies and normal galaxy browsing feeds freshness.
2. **Galaxy proposals in the FAB** — sendSpy pure+index: unified top-1 across
   both plans; galaxy tap = one navigation (in-page nav on galaxy component,
   URL elsewhere); self-advance via the `oge:galaxyScanned` ingest bumping
   freshness (no queue state, no session marker needed).
3. **Polish (DONE 2026-07-07)** — players-table Intel-column mode glyph
   (🔭 galaxy / ⊘ off / dimmed-🔭 mixed; probe stays quiet), via
   `domain/watchMode.aggregatePlayerMode`; dossier relocation hint (bodies with
   intel but absent from current universe.xml occupancy → "🚚 no longer here",
   guarded on occupancy being loaded); `docs/fair-play.md` rows — galaxy-watch
   mode + prefs GREEN, presence heatmap folded into the YELLOW-D routine-tracker
   consult (it's the sharpest form of "opponent activity over time", NOT shipped
   as GREEN); SPYGLASS-SYNC-PLAN merge rules for `watchMode` (per-key LWW +
   `watchModeGone` tombstones) and `cadence` (whole-object LWW).
4. **Presence heatmap** — domain/presence.js + dossier view: 7×24 / 1×24 CSS
   grid, hue = p(online) (blue→gray→red), alpha = coverage, framed offline
   window + basis line, scale auto-pick with manual override, "occasional"
   fallback. Entirely analysis of gathered data — no new collection.

## Fleet-landing "strike" signal (added 2026-07-07)

The aggressor's core tactic: catch a returning fleet-save that landed on a moon
while the owner is offline. `domain/fleetLanding.js` reads it off the SAME
passive activity rings: fires when exactly ONE of a watched player's bodies is
fresh-active, it's a **moon**, and ≥1 other body is recently-seen quiet.
Honesty gates: **coverage** (only bodies we looked at recently count as "quiet";
displayed, never over-claimed) and a **self-induced skip** (a moon we probed
ourselves isn't a landing). A hit → `scanPriority.STRIKE_BOOST` forces that moon
to the top of the probe plan (past the scan-bodies filter + freshness gate, but
respecting scan-'off'), so the FAB proposes spying it first (hot "Strike" paint,
`BG_SPY_STRIKE`); dashboard flags it (🎯 targets-row marker + dossier banner).
It's a CANDIDATE ("possible fresh fleet — spy to confirm"), never auto-sent —
the confirming probe is one tap. Flag surface: dashboard + FAB only (no in-game
galaxy highlight — that'd be YELLOW-C; user chose to keep it off). Reverse-eng
knowledge in `docs/ogame-fleet-mechanics.md`. Smoke-verified (scratchpad
landing-smoke.mjs: signature, moon-only, coverage gate, self-induced skip,
confidence tiers).

## Deliberate decisions

- One FAB, one unified "best next intel action" — no second button.
- Cadences global per mode (per-body stays mode + ↻ only). YAGNI on per-body
  intervals.
- Single one-off logins in a cold window are DOWN-WEIGHTED but visibly noted
  next to the recommended window (cost asymmetry: a missed window is cheap, an
  ambush during a "once in 7 days" login is not).
- windowBonus (YELLOW-D) untouched — presence must not grow into a nudge;
  it renders in the dashboard only.
- Tests deferred to release per CLAUDE.md workflow; pure cores designed for
  fixture tests (no DOM, no Date.now inside the math).
