// @ts-check

// Reminders config editor — the dashboard surface for the reminder knobs that
// moved out of the in-game AGR settings panel (see REFRESH-PLAN.md B3). It
// edits TWO stores with different scopes:
//
//   - GLOBAL (all servers): expedition-wave enable + schedule, and the ad-hoc
//     lead time. Backed by the global `reminderGlobalConfig` chrome.storage
//     slot (B3c). These apply to every universe.
//   - PER-SERVER (this server): fleet-save enable / ship threshold / min flight
//     time / landing-relative offset schedule. Backed by the per-universe
//     `galaxyScanConfig` slot (B3b) — the "big fleet" cutoff + flight-time gate
//     are speed-dependent, so they're server-scoped.
//
// Both chrome.storage surfaces are visible to the game origin AND this
// extension page, and both are already gist-synced whole-slot newest-wins.
// The scan-config editor (Galaxy Observations tab) writes the SAME per-universe
// slot, so the fleet-save save read-modify-writes it: each surface overlays
// only the fields it owns, so neither clobbers the other.
//
// Master switch + ntfy token stay in AGR (the credential is required there).
// All parsing/formatting lives in `domain/duration.js`.

import { chromeStore } from '../../lib/storage.js';
import {
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
} from '../../state/galaxyScanConfig.js';
import {
  REMINDER_GLOBAL_CONFIG_KEY,
  REMINDER_GLOBAL_CONFIG_TS_KEY,
} from '../../state/reminderGlobalConfig.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
} from '../../domain/galaxyScanConfig.js';
import {
  defaultReminderGlobalConfig,
  normalizeReminderGlobalConfig,
} from '../../domain/reminderGlobalConfig.js';
import {
  parseDuration, formatDuration, parseDurationList,
} from '../../domain/duration.js';

