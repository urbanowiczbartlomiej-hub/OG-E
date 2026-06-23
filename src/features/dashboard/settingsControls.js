// @ts-check
//
// Dashboard-side controls for the four cross-universe shared settings that
// moved out of the in-game panel: the Multi-device-sync switch + GitHub token
// (Sync tab) and the alarmClock master switch + ntfy token (AlarmClock tab).
//
// All four live in the chrome.storage dict that state/sharedSettings.js bridges
// into every game origin — the dashboard is the SOLE writer. This module reads
// that dict to fill the inputs, writes edits straight back, drives "Sync now"
// (via the per-universe syncRequest channel the scheduler already watches), and
// runs live token validation. The inputs themselves live in dashboard.html
// under #syncSection / #alarmClockSection; here we only wire them by id.

/* global fetch */

import { chromeStore } from '../../lib/storage.js';
import { SHARED_SETTINGS_KEY } from '../../state/sharedSettings.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import { fetchNtfyAccount } from '../../sync/ntfyAccount.js';
import { formatNtfyAccountLines } from '../../domain/ntfyAccount.js';
import { ALARM_CLOCK_NTFY_TOKEN_KEY, isValidNtfyToken } from '../../sync/alarmClock.js';
import { SYNC_STATUS_BASE } from './syncInventory.js';

/**
 * Read the shared-settings dict, normalised to the four known fields.
 *
 * @returns {Promise<{ cloudSync: boolean, gistToken: string, alarmClockMasterEnabled: boolean, alarmClockNtfyToken: string }>}
 */
const readShared = async () => {
  const raw = await chromeStore.get(SHARED_SETTINGS_KEY);
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    cloudSync: typeof o.cloudSync === 'boolean' ? o.cloudSync : false,
    gistToken: typeof o.gistToken === 'string' ? o.gistToken : '',
    alarmClockMasterEnabled:
      typeof o.alarmClockMasterEnabled === 'boolean' ? o.alarmClockMasterEnabled : false,
    alarmClockNtfyToken: typeof o.alarmClockNtfyToken === 'string' ? o.alarmClockNtfyToken : '',
  };
};

/**
 * Read-modify-write a patch into the shared-settings dict.
 *
 * @param {Partial<{ cloudSync: boolean, gistToken: string, alarmClockMasterEnabled: boolean, alarmClockNtfyToken: string }>} patch
 * @returns {Promise<void>}
 */
const writeShared = async (patch) => {
  const cur = await readShared();
  await chromeStore.set(SHARED_SETTINGS_KEY, { ...cur, ...patch });
};

/**
 * Poke every universe's scheduler to sync now, using the per-universe
 * syncRequest key the game-origin scheduler already watches via
 * chrome.storage.onChanged. Universes are discovered from the namespaced
 * `<id>:oge_*` keys present in storage.
 *
 * @returns {Promise<void>}
 */
const requestSyncAll = async () => {
  const all = await chromeStore.getAll();
  /** @type {Set<string>} */
  const ids = new Set();
  for (const key of Object.keys(all)) {
    const i = key.indexOf(':');
    if (i > 0 && key.slice(i + 1).startsWith('oge_')) ids.add(key.slice(0, i));
  }
  const now = Date.now();
  await Promise.all([...ids].map((id) => chromeStore.set(syncRequestKeyFor(id), now)));
};

/**
 * Validate a GitHub PAT against `/user`. Done here (not via gist.js
 * `validateToken`) because that reads the game origin's localStorage, which
 * this extension-origin page can't see — so we probe with the explicit token.
 *
 * @param {string} token
 * @returns {Promise<string>}
 */
