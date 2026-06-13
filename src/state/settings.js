// User preferences — the one reactive store that mirrors the Settings panel.
//
// # Role
//
// Every knob the user can toggle (mobile mode, colonize sizes, cloud-sync
// opt-in, the GitHub PAT, ...) lives here as a single {@link Settings}
// object. UI bindings subscribe once and light up every row of the panel at
// the same time; feature code reads individual fields via `settingsStore.get()`.
//
// # Why reactive store is a SINGLE object (not one store per preference)
//
// The settings panel reads the whole config in one render pass and
// re-renders on any change. Keeping one `Store<Settings>` means one
// subscription, one snapshot, and one predictable render — per-field stores
// would multiply subscriptions and make "apply changes" wiring painful.
//
// # Why persistence is PER-KEY (not the generic `lib/persist` helper)
//
// This is the ONE state module with custom persist logic — that is why it
// does NOT import `lib/persist`. Every Settings field maps to its own
// localStorage key under the `oge_` prefix (e.g. `mobileMode` →
// `oge_mobileMode`). Two reasons:
//
//   1. AGR integration — the browser-script AGR settings panel expects
//      each preference under its own key. Bundling everything into one
//      JSON blob would break AGR's view/edit flow.
//   2. DevTools debuggability — one preference per key gives a flat,
//      human-readable view in the Application panel (`oge_colMinGap = 20`
//      beats `oge_settings = {"...":20,...}` when you are tracing a bug).
//
// # Algorithm
//
// Hydration: for each field in {@link SETTINGS_SCHEMA}, read its LS key
// with the type-appropriate accessor (`safeLS.bool` / `safeLS.int` / raw
// `safeLS.get` with default fallback) and assemble a full Settings object.
// A single `settingsStore.set(hydrated)` notifies subscribers once.
//
// Write-through: {@link initSettingsStore} installs a subscriber that
// diffs the new state against a closure-held `prev` snapshot — only keys
// whose values changed are written back to localStorage. `String(value)`
// is used uniformly: `safeLS.bool`/`.int` parse it back on next hydrate.
//
// Idempotency: repeated calls to {@link initSettingsStore} return the
// existing dispose fn without installing a second subscription, matching
// the convention used by `state/scans.js` and `state/registry.js`.
//
// @ts-check

import { createStore } from '../lib/createStore.js';
import { chromeStore, safeLS } from '../lib/storage.js';
import { currentUniverseKey } from './universeKey.js';

/**
 * Shared prefix for every localStorage key this module owns. Kept exported
 * so tests and tooling (AGR panel, migration scripts) can reason about
 * ownership without re-deriving it from per-field keys.
 */
export const SETTINGS_PREFIX = 'oge_';

