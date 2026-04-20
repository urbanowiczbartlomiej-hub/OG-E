# OG-E — Storage Schemas & Cross-World Events

Single source of truth for OG-E's persisted data shapes and cross-script event
payloads. JSDoc in source files refers back here via `@see SCHEMAS.md`.

**Schema versions:**
- `oge_scansSchemaVersion`: **2** (local chrome.storage scans shape)
- Gist payload: **3** (gzip+base64 encoded; introduced 4.9.0)

**Last updated:** 4.9.6.

---

## Architecture context

OG-E persists data in two places and exchanges runtime data over three custom
DOM events.

| Storage | Where | What |
|---|---|---|
| `chrome.storage.local` | extension storage (large, async) | observed game data — galaxy scans, colony history, in-flight colonization registry, cross-context tombstones |
| `localStorage` | origin `ogame.gameforge.com` (small, sync) | settings, button positions, sync configuration, transient UI state |

Cross-context note: histogram (extension origin) cannot read game-origin
localStorage. Settings keys that must be visible on both sides are mirrored to
`chrome.storage.local` (currently `oge_colPositions`).

---

## chrome.storage.local

### `oge_galaxyScans`

Galaxy observation database. Built from passive XHR observation of game's
`fetchGalaxyContent` responses (see `colonize.js`).

```ts
type GalaxyScans = Record<SystemKey, SystemScan>;

type SystemKey = `${number}:${number}`;          // "galaxy:system" e.g. "4:30"

type SystemScan = {
  scannedAt: number;                              // ms timestamp of latest write
  positions: Record<PositionId, Position>;        // 1..15
};

type PositionId = 1 | 2 | ... | 15;

type Position = {
  status: PositionStatus;
  player?: { id: number; name: string };          // omitted for empty/abandoned/mine
  flags?: PositionFlags;
};

type PositionStatus =
  | 'empty'           // no live planet, slot is colonizable
  | 'empty_sent'      // OUR fleet in flight to this slot (4h re-scan)
  | 'mine'            // our colony
  | 'occupied'        // active player
  | 'inactive'        // i flag (7-28 days inactive)
  | 'long_inactive'   // I flag (28+ days inactive)
  | 'vacation'
  | 'banned'
  | 'admin'           // Game Administrator (untouchable)
  | 'abandoned'       // destroyed-planet remains (debris); not yet colonizable
  | 'reserved';       // another player reserved the slot for planet-move (DM-paid); temporarily not colonizable

type PositionFlags = {
  hasAbandonedPlanet?: true;   // destroyed planet present (independent of status)
  hasMoon?: true;
  hasDebris?: true;
  inAlliance?: true;           // player has allyId
};
```

**Re-scan policy** (`mobile.js:RESCAN_AFTER`):

| status | re-scan after | rationale |
|---|---|---|
| `empty`, `mine`, `admin` | never | stable |
| `empty_sent` | 4h | our fleet should land — verify outcome |
| `abandoned` | **dynamic (25-47h)** | see below — cleanup deadline formula |
| `reserved` | 24h | planet-move reservation cooldown is ~22h |
| `inactive`, `long_inactive` | 5d | inactivity flag may flip |
| `occupied`, `vacation`, `banned` | 30d | rare changes |

**`abandoned` dynamic deadline** (`mobile.js:abandonedCleanupDeadline`):
game sweeps at **3 AM server time** each day, deleting abandoned planets
whose 24h grace has expired. Deadline = first 3 AM **after** `scannedAt + 24h`.
Yields 25-47h variable wait (avg ~36h) depending on what time of day the
observation was taken — always just enough, never more. Assumes browser
local TZ matches server TZ (true for PL users on PL server).

A system is "stale" iff any of its positions has a `status` whose threshold has
elapsed since `scannedAt`.

**Merge policy** (`content.js` `oge:galaxyScanned` handler):
- Per-position merge — fresh scan wins for everything observable in-game
- EXCEPT: preserve old `empty_sent` iff fresh status is `empty` AND
  `oge_colonizationRegistry` confirms our fleet still in flight (game cannot
  see our pending mission, so we must keep our marker)

