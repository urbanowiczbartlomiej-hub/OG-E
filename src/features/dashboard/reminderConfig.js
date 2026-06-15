// @ts-check

// Reminders config editor — the dashboard surface for the per-universe
// FLEET-SAVE reminder knobs (enable / ship threshold / min flight time /
// landing-relative offset schedule). These moved out of the in-game AGR
// settings panel because they are SERVER-SCOPED (the "big fleet" cutoff and
// flight-time gate are speed-dependent) — see REFRESH-PLAN.md B3.
//
// They share the per-universe `galaxyScanConfig` slot (the only chrome.storage
// surface both the game origin and this extension page see, already gist-synced
// whole-slot newest-wins). The scan-config editor (Galaxy Observations tab)
// writes the SAME slot, so BOTH editors read-modify-write: each overlays only
// the fields it owns over the stored config, so neither clobbers the other.
//
// Master switch + ntfy token stay in AGR (the credential is required there);
// the wave/ad-hoc cadence stays global (a different store). This editor owns
// the `fs*` fields only. All parsing/formatting lives in `domain/duration.js`.

import { chromeStore } from '../../lib/storage.js';
import {
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
} from '../../state/galaxyScanConfig.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
} from '../../domain/galaxyScanConfig.js';
import { parseDuration, formatDuration, parseDurationList } from '../../domain/duration.js';

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
 * Install the fleet-save reminder config editor into `#reminderConfigBody`.
 * Idempotent per call site (the host installs once at boot); returns a
 * `refresh()` the host calls on universe change so the fields reload for the
 * newly-selected server.
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installReminderConfig = ({ getUniverseId }) => {
  const body = document.getElementById('reminderConfigBody');
  if (!body) return { refresh: () => {} };

  // ── field widgets ────────────────────────────────────────────────────
  // ids are OG-E's own hooks (not a game DOM contract) — kept next to the
  // code that emits them, used by the behavioural tests.
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

  /** Populate the widgets from a config. @param {import('../../domain/galaxyScanConfig.js').GalaxyScanConfig} cfg */
  const fill = (cfg) => {
    enabledInput.checked = cfg.fsEnabled;
    thresholdInput.value = String(cfg.fsThreshold);
    minFlightInput.value = formatDuration(cfg.fsMinFlightSec);
    offsetsInput.value = cfg.fsOffsets;
  };

  const refresh = async () => {
    const uni = getUniverseId();
    if (!uni) {
      fill(defaultGalaxyScanConfig());
      setStatus('No universe selected.', '#e66');
      return;
    }
    const stored = await chromeStore.get(galaxyScanConfigKeyFor(uni));
    fill(normalizeGalaxyScanConfig(stored));
    setStatus('');
  };

  /**
   * Read the widgets this editor owns into a partial config, validating the
   * numeric/duration fields. Returns null + sets an error status on a bad
   * value. The offsets string is stored verbatim (the producer parses it with
   * the same grammar); an empty list is allowed (no fleet-save pings).
   *
   * @returns {Pick<import('../../domain/galaxyScanConfig.js').GalaxyScanConfig, 'fsEnabled' | 'fsThreshold' | 'fsMinFlightSec' | 'fsOffsets'> | null}
   */
  const collect = () => {
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
      setStatus('Reminder schedule — use a list like -10m, 0m, 10m (or leave empty).', '#e66');
      return null;
    }
    return {
      fsEnabled: enabledInput.checked,
      fsThreshold: threshold,
      fsMinFlightSec: minFlight,
      fsOffsets: offsets,
    };
  };

  const save = async () => {
    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected.', '#e66'); return; }
    const owned = collect();
    if (!owned) return;
    // Read-modify-write so the scan-config fields (edited from the Galaxy
    // Observations tab) survive a reminders save — both surfaces share one slot.
    const stored = normalizeGalaxyScanConfig(await chromeStore.get(galaxyScanConfigKeyFor(uni)));
    const cfg = normalizeGalaxyScanConfig({ ...stored, ...owned });
    await chromeStore.set(galaxyScanConfigKeyFor(uni), cfg);
    // Stamp the whole-slot newest-wins clock + poke any open game tab to push
    // to the gist — same trio the scan-config / routes editors write on save.
    await chromeStore.set(galaxyScanConfigTsKeyFor(uni), Date.now());
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());
    fill(cfg);
    setStatus('Saved.', '#67c23a');
  };

  saveBtn.addEventListener('click', () => { void save(); });
  resetBtn.addEventListener('click', () => {
    const d = defaultGalaxyScanConfig();
    enabledInput.checked = d.fsEnabled;
    thresholdInput.value = String(d.fsThreshold);
    minFlightInput.value = formatDuration(d.fsMinFlightSec);
    offsetsInput.value = d.fsOffsets;
    setStatus('Defaults loaded — click Save to apply.', '#e6a23c');
  });

  return { refresh: () => void refresh() };
};