/**
 * Full shape of user preferences. Every property maps 1:1 to a row in the
 * Settings panel and to a localStorage key under {@link SETTINGS_PREFIX}.
 *
 * Defaults (duplicated in {@link SETTINGS_SCHEMA} — that record is the
 * single source of truth at runtime; this typedef is the compile-time
 * counterpart):
 *
 *   fabMode                 true  — unified floating button (all four command
 *                                   modules: Exp / Col / Lifeforms / Daily Run) visible
 *   fabBtnSize              320   — unified floating button size in px
 *   expeditionBadges        true  — ekspedycje dot on planet list
 *   autoRedirectExpedition  true  — redirect to next planet after expedition
 *   colPositions            '8'   — comma-separated colonize positions e.g. "8,9,10"
 *   colMinGap               15    — seconds between colonize arrivals
 *   colMinFields            320   — abandon threshold (fields)
 *   colPassword             ''    — autofill value for the abandon form
 *   maxExpPerPlanet         1     — simultaneous expeditions per planet
 *   colPreferOtherGalaxies  true  — prefer neighbouring galaxies first
 *   cloudSync               false — enable Gist-based cross-device sync
 *   gistToken               ''    — GitHub personal access token
 *   readabilityBoost        true  — inject CSS fix for event box + movement link
 *   eventMenuHighlight      true  — animate ephemeral event entries in the left toolbar
 *   traderMenuHighlight     true  — time-aware pulse on the Trader (Handlarz) entry
 *   remindersMasterEnabled  false — master switch for the whole reminders section; with
 *                                   a valid token, gates both wave + ad-hoc reminders
 *   reminderEnabled         false — auto-schedule ntfy.sh pushes for expedition return waves
 *   reminderNtfyToken       ''    — ntfy.sh access token (Bearer) for publish/cancel
 *   reminderSchedule        '0m, 10m, 30m, 60m' — free-form wave cadence: minutes-first
 *                                   offset list AFTER the wave returns (LS key reminderWaveOffsets)
 *   adhocEnabled            true  — allow per-fleet ad-hoc reminders from the event list
 *   adhocOffsetSec          60    — fire an ad-hoc reminder this many seconds before arrival
 *   fsEnabled               false — auto-detect fleet-saves (big own fleets) in the event list
 *   fsThreshold             100000 — minimum total ships for a leg to count as a fleet-save
 *   fsOffsets               '-10m, 0m, 10m' — FS reminder offsets relative to arrival,
 *                                   minutes-first (negative = before landing, 0 = at, + = after;
 *                                   LS key fsReminderOffsets)
 *   fsMinFlightSec          600   — minimum flight time (sec) for a leg to count as a fleet-save;
 *                                   excludes short planet⇄moon hops. Server-speed dependent.
 *
 * @typedef {object} Settings
 * @property {boolean} fabMode
 * @property {number}  fabBtnSize
 * @property {boolean} expeditionBadges
 * @property {boolean} autoRedirectExpedition
 * @property {string}  colPositions
 * @property {number}  colMinGap
 * @property {number}  colMinFields
 * @property {string}  colPassword
 * @property {number}  maxExpPerPlanet
 * @property {boolean} colPreferOtherGalaxies
 * @property {boolean} cloudSync
 * @property {string}  gistToken
 * @property {boolean} readabilityBoost
 * @property {boolean} eventMenuHighlight
 * @property {boolean} traderMenuHighlight
 * @property {boolean} remindersMasterEnabled
 * @property {boolean} reminderEnabled
 * @property {string}  reminderNtfyToken
 * @property {string}  reminderSchedule
 * @property {boolean} adhocEnabled
 * @property {number}  adhocOffsetSec
 * @property {boolean} fsEnabled
 * @property {number}  fsThreshold
 * @property {string}  fsOffsets
 * @property {number}  fsMinFlightSec
 */

/**
 * One entry in {@link SETTINGS_SCHEMA}. The `type` tag drives which
 * `safeLS` accessor is used for hydration and implicitly which coercion
 * rule applies on write-through (we always `String()` the value, but the
 * type tag lets callers reason about what kind of string we produce —
 * `'true'|'false'`, an integer literal, or the string value itself).
 *
 * The `default` is typed as `unknown` because the record as a whole is
 * heterogeneous (bool/int/string defaults sit next to each other). Each
 * accessor casts to its expected type at hydrate time — see
 * {@link hydrateFromStorage}.
 *
 * `key` is the full localStorage key (prefix + field name), precomputed
 * once at module eval so hot paths avoid string concatenation.
 *
 * @typedef {object} SettingSchema
 * @property {'bool' | 'int' | 'string'} type
 *   Which `safeLS` accessor to use on hydrate.
 * @property {unknown} default
 *   Value used when the key is absent. Narrowed to the concrete runtime
 *   type (boolean / number / string) at hydrate time.
 * @property {string} key
 *   Full localStorage key — `SETTINGS_PREFIX` + field name.
 */

/**
 * Single source of truth for every {@link Settings} field: its storage
 * type, default value, and full localStorage key. Exported so tests and
 * future migration code can iterate the same definitions the hydrate /
 * write-through code uses — avoiding drift between the typedef and the
 * runtime schema.
 *
 * @type {Record<keyof Settings, SettingSchema>}
 */
