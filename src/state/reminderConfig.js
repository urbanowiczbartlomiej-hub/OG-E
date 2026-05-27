// @ts-check

// Reminder configuration store — the single GLOBAL config object that
// drives the expedition push-reminder feature.
//
// # Why chrome.storage (not localStorage)
//
// Unlike every other preference (which lives in localStorage for AGR
// compatibility — see `state/settings.js`), this config is authored on
// the EXTENSION-ORIGIN histogram page and consumed on the GAME-ORIGIN
// content script. Those two origins do not share a localStorage, but
// they DO share `chrome.storage.local`. So this is the one config that
// is canonically stored there:
//
//   - histogram page  → writes (user edits the form)
//   - game content    → reads, pushes into the gist's `oge-reminders.json`
//
// To keep both surfaces live without a page reload we also subscribe to
// `chrome.storage.onChanged`: an edit on the histogram tab propagates to
// the game tab's store, which re-pushes to the gist on its next write.
//
// # Why GLOBAL (not per-universe)
//
// Confirmed with the product owner: one set of reminder settings across
// all servers. Waves themselves carry their universe for labelling, but
// the schedule / allowed-hours / ntfy topic are shared. Hence a single
// un-namespaced key, {@link REMINDER_CONFIG_KEY}.

import { createStore } from '../lib/createStore.js';
import { chromeStore } from '../lib/storage.js';

/**
 * chrome.storage.local key holding the whole config object as a single
 * structured value. Un-namespaced (global) on purpose — see header.
 */
export const REMINDER_CONFIG_KEY = 'oge_reminderConfig';

/**
 * Allowed notification window, local wall-clock `"HH:MM"` strings.
 * `start === end` means "no restriction" (see
 * `domain/waves.withinAllowedHours`).
 *
 * @typedef {object} AllowedHours
 * @property {string} start `"HH:MM"`.
 * @property {string} end   `"HH:MM"`.
 */

/**
 * Full reminder configuration. Mirrors the `config` block written into
 * the gist's `oge-reminders.json` and read by the Cloudflare Worker.
 *
 * @typedef {object} ReminderConfig
 * @property {boolean} enabled
 *   Master switch. When false the Worker does nothing and the extension
 *   still maintains `waves` (so flipping it on resumes cleanly).
 * @property {number} reminderEveryMinutes
 *   Gap between repeat pushes for a still-due wave.
 * @property {AllowedHours} allowedHours
 *   Window during which the Worker may send. Evaluated in {@link timezone}.
 * @property {string} timezone
 *   IANA tz (e.g. `'Europe/Warsaw'`) the Worker uses to evaluate
 *   {@link allowedHours}. Defaulted from the browser at first init.
 * @property {number} maxNotificationsPerWave
 *   Hard cap on pushes per wave — anti-spam backstop for the case a wave
 *   is never re-sent (user's `maxNotificationsPerWave`, default 30).
 * @property {string} ntfyTopic
 *   ntfy.sh topic (acts as a shared secret). Empty until the user
 *   generates one on the histogram tab.
 * @property {number} gapSeconds
 *   Clustering threshold handed to `domain/waves.clusterWaves`.
 */

/**
 * Resolve the browser's IANA timezone, falling back to UTC where the
 * Intl API or a resolved zone is unavailable (old engines, node tests).
 *
 * @returns {string}
 */
const detectTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * Build the default config. `enabled` is false (opt-in) and `ntfyTopic`
 * empty so nothing is dispatched until the user finishes setup on the
 * histogram tab. Timezone is detected from the browser so the allowed
 * window means what the user expects without extra configuration.
 *
 * @returns {ReminderConfig}
 */
export const buildDefaultConfig = () => ({
  enabled: false,
  reminderEveryMinutes: 10,
  allowedHours: { start: '08:00', end: '23:00' },
  timezone: detectTimezone(),
  maxNotificationsPerWave: 30,
  ntfyTopic: '',
  gapSeconds: 300,
});

/**
 * Coerce an arbitrary stored value into a complete {@link ReminderConfig},
 * filling any missing field from the defaults. Tolerant by design — the
 * histogram and game sides may run different extension versions briefly
 * during an upgrade, so a config missing a newer field must still load.
 *
 * @param {unknown} raw
 * @returns {ReminderConfig}
 */
