# Spyglass gist-sync — plan (targets 1.40)

Transient plan doc (delete when the cycle closes; git keeps history). Records the
design **decided 2026-07-06**, not yet implemented.

## Goal

Sync the Spyglass **workbench decisions** across devices: the watchlist and each
watched player's relationship tag. Today both are `LOCAL ONLY` (see
`state/watchList.js` header) — you must re-star / re-tag on every device.

## Scope (decided)

| State | Sync? |
|---|---|
| Watchlist player ids | **yes** |
| Relationship tags (enemy/friend/neutral) | **yes** |
| Probes count (`{players, probes}`) | **no** — per-device FAB convenience, stays local |
| `targetReports` (opened spy reports) | **no** — heavy (`{latest,history}`/body); gist-size risk (cf. the 2.6 MB scans lesson) |
| `allianceClass` map | **no** — small but re-derivable by opening the ranking; marginal |
| `activityObs`, proximity reports | **no** — device-local, re-observable |

## Merge (decided): last-write-wins + tombstones

Today the store is `{ players: string[], probes: number }` with **no timestamps
and no merge** (its header literally says "no `Ts` key and no merge"). To sync we
add per-item timestamps so an **un-watch on device A propagates** instead of being
resurrected by a union.

Proposed synced shape (per universe):

```jsonc
{
  "watched":       { "<id>": { "ts": 1720000000000 } },   // added/re-added at ts
  "tombstones":    { "<id>": { "ts": 1720000100000 } },   // removed at ts
  "relationships": { "<id>": { "rel": "enemy", "ts": 1720000050000 } }
}
```

Merge rule (pure, per id): the **newest ts wins** across devices AND across
`watched` vs `tombstones` — a later removal beats an earlier add and vice-versa.
Relationship: newest ts per id wins. A relationship for a tombstoned id is kept
(harmless; re-watching restores the tag).

## Mechanism

- **Per-universe gist file** `oge-spyglass-<universeId>.json` — mirrors the
  alarmClock per-universe files; this is what structurally avoids the C6
  "silent multi-universe wipe" class from the sync audit (never one blob for all
  universes).
- Wire into the existing `sync/gist.js` + scheduler: upload on change (debounced)
  **and** an on-install catch-up (the decisions were stranded once before by a
  post-send reload killing the debounce — same fix as colonizeDecisions).
- Additive merge only — never wholesale-overwrite a remote file (sync-audit rule).

## Implementation steps

1. **`domain/watchListMerge.js` (pure, NEW)** — the LWW+tombstone merge of two
   synced shapes → one. Unit-tested: add-vs-remove ordering, cross-device union,
   relationship LWW, tombstone GC (drop tombstones older than N days so the file
   can't grow forever).
2. **`state/watchList.js`** — migrate `{players[], probes}` → the timestamped
   shape; tolerate BOTH on read (like `targetReports` `{latest,history}`). Writes
   stamp `ts`. Drop the "LOCAL ONLY" header note. **First-sync safety:** seed
   existing local ids with `ts = now` so the initial merge PRESERVES them (never
   wipe a device's list); tombstones start empty.
3. **`sync/gist.js` + scheduler** — register the new per-universe file: fetch,
   merge (via the pure fn), write-back; upload on the watchlist store's change +
   on-install catch-up.
4. **`features/dashboard/syncInventory.js`** — add `oge_watchList` (or the new
   base) so the dashboard's sync inventory shows it.
5. **Tests** — pure merge (domain), state migration + round-trip, and a
   behavioural gist merge (two device blobs → expected union) per the sync test
   discipline.

## Risks / notes

- **Clock skew** — LWW uses wall-clock `ts`; acceptable for low-frequency
  decisions, but note it (a badly-skewed device could lose a recent change).
- **First sync must not wipe** — covered by seeding local ids with `ts = now` +
  additive merge; add a test that pins it.
- **Tombstone growth** — GC by age in the merge fn (step 1).
- Version: user-visible new sync capability → **1.40.0** (minor).