export const SETTINGS_SCHEMA = {
  // v2 unified floating button (replaces the four per-button mode/size
  // pairs — see migrateLegacyButtonSettings below).
  fabMode:                { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'fabMode' },
  fabBtnSize:             { type: 'int',    default: 320,   key: SETTINGS_PREFIX + 'fabBtnSize' },
  expeditionBadges:       { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'expeditionBadges' },
  autoRedirectExpedition: { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'autoRedirectExpedition' },
  colPositions:           { type: 'string', default: '8',   key: SETTINGS_PREFIX + 'colPositions' },
  colMinGap:              { type: 'int',    default: 15,    key: SETTINGS_PREFIX + 'colMinGap' },
  colMinFields:           { type: 'int',    default: 320,   key: SETTINGS_PREFIX + 'colMinFields' },
  colPassword:            { type: 'string', default: '',    key: SETTINGS_PREFIX + 'colPassword' },
  maxExpPerPlanet:        { type: 'int',    default: 1,     key: SETTINGS_PREFIX + 'maxExpPerPlanet' },
  colPreferOtherGalaxies: { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'colPreferOtherGalaxies' },
  cloudSync:              { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'cloudSync' },
  gistToken:              { type: 'string', default: '',    key: SETTINGS_PREFIX + 'gistToken' },
  readabilityBoost:       { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'readabilityBoost' },
  eventMenuHighlight:     { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'eventMenuHighlight' },
  traderMenuHighlight:    { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'traderMenuHighlight' },
  remindersMasterEnabled: { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'remindersMasterEnabled' },
  reminderEnabled:        { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'reminderEnabled' },
  reminderNtfyToken:      { type: 'string', default: '',    key: SETTINGS_PREFIX + 'reminderNtfyToken' },
  // v1.11.0 moved the wave schedule + FS offsets from fixed presets / raw
  // seconds to a free-form, minutes-first duration list (`0m, 10m, …`). The
  // old stored formats are incompatible (a preset KEY, or seconds read as
  // minutes), so these point at NEW keys — the old values are orphaned and
  // every player lands on the new default. Deliberate: no migration.
  reminderSchedule:       { type: 'string', default: '0m, 10m, 30m, 60m', key: SETTINGS_PREFIX + 'reminderWaveOffsets' },
  adhocEnabled:           { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'adhocEnabled' },
  adhocOffsetSec:         { type: 'int',    default: 60,    key: SETTINGS_PREFIX + 'adhocOffsetSec' },
  fsEnabled:              { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'fsEnabled' },
  fsThreshold:            { type: 'int',    default: 100000, key: SETTINGS_PREFIX + 'fsThreshold' },
  fsOffsets:              { type: 'string', default: '-10m, 0m, 10m', key: SETTINGS_PREFIX + 'fsReminderOffsets' },
  fsMinFlightSec:         { type: 'int',    default: 600,   key: SETTINGS_PREFIX + 'fsMinFlightSec' },
};

// ─────────────────────────────────────────────────────────────────────────
// Unified-FAB keys that are persisted state but NOT Settings-panel fields
// (they change through direct interaction with the button, like the drag
// position always has). Declared here so there is a single owner for the
// key names; `features/shared/unifiedFab.js` imports them.

/** localStorage key for the unified FAB's dragged `{x,y}` position. */
export const FAB_POS_KEY = SETTINGS_PREFIX + 'fabPos';

/** localStorage key for the id of the currently active FAB module. */
export const FAB_ACTIVE_KEY = SETTINGS_PREFIX + 'fabActive';

/**
 * Pre-unified-FAB per-button keys (≤ v1.x), frozen verbatim for migration:
 * one mode/size/pos triple per floating button, with the historical mode
 * defaults. Order matters — it is the priority used to pick the module the
 * migrated FAB starts on (first legacy-enabled one wins).
 */
const LEGACY_FAB_MODULES = [
  { id: 'exp', modeKey: SETTINGS_PREFIX + 'mobileMode',    modeDefault: true,  sizeKey: SETTINGS_PREFIX + 'enterBtnSize', posKey: SETTINGS_PREFIX + 'enterBtnPos' },
  { id: 'col', modeKey: SETTINGS_PREFIX + 'colonizeMode',  modeDefault: true,  sizeKey: SETTINGS_PREFIX + 'colBtnSize',   posKey: SETTINGS_PREFIX + 'colBtnPos' },
  { id: 'lf',  modeKey: SETTINGS_PREFIX + 'lifeformMode',  modeDefault: true,  sizeKey: SETTINGS_PREFIX + 'lfBtnSize',    posKey: SETTINGS_PREFIX + 'lfBtnPos' },
  { id: 'fs',  modeKey: SETTINGS_PREFIX + 'fsCollectMode', modeDefault: false, sizeKey: SETTINGS_PREFIX + 'fsBtnSize',    posKey: SETTINGS_PREFIX + 'fsUnifiedPos' },
];