const validateGistToken = async (token) => {
  if (!token) return '✗ No token set';
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return `✗ ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
    const user = await res.json();
    const login = user && typeof user.login === 'string' ? user.login : '?';
    return `✓ Valid — ${login}`;
  } catch (err) {
    return `✗ ${err instanceof Error ? err.message : 'network error'}`;
  }
};

/**
 * Wire the moved settings controls. Idempotent enough for a single boot call;
 * each input is optional (guards on null) so a partial DOM never throws.
 *
 * @returns {void}
 */
export const installSettingsControls = () => {
  const cloud = /** @type {HTMLInputElement | null} */ (document.getElementById('syncCloudToggle'));
  const gist = /** @type {HTMLInputElement | null} */ (document.getElementById('syncGistToken'));
  const syncNow = document.getElementById('syncNowBtn');
  const gistStatus = document.getElementById('syncTokenStatus');
  const gistReveal = document.getElementById('syncRevealGist');
  const syncControlsBody = document.getElementById('syncControlsBody');

  // The "Sync across devices" switch gates the credential controls, mirroring
  // the alarmClock master switch: with sync off there's no token to configure,
  // so the token row + status + note collapse. (The per-universe inventory
  // below stays — it's local-data info, independent of the sync toggle.)
  const syncControlsVisibility = () => {
    if (syncControlsBody && cloud) syncControlsBody.style.display = cloud.checked ? '' : 'none';
  };
  const master = /** @type {HTMLInputElement | null} */ (document.getElementById('remMasterToggle'));
  const ntfy = /** @type {HTMLInputElement | null} */ (document.getElementById('remNtfyToken'));
  const ntfyStatus = document.getElementById('remTokenStatus');
  const ntfyReveal = document.getElementById('remRevealNtfy');
  const ntfyValidate = document.getElementById('remValidateBtn');
  const remBody = document.getElementById('remBody');

  // The master switch gates the rest of the tab: with alarmClock off there's
  // nothing to configure, so the whole body below it collapses out of view.
  const syncRemBodyVisibility = () => {
    if (remBody && master) remBody.style.display = master.checked ? '' : 'none';
  };

  // Render the ntfy account probe under the token: a ✓/✗ head plus, on success,
  // the login + tier and the message usage drawn from the account. Built with
  // textContent throughout so an account field can't inject markup.
  const renderNtfyStatus = (/** @type {import('../../domain/ntfyAccount.js').NtfyAccountResult} */ result) => {
    if (!ntfyStatus) return;
    const { ok, head, detail } = formatNtfyAccountLines(result);
    ntfyStatus.textContent = '';
    const headEl = document.createElement('div');
    headEl.textContent = head;
    headEl.className = ok ? 'rem-status-head ok' : 'rem-status-head err';
    ntfyStatus.appendChild(headEl);
    for (const line of detail) {
      const d = document.createElement('div');
      d.className = 'rem-substatus';
      d.textContent = line;
      ntfyStatus.appendChild(d);
    }
  };

  const populate = async () => {
    const s = await readShared();
    const active = document.activeElement;
    if (cloud && cloud !== active) cloud.checked = s.cloudSync;
    if (gist && gist !== active) gist.value = s.gistToken;
    if (master && master !== active) master.checked = s.alarmClockMasterEnabled;
    if (ntfy && ntfy !== active) ntfy.value = s.alarmClockNtfyToken;
    syncRemBodyVisibility();
    syncControlsVisibility();
  };
  void populate();

  cloud?.addEventListener('change', () => {
    void writeShared({ cloudSync: cloud.checked });
    syncControlsVisibility();
  });

  // GitHub token reveal (password ↔ text), mirroring the ntfy + topic eyes.
  gistReveal?.addEventListener('click', () => {
    if (!gist) return;
    const reveal = gist.type === 'password';
    gist.type = reveal ? 'text' : 'password';
    gistReveal.classList.toggle('revealed', reveal);
    gistReveal.setAttribute('aria-pressed', String(reveal));
  });
  master?.addEventListener('change', () => {
    void writeShared({ alarmClockMasterEnabled: master.checked });
    syncRemBodyVisibility();
  });

  // Tokens persist on change (blur / Enter), trimmed.
  gist?.addEventListener('change', () => {
    const t = gist.value.trim();
    gist.value = t;
    void writeShared({ gistToken: t });
  });
  ntfy?.addEventListener('change', () => {
    const t = ntfy.value.trim();
    ntfy.value = t;
    void writeShared({ alarmClockNtfyToken: t });
    // Keep the preview mirror (ALARM_CLOCK_NTFY_TOKEN_KEY) in lockstep so the
    // AlarmClock tab's derived topic + queue fetch update immediately, rather
    // than only after a game tab's producer next mirrors it. Mirror only a
    // valid token (matching the producer's guard); clearing the token removes
    // the mirror so "clear token = alarmClock off" takes effect at once instead
    // of the stale mirror keeping the old topic alive.
    if (isValidNtfyToken(t)) void chromeStore.set(ALARM_CLOCK_NTFY_TOKEN_KEY, t);
    else if (!t) void chromeStore.remove(ALARM_CLOCK_NTFY_TOKEN_KEY);
    // The token changed — any earlier validation verdict is now stale.
    if (ntfyStatus) ntfyStatus.textContent = '—';
  });

  // Token reveal (password ↔ text), mirroring the topic row's eye toggle: a
  // diagonal slash over the glyph signals the revealed state (see .rem-eye CSS).
  ntfyReveal?.addEventListener('click', () => {
    if (!ntfy) return;
    const reveal = ntfy.type === 'password';
    ntfy.type = reveal ? 'text' : 'password';
    ntfyReveal.classList.toggle('revealed', reveal);
    ntfyReveal.setAttribute('aria-pressed', String(reveal));
  });

  // Validate button — replaces the (meaningless-for-a-token) Copy the topic
  // row has: an explicit live probe of the ntfy account.
  ntfyValidate?.addEventListener('click', () => {
    if (!ntfyStatus) return;
    ntfyStatus.textContent = 'Checking…';
    void fetchNtfyAccount(ntfy?.value.trim() ?? '').then(renderNtfyStatus);
  });

  // "Sync now" folds in token validation (mirrors the old in-game UX): validate
  // first (painted), then signal every universe's scheduler.
  syncNow?.addEventListener('click', () => {
    if (gistStatus) gistStatus.textContent = 'Validating…';
    void validateGistToken(gist?.value.trim() ?? '').then((line) => {
      if (gistStatus) gistStatus.textContent = `${line} · syncing…`;
      void requestSyncAll();
      // Drop the "syncing…" suffix once a sync round actually lands (any
      // per-universe status mirror changes) or after a fallback timeout — the
      // sync runs on the game origin, so without this the label would stick
      // forever even though the data refreshed.
      let settled = false;
      let stop = () => {};
      let timer = 0;
      const settle = () => {
        if (settled) return;
        settled = true;
        stop();
        clearTimeout(timer);
        if (gistStatus) gistStatus.textContent = line;
      };
      stop = chromeStore.onChanged((changes) => {
        if (Object.keys(changes).some((k) => k.endsWith(`:${SYNC_STATUS_BASE}`))) settle();
      });
      timer = setTimeout(settle, 8000);
    });
  });

  // Reflect edits made from another dashboard tab.
  chromeStore.onChanged((changes) => {
    if (SHARED_SETTINGS_KEY in changes) void populate();
  });
};
