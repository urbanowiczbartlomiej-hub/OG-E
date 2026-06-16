// @ts-check

// Galaxy-Scan config editor — the dashboard surface for the per-universe
// scan strategy (target positions, prefer-other-galaxies, and the per-status
// rescan policy). Installed like the routes tab: the host passes a
// `getUniverseId` getter and we read/write `chrome.storage.local` directly
// (the store both the game origin and this extension page share).
//
// Saving writes three keys, mirroring `dashboard/routes.js`:
//   1. `<uni>:oge_galaxyScanConfig`   — the config value
//   2. `<uni>:oge_galaxyScanConfigTs` — the whole-slot newest-wins clock
//   3. `<uni>:oge_syncRequestAt`      — pokes any open game tab to push to
//      the gist (harmless no-op when cloud sync is off)
//
// All parsing / formatting / defaults live in the pure
// `domain/galaxyScanConfig.js`; this module is DOM glue only.

import { chromeStore } from '../../lib/storage.js';
import {
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
} from '../../state/galaxyScanConfig.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  RESCAN_FIELDS,
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
  parseRescanDuration,
  formatRescanDuration,
} from '../../domain/galaxyScanConfig.js';

/**
 * Make an element with inline CSS + optional text (same tiny builder as
 * `dashboard/routes.js`).
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
 * Install the Galaxy-Scan config editor into `#scanConfigBody`. Idempotent
 * per call site (the host installs once at boot); returns a `refresh()` the
 * host calls on universe change so the fields reload for the new server.
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installScanConfig = ({ getUniverseId }) => {
  const body = document.getElementById('scanConfigBody');
  if (!body) return { refresh: () => {} };

  // ── field widgets ────────────────────────────────────────────────────
  // ids / data-field are OG-E's own hooks (not a game DOM contract) — kept
  // next to the code that emits them, and used by the behavioural tests.
  const positionsInput = /** @type {HTMLInputElement} */ (mk('input'));
  positionsInput.type = 'text';
  positionsInput.id = 'scanCfgPositions';
  positionsInput.size = 14;
  positionsInput.placeholder = 'e.g. 8,10-12,15';
  positionsInput.title =
    'Target positions (only these count as colonizable / drive the Scan + Colonize buttons). A list or range, e.g. 8,10-12,15.';

  const preferInput = /** @type {HTMLInputElement} */ (mk('input'));
  preferInput.type = 'checkbox';
  preferInput.id = 'scanCfgPrefer';

  const abandonedInput = /** @type {HTMLInputElement} */ (mk('input'));
  abandonedInput.type = 'checkbox';
  abandonedInput.id = 'scanCfgAbandoned';

  // Colonization knobs (moved here from the in-game AGR settings panel so
  // they live in one per-universe, cross-device-synced config). min-gap drives
  // the Send-Col scheduling guard; min-fields + password drive the
  // abandon-overview flow.
  const colonyMinGapInput = /** @type {HTMLInputElement} */ (mk('input'));
  colonyMinGapInput.type = 'text';
  colonyMinGapInput.id = 'scanCfgColonyMinGap';
  colonyMinGapInput.size = 8;
  colonyMinGapInput.placeholder = 'e.g. 20';
  colonyMinGapInput.title =
    'Minimum seconds between two colony-ship arrivals — the Send-Col button waits out this gap to avoid stacking arrivals.';

  const colonyMinFieldsInput = /** @type {HTMLInputElement} */ (mk('input'));
  colonyMinFieldsInput.type = 'text';
  colonyMinFieldsInput.id = 'scanCfgColonyMinFields';
  colonyMinFieldsInput.size = 8;
  colonyMinFieldsInput.placeholder = 'e.g. 200';
  colonyMinFieldsInput.title =
    'A fresh colony with fewer than this many fields is offered for abandon on its overview page.';

  const colonyPasswordInput = /** @type {HTMLInputElement} */ (mk('input'));
  colonyPasswordInput.type = 'password';
  colonyPasswordInput.id = 'scanCfgColonyPassword';
  colonyPasswordInput.size = 14;
  colonyPasswordInput.title =
    'Account password, autofilled into the game’s give-up confirmation form during the abandon flow.';

  /** @type {Map<string, HTMLInputElement>} rescan field id → text input */
  const rescanInputs = new Map();

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

  body.appendChild(mk('div', 'margin:10px 0 4px;color:#4a9eff;font-size:13px;font-weight:bold;', 'Colonization'));
  body.appendChild(row('Target positions', positionsInput, 'list or range, e.g. 7-9, 15'));
  body.appendChild(row('Prefer neighbouring galaxies', preferInput, 'more predictable arrival times'));
  body.appendChild(row('Min gap between arrivals (sec)', colonyMinGapInput));
  body.appendChild(row('Min fields to keep colony', colonyMinFieldsInput));
  body.appendChild(row('Account password (for abandon)', colonyPasswordInput));

  body.appendChild(mk('div', 'margin:10px 0 4px;color:#4a9eff;font-size:13px;font-weight:bold;', 'Re-scan after (0 = never):'));

  for (const { field, label } of RESCAN_FIELDS) {
    const input = /** @type {HTMLInputElement} */ (mk('input'));
    input.type = 'text';
    input.size = 8;
    input.dataset.field = field;
    input.title = `How long a "${label}" slot stays fresh before Scan revisits it. Free units: 6h, 5d, 90m. 0 = never.`;
    rescanInputs.set(field, input);
    body.appendChild(row(label, input));
  }

  body.appendChild(row('Re-scan abandoned (3 AM sweep)', abandonedInput, 'dynamic 25-47h timing'));

  const statusEl = mk('span', 'margin-left:12px;font-size:13px;');
  statusEl.id = 'scanCfgStatus';
  const saveBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Save config'));
  saveBtn.id = 'scanCfgSave';
  const resetBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Reset to defaults'));
  resetBtn.id = 'scanCfgReset';
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

  /** Populate every widget from a config object. @param {import('../../domain/galaxyScanConfig.js').GalaxyScanConfig} cfg */
  const fill = (cfg) => {
    positionsInput.value = cfg.positions;
    preferInput.checked = cfg.preferOtherGalaxies;
    colonyMinGapInput.value = String(cfg.colonyMinGap);
    colonyMinFieldsInput.value = String(cfg.colonyMinFields);
    colonyPasswordInput.value = cfg.colonyPassword;
    abandonedInput.checked = cfg.rescan.abandonedEnabled;
    for (const { field } of RESCAN_FIELDS) {
      const input = rescanInputs.get(field);
      // RESCAN_FIELDS only lists duration fields, so the value is a number
      // (abandonedEnabled is handled separately above) — assert it for tsc.
      if (input) input.value = formatRescanDuration(/** @type {number} */ (cfg.rescan[field]));
    }
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
   * Read every widget this editor owns into a partial config, rejecting an
   * unparseable rescan field (keeps the user honest about the `6h`/`5d`/`0`
   * grammar). Returns null + sets an error status when any field is invalid.
   *
   * The fleet-save knobs (`fs*`) live in the SAME per-universe slot but are
   * edited from the Reminders tab, so they are deliberately NOT in this
   * partial — {@link save} merges it over the stored config so a scan-config
   * save never clobbers them.
   *
   * @returns {Partial<import('../../domain/galaxyScanConfig.js').GalaxyScanConfig> | null}
   */
  const collect = () => {
    /** @type {Record<string, number | boolean>} */
    const rescan = {};
    for (const { field, label } of RESCAN_FIELDS) {
      const input = rescanInputs.get(field);
      const secs = parseRescanDuration(input ? input.value : '');
      if (secs === null) {
        setStatus(`Invalid time for "${label}" — use e.g. 6h, 5d, or 0.`, '#e66');
        return null;
      }
      rescan[field] = secs;
    }
    rescan.abandonedEnabled = abandonedInput.checked;
    return {
      positions: positionsInput.value.trim(),
      preferOtherGalaxies: preferInput.checked,
      colonyMinGap: parseInt(colonyMinGapInput.value, 10),
      colonyMinFields: parseInt(colonyMinFieldsInput.value, 10),
      colonyPassword: colonyPasswordInput.value,
      rescan: /** @type {import('../../domain/galaxyScanConfig.js').GalaxyScanRescan} */ (rescan),
    };
  };

  const save = async () => {
    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected.', '#e66'); return; }
    const owned = collect();
    if (!owned) return;
    // Read-modify-write so the per-universe fleet-save knobs (edited from the
    // Reminders tab) survive a scan-config save — both surfaces share one slot.
    const stored = normalizeGalaxyScanConfig(await chromeStore.get(galaxyScanConfigKeyFor(uni)));
    const cfg = normalizeGalaxyScanConfig({ ...stored, ...owned });
    await chromeStore.set(galaxyScanConfigKeyFor(uni), cfg);
    // Stamp the whole-slot newest-wins clock and poke any open game tab to
    // push to the gist — same trio the routes editor writes on save.
    await chromeStore.set(galaxyScanConfigTsKeyFor(uni), Date.now());
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());
    fill(cfg);
    setStatus('Saved.', '#67c23a');
  };

  saveBtn.addEventListener('click', () => { void save(); });
  resetBtn.addEventListener('click', () => {
    fill(defaultGalaxyScanConfig());
    setStatus('Defaults loaded — click Save to apply.', '#e6a23c');
  });

  return { refresh: () => void refresh() };
};