---

### `oge_colonyHistory`

**Purpose: a STATISTICAL DATASET of planet sizes as they appear at first
colonization**, not a list of the user's currently-held colonies. Used by
`histogram.js` to show the distribution of possible sizes on the user's
target positions (e.g. "what fields range does the game spawn on position 8?").

Records are created by `content.js:collectColonyData` on overview pages when
`usedFields == 0` (first visit to a freshly colonized planet). Deduped by
`cp` — CP ids are globally iterative across all game servers, so collisions
do not happen in practice.

**Abandoned planets are intentionally kept.** The small ones are the most
important statistical evidence — users who colonize-then-abandon when a
planet is too small would lose the left tail of the distribution if
abandoned entries were pruned (this was the bug fixed in 4.8.3).

```ts
type ColonyHistory = ColonyEntry[];

type ColonyEntry = {
  cp: number;                  // game's planet ID (cp param). Globally iterative.
  fields: number;              // max fields — size of the planet (stable)
  coords: string;              // "[g:s:p]"
  position: number;            // 1..15
  timestamp: number;           // first observed (ms)
};
```

Synced to gist (see `sync.js:mergeHistory`, dedup by `cp`). Entries whose
`cp` appears in `oge_deletedColonies` (see below) are filtered out on read
and skipped during merge — this is how soft-deleted rows stay deleted across
devices instead of being re-added by another device's pending upload.

---

### `oge_deletedColonies`

Soft-delete tombstone list for `oge_colonyHistory`. Union-merged across
devices so a delete on one device propagates permanently to all (without
this, merge's union semantics would let another device's pending upload
re-introduce the row).

```ts
type DeletedColonies = number[];   // cp values
```

Lifecycle:
- **Added to**: user manipulates directly (DevTools console snippet on the
  histogram page). The companion write to `oge_colonyHistory` (filter out
  the matching row) triggers `storage.onChanged`, which `sync.js` propagates
  to the gist as both the shorter colonyHistory AND the extended
  deletedColonies.
- **Merged**: `mergeDeleted(local, remote) = union`, `{merged, changed}`.
  Propagates across devices via gist.
- **Never pruned automatically** — list grows monotonically. Realistic size
  is dozens of entries per account (one per manually-removed bad observation);
  trivial storage footprint. If ever a concern, add a UI "Reset deleted
  colonies" button (clears the array).

Synced to gist (see `sync.js:mergeDeleted`).

---

### `oge_colPositions` (mirrored from localStorage)

Mirrored by `settings.js` because histogram (extension origin) cannot read
ogame.gameforge.com localStorage directly.

```ts
type ColPositionsString = string;
// e.g. "8" or "8,9,7" or "1,3-5,8"
// Parsed by mobile.js:parsePositions into ordered, deduped array of 1..15 ints.
```

---

### Tombstones

Cross-context one-shot triggers — written in one execution context, observed
via `storage.onChanged` in another, then cleared.

```ts
type Tombstone = number;       // ms timestamp; consumers compare against last-handled
```

