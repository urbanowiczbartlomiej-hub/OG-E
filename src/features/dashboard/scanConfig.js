// @ts-check

// Per-universe scan/colonization config — split across TWO dashboard tabs but
// backed by ONE shared `chrome.storage.local` slot (`<uni>:oge_galaxyScanConfig`):
//
//   - Colonization knobs (target positions, prefer-other-galaxies, arrival gap,
//     abandon threshold, abandon password) live on the Colonizations tab.
//   - Scan / re-scan policy (per-status rescan times + the abandoned sweep)
//     lives on the Galaxy Observations tab.
//
// Both are built by the same generic {@link installConfigEditor}. Each editor
// owns only its subset of fields and saves via read-modify-write merge, so the
// two surfaces (and the Reminders tab's fleet-save knobs, which share the same
// slot) never clobber each other.
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
 * A labelled config row: `<label> <control> <hint?>`.
 *
 * @param {string} labelText
 * @param {HTMLElement} control
 * @param {string} [hint]
 * @returns {HTMLElement}
 */
const row = (labelText, control, hint) => {
  const r = mk('div');
  r.className = 'cfg-row';
  const lbl = mk('label', undefined, labelText);
  lbl.className = 'cfg-label';
  r.appendChild(lbl);
  const field = mk('div');
  field.className = 'cfg-field';
  field.appendChild(control);
  if (hint) {
    const h = mk('span', undefined, hint);
    h.className = 'cfg-hint';
    field.appendChild(h);
  }
  r.appendChild(field);
  return r;
};

/** A blue sub-group heading inside an editor body. @param {string} text @returns {HTMLElement} */
const groupHeading = (text) => {
  const el = mk('div', undefined, text);
  el.className = 'cfg-group';
  return el;
};

/**
 * @typedef {import('../../domain/galaxyScanConfig.js').GalaxyScanConfig} GalaxyScanConfig
 */

/**
 * What an editor's field-builder returns: how to paint the widgets from a
 * config, and how to read them back into the subset of config this editor owns.
 *
 * @typedef {object} EditorFields
 * @property {(cfg: GalaxyScanConfig) => void} fill
 *   Paint this editor's widgets from a (normalized) full config.
 * @property {() => Partial<GalaxyScanConfig> | null} collect
 *   Read this editor's widgets into a partial config, or `null` when a field
 *   is invalid (the builder sets an error status before returning null).
 */

/**
 * Generic per-universe config editor over the shared `galaxyScanConfig` slot.
 * `build(body, setStatus)` populates `body` with the editor's widgets and
 * returns its {@link EditorFields}; this wrapper adds the Save / Reset /
 * status controls and the load+merge plumbing. Save is read-modify-write so
 * an editor only ever overwrites the fields it owns.
 *
 * @param {object} opts
 * @param {() => string} opts.getUniverseId
 * @param {string} opts.containerId   id of the (already-present) body element.
 * @param {(body: HTMLElement, setStatus: (msg: string, color?: string) => void) => EditorFields} opts.build
 * @returns {{ refresh: () => void }}
 */
