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
//      human-readable view in the Application panel (`oge_fabBtnSize = 320`
//      beats `oge_settings = {"...":320,...}` when you are tracing a bug).
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
import { safeLS } from '../lib/storage.js';

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
 *   showExpeditionButton    true  — Expeditions module visible on the FAB
 *   autoRedirectExpedition  true  — redirect to next planet after expedition
 *   maxExpeditionsPerPlanet         1     — simultaneous expeditions per planet
 *
 *   (colonyMinGap / colonyMinFields / colonyPassword moved OUT of Settings
 *    into the per-universe Galaxy-Scan config — edited in the dashboard,
 *    see `state/galaxyScanConfig.js`.)
 *   cloudSync               false — enable Gist-based cross-device sync
 *
 *   (Target positions + "prefer other galaxies" + the galaxy-scan rescan
 *    policy moved OUT of Settings into the per-universe Galaxy-Scan config —
 *    edited in the dashboard, see `state/galaxyScanConfig.js`.)
 *   gistToken               ''    — GitHub personal access token
 *   readabilityBoost        true  — inject CSS fix for event box + movement link
 *   eventMenuHighlight      true  — animate ephemeral event entries in the left toolbar
 *   traderMenuHighlight     true  — time-aware pulse on the Trader (Handlarz) entry
 *   threatHighlight             false — loud full-screen alert while under attack (opt-in)
 *   alarmClockMasterEnabled  false — master switch for the whole alarmClock section; with
 *                                   a valid token, gates both wave + ad-hoc alarmClock
 *   alarmClockNtfyToken       ''    — ntfy.sh access token (Bearer) for publish/cancel
 *   (The fleet-save knobs — fsEnabled / fsThreshold / fsMinFlightSec / fsOffsets —
 *    moved OUT of Settings into the per-universe Galaxy-Scan config (server-scoped,
 *    edited in the dashboard's AlarmClock tab), see `state/galaxyScanConfig.js`.)
 *   (The alarmClock knobs — alarmClockEnabled / alarmClockSchedule / adhocSchedule —
 *    moved OUT of Settings into the per-universe alarmClock config (server-scoped,
 *    edited in the dashboard's AlarmClock tab), see `state/alarmClockConfig.js`.)
 *
 * @typedef {object} Settings
 * @property {boolean} fabMode
 * @property {number}  fabBtnSize
 * @property {boolean} expeditionBadges
 * @property {boolean} showExpeditionButton
 * @property {boolean} showColonizeButton
 * @property {boolean} showLifeformButton
 * @property {boolean} showDailyRunButton
 * @property {boolean} autoRedirectExpedition
 * @property {number}  maxExpeditionsPerPlanet
 * @property {boolean} cloudSync
 * @property {string}  gistToken
 * @property {boolean} readabilityBoost
 * @property {boolean} eventMenuHighlight
 * @property {boolean} traderMenuHighlight
 * @property {boolean} threatHighlight
 * @property {boolean} showWhosSpying
 * @property {boolean} alarmClockMasterEnabled
 * @property {string}  alarmClockNtfyToken
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
  // Unified floating button (one mode/size pair for all modules).
  fabMode:                { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'fabMode' },
  fabBtnSize:             { type: 'int',    default: 320,   key: SETTINGS_PREFIX + 'fabBtnSize' },
  expeditionBadges:       { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'expeditionBadges' },
  showExpeditionButton:   { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'showExpeditionButton' },
  showColonizeButton:     { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'showColonizeButton' },
  showLifeformButton:     { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'showLifeformButton' },
  showDailyRunButton:     { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'showDailyRunButton' },
  autoRedirectExpedition: { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'autoRedirectExpedition' },
  maxExpeditionsPerPlanet:        { type: 'int',    default: 1,     key: SETTINGS_PREFIX + 'maxExpeditionsPerPlanet' },
  cloudSync:              { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'cloudSync' },
  gistToken:              { type: 'string', default: '',    key: SETTINGS_PREFIX + 'gistToken' },
  readabilityBoost:       { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'readabilityBoost' },
  eventMenuHighlight:     { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'eventMenuHighlight' },
  traderMenuHighlight:    { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'traderMenuHighlight' },
  threatHighlight:            { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'threatHighlight' },
  showWhosSpying:             { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'showWhosSpying' },
  alarmClockMasterEnabled: { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'alarmClockMasterEnabled' },
  alarmClockNtfyToken:      { type: 'string', default: '',    key: SETTINGS_PREFIX + 'alarmClockNtfyToken' },
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
