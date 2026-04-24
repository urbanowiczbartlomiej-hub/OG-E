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
 *   mobileMode              false — Send Exp button visible in mobile layout
 *   colonizeMode            false — Send Col button visible

 *   expeditionBadges        true  — ekspedycje dot on planet list
 *   autoRedirectExpedition  true  — redirect to next planet after expedition
 *   autoRedirectColonize    true  — redirect to next colonize target after send
 *   enterBtnSize            560   — Send Exp button size in px
 *   colBtnSize              336   — Send Col button size in px
 *   colPositions            '8'   — comma-separated colonize positions e.g. "8,9,10"
 *   colMinGap               20    — seconds between colonize arrivals
 *   colMinFields            200   — abandon threshold (fields)
 *   colPassword             ''    — autofill value for the abandon form
 *   maxExpPerPlanet         1     — simultaneous expeditions per planet
 *   colPreferOtherGalaxies  false — prefer neighbouring galaxies first
 *   cloudSync               false — enable Gist-based cross-device sync
 *   gistToken               ''    — GitHub personal access token
 *   readabilityBoost        true  — inject CSS fix for event box + movement link
 *
 * @typedef {object} Settings
 * @property {boolean} mobileMode
 * @property {boolean} colonizeMode
 * @property {boolean} expeditionBadges
 * @property {boolean} autoRedirectExpedition
 * @property {boolean} autoRedirectColonize
 * @property {number}  enterBtnSize
 * @property {number}  colBtnSize
 * @property {string}  colPositions
 * @property {number}  colMinGap
 * @property {number}  colMinFields
 * @property {string}  colPassword
 * @property {number}  maxExpPerPlanet
 * @property {boolean} colPreferOtherGalaxies
 * @property {boolean} cloudSync
 * @property {string}  gistToken
 * @property {boolean} readabilityBoost
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
  mobileMode:             { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'mobileMode' },
  colonizeMode:           { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'colonizeMode' },
  expeditionBadges:       { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'expeditionBadges' },
  autoRedirectExpedition: { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'autoRedirectExpedition' },
  autoRedirectColonize:   { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'autoRedirectColonize' },
  enterBtnSize:           { type: 'int',    default: 560,   key: SETTINGS_PREFIX + 'enterBtnSize' },
  colBtnSize:             { type: 'int',    default: 336,   key: SETTINGS_PREFIX + 'colBtnSize' },
  colPositions:           { type: 'string', default: '8',   key: SETTINGS_PREFIX + 'colPositions' },
  colMinGap:              { type: 'int',    default: 20,    key: SETTINGS_PREFIX + 'colMinGap' },
  colMinFields:           { type: 'int',    default: 200,   key: SETTINGS_PREFIX + 'colMinFields' },
  colPassword:            { type: 'string', default: '',    key: SETTINGS_PREFIX + 'colPassword' },
  maxExpPerPlanet:        { type: 'int',    default: 1,     key: SETTINGS_PREFIX + 'maxExpPerPlanet' },
  colPreferOtherGalaxies: { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'colPreferOtherGalaxies' },
  cloudSync:              { type: 'bool',   default: false, key: SETTINGS_PREFIX + 'cloudSync' },
  gistToken:              { type: 'string', default: '',    key: SETTINGS_PREFIX + 'gistToken' },
  readabilityBoost:       { type: 'bool',   default: true,  key: SETTINGS_PREFIX + 'readabilityBoost' },
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
// @see ../features/histogram/index.js — COL_POSITIONS_KEY reader

/**
 * chrome.storage.local key the histogram reads. Matches
 * `features/histogram/index.js:COL_POSITIONS_KEY`. Keep the two in
 * sync if either side changes — they don't import a shared constant
 * because they live in different module trees (state vs. features)
 * and a shared constants module would be overkill for one string.
 */
const COL_POSITIONS_KEY = 'oge_colPositions';

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
  void chromeStore.set(COL_POSITIONS_KEY, last);

  const unsubscribe = settingsStore.subscribe((settings) => {
    // Diff-guarded write: the store notifies on ANY field change, but
    // we only care about `colPositions`. Most subscriber firings touch
    // nothing we mirror — skipping the chromeStore.set on those avoids
    // unnecessary storage writes (and the onChanged event they produce
    // in every consuming origin).
    if (settings.colPositions !== last) {
      last = settings.colPositions;
      void chromeStore.set(COL_POSITIONS_KEY, last);
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
