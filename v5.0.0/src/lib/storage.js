// Storage helpers — two independent tools for two different substrates.
//
// `safeLS` wraps the synchronous Window.localStorage API. Every access to
// localStorage can throw: private-browsing denies writes, sandboxed iframes
// block reads, Safari in lockdown mode rejects everything, and any origin
// can hit the 5MB quota. Propagating those errors up through every caller
// would mean sprinkling try/catch over every pref read. Instead `safeLS`
// catches them at the source and returns a sensible default — that is the
// entire reason this helper exists, so the try/catch swallowing here is
// deliberate and documented rather than a code smell.
//
// `chromeStore` wraps the asynchronous, cross-browser WebExtension storage
// API (`chrome.storage.local` in Chrome, `browser.storage.local` in Firefox).
// It picks the `browser` namespace first (Firefox's native Promise-based
// API) and falls back to `chrome` (available in both). Even though modern
// Firefox returns Promises from both, we always wrap the callback form by
// hand — it works identically in both engines and we avoid runtime feature
// detection per call. If neither namespace exists (node tests without a
// mock, pages without the extension API), reads resolve to `undefined`
// and writes resolve to void; change-listener registration is a no-op.
//
// The two helpers are intentionally disjoint: `safeLS` is sync and lossy
// (only string values; typed getters do the parsing), `chromeStore` is
// async and structured-clone-safe. Neither mirrors the other's data —
// callers pick the right substrate for each piece of state.

/* global localStorage, chrome, browser */

/**
 * Synchronous localStorage helper. Every method swallows thrown errors
 * from the underlying Web Storage API (quota, security, disabled) and
 * falls back to the documented default. Typed getters (`bool`, `int`,
 * `json`) additionally handle missing keys and parse failures.
 *
 * @typedef {object} SafeLS
 * @property {(key: string) => string | null} get
 *   Read a raw string value, or null if missing / inaccessible.
 * @property {(key: string, value: unknown) => void} set
 *   Write `String(value)` under `key`. Silently drops on failure.
 * @property {(key: string) => void} remove
 *   Delete `key`. Silently drops on failure.
 * @property {(key: string, defaultValue?: boolean) => boolean} bool
 *   Return `true` iff the stored string equals `'true'`. Otherwise the
 *   `defaultValue` (default `false`).
 * @property {(key: string, defaultValue?: number) => number} int
 *   `parseInt(value, 10)`; returns the parsed number when
 *   `Number.isFinite` accepts it (including `0` and negatives) else
 *   `defaultValue` (default `0`).
 * @property {(key: string, defaultValue?: unknown) => unknown} json
 *   `JSON.parse` of the stored string; returns `defaultValue` (default
 *   `null`) when the key is absent or parsing throws.
 * @property {(key: string, value: unknown) => void} setJSON
 *   `JSON.stringify` + write. Silently drops on failure (stringify or
 *   storage quota).
 */

/** @type {SafeLS} */
export const safeLS = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  set: (key, value) => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // Intentionally swallowed — private mode, quota, sandboxed iframe.
    }
  },

  remove: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Intentionally swallowed — see file header.
    }
  },

  bool: (key, defaultValue = false) => {
    const raw = safeLS.get(key);
    if (raw === null) return defaultValue;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return defaultValue;
  },

  int: (key, defaultValue = 0) => {
    const raw = safeLS.get(key);
    if (raw === null) return defaultValue;
    // NOTE: This is a PURE parser — unlike v4, zero and negative values
    // round-trip. Callers that need "positive only" must validate on top.
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  },

  json: (key, defaultValue = null) => {
    const raw = safeLS.get(key);
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  },

  setJSON: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Intentionally swallowed — stringify can throw on cycles; setItem
      // can throw on quota. Either way the caller asked for best-effort.
    }
  },
};

/**
 * Pick the WebExtension storage namespace, preferring Firefox's `browser`
 * over `chrome`. Returns `null` when neither is available — callers treat
 * that as "no-op mode" (reads resolve undefined, writes resolve void,
 * change-listener registration is a no-op).
 *
 * Resolved lazily on every call: tests stub and un-stub globals between
 * cases, so caching the reference at module-eval time would lock the
 * wrapper to whichever state existed first.
 *
 * @returns {{
 *   local: {
 *     get: (key: string, cb: (items: Record<string, unknown>) => void) => void,
 *     set: (items: Record<string, unknown>, cb?: () => void) => void,
 *     remove: (keys: string | string[], cb?: () => void) => void,
 *   },
 *   onChanged: {
 *     addListener: (cb: (changes: Record<string, unknown>, areaName: string) => void) => void,
 *     removeListener: (cb: (changes: Record<string, unknown>, areaName: string) => void) => void,
 *   },
 * } | null}
 */
const pickStorage = () => {
  // `globalThis` access keeps us honest under `strict` typecheck: neither
  // `chrome` nor `browser` are declared as ambient globals in lib.dom, so
  // we treat them as possibly-undefined properties on the global object.
  const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
  const ns = g.browser ?? g.chrome;
  if (!ns || !ns.storage || !ns.storage.local || !ns.storage.onChanged) return null;
  return { local: ns.storage.local, onChanged: ns.storage.onChanged };
};

/**
 * Promise-shaped wrapper over `chrome.storage.local` / `browser.storage.local`.
 * All calls are safe when the WebExtension API is not loaded (node tests,
 * stripped contexts): reads resolve to `undefined`, writes resolve to void,
 * `onChanged` returns a no-op unsubscribe.
 *
 * @typedef {object} ChromeStore
 * @property {(key: string) => Promise<unknown>} get
 *   Resolve with the value at `key`, or `undefined` if missing / API absent.
 * @property {(key: string, value: unknown) => Promise<void>} set
 *   Persist `{ [key]: value }`. Resolves when the backing store acks.
 * @property {(key: string | string[]) => Promise<void>} remove
 *   Delete one key or a batch.
 * @property {(callback: (changes: Record<string, unknown>, areaName: string) => void) => () => void} onChanged
 *   Register a global storage-change listener. Returned unsubscribe is
 *   idempotent and a no-op when the API is absent.
 */

/** @type {ChromeStore} */
export const chromeStore = {
  get: (key) =>
    new Promise((resolve) => {
      const api = pickStorage();
      if (!api) {
        resolve(undefined);
        return;
      }
      api.local.get(key, (items) => {
        resolve(items ? items[key] : undefined);
      });
    }),

  set: (key, value) =>
    new Promise((resolve) => {
      const api = pickStorage();
      if (!api) {
        resolve();
        return;
      }
      api.local.set({ [key]: value }, () => {
        resolve();
      });
    }),

  remove: (key) =>
    new Promise((resolve) => {
      const api = pickStorage();
      if (!api) {
        resolve();
        return;
      }
      api.local.remove(key, () => {
        resolve();
      });
    }),

  onChanged: (callback) => {
    const api = pickStorage();
    if (!api) {
      return () => {
        // No listener was registered; unsubscribe is a no-op.
      };
    }
    api.onChanged.addListener(callback);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      api.onChanged.removeListener(callback);
    };
  },
};