/**
 * One-shot migration from the four legacy per-button settings to the
 * unified FAB. Runs before hydration on every {@link initSettingsStore}
 * call but only acts when `oge_fabMode` is still unset AND at least one
 * legacy key exists (a fresh install has neither and just gets the schema
 * defaults). Derivation:
 *
 *   - `fabMode`    — true iff any legacy button was enabled;
 *   - `fabBtnSize` — the first legacy-enabled button's size (its module is
 *     the one the user actually looked at), default 320;
 *   - `oge_fabActive` / `oge_fabPos` — that same button's id and dragged
 *     position, so the unified FAB appears exactly where the user's main
 *     button used to be.
 *
 * The legacy keys are left in place (harmless, and a downgrade keeps
 * working); only new keys are written. Exported for tests.
 *
 * @returns {void}
 */
export const migrateLegacyButtonSettings = () => {
  if (safeLS.get(SETTINGS_SCHEMA.fabMode.key) !== null) return;
  const hasLegacy = LEGACY_FAB_MODULES.some(
    (m) => safeLS.get(m.modeKey) !== null || safeLS.get(m.sizeKey) !== null,
  );
  if (!hasLegacy) return;
  const enabled = LEGACY_FAB_MODULES.filter((m) =>
    safeLS.bool(m.modeKey, m.modeDefault),
  );
  safeLS.set(SETTINGS_SCHEMA.fabMode.key, String(enabled.length > 0));
  const primary = enabled[0] ?? LEGACY_FAB_MODULES[0];
  safeLS.set(
    SETTINGS_SCHEMA.fabBtnSize.key,
    String(safeLS.int(primary.sizeKey, /** @type {number} */ (SETTINGS_SCHEMA.fabBtnSize.default))),
  );
  if (safeLS.get(FAB_ACTIVE_KEY) === null) safeLS.set(FAB_ACTIVE_KEY, primary.id);
  const pos = safeLS.json(primary.posKey);
  if (pos && safeLS.json(FAB_POS_KEY) === null) safeLS.setJSON(FAB_POS_KEY, pos);
};

/**
 * All `keyof Settings` strings, captured once so both hydrate and diff
 * iterate the same list in the same order. `Object.entries` would work
 * too but the cast-churn on its index signature is uglier — the keys
 * array lets us type the loop variable as `keyof Settings` cleanly.
 *
 * @type {Array<keyof Settings>}
 */
const SETTINGS_KEYS = /** @type {Array<keyof Settings>} */ (Object.keys(SETTINGS_SCHEMA));

/**
 * Build a fresh {@link Settings} object pre-populated from the defaults
 * declared in {@link SETTINGS_SCHEMA}. Used as the initial state of
 * {@link settingsStore} before hydration runs, and as the "reset to
 * defaults" shape in tests.
 *
 * @returns {Settings}
 */
const buildDefaults = () => {
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (const field of SETTINGS_KEYS) {
    obj[field] = SETTINGS_SCHEMA[field].default;
  }
  return /** @type {Settings} */ (/** @type {unknown} */ (obj));
};

/**
 * Read every {@link Settings} field from localStorage using the accessor
 * appropriate to its declared type. Missing / unparseable values fall
 * back to the schema default. Called exactly once per
 * {@link initSettingsStore} call.
 *
 * `safeLS.bool` / `safeLS.int` already swallow parse failures and apply
 * their own default — we pass the schema default through as that default.
 * For `string` fields we deliberately treat EMPTY STRING as a legitimate
 * stored value (not "missing") so users can opt-out of e.g. the abandon
 * password by explicitly setting it to empty.
 *
 * @returns {Settings}
 */
const hydrateFromStorage = () => {
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (const field of SETTINGS_KEYS) {
    const schema = SETTINGS_SCHEMA[field];
    /** @type {unknown} */
    let value;
    if (schema.type === 'bool') {
      value = safeLS.bool(schema.key, /** @type {boolean} */ (schema.default));
    } else if (schema.type === 'int') {
      value = safeLS.int(schema.key, /** @type {number} */ (schema.default));
    } else {
      // 'string' — safeLS.get returns null when absent / inaccessible;
      // an empty string is a legitimate user-set value (see above).
      const raw = safeLS.get(schema.key);
      value = raw !== null ? raw : schema.default;
    }
    obj[field] = value;
  }
  return /** @type {Settings} */ (/** @type {unknown} */ (obj));
};