const installConfigEditor = ({ getUniverseId, containerId, build }) => {
  const body = document.getElementById(containerId);
  if (!body) return { refresh: () => {} };
  body.textContent = '';

  const statusEl = mk('span', 'margin-left:12px;font-size:13px;');
  statusEl.className = 'scanCfgStatus';
  /** @param {string} msg @param {string} [color] */
  const setStatus = (msg, color) => {
    statusEl.textContent = msg;
    statusEl.style.color = color || '#888';
  };

  const { fill, collect } = build(body, setStatus);

  const saveBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Save config'));
  saveBtn.className = 'scanCfgSave';
  const resetBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Reset to defaults'));
  resetBtn.className = 'scanCfgReset';
  const controls = mk('div', 'margin-top:10px;display:flex;align-items:center;gap:8px;');
  controls.className = 'controls';
  controls.appendChild(saveBtn);
  controls.appendChild(resetBtn);
  controls.appendChild(statusEl);
  body.appendChild(controls);

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

  const save = async () => {
    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected.', '#e66'); return; }
    const owned = collect();
    if (!owned) return;
    // Read-modify-write so the fields owned by the OTHER editor (and the
    // Reminders tab's fleet-save knobs) survive — all three share one slot.
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

/**
 * Build the Colonization editor's widgets (positions, prefer-other-galaxies,
 * arrival gap, abandon threshold, abandon password). The min-gap drives the
 * Send-Col scheduling guard; min-fields + password drive the abandon-overview
 * flow. ids are OG-E's own hooks (not a game DOM contract).
 *
 * @param {HTMLElement} body
 * @returns {EditorFields}
 */
const buildColonizationFields = (body) => {
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

  body.appendChild(row('Target positions', positionsInput, 'list or range, e.g. 7-9, 15'));
  body.appendChild(row('Prefer neighbouring galaxies', preferInput, 'more predictable arrival times'));
  body.appendChild(row('Min gap between arrivals (sec)', colonyMinGapInput));
  body.appendChild(row('Min fields to keep colony', colonyMinFieldsInput));
  body.appendChild(row('Account password (for abandon)', colonyPasswordInput));

  return {
    fill: (cfg) => {
      positionsInput.value = cfg.positions;
      preferInput.checked = cfg.preferOtherGalaxies;
      colonyMinGapInput.value = String(cfg.colonyMinGap);
      colonyMinFieldsInput.value = String(cfg.colonyMinFields);
      colonyPasswordInput.value = cfg.colonyPassword;
    },
    collect: () => ({
      positions: positionsInput.value.trim(),
      preferOtherGalaxies: preferInput.checked,
      colonyMinGap: parseInt(colonyMinGapInput.value, 10),
      colonyMinFields: parseInt(colonyMinFieldsInput.value, 10),
      colonyPassword: colonyPasswordInput.value,
    }),
  };
};

/**
 * Build the Scan re-scan editor's widgets (per-status rescan durations + the
 * 3 AM abandoned sweep). Rejects an unparseable rescan field on collect.
 *
 * @param {HTMLElement} body
 * @param {(msg: string, color?: string) => void} setStatus
 * @returns {EditorFields}
 */
const buildScanRescanFields = (body, setStatus) => {
  const abandonedInput = /** @type {HTMLInputElement} */ (mk('input'));
  abandonedInput.type = 'checkbox';
  abandonedInput.id = 'scanCfgAbandoned';

  /** @type {Map<string, HTMLInputElement>} rescan field id → text input */
  const rescanInputs = new Map();

  body.appendChild(groupHeading('Re-scan after (0 = never):'));
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

  return {
    fill: (cfg) => {
      abandonedInput.checked = cfg.rescan.abandonedEnabled;
      for (const { field } of RESCAN_FIELDS) {
        const input = rescanInputs.get(field);
        // RESCAN_FIELDS only lists duration fields, so the value is a number
        // (abandonedEnabled is handled separately above) — assert it for tsc.
        if (input) input.value = formatRescanDuration(/** @type {number} */ (cfg.rescan[field]));
      }
    },
    collect: () => {
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
        rescan: /** @type {import('../../domain/galaxyScanConfig.js').GalaxyScanRescan} */ (rescan),
      };
    },
  };
};

/**
 * Install the Colonization config editor into `#colonizationConfigBody`
 * (Colonizations tab). Returns a `refresh()` the host calls on universe change.
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installColonizationConfig = ({ getUniverseId }) =>
  installConfigEditor({
    getUniverseId,
    containerId: 'colonizationConfigBody',
    build: buildColonizationFields,
  });

/**
 * Install the Scan re-scan config editor into `#scanRescanBody`
 * (Galaxy Observations tab). Returns a `refresh()` the host calls on universe
 * change.
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installScanRescanConfig = ({ getUniverseId }) =>
  installConfigEditor({
    getUniverseId,
    containerId: 'scanRescanBody',
    build: buildScanRescanFields,
  });
