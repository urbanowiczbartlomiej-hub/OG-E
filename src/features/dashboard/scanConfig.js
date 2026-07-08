// @ts-check

// Per-universe colonization config — ONE editor on the Colonizations tab,
// backed by ONE shared `chrome.storage.local` slot (`<uni>:oge_galaxyScanConfig`).
// It carries the colonization knobs (target positions, prefer-other-galaxies,
// arrival gap, abandon threshold, abandon password).
//
// (§5d removed the per-status "Re-scan after" policy that used to share this
// editor: galaxy occupancy is now re-derived from the OGame API and
// colonization state lives in the decision log with its own built-in horizons.)
//
// Save is read-modify-write so the fields it does NOT own (the AlarmClock tab's
// fleet-save `fs*` knobs, which share the same slot) are never clobbered.
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
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
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
    // AlarmClock tab's fleet-save knobs) survive — all three share one slot.
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

  const showFabInput = /** @type {HTMLInputElement} */ (mk('input'));
  showFabInput.type = 'checkbox';
  showFabInput.id = 'scanCfgShowFab';
  showFabInput.title =
    'Show the Colonize button on the in-game floating button. Off hides the module '
    + '(and its orbit orb); scanning, decisions and this dashboard keep working.';

  const preferFarthestInput = /** @type {HTMLInputElement} */ (mk('input'));
  preferFarthestInput.type = 'checkbox';
  preferFarthestInput.id = 'scanCfgPreferFarthest';
  preferFarthestInput.title =
    'Within your home galaxy, propose the farthest free system first (spreads colony-ship arrival times). Uncheck to propose the nearest free system first.';

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

  // Packed into the same responsive grid (1 → 2 → 3 columns) the rescan
  // fields use, so both groups of the combined editor read as columns rather
  // than one tall single-column stack.
  const grid = mk('div');
  grid.className = 'cfg-grid';
  grid.appendChild(row('Target positions', positionsInput, 'list or range, e.g. 7-9, 15'));
  grid.appendChild(row('Colonize button on the FAB', showFabInput, 'off = hide the in-game button'));
  grid.appendChild(row('Prefer neighbouring galaxies', preferInput, 'more predictable arrival times'));
  grid.appendChild(row('Prefer farthest systems first', preferFarthestInput, 'better arrival spread; off = nearest first'));
  grid.appendChild(row('Min gap between arrivals (sec)', colonyMinGapInput));
  grid.appendChild(row('Min fields to keep colony', colonyMinFieldsInput));
  grid.appendChild(row('Account password (for abandon)', colonyPasswordInput));
  body.appendChild(grid);

  return {
    fill: (cfg) => {
      positionsInput.value = cfg.positions;
      showFabInput.checked = cfg.showFabButton;
      preferInput.checked = cfg.preferOtherGalaxies;
      preferFarthestInput.checked = cfg.preferFarthestSystems;
      colonyMinGapInput.value = String(cfg.colonyMinGap);
      colonyMinFieldsInput.value = String(cfg.colonyMinFields);
      colonyPasswordInput.value = cfg.colonyPassword;
    },
    collect: () => ({
      positions: positionsInput.value.trim(),
      showFabButton: showFabInput.checked,
      preferOtherGalaxies: preferInput.checked,
      preferFarthestSystems: preferFarthestInput.checked,
      colonyMinGap: parseInt(colonyMinGapInput.value, 10),
      colonyMinFields: parseInt(colonyMinFieldsInput.value, 10),
      colonyPassword: colonyPasswordInput.value,
    }),
  };
};

/**
 * Compose the Colonizations-tab config form. Since §5d removed the per-status
 * "Re-scan after" policy (occupancy freshness comes from the API; colonization
 * state from the decision log with its own horizons), this is now just the
 * colonization & abandon group under a single Save/Reset.
 *
 * @param {HTMLElement} body
 * @returns {EditorFields}
 */
const buildScanColonyFields = (body) => {
  body.appendChild(groupHeading('Colonization & abandon'));
  return buildColonizationFields(body);
};

/**
 * Install the colonization config editor into `#colonizationConfigBody`
 * (Colonizations tab's ⚙ Settings). Returns a `refresh()` the host calls on
 * universe change.
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installScanColonyConfig = ({ getUniverseId }) =>
  installConfigEditor({
    getUniverseId,
    containerId: 'colonizationConfigBody',
    build: buildScanColonyFields,
  });