/**
 * The user-preferences store. Starts at defaults from
 * {@link SETTINGS_SCHEMA}; {@link initSettingsStore} replaces the value
 * with whatever is currently in localStorage and begins mirroring writes
 * back. Consumers that only read after init see hydrated values; those
 * that read before init see defaults — a deliberate "never-null" shape
 * so UI bindings don't need to branch on initialised/not.
 *
 * @type {import('../lib/createStore.js').Store<Settings>}
 */
export const settingsStore = createStore(buildDefaults());

/**
 * Unsubscribe handle from the most recent {@link initSettingsStore} call,
 * or `null` when persistence is not currently wired. Held at module scope
 * so repeat inits collapse to no-ops and tests can detect
 * already-initialized runs cleanly.
 *
 * @type {(() => void) | null}
 */
let disposeFn = null;

/**
 * Wire {@link settingsStore} to localStorage. Idempotent — a second call
 * while already wired returns the existing dispose fn without hydrating
 * again or installing a duplicate subscription.
 *
 * Side effects, in order:
 *
 *   1. Hydrate: read every key declared in {@link SETTINGS_SCHEMA} and
 *      replace the store state with the assembled object. One
 *      notification fires at this point.
 *   2. Write-through: subscribe a diffing listener. On every subsequent
 *      store change the listener compares each field against a
 *      closure-held `prev` snapshot and writes ONLY the fields whose
 *      values changed. `String(value)` is applied uniformly (booleans
 *      become `'true'`/`'false'`, ints become their decimal
 *      representation, strings pass through) — symmetric with what
 *      `safeLS.bool` / `safeLS.int` parse on next hydrate.
 *
 * @returns {() => void} Dispose fn that cuts the write-through
 *   subscription. Calling it does NOT revert the store state to defaults
 *   — in-memory state survives dispose; only further writes to
 *   localStorage are suppressed.
 */
export const initSettingsStore = () => {
  if (disposeFn) return disposeFn;

  // Upgrade path: fold the four legacy per-button settings into the
  // unified-FAB keys BEFORE hydration reads them. No-op on fresh installs
  // and on every run after the first.
  migrateLegacyButtonSettings();

  // Hydrate: one set() → one notification.
  settingsStore.set(hydrateFromStorage());

  // `prev` is captured in the closure and updated inside the subscriber
  // after every successful diff. It is initialized to the hydrated state
  // so the first subsequent change diffs against real data, not defaults.
  let prev = settingsStore.get();

  const unsubscribe = settingsStore.subscribe((next) => {
    for (const field of SETTINGS_KEYS) {
      // Typed indexing: `field` is keyof Settings, `prev`/`next` are
      // Settings, so `prevVal`/`nextVal` inherit the union of field
      // types (boolean | number | string). That is exactly what
      // `String()` accepts, so no further narrowing is needed.
      const prevVal = prev[field];
      const nextVal = next[field];
      if (prevVal !== nextVal) {
        safeLS.set(SETTINGS_SCHEMA[field].key, String(nextVal));
      }
    }
    prev = next;
  });

  disposeFn = unsubscribe;
  return disposeFn;
};

/**
 * Tear down the persistence wiring installed by
 * {@link initSettingsStore}. Safe to call when already disposed (no-op)
 * and when init was never called. Primarily a test-teardown affordance;
 * production callers wire the store at startup and leave it alone.
 *
 * @returns {void}
 */