export const normalizeConfig = (raw) => {
  const d = buildDefaultConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const hours = /** @type {Record<string, unknown>} */ (
    r.allowedHours && typeof r.allowedHours === 'object' ? r.allowedHours : {}
  );
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    reminderEveryMinutes:
      Number.isFinite(r.reminderEveryMinutes) && Number(r.reminderEveryMinutes) > 0
        ? Number(r.reminderEveryMinutes)
        : d.reminderEveryMinutes,
    allowedHours: {
      start: typeof hours.start === 'string' ? hours.start : d.allowedHours.start,
      end: typeof hours.end === 'string' ? hours.end : d.allowedHours.end,
    },
    timezone: typeof r.timezone === 'string' && r.timezone ? r.timezone : d.timezone,
    maxNotificationsPerWave:
      Number.isFinite(r.maxNotificationsPerWave) && Number(r.maxNotificationsPerWave) > 0
        ? Number(r.maxNotificationsPerWave)
        : d.maxNotificationsPerWave,
    ntfyTopic: typeof r.ntfyTopic === 'string' ? r.ntfyTopic : d.ntfyTopic,
    gapSeconds:
      Number.isFinite(r.gapSeconds) && Number(r.gapSeconds) > 0
        ? Number(r.gapSeconds)
        : d.gapSeconds,
  };
};

/**
 * The reminder-config store. Starts at defaults; {@link initReminderConfig}
 * hydrates it from chrome.storage and keeps it mirrored both directions.
 *
 * @type {import('../lib/createStore.js').Store<ReminderConfig>}
 */
export const reminderConfigStore = createStore(buildDefaultConfig());

/** @type {(() => void) | null} */
let disposeFn = null;

/**
 * Wire {@link reminderConfigStore} to chrome.storage. Idempotent.
 *
 * Side effects, in order:
 *   1. Hydrate once from {@link REMINDER_CONFIG_KEY} (async; until it
 *      resolves the store holds defaults — callers reading early just
 *      see the opt-out default, which is safe).
 *   2. Write-through: a store subscription persists the whole config on
 *      every change. A re-entrancy guard (`applyingRemote`) prevents the
 *      onChanged → set → subscribe → write loop.
 *   3. onChanged: pick up edits made in the OTHER origin (histogram
 *      ↔ game) and push them into the store without a write-back.
 *
 * @returns {() => void} Dispose fn — cuts both the subscription and the
 *   onChanged listener. In-memory state survives.
 */
export const initReminderConfig = () => {
  if (disposeFn) return disposeFn;

  let applyingRemote = false;

  void chromeStore.get(REMINDER_CONFIG_KEY).then((raw) => {
    if (raw === undefined) {
      // First run on this device — seed storage with defaults so the
      // histogram and Worker have a concrete object to read.
      reminderConfigStore.set(buildDefaultConfig());
      return;
    }
    applyingRemote = true;
    reminderConfigStore.set(normalizeConfig(raw));
    applyingRemote = false;
  });

  const unsubStore = reminderConfigStore.subscribe((next) => {
    if (applyingRemote) return;
    void chromeStore.set(REMINDER_CONFIG_KEY, next);
  });

  const unsubChanged = chromeStore.onChanged((changes) => {
    if (!(REMINDER_CONFIG_KEY in changes)) return;
    const change = /** @type {{ newValue?: unknown }} */ (changes[REMINDER_CONFIG_KEY]);
    if (!change || change.newValue === undefined) return;
    applyingRemote = true;
    reminderConfigStore.set(normalizeConfig(change.newValue));
    applyingRemote = false;
  });

  disposeFn = () => {
    unsubStore();
    unsubChanged();
    disposeFn = null;
  };
  return disposeFn;
};

/**
 * Tear down the persistence wiring. Safe when never initialised.
 *
 * @returns {void}
 */
export const disposeReminderConfig = () => {
  if (disposeFn) disposeFn();
};

/**
 * Generate a hard-to-guess ntfy topic. ntfy topics are public-by-URL, so
 * the topic string is effectively the only access control — we want it
 * long and random. `oge-` prefix keeps it recognisable in the ntfy app.
 *
 * Uses `crypto.getRandomValues` when available (browser + modern node),
 * falling back to `Math.random` only in degraded contexts.
 *
 * @returns {string}
 */
export const generateNtfyTopic = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const len = 20;
  let out = '';
  const cryptoObj = /** @type {{ getRandomValues?: (a: Uint8Array) => Uint8Array }} */ (
    /** @type {unknown} */ (globalThis.crypto)
  );
  if (cryptoObj && cryptoObj.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(len));
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  } else {
    for (let i = 0; i < len; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  }
  return 'oge-' + out;
};
