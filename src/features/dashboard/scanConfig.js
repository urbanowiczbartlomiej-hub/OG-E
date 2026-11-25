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
import { readApiCacheFor } from '../../state/apiCache.js';
import { colonizeDecisionsKeyFor } from '../../state/colonizeDecisions.js';
import { scansKeyFor } from '../../state/scans.js';
import { parsePositions } from '../../domain/positions.js';
import { freeSlotOutlook } from '../../domain/freeSlots.js';

/** Short weekday + 03:00, e.g. "Thu 03:00". @param {number} ms */
const cleanupLabel = (ms) =>
  `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short' })} 03:00`;

/**
 * The free-slot outlook under Positions: one summary line (free now, released
 * at the next two 03:00 cleanups) that unfolds a per-galaxy table. Visible
 * text, not a tooltip — touch has no hover (CLAUDE.md UI rules). Same count as
 * the colonize button's "N free" (see domain/freeSlots.js).
 *
 * @param {() => string} getUniverseId
 * @returns {{ el: HTMLElement, paint: (positions: string) => void }}
 */
const createFreeOutlook = (getUniverseId) => {
  const el = /** @type {HTMLDetailsElement} */ (mk('details'));
  el.className = 'free-outlook';
  el.hidden = true;
  const summary = mk('summary');
  const table = mk('table');
  el.append(summary, table);
  // A popover closes on any tap outside it (the summary itself toggles).
  document.addEventListener('click', (e) => {
    if (el.open && e.target instanceof Node && !el.contains(e.target)) el.open = false;
  });
  let token = 0;

  /** @param {string} positions */
  const paint = async (positions) => {
    const my = ++token;
    const uni = getUniverseId();
    const targets = parsePositions(positions);
    if (!uni || targets.length === 0) { el.hidden = true; return; }
    const [api, decisions, scans] = await Promise.all([
      readApiCacheFor(uni),
      chromeStore.get(colonizeDecisionsKeyFor(uni)),
      chromeStore.get(scansKeyFor(uni)),
    ]);
    if (my !== token) return; // a newer paint (edit / universe switch) won
    const galaxies = Number(api.server?.data?.galaxies);
    const systems = Number(api.server?.data?.systems);
    if (!api.universe || !(galaxies > 0) || !(systems > 0)) { el.hidden = true; return; }
    const o = freeSlotOutlook({
      occupied: api.universe.planets.map((p) => p.coords),
      galaxies,
      systems,
      targets,
      decisions: /** @type {any} */ (decisions && typeof decisions === 'object' ? decisions : {}),
      scans: /** @type {any} */ (scans && typeof scans === 'object' ? scans : {}),
      now: Date.now(),
    });
    const next = cleanupLabel(o.nextAt);
    const after = cleanupLabel(o.afterAt);
    summary.textContent = `${o.free} free · +${o.next} ${next} · +${o.after} ${after}`;
    table.textContent = '';
    const head = mk('tr');
    for (const h of ['Galaxy', 'Free', next, after]) head.appendChild(mk('th', undefined, h));
    table.appendChild(head);
    for (const r of o.rows) {
      const tr = mk('tr');
      if (r.free + r.next + r.after === 0) tr.className = 'free-outlook-none';
      for (const v of [`G${r.galaxy}`, r.free, r.next ? `+${r.next}` : '', r.after ? `+${r.after}` : '']) {
        tr.appendChild(mk('td', undefined, String(v)));
      }
      table.appendChild(tr);
    }
    el.hidden = false;
  };
  return { el, paint: (positions) => void paint(positions) };
};

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
 * One command-block cell (Best Colony Spots' `.cmd-grid` idiom): a muted
 * keyword caption, the control(s), optional unit. The sentence that explains
 * it lives in the cell's title — labels stay keywords (CLAUDE.md UI rules).
 *
 * @param {string} caption
 * @param {Array<HTMLElement | string>} parts  Controls; a string is a unit.
 * @param {string} [title]
 * @returns {HTMLElement}
 */
const cell = (caption, parts, title) => {
  const c = mk('div');
  c.className = 'cmd-cell';
  if (title) c.title = title;
  const cap = mk('span', undefined, caption);
  cap.className = 'cmd-cap';
  c.appendChild(cap);
  for (const p of parts) {
    if (typeof p === 'string') {
      const u = mk('span', undefined, p);
      u.className = 'cmd-unit';
      c.appendChild(u);
    } else c.appendChild(p);
  }
  return c;
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
 * @returns {{ refresh: () => void, refreshIfIdle: () => void }}
 */
const installConfigEditor = ({ getUniverseId, containerId, build }) => {
  const body = document.getElementById(containerId);
  if (!body) return { refresh: () => {}, refreshIfIdle: () => {} };
  body.textContent = '';

  const statusEl = mk('span');
  statusEl.className = 'scanCfgStatus cfg-status';
  /** @param {string} msg @param {string} [color] */
  const setStatus = (msg, color) => {
    statusEl.textContent = msg;
    statusEl.style.color = color || '';
    // The footnote row exists only while there is something to say.
    controls.hidden = !msg;
  };

  const { fill, collect } = build(body, setStatus);

  // Footnote row of the command block: the autosave status, shown only while
  // it has a message (the editor has no Reset — every field autosaves).
  const controls = mk('div');
  controls.className = 'cmd-cell cmd-wide';
  controls.hidden = true;
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
    // A success note is a blink, not a permanent row.
    setTimeout(() => { if (statusEl.textContent === 'Saved.') setStatus(''); }, 2000);
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

  return {
    refresh: () => void refresh(),
    // Repaint from storage after an edit made elsewhere (e.g. the bonus read
    // in a game tab) — but never under a user who is typing in this editor.
    refreshIfIdle: () => {
      if (!body.contains(document.activeElement)) void refresh();
    },
  };
};

/**
 * Build the Colonization editor's widgets (positions, prefer-other-galaxies,
 * arrival gap, abandon threshold, abandon password). The min-gap drives the
 * Send-Col scheduling guard; min-fields + password drive the abandon-overview
 * flow. ids are OG-E's own hooks (not a game DOM contract).
 *
 * @param {HTMLElement} body
 * @param {() => string} getUniverseId
 * @returns {EditorFields}
 */
const buildColonizationFields = (body, getUniverseId) => {
  const positionsInput = /** @type {HTMLInputElement} */ (mk('input'));
  positionsInput.type = 'text';
  positionsInput.id = 'scanCfgPositions';
  positionsInput.className = 'gv-text gv-short';
  positionsInput.placeholder = 'e.g. 8,10-12,15';
  positionsInput.title =
    'Target positions (only these count as colonizable / drive the Scan + Colonize buttons). A list or range, e.g. 8,10-12,15.';

  // Toggle chips, not checkboxes — every dashboard boolean wears the same
  // `.toggle-chip` pill (state read via toggleChipOn at Save time).
  const preferInput = /** @type {HTMLButtonElement} */ (mk('button'));
  preferInput.type = 'button';
  preferInput.className = 'toggle-chip';
  preferInput.textContent = 'Others first';
  preferInput.id = 'scanCfgPrefer';
  wireToggleChip(preferInput, () => {});

  const preferFarthestInput = /** @type {HTMLButtonElement} */ (mk('button'));
  preferFarthestInput.type = 'button';
  preferFarthestInput.className = 'toggle-chip';
  preferFarthestInput.textContent = 'Farthest first';
  preferFarthestInput.id = 'scanCfgPreferFarthest';
  wireToggleChip(preferFarthestInput, () => {});
  preferFarthestInput.title =
    'Within your home galaxy, propose the farthest free system first (spreads colony-ship arrival times). Uncheck to propose the nearest free system first.';

  const colonyMinGapInput = /** @type {HTMLInputElement} */ (mk('input'));
  colonyMinGapInput.type = 'text';
  colonyMinGapInput.id = 'scanCfgColonyMinGap';
  colonyMinGapInput.className = 'gv-text gv-short';
  colonyMinGapInput.inputMode = 'numeric';
  colonyMinGapInput.placeholder = 'e.g. 20';
  colonyMinGapInput.title =
    'Minimum seconds between two colony-ship arrivals — the Send-Col button waits out this gap to avoid stacking arrivals.';

  const colonyMinFieldsInput = /** @type {HTMLInputElement} */ (mk('input'));
  colonyMinFieldsInput.type = 'text';
  colonyMinFieldsInput.id = 'scanCfgColonyMinFields';
  colonyMinFieldsInput.className = 'gv-text gv-short';
  colonyMinFieldsInput.inputMode = 'numeric';
  colonyMinFieldsInput.placeholder = 'e.g. 200';
  colonyMinFieldsInput.title =
    'A fresh colony with fewer than this many fields is offered for abandon on its overview page.';

  const colonyPasswordInput = /** @type {HTMLInputElement} */ (mk('input'));
  colonyPasswordInput.type = 'password';
  colonyPasswordInput.id = 'scanCfgColonyPassword';
  colonyPasswordInput.className = 'gv-text';
  colonyPasswordInput.title =
    'Account password, autofilled into the game’s give-up confirmation form during the abandon flow. '
    + 'Stays on THIS device only — never gist-synced and never written into export files; '
    + 'enter it once per device that runs the abandon flow. The game tab keeps a local backup '
    + 'that survives an extension reinstall.';

  // Typing filter: drop characters a field can never hold, as they are typed
  // (numbers: digits only; positions: digits, commas, ranges, spaces).
  /** @param {HTMLInputElement} input @param {RegExp} notAllowed */
  const allowOnly = (input, notAllowed) => input.addEventListener('input', () => {
    const clean = input.value.replace(notAllowed, '');
    if (clean !== input.value) input.value = clean;
  });
  allowOnly(positionsInput, /[^\d,\- ]/g);
  allowOnly(colonyMinGapInput, /\D/g);
  allowOnly(colonyMinFieldsInput, /\D/g);

  // Best Colony Spots' command block: two columns, stacking on phones.
  // Each control carries a short visible note (like a unit) instead of a
  // hover — touch has no hover (CLAUDE.md UI rules).
  const outlook = createFreeOutlook(getUniverseId);
  // Recount as soon as the positions change, before the autosave lands.
  positionsInput.addEventListener('change', () => outlook.paint(positionsInput.value));
  // The note and the outlook stack in one column beside the input, so the
  // outlook reads as part of the note instead of a new row across the cell.
  const positionsNote = mk('div');
  positionsNote.className = 'cmd-stack';
  const positionsUnit = mk('span', undefined, 'to hunt (8, 10-12)');
  positionsUnit.className = 'cmd-unit';
  positionsNote.append(positionsUnit, outlook.el);
  body.appendChild(cell('Positions', [positionsInput, positionsNote]));
  body.appendChild(cell('Galaxies', [preferInput, 'for closer arrival times']));
  body.appendChild(cell('Arrival gap', [colonyMinGapInput, 's between arrivals']));
  body.appendChild(cell('Systems', [preferFarthestInput, 'to keep the arrival gap']));
  body.appendChild(cell('Keep from', [colonyMinFieldsInput, 'fields, else abandon']));
  body.appendChild(cell('Password', [colonyPasswordInput, 'to confirm abandoning']));

  return {
    fill: (cfg) => {
      positionsInput.value = cfg.positions;
      outlook.paint(cfg.positions);
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
 * @param {() => string} getUniverseId
 * @returns {EditorFields}
 */
const buildScanColonyFields = (body, getUniverseId) => {
  // Subtitle intentionally dropped — the panel's <summary> now reads
  // "Colonization & abandon settings", so a repeated group heading is noise.
  return buildColonizationFields(body, getUniverseId);
};

/**
 * Install the colonization config editor into `#colonizationConfigBody`
 * (Colonizations tab's ⚙ Settings). Returns a `refresh()` the host calls on
 * universe change.
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void, refreshIfIdle: () => void }}
 */
export const installScanColonyConfig = ({ getUniverseId }) =>
  installConfigEditor({
    getUniverseId,
    containerId: 'colonizationConfigBody',
    build: (body) => buildScanColonyFields(body, getUniverseId),
  });