/**
 * Make an element with inline CSS + optional text (same tiny builder as
 * `dashboard/scanConfig.js`).
 *
 * @param {string} tag
 * @param {string} [css]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const mk = (tag, css, text) => {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (text != null) el.textContent = text;
  return el;
};

/**
 * Install the reminder config editor into `#reminderConfigBody`. Idempotent
 * per call site (the host installs once at boot); returns a `refresh()` the
 * host calls on universe change so the per-server fields reload for the
 * newly-selected server (the global fields are universe-independent).
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installReminderConfig = ({ getUniverseId }) => {
  const body = document.getElementById('reminderConfigBody');
  if (!body) return { refresh: () => {} };

  // ── global (all-servers) field widgets ───────────────────────────────
  // ids are OG-E's own hooks (not a game DOM contract) — kept next to the
  // code that emits them, used by the behavioural tests.
  const waveEnabledInput = /** @type {HTMLInputElement} */ (mk('input'));
  waveEnabledInput.type = 'checkbox';
  waveEnabledInput.id = 'remCfgWaveEnabled';

  const waveScheduleInput = /** @type {HTMLInputElement} */ (mk('input'));
  waveScheduleInput.type = 'text';
  waveScheduleInput.id = 'remCfgWaveSchedule';
  waveScheduleInput.size = 16;
  waveScheduleInput.placeholder = '0m, 10m, 30m, 60m';
  waveScheduleInput.title =
    'Reminder cadence AFTER a wave returns — a minutes-first list. e.g. 0m, 10m, 30m, 60m.';

  const adhocInput = /** @type {HTMLInputElement} */ (mk('input'));
  adhocInput.type = 'text';
  adhocInput.id = 'remCfgAdhoc';
  adhocInput.size = 8;
  adhocInput.placeholder = '1m';
  adhocInput.title =
    'How long before arrival an ad-hoc ping fires. Minutes-first (1m, 90s, 2h).';

  // ── per-server (fleet-save) field widgets ────────────────────────────
  const enabledInput = /** @type {HTMLInputElement} */ (mk('input'));
  enabledInput.type = 'checkbox';
  enabledInput.id = 'remCfgFsEnabled';

  const thresholdInput = /** @type {HTMLInputElement} */ (mk('input'));
  thresholdInput.type = 'text';
  thresholdInput.id = 'remCfgFsThreshold';
  thresholdInput.size = 8;
  thresholdInput.placeholder = 'e.g. 100000';
  thresholdInput.title =
    'A fleet whose total ship count crosses this is flagged 🛡 and gets a reminder series.';

  const minFlightInput = /** @type {HTMLInputElement} */ (mk('input'));
  minFlightInput.type = 'text';
  minFlightInput.id = 'remCfgFsMinFlight';
  minFlightInput.size = 8;
  minFlightInput.placeholder = 'e.g. 10m';
  minFlightInput.title =
    'Excludes short planet⇄moon hops. Minutes-first (10m, 90s, 1h). 0 disables the gate.';

  const offsetsInput = /** @type {HTMLInputElement} */ (mk('input'));
  offsetsInput.type = 'text';
  offsetsInput.id = 'remCfgFsOffsets';
  offsetsInput.size = 16;
  offsetsInput.placeholder = '-10m, 0m, 10m';
  offsetsInput.title =
    'Reminder offsets relative to landing — a minutes-first list. Negative = before landing, 0 = at landing, positive = after. e.g. -10m, 0m, 10m.';

  // ── layout ───────────────────────────────────────────────────────────
  body.textContent = '';

  /**
   * @param {string} labelText
   * @param {HTMLElement} control
   * @param {string} [hint]
   * @returns {HTMLElement}
   */
  const row = (labelText, control, hint) => {
    const r = mk('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
    const lbl = mk('label', 'min-width:230px;color:#ccc;font-size:13px;', labelText);
    r.appendChild(lbl);
    r.appendChild(control);
    if (hint) r.appendChild(mk('span', 'color:#666;font-size:12px;', hint));
    return r;
  };

  /** @param {string} text @returns {HTMLElement} */
  const groupHeading = (text) =>
    mk('div', 'color:#4a9eff;font-size:13px;font-weight:600;margin:4px 0 8px;', text);

  body.appendChild(groupHeading('Expedition waves & ad-hoc (all servers)'));
  body.appendChild(row('Expedition-wave reminders — enable', waveEnabledInput, 'auto-detect a returning wave + schedule a series'));
  body.appendChild(row('Wave reminder schedule', waveScheduleInput, 'after the wave returns, e.g. 0m, 10m, 30m, 60m'));
  body.appendChild(row('Ad-hoc reminders — lead time', adhocInput, 'before arrival, e.g. 1m'));

  body.appendChild(groupHeading('Fleet-save (this server)'));
  body.appendChild(row('Fleet-save reminders — enable', enabledInput, 'flag big own fleets 🛡 + ping before landing'));
  body.appendChild(row('Ship threshold', thresholdInput, 'total ships that count as a "big" fleet'));
  body.appendChild(row('Min flight time', minFlightInput, 'minutes-first, e.g. 10m · 0 = off'));
  body.appendChild(row('Reminder schedule', offsetsInput, 'relative to landing, e.g. -10m, 0m, 10m'));

  const statusEl = mk('span', 'margin-left:12px;font-size:13px;');
  statusEl.id = 'remCfgStatus';
  const saveBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Save config'));
  saveBtn.id = 'remCfgSave';
  const resetBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Reset to defaults'));
  resetBtn.id = 'remCfgReset';
  const controls = mk('div', 'margin-top:10px;display:flex;align-items:center;gap:8px;');
  controls.className = 'controls';
  controls.appendChild(saveBtn);
  controls.appendChild(resetBtn);
  controls.appendChild(statusEl);
  body.appendChild(controls);

  /**
   * @param {string} msg
   * @param {string} [color]
   */
  const setStatus = (msg, color) => {
    statusEl.textContent = msg;
    statusEl.style.color = color || '#888';
  };

  // ── load / fill / save ────────────────────────────────────────────────

  /** Populate the per-server widgets. @param {import('../../domain/galaxyScanConfig.js').GalaxyScanConfig} cfg */
  const fillFs = (cfg) => {
    enabledInput.checked = cfg.fsEnabled;
    thresholdInput.value = String(cfg.fsThreshold);
    minFlightInput.value = formatDuration(cfg.fsMinFlightSec);
    offsetsInput.value = cfg.fsOffsets;
  };

  /** Populate the global widgets. @param {import('../../domain/reminderGlobalConfig.js').ReminderGlobalConfig} cfg */
  const fillGlobal = (cfg) => {
    waveEnabledInput.checked = cfg.reminderEnabled;
    waveScheduleInput.value = cfg.reminderSchedule;
    adhocInput.value = formatDuration(cfg.adhocOffsetSec);
  };

  const refresh = async () => {
    // Global config is universe-independent — always load it.
    const storedGlobal = await chromeStore.get(REMINDER_GLOBAL_CONFIG_KEY);
    fillGlobal(normalizeReminderGlobalConfig(storedGlobal));

    const uni = getUniverseId();
    if (!uni) {
      fillFs(defaultGalaxyScanConfig());
      setStatus('No universe selected — fleet-save config is per-server.', '#e6a23c');
      return;
    }
    const stored = await chromeStore.get(galaxyScanConfigKeyFor(uni));
    fillFs(normalizeGalaxyScanConfig(stored));
    setStatus('');
  };

  /**
   * Read the per-server fleet-save widgets into a partial config, validating
   * the numeric/duration fields. Returns null + sets an error status on a bad
   * value. The offsets string is stored verbatim (the producer parses it with
   * the same grammar); an empty list is allowed (no fleet-save pings).
   *
   * @returns {Pick<import('../../domain/galaxyScanConfig.js').GalaxyScanConfig, 'fsEnabled' | 'fsThreshold' | 'fsMinFlightSec' | 'fsOffsets'> | null}
   */
  const collectFs = () => {
    const threshold = parseInt(thresholdInput.value, 10);
    if (!Number.isFinite(threshold) || threshold < 0) {
      setStatus('Ship threshold must be a non-negative whole number.', '#e66');
      return null;
    }
    const minFlight = parseDuration(minFlightInput.value);
    if (minFlight === null || minFlight < 0) {
      setStatus('Min flight time — use e.g. 10m, 90s, 1h, or 0.', '#e66');
      return null;
    }
    const offsets = offsetsInput.value.trim();
    if (offsets !== '' && parseDurationList(offsets, { signed: true }).length === 0) {
      setStatus('Fleet-save schedule — use a list like -10m, 0m, 10m (or leave empty).', '#e66');
      return null;
    }
    return {
      fsEnabled: enabledInput.checked,
      fsThreshold: threshold,
      fsMinFlightSec: minFlight,
      fsOffsets: offsets,
    };
  };

  /**
   * Read the global widgets into a complete {@link import('../../domain/reminderGlobalConfig.js').ReminderGlobalConfig},
   * validating the schedule + lead-time durations. Returns null + sets an error
   * on a bad value. The wave schedule is stored verbatim (the producer parses
   * it the same way); an empty list is allowed (no wave pings).
   *
   * @returns {import('../../domain/reminderGlobalConfig.js').ReminderGlobalConfig | null}
   */
  const collectGlobal = () => {
    const schedule = waveScheduleInput.value.trim();
    if (schedule !== '' && parseDurationList(schedule).length === 0) {
      setStatus('Wave schedule — use a list like 0m, 10m, 30m (or leave empty).', '#e66');
      return null;
    }
    const adhoc = parseDuration(adhocInput.value);
    if (adhoc === null || adhoc < 0) {
      setStatus('Ad-hoc lead time — use e.g. 1m, 90s, 2h.', '#e66');
      return null;
    }
    return {
      reminderEnabled: waveEnabledInput.checked,
      reminderSchedule: schedule,
      adhocOffsetSec: adhoc,
    };
  };

  const save = async () => {
    const global = collectGlobal();
    if (!global) return;
    const ownedFs = collectFs();
    if (!ownedFs) return;

    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected — pick a server to save fleet-save config.', '#e66'); return; }

    // Per-server fleet-save: read-modify-write so the scan-config fields (edited
    // from the Galaxy Observations tab) survive — both surfaces share one slot.
    const stored = normalizeGalaxyScanConfig(await chromeStore.get(galaxyScanConfigKeyFor(uni)));
    const cfg = normalizeGalaxyScanConfig({ ...stored, ...ownedFs });
    await chromeStore.set(galaxyScanConfigKeyFor(uni), cfg);
    await chromeStore.set(galaxyScanConfigTsKeyFor(uni), Date.now());

    // Global config: a complete slot of its own (no other fields to preserve),
    // its own whole-slot newest-wins timestamp.
    const globalCfg = normalizeReminderGlobalConfig(global);
    await chromeStore.set(REMINDER_GLOBAL_CONFIG_KEY, globalCfg);
    await chromeStore.set(REMINDER_GLOBAL_CONFIG_TS_KEY, Date.now());

    // One poke is enough — onForceSync runs a full round-trip that pushes BOTH
    // the per-universe galaxy-config slot AND the global reminder-config slot.
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());

    fillFs(cfg);
    fillGlobal(globalCfg);
    setStatus('Saved.', '#67c23a');
  };

  saveBtn.addEventListener('click', () => { void save(); });
  resetBtn.addEventListener('click', () => {
    fillGlobal(defaultReminderGlobalConfig());
    fillFs(defaultGalaxyScanConfig());
    setStatus('Defaults loaded — click Save to apply.', '#e6a23c');
  });

  return { refresh: () => void refresh() };
};