| key | written by | consumed by | meaning |
|---|---|---|---|
| `oge_clearRemoteAt` | histogram.js (Clear scan data) and mobile.js (schema migration) | sync.js → `clearGistScans` | wipe gist scans (merge alone can't tell "user cleared" from "device hasn't seen this") |
| `oge_syncRequestAt` | histogram.js (Refresh button) | sync.js → `downloadAndMerge` + `upload` | force a full bidirectional sync |

---

## localStorage (origin: ogame.gameforge.com)

All values stored as strings (localStorage convention). Helpers in
`mobile.js:safeLS` do typed get/set with try/catch baked in.

### Feature toggles

| key | type | default | meaning |
|---|---|---|---|
| `oge_mobileMode` | bool | false | Show floating Send Exp button |
| `oge_colonizeMode` | bool | false | Show floating Send Col button + scan-and-send flow |
| `oge_expeditionBadges` | bool | true | Show expedition-in-flight dots on planet list |
| `oge_autoRedirectExpedition` | bool | true | Rewrite `redirectUrl` after expedition send to next planet without an expedition |
| `oge_cloudSync` | bool | false | Enable GitHub Gist sync |

### Button sizing & positions

| key | type | default | meaning |
|---|---|---|---|
| `oge_enterBtnSize` | int (px) | 560 | Send Exp button diameter |
| `oge_colBtnSize` | int (px) | 336 | Send Col button diameter |
| `oge_enterBtnPos` | JSON `{x, y}` | none | Drag-saved position |
| `oge_colBtnPos` | JSON `{x, y}` | none | Drag-saved position |
| `oge_focusedBtn` | string | none | ID of last keyboard-focused floating button |

### Colonization configuration

| key | type | default | meaning |
|---|---|---|---|
| `oge_colPositions` | string | "8" | Required target positions for Send Col (e.g. "8,9,7" or "1,3-5") |
| `oge_colPreferOtherGalaxies` | bool | false | Deprioritize home galaxy in `findNextColonizeTarget`; neighbour galaxies first. Trade-off: slower same-galaxy sends but more predictable min-gap timing (cross-galaxy flights are ~uniform duration). |
| `oge_colMinGap` | int (sec) | 20 | Min gap between colonization arrivals |
| `oge_colMinFields` | int | 200 | Abandon threshold for too-small colonies |
| `oge_colPassword` | string | "" | OGame password (autofilled into abandon form) |
| `oge_maxExpPerPlanet` | int | 1 | Expedition limit per planet |

### Sync configuration

| key | type | default | meaning |
|---|---|---|---|
| `oge_gistToken` | string | "" | GitHub PAT (gist scope only) |
| `oge_gistId` | string | "" | Auto-discovered/created gist ID |
| `oge_lastSyncAt` | ISO string | "" | Last successful upload timestamp |
| `oge_lastDownAt` | ISO string | "" | Last successful download timestamp |
| `oge_lastSyncErr` | string | "" | Last sync error message (cleared on success) |

### In-flight colonization registry

```ts
type ColonizationRegistry = ColonizationEntry[];

type ColonizationEntry = {
  coords: `${number}:${number}:${number}`;   // "galaxy:system:position"
  sentAt: number;                             // ms — Date.now() immediately before nativeSend
  arrivalAt: number;                          // sentAt + parseDurationSeconds(#durationOneWay)*1000
};
```

Stored under key `oge_colonizationRegistry` (JSON-encoded array).

**Drives the min-gap timer** and is cross-checked by `findNextColonizeTarget`
(`inFlight` set) to prevent double-send. `content.js:oge:galaxyScanned` also
reads it to preserve `empty_sent` across scan merges.

**Lifecycle** (writer: `fleet-redirect.js` MAIN world; readers: `mobile.js`
and `content.js`, both synchronous):

- **Pre-register** synchronously in `XMLHttpRequest.prototype.send()` hook
  BEFORE `nativeSend`. This is the whole point of hosting the registry in
  localStorage — `chrome.storage.local.set` is async and on mobile its
  callback was racing (and losing) against the game's
  `location.href = redirectUrl` that follows the response. `localStorage`
  is synchronous — the write is committed in the same JS tick, guaranteed
  to survive the imminent navigation.
- **Auto-prune** on every write: drop entries with `arrivalAt <= Date.now()`.
- **Skip insert** when `arrivalAt === 0` (duration parse failed → no value
  for min-gap; storing just adds noise).
- **Dedup**: skip if an entry with identical `coords` AND `sentAt±2s` already
  exists.
- If `nativeSend` throws synchronously (very rare — most send failures
  arrive as error events, not sync throws) the entry stays as a ghost.
  Auto-prune cleans it up once `arrivalAt` elapses. Worst case: one false
  min-gap block in a ~20s window.

**NOT synced** to gist — local per-device, regenerated naturally by sending
missions. Migrated from `chrome.storage.local` → localStorage in 4.8.5.

### Transient state

| key | type | meaning |
|---|---|---|
| `oge_pendingColVerify` | JSON `{galaxy, system, position, ts}` | Set when Send Col redirects via `pendingColLink`; consumed by `oge:checkTargetResult` handler. 5-min TTL. |
| `oge_scansSchemaVersion` | int | Migration marker. Currently 2. Mismatch on boot triggers wipe + remote clear. |
| `oge_registryMigrated485` | bool | One-shot marker for the 4.8.5 registry migration (chrome.storage → localStorage). |
| `oge_expandedGalaxies` | JSON array | Histogram accordion expanded-state |
| `oge_debugMinGap` | bool | When `'true'`, `mobile.js:getColonizeWaitTime` logs a full diagnostic dump via `console.debug('[OG-E min-gap]', ...)` on every Send-button click (durations, registry pending entries, gaps, conflicts, resulting wait). Set via DevTools console to diagnose "why didn't min-gap block?". |

---

## Custom DOM Events

All events are dispatched on `document` and listened by `document.addEventListener`.
Cross-world communication: MAIN-world scripts (`colonize.js`, `fleet-redirect.js`)
dispatch; isolated-world scripts (`mobile.js`, `content.js`) listen.

### `oge:galaxyScanned`

**Dispatched by:** `colonize.js` after observing `fetchGalaxyContent` response.
**Listened by:** `mobile.js` (UI updates — Send Col button label), `content.js` (storage merge into `oge_galaxyScans`).

```ts
type GalaxyScannedDetail = {
  galaxy: number;
  system: number;
  scannedAt: number;                              // ms
  positions: Record<PositionId, Position>;        // see oge_galaxyScans
  canColonize: boolean;                           // does our active planet have a colony ship right now
};
```

### `oge:checkTargetResult`

**Dispatched by:** `colonize.js` after observing `checkTarget` XHR response.
**Listened by:** `mobile.js` for stale-target detection on fleetdispatch (Send Col flow).

```ts
type CheckTargetResultDetail = {
  galaxy: number;
  system: number;
  position: number;
  success: boolean;                               // data.status === 'success'
  targetOk: boolean;                              // game's overall ok flag
  targetInhabited: boolean;
  targetPlayerId: number;                         // 0 if uninhabited
  targetPlayerName: string;
  orders: Record<string, boolean>;                // per-mission availability; orders['7'] === colonize
  errorCodes: number[];                           // game errors[].error codes; 140016 = "reserved for planet-move"
};
```

Fires for both success AND failure responses (4.9.2+). `mobile.js` uses
`errorCodes` to distinguish `reserved` slots (code 140016) from generic
stale outcomes.

### `oge:colonizeSent`

**Dispatched by:** `fleet-redirect.js` after observing successful `sendFleet` response with `mission=7`.
Listener uses `{ once: true }` defensively against XHR object reuse.
**Listened by:** `content.js` to update position status to `empty_sent` and append a registry entry.

```ts
type ColonizeSentDetail = {
  galaxy: number;
  system: number;
  position: number;        // 0 if URL had no position param (rare edge case)
  sentAt: number;          // ms — Date.now() captured BEFORE nativeSend
  arrivalAt: number;       // sentAt + parseDurationSeconds(#durationOneWay)*1000; 0 if parse failed
};
```

### `oge:syncForce`

**Dispatched by:** `settings.js` when user clicks "Sync now" button.
**Listened by:** `sync.js` to trigger immediate bidirectional sync.

```ts
type SyncForceDetail = void;  // no payload
```

---

## GitHub Gist payload

### Storage format (v3, current)

`sync.js` writes a **base64-encoded gzip** of the JSON payload into file
`oge-data.json.gz.b64` in a private gist (description:
`"OG-E sync data v3 (compressed) — do not edit manually"`). Auto-discovered on
boot or auto-created. Cached gist id in localStorage key `oge_gistId_v3`.

**Pipeline**: `payload → JSON.stringify → gzip (CompressionStream) → base64 → gist file`

Decompressed payload shape:

```ts
type GistPayload = {
  version: 3;                            // SCHEMA_VERSION; mismatch → ignore remote
  updatedAt: string;                     // ISO timestamp
  galaxyScans: GalaxyScans;              // see oge_galaxyScans
  colonyHistory: ColonyHistory;          // see oge_colonyHistory
  deletedColonies?: number[];            // soft-delete tombstones (4.9.1+); optional for back-compat
};
```

**Why compressed**: the raw JSON for a fully-scanned account is ~2 MB,
dominated by repeated keys. Gzip's LZ77 dedupes these almost perfectly →
~250 KB payloads (~6× reduction before base64's +33% overhead, so net ~330 KB).
On slow mobile links this is the difference between a smooth sync and a
visibly throttled one that competes with game traffic during active scanning.

**Why base64**: gist files are UTF-8 text. Gzipped bytes contain non-ASCII
values that GitHub would mangle. base64 is text-safe and deterministic.

**Why a dedicated file name** (not plain `oge-data.json`): lets a human
inspecting the gist immediately see it's compressed, and prevents confusion
with the v2 format if both exist during migration.

### v2 → v3 migration

On first 4.9.0 boot, `ensureGistV3` discovers the gist as follows:

1. Cached id in `oge_gistId_v3` → use.
2. Search user's gists for v3 description → cache + use.
3. Search for v2 description (`"OG-E sync data — do not edit manually"`). Read
   its uncompressed `oge-data.json`, parse, repackage as v3 payload, create a
   **new** v3 gist. The v2 gist is **not deleted** — user can prune it via
   GitHub UI at any time. Rollback-safe backup.
4. Nothing found → create empty v3.

The stale `oge_gistId` localStorage key is cleaned on successful migration.

### Cross-device merge logic

- `mergeScans`: per-system merge by max `scannedAt` (whole-system replace,
  not per-position — fresh scan would replace stale anyway).
- `mergeHistory`: dedup by `cp` (planet ID); first-seen wins. Entries whose
  `cp` is in the merged `deletedColonies` set are filtered from both sides —
  this is how soft-delete from one device stays deleted across all devices.
- `mergeDeleted`: union of local + remote `deletedColonies`. Tombstones
  append-only, propagate permanently.
- `colonizationRegistry`: NOT synced — local-only per device (see localStorage
  section above), regenerated naturally by sending missions.

### Anti-loop

Both `mergeScans` and `mergeHistory` return `{ merged, changed }`. Local
writes happen only when `changed === true`. Without this, every sync write
would trigger `storage.onChanged` → `scheduleUpload` → another sync →
infinite loop hammering GitHub's 5000 req/h quota.

### Debounce

Uploads are debounced at **15 s** (was 5 s in ≤4.8.5). On mobile active-scan
bursts this coalesces many individual chrome.storage changes into one upload.
Trade-off: a fresh observation on device A is at most ~15 s "stale" on
device B's next sync.

### Rate limit handling

403/429 responses arm `backoffUntil` from `Retry-After` → `X-RateLimit-Reset`
→ default 5 min. All `gh()` calls before that time throw immediately without
hitting the network.

---

## Schema migrations

Bump `SCANS_SCHEMA_VERSION` in `mobile.js` (top of file) when changing
`oge_galaxyScans` shape. On boot, if `oge_scansSchemaVersion < SCANS_SCHEMA_VERSION`:

1. Wipe local `oge_galaxyScans` (and clear any lingering
   `oge_colonizationRegistry` in chrome.storage — obsolete as of 4.8.5 but
   cleaned defensively).
2. Set tombstone `oge_clearRemoteAt = Date.now()` so `sync.js` clears the gist
3. Update `oge_scansSchemaVersion` to current

Gist is also schema-versioned — `fetchGistData` returns `null` if remote
version mismatches local, preventing v1 contamination of v2 storage.
