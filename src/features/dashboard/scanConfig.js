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
// AUTOSAVE: every control persists on change (debounced) — there is no Save
// button. The write is read-modify-write so the fields this editor does NOT
// own (the AlarmClock tab's fleet-save `fs*` knobs, which share the same
// slot) are never clobbered.
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
import { createAutosave } from './autosave.js';
import {
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
} from '../../state/galaxyScanConfig.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
} from '../../domain/galaxyScanConfig.js';
import { toggleChipOn, setToggleChip, wireToggleChip } from './chips.js';

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
 * returns its {@link EditorFields}; this wrapper adds the Reset + status
 * controls, the load plumbing, and the AUTOSAVE: any `change` event bubbling
 * out of the editor body (text/number inputs commit on blur/Enter) and any
 * `.toggle-chip` click triggers a debounced read-modify-write, so an editor
 * only ever overwrites the fields it owns and there is no Save button to
 * forget.
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

  const resetBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, 'Reset to defaults'));
  resetBtn.className = 'scanCfgReset';
  const controls = mk('div', 'margin-top:10px;display:flex;align-items:center;gap:8px;');
  controls.className = 'controls';
  controls.appendChild(resetBtn);
  controls.appendChild(statusEl);
  body.appendChild(controls);

  /**
   * The autosave's save callback. `uni` is the universe CAPTURED when the
   * edit was scheduled (see ./autosave.js); the widget values are collected
   * synchronously at entry, so a flush racing a universe switch persists the
   * OLD universe's fields into the OLD universe's slot. A payload identical
   * to what's stored is skipped entirely — no write, no newest-wins stamp,
   * no gist poke — so a spurious `change` (blurring an untouched field, a
   * no-op chip click) can't bump the sync clock with stale data.
   *
   * @param {string} uni
   * @returns {Promise<void>}
   */
  const save = async (uni) => {
    if (!uni) {
      // Same failure mode as the alarmClock editor: with an empty universe
      // selector (fresh device / post-reinstall) autosave has nowhere to
      // write — surface it instead of silently dropping the edit.
      setStatus('Not saved — open the game once so this server appears, then pick it above.', '#e66');
      return;
    }
    const owned = collect(); // synchronous widget snapshot
    if (!owned) return;
    // Read-modify-write so the fields owned by the OTHER editor (and the
    // AlarmClock tab's fleet-save knobs) survive — all three share one slot.
    const stored = normalizeGalaxyScanConfig(await chromeStore.get(galaxyScanConfigKeyFor(uni)));
    const cfg = normalizeGalaxyScanConfig({ ...stored, ...owned });
    // Password edits (a SET and a deliberate CLEAR alike) stamp the
    // device-local edit clock that arbitrates against the game-origin
    // localStorage backup (state/galaxyScanConfig.js). Only real changes
    // stamp — an untouched field must not let a stale backup lose.
    if (cfg.colonyPassword !== stored.colonyPassword) cfg.colonyPasswordTs = Date.now();
    if (JSON.stringify(cfg) === JSON.stringify(stored)) return; // no-op edit
    await chromeStore.set(galaxyScanConfigKeyFor(uni), cfg);
    // Stamp the whole-slot newest-wins clock and poke any open game tab to
    // push to the gist — same trio the routes editor writes on save.
    await chromeStore.set(galaxyScanConfigTsKeyFor(uni), Date.now());
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());
    // Reflect the NORMALIZED persisted values back into the widgets — but
    // only when the user isn't mid-edit in this editor and the view still
    // shows this universe (a repaint must never clobber a focused field or
    // a just-switched view).
    if (!body.contains(document.activeElement) && getUniverseId() === uni) fill(cfg);
    setStatus('Saved.', '#67c23a');
  };

  const autosave = createAutosave({ getUniverseId, save, delayMs: 500 });

  const refresh = async () => {
    // Persist any pending edit first — it belongs to the universe it was
    // made in (save() gets the captured id and snapshots synchronously).
    autosave.flush();
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

  // `change` bubbles from every input/select; toggle chips are buttons (no
  // change event), so their clicks are caught separately. The chip's own
  // wireToggleChip handler flips its state first (registered earlier), so
  // collect() at save time reads the post-toggle state.
  body.addEventListener('change', autosave.schedule);
  body.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t instanceof HTMLElement && t.closest('.toggle-chip')) autosave.schedule();
  });

  // Reset is DESTRUCTIVE under autosave (defaults persist and sync out), so
  // it takes two taps: the first arms, the second (within 3 s) applies.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let resetTimer = null;
  const disarmReset = () => {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = null;
    resetBtn.textContent = 'Reset to defaults';
  };
  resetBtn.addEventListener('click', () => {
    if (!resetTimer) {
      resetBtn.textContent = 'Sure? Tap again';
      setStatus('Resets & saves defaults.', '#e6a23c');
      resetTimer = setTimeout(() => { disarmReset(); setStatus(''); }, 3000);
      return;
    }
    disarmReset();
    fill(defaultGalaxyScanConfig());
    setStatus('Defaults restored.', '#e6a23c');
    autosave.schedule();
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

  // Toggle chips, not checkboxes — every dashboard boolean wears the same
  // `.toggle-chip` pill (state read via toggleChipOn at Save time).
  const preferInput = /** @type {HTMLButtonElement} */ (mk('button'));
  preferInput.type = 'button';
  preferInput.className = 'toggle-chip';
  preferInput.textContent = 'Enabled';
  preferInput.id = 'scanCfgPrefer';
  wireToggleChip(preferInput, () => {});

  const preferFarthestInput = /** @type {HTMLButtonElement} */ (mk('button'));
  preferFarthestInput.type = 'button';
  preferFarthestInput.className = 'toggle-chip';
  preferFarthestInput.textContent = 'Enabled';
  preferFarthestInput.id = 'scanCfgPreferFarthest';
  wireToggleChip(preferFarthestInput, () => {});
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
    'Account password, autofilled into the game’s give-up confirmation form during the abandon flow. '
    + 'Stays on THIS device only — never gist-synced and never written into export files; '
    + 'enter it once per device that runs the abandon flow. The game tab keeps a local backup '
    + 'that survives an extension reinstall.';

  // Packed into the same responsive grid (1 → 2 → 3 columns) the rescan
  // fields use, so both groups of the combined editor read as columns rather
  // than one tall single-column stack.
  const grid = mk('div');
  grid.className = 'cfg-grid';
  grid.appendChild(row('Target positions', positionsInput, 'list or range, e.g. 7-9, 15'));
  grid.appendChild(row('Prefer neighbouring galaxies', preferInput, 'more predictable arrival times'));
  grid.appendChild(row('Prefer farthest systems first', preferFarthestInput, 'better arrival spread; off = nearest first'));
  grid.appendChild(row('Min gap between arrivals (sec)', colonyMinGapInput));
  grid.appendChild(row('Min fields to keep colony', colonyMinFieldsInput));
  grid.appendChild(row('Account password (for abandon)', colonyPasswordInput));
  body.appendChild(grid);

  return {
    fill: (cfg) => {
      positionsInput.value = cfg.positions;
      setToggleChip(preferInput, cfg.preferOtherGalaxies);
      setToggleChip(preferFarthestInput, cfg.preferFarthestSystems);
      colonyMinGapInput.value = String(cfg.colonyMinGap);
      colonyMinFieldsInput.value = String(cfg.colonyMinFields);
      colonyPasswordInput.value = cfg.colonyPassword;
    },
    collect: () => ({
      positions: positionsInput.value.trim(),
      preferOtherGalaxies: toggleChipOn(preferInput),
      preferFarthestSystems: toggleChipOn(preferFarthestInput),
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
  // Subtitle intentionally dropped — the panel's <summary> now reads
  // "Colonization & abandon settings", so a repeated group heading is noise.
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