export const disposeSettingsStore = () => {
  if (disposeFn) {
    disposeFn();
    disposeFn = null;
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Settings → chrome.storage cross-origin mirror.
//
// Problem it solves: the per-key persistence above writes every preference
// to `localStorage` (for AGR compatibility and per-key debuggability). The
// histogram extension page, however, runs in the EXTENSION origin and
// cannot read the game page's localStorage. For every setting the
// histogram needs to observe (today: `colPositions`, which drives the
// "target positions" filter), we mirror a copy into
// `chrome.storage.local` — an API area that IS visible across origins
// within the same extension.
//
// Direction: one-way, settings → chrome.storage. The histogram page
// never writes back; it reads and renders. Mirroring in reverse would
// create a feedback loop that the persistence logic above isn't built for.
//
// Scope: only the keys the histogram (or any other extension-origin
// surface) actually reads. Mirroring the full Settings object would
// leak sensitive fields (`gistToken`, `colPassword`) into a second
// storage area for no benefit. Today that's just `colPositions`.
//
// Per-universe: the actual key written is
// `<universeId>:oge_colPositions` so two servers' mirrors don't
// clobber each other in the shared `chrome.storage.local` area. The
// histogram reads the mirror for the currently-selected universe.
//
// @see ../features/dashboard/index.js — colPositions reader

/**
 * Suffix portion of the chrome.storage.local key the histogram reads.
 * The actual key is `<universeId>:<COL_POSITIONS_KEY_BASE>` — see
 * {@link colPositionsKeyFor}. Exported so the histogram can compose
 * a key for the selected universe without re-deriving the suffix.
 */
export const COL_POSITIONS_KEY_BASE = 'oge_colPositions';

/**
 * Compose the per-universe chrome.storage.local key for the
 * `colPositions` mirror. Histogram side imports this; mirror code
 * below resolves `location.host` at write time.
 *
 * @param {string} universeId  e.g. `'s163-pl'` from
 *   {@link parseUniverseId}.
 * @returns {string}
 */
export const colPositionsKeyFor = (universeId) =>
  `${universeId}:${COL_POSITIONS_KEY_BASE}`;

/**
 * Resolve the mirror key for the current tab's universe. Defensive
 * fallback to the base suffix when `location` is unavailable (node
 * tests) — production always has `location` because the manifest
 * restricts this module to game-origin tabs.
 *
 * @returns {string}
 */
const currentColPositionsKey = () =>
  currentUniverseKey(COL_POSITIONS_KEY_BASE, colPositionsKeyFor);

/**
 * Active install handle, or `null` when the mirror is not installed.
 * Kept at module scope so a second {@link installSettingsMirror} call
 * can collapse to the existing dispose fn — matches the convention in
 * `state/scans.js`, `state/history.js`, etc.
 *
 * @type {(() => void) | null}
 */
let mirrorDisposeFn = null;

/**
 * Subscribe to {@link settingsStore} and mirror `colPositions` into
 * `chrome.storage.local` whenever it changes. Fires once on install to
 * carry the current value into chromeStore — otherwise a fresh extension
 * load on a freshly-loaded game page would leave the histogram reading
 * `undefined` (and falling back to the hard-coded default) until the
 * user touched a setting.
 *
 * Idempotent: repeat calls return the existing dispose handle.
 *
 * @returns {() => void} Dispose fn that unsubscribes the listener.
 *   In-memory `settingsStore` state and the already-written chromeStore
 *   value are left intact; only future writes are suppressed.
 */
export const installSettingsMirror = () => {
  if (mirrorDisposeFn) return mirrorDisposeFn;

  // Initial mirror. Without this, devices that load the game page AFTER
  // the histogram page has already started — and haven't yet changed a
  // setting — would see the histogram stuck on its default filter.
  let last = settingsStore.get().colPositions;
  void chromeStore.set(currentColPositionsKey(), last);

  const unsubscribe = settingsStore.subscribe((settings) => {
    // Diff-guarded write: the store notifies on ANY field change, but
    // we only care about `colPositions`. Most subscriber firings touch
    // nothing we mirror — skipping the chromeStore.set on those avoids
    // unnecessary storage writes (and the onChanged event they produce
    // in every consuming origin).
    if (settings.colPositions !== last) {
      last = settings.colPositions;
      void chromeStore.set(currentColPositionsKey(), last);
    }
  });

  mirrorDisposeFn = unsubscribe;
  return mirrorDisposeFn;
};

/**
 * Tear down the mirror subscription. Safe to call when never installed
 * (no-op) and when already disposed. In-memory state and the previously
 * mirrored chromeStore value both survive dispose.
 *
 * @returns {void}
 */
export const disposeSettingsMirror = () => {
  if (mirrorDisposeFn) {
    mirrorDisposeFn();
    mirrorDisposeFn = null;
  }
};
