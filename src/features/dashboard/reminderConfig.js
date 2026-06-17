// @ts-check

// Reminders config editor — the dashboard surface for the reminder knobs that
// moved out of the in-game AGR settings panel. Everything here is PER-SERVER
// (the server comes from the dashboard's top switcher), spread across two
// per-universe chrome.storage slots:
//
//   - `reminderConfig`: expedition-wave enable + schedule, ad-hoc lead time,
//     and the three message templates (wave / ad-hoc / fleet-save).
//   - `galaxyScanConfig`: fleet-save enable / ship threshold / min flight time /
//     landing-relative offset schedule (the behavioural fs* knobs).
//
// Both slots are visible to the game origin AND this extension page, and both
// are gist-synced whole-slot newest-wins. The scan-config editor (Galaxy
// Observations tab) writes the SAME galaxyScanConfig slot, so the fleet-save
// save read-modify-writes it: each surface overlays only the fields it owns,
// so neither clobbers the other.
//
// # Offset schedules: a per-entry chip editor (B3d)
//
// The wave schedule and the fleet-save offsets are still STORED as a
// comma-separated minutes-first string (the producer parses it the same way),
// but the surface is a row of CHIPS that flow horizontally and wrap (like the
// Daily Run endpoint chips) instead of one raw text field: each chip is a
// single duration input + a COMPACT impact phrase (`humanize*OffsetShort`),
// with the reference point stated once in the section hint. The chip's hover
// title carries the full `humanize*Offset` phrase — the SAME pure helper the
// fleet-save push body renders `{offset}` from — so the long-form phrasing
// stays the single source of truth and the editor / push can never drift.
//
// Master switch + ntfy token stay in AGR (the credential is required there).
// All parsing/formatting lives in `domain/duration.js`.

import { chromeStore } from '../../lib/storage.js';
import {
  galaxyScanConfigKeyFor,
  galaxyScanConfigTsKeyFor,
} from '../../state/galaxyScanConfig.js';
import {
  reminderConfigKeyFor,
  reminderConfigTsKeyFor,
} from '../../state/reminderConfig.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  defaultGalaxyScanConfig,
  normalizeGalaxyScanConfig,
} from '../../domain/galaxyScanConfig.js';
import {
  defaultReminderConfig,
  normalizeReminderConfig,
} from '../../domain/reminderConfig.js';
import {
  TEMPLATE_FIELDS,
  PRESET_ICONS,
  renderTemplate,
  unknownTokens,
} from '../../domain/reminderTemplates.js';
import {
  parseDuration, formatDuration, parseDurationList,
  humanizeOffset, humanizeReturnOffset,
  humanizeOffsetShort, humanizeReturnOffsetShort,
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
 * @typedef {object} OffsetEditor
 * @property {HTMLElement} element  The editor container (rows + add button).
 * @property {(str: string) => void} setFromString  Reload the rows from a stored list.
 * @property {() => string | null} collect  Canonical comma string, or null if any
 *   row holds an unparseable / wrong-signed token (the caller surfaces the error).
 */

/**
 * Build a per-entry offset list editor as a row of removable CHIPS that flow
 * horizontally and wrap (à la the Daily Run endpoint chips) — each chip is a
 * small duration input + a compact impact phrase, with an "Add" chip trailing
 * the row. The value round-trips through `parseDurationList`/`formatDuration`
 * so it stays a canonical minutes-first comma string. Pure DOM (no store
 * access); the host wires load/save.
 *
 * @param {object} o
 * @param {string} o.idBase  id prefix — container is `idBase`, add button
 *   `idBase + 'Add'`; row inputs/previews/removes carry stable classes.
 * @param {boolean} o.signed  Allow negative offsets (fleet-save, landing-relative)
 *   or drop them (wave, after-return).
 * @param {(sec: number) => string} o.preview  Compact phrase shown ON the chip
 *   (reference point lives once in the section hint).
 * @param {(sec: number) => string} o.previewLong  Full phrase used as the chip's
 *   hover title (the long-form single source of truth shared with the push).
 * @param {string} o.placeholder
 * @returns {OffsetEditor}
 */
const makeOffsetEditor = ({ idBase, signed, preview, previewLong, placeholder }) => {
  // The container IS the wrapping chip row; the "Add" chip is its last child so
  // setFromString can clear the value chips without disturbing it.
  const wrap = mk('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;');
  wrap.id = idBase;

  const addBtn = /** @type {HTMLButtonElement} */ (mk('button', undefined, '+ Add reminder'));
  addBtn.type = 'button';
  addBtn.id = idBase + 'Add';
  addBtn.className = 'oge-offset-add';

  /** Insert one chip (before the Add button) pre-filled with `value`; returns its input. @param {string} [value] */
  const addRow = (value = '') => {
    const r = mk('div');
    r.className = 'oge-offset-row';
    const inp = /** @type {HTMLInputElement} */ (mk('input'));
    inp.type = 'text';
    inp.className = 'oge-offset-input';
    inp.size = 6;
    inp.placeholder = placeholder;
    inp.value = value;
    const prev = mk('span');
    prev.className = 'oge-offset-preview';
    const rm = /** @type {HTMLButtonElement} */ (mk('button', undefined, '✕'));
    rm.type = 'button';
    rm.className = 'oge-offset-remove';
    rm.title = 'Remove this reminder';

    const refreshPreview = () => {
      const t = inp.value.trim();
      const sec = parseDuration(t);
      const valid = sec !== null && (signed || sec >= 0);
      const bad = t !== '' && !valid;
      r.classList.toggle('invalid', bad);
      prev.textContent = t === '' ? '' : valid ? preview(/** @type {number} */ (sec)) : 'invalid';
      // Full phrase on hover — the chip face stays compact, the meaning is one
      // hover away, and the push body shares the same long-form helper.
      r.title = valid && t !== '' ? previewLong(/** @type {number} */ (sec)) : '';
    };
    inp.addEventListener('input', refreshPreview);
    rm.addEventListener('click', () => { r.remove(); });

    r.append(inp, prev, rm);
    wrap.insertBefore(r, addBtn);
    refreshPreview();
    return inp;
  };

  addBtn.addEventListener('click', () => addRow().focus());
  wrap.appendChild(addBtn);

  return {
    element: wrap,
    setFromString: (str) => {
      wrap.querySelectorAll('.oge-offset-row').forEach((el) => el.remove());
      for (const sec of parseDurationList(str, { signed })) addRow(formatDuration(sec));
    },
    collect: () => {
      const inputs = /** @type {HTMLInputElement[]} */ (
        [...wrap.querySelectorAll('.oge-offset-input')]
      );
      /** @type {number[]} */
      const secs = [];
      for (const inp of inputs) {
        const t = inp.value.trim();
        if (t === '') continue;
        const sec = parseDuration(t);
        if (sec === null || (!signed && sec < 0)) return null;
        secs.push(sec);
      }
      // Canonicalise: dedupe + sort ascending, render minutes-first. Empty ⇒ ''.
      return [...new Set(secs)].sort((a, b) => a - b).map(formatDuration).join(', ');
    },
  };
};

/**
 * @typedef {object} TemplateEditor
 * @property {HTMLElement} element  The editor container (body + chips + selects + preview).
 * @property {(t: import('../../domain/reminderTemplates.js').ReminderTemplate) => void} setFromTemplate
 * @property {() => import('../../domain/reminderTemplates.js').ReminderTemplate} collect
 */

/**
 * Build a per-kind MESSAGE editor: a body textarea with `{wildcard}` chips
 * (click to insert at the caret), an icon picker, a priority picker, and a
 * LIVE preview rendered from the kind's sample context (so the user sees a
 * realistic push, not raw tokens) plus an unknown-token warning. Pure DOM; the
 * host wires load/save. Title is intentionally not editable (see
 * `domain/reminderTemplates` header — the title is the ntfy queue filter).
 *
 * @param {object} o
 * @param {import('../../domain/reminderTemplates.js').ReminderKind} o.kind
 * @param {string} o.idBase  id prefix for this kind's controls.
 * @returns {TemplateEditor}
 */
const makeTemplateEditor = ({ kind, idBase }) => {
  const fields = TEMPLATE_FIELDS[kind];
  const sampleCtx = Object.fromEntries(fields.map((f) => [f.token, f.sample]));

  const wrap = mk('div', 'display:flex;flex-direction:column;gap:6px;flex:1;min-width:280px;');
  wrap.id = idBase;

  const body = /** @type {HTMLTextAreaElement} */ (mk('textarea',
    'width:100%;min-height:46px;resize:vertical;font:inherit;font-size:13px;' +
    'background:#0d1620;color:#cfe;border:1px solid #244;border-radius:4px;padding:6px;box-sizing:border-box;'));
  body.id = idBase + 'Body';

  // Wildcard chips — click to insert the token at the caret.
  const chips = mk('div', 'display:flex;flex-wrap:wrap;gap:4px;');
  for (const f of fields) {
    const chip = /** @type {HTMLButtonElement} */ (mk('button',
      'font-size:11px;padding:1px 6px;background:#16252f;color:#9cf;border:1px solid #2a4a5a;border-radius:10px;cursor:pointer;',
      `{${f.token}}`));
    chip.type = 'button';
    chip.title = f.label;
    chip.addEventListener('click', () => {
      const start = body.selectionStart ?? body.value.length;
      const end = body.selectionEnd ?? body.value.length;
      const tok = `{${f.token}}`;
      body.value = body.value.slice(0, start) + tok + body.value.slice(end);
      const caret = start + tok.length;
      body.setSelectionRange(caret, caret);
      body.focus();
      body.dispatchEvent(new Event('input'));
    });
    chips.appendChild(chip);
  }

  // Icon + priority selects on one row.
  const selRow = mk('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:#aaa;');
  const iconSel = /** @type {HTMLSelectElement} */ (mk('select'));
  iconSel.id = idBase + 'Icon';
  for (const p of PRESET_ICONS) {
    const opt = /** @type {HTMLOptionElement} */ (mk('option', undefined, p.label));
    opt.value = p.id;
    iconSel.appendChild(opt);
  }
  const prioSel = /** @type {HTMLSelectElement} */ (mk('select'));
  prioSel.id = idBase + 'Priority';
  for (const n of [1, 2, 3, 4, 5]) {
    const opt = /** @type {HTMLOptionElement} */ (mk('option', undefined,
      n === 5 ? '5 (max)' : n === 1 ? '1 (min)' : String(n)));
    opt.value = String(n);
    prioSel.appendChild(opt);
  }
  const iconLabel = mk('label', undefined, 'Icon: ');
  iconLabel.appendChild(iconSel);
  const prioLabel = mk('label', undefined, 'Priority: ');
  prioLabel.appendChild(prioSel);
  selRow.append(iconLabel, prioLabel);

  // Live preview + unknown-token warning.
  const preview = mk('div',
    'font-size:12px;color:#cfe;background:#0d1117;border:1px solid #233;border-radius:4px;padding:6px;min-height:16px;');
  preview.className = 'oge-tpl-preview';
  const warn = mk('div', 'font-size:12px;color:#e6a23c;');
  warn.className = 'oge-tpl-warn';

  const refreshPreview = () => {
    preview.textContent = renderTemplate(body.value, sampleCtx) || '(empty)';
    const unk = unknownTokens(body.value, kind);
    warn.textContent = unk.length ? `Unknown wildcard${unk.length > 1 ? 's' : ''}: ${unk.map((t) => `{${t}}`).join(', ')}` : '';
  };
  body.addEventListener('input', refreshPreview);

  wrap.append(body, chips, selRow, preview, warn);

  return {
    element: wrap,
    setFromTemplate: (t) => {
      body.value = t.body;
      iconSel.value = t.icon;
      prioSel.value = String(t.priority);
      refreshPreview();
    },
    collect: () => ({
      body: body.value,
      icon: iconSel.value,
      priority: parseInt(prioSel.value, 10),
    }),
  };
};

/**
 * Install the reminder config editor into `#reminderConfigBody`. Idempotent
 * per call site (the host installs once at boot); returns a `refresh()` the
 * host calls on universe change so the fields reload for the newly-selected
 * server (everything here is per-server).
 *
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installReminderConfig = ({ getUniverseId }) => {
  const body = document.getElementById('reminderConfigBody');
  if (!body) return { refresh: () => {} };

  // ── wave / ad-hoc field widgets ──────────────────────────────────────
  // ids are OG-E's own hooks (not a game DOM contract) — kept next to the
  // code that emits them, used by the behavioural tests.
  const waveEnabledInput = /** @type {HTMLInputElement} */ (mk('input'));
  waveEnabledInput.type = 'checkbox';
  waveEnabledInput.id = 'remCfgWaveEnabled';

  const waveEditor = makeOffsetEditor({
    idBase: 'remCfgWaveEditor',
    signed: false,
    preview: humanizeReturnOffsetShort,
    previewLong: humanizeReturnOffset,
    placeholder: '10m',
  });

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

  const fsEditor = makeOffsetEditor({
    idBase: 'remCfgFsOffsets',
    signed: true,
    preview: humanizeOffsetShort,
    previewLong: humanizeOffset,
    placeholder: '-10m',
  });

  // ── message template editors (one per kind) ──────────────────────────
  const waveTplEditor = makeTemplateEditor({ kind: 'wave', idBase: 'remCfgTplWave' });
  const adhocTplEditor = makeTemplateEditor({ kind: 'adhoc', idBase: 'remCfgTplAdhoc' });
  const fsTplEditor = makeTemplateEditor({ kind: 'fleetSave', idBase: 'remCfgTplFs' });

  // ── layout ───────────────────────────────────────────────────────────
  body.textContent = '';

  /**
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

  /** @param {string} text @returns {HTMLElement} */
  const subHeading = (text) => {
    const el = mk('div', undefined, text);
    el.className = 'cfg-sub';
    return el;
  };

  /**
   * A full-width "label + hint over control" block — used for the chip-style
   * schedule editor, which wants the column's whole width to flow its chips
   * (so it is NOT squeezed beside a 220px `cfg-label` like the scalar rows).
   *
   * @param {string} labelText
   * @param {HTMLElement} control
   * @param {string} [hint]
   * @returns {HTMLElement}
   */
  const block = (labelText, control, hint) => {
    const b = mk('div', 'margin-bottom:10px;');
    const head = mk('div');
    head.className = 'cfg-block-label';
    head.appendChild(mk('span', undefined, labelText));
    if (hint) {
      const h = mk('span', 'margin-left:6px;', hint);
      h.className = 'cfg-hint';
      head.appendChild(h);
    }
    b.append(head, control);
    return b;
  };

  /**
   * Lay a pane out as two responsive columns: a "Settings" column (the knobs)
   * and a "Message" column (that kind's template editor). Collapses to one
   * column on narrow widths (see `.rem-pane-grid`).
   *
   * @param {HTMLElement} pane
   * @param {HTMLElement[]} settings  the knob rows/blocks, in order
   * @param {HTMLElement} message  the template editor element
   * @returns {void}
   */
  const twoCol = (pane, settings, message) => {
    const grid = mk('div');
    grid.className = 'rem-pane-grid';
    const left = mk('div');
    left.append(subHeading('Settings'), ...settings);
    const right = mk('div');
    right.append(subHeading('Message'), message);
    grid.append(left, right);
    pane.appendChild(grid);
  };

  // Three sub-tabs (Expedition waves / Ad-hoc / Fleet-save) so each kind's
  // knobs + message editor live on their own pane instead of one long form.
  // All widgets stay mounted (inactive panes are display:none) so a single
  // Save below persists every tab at once.
  const tabBar = mk('div');
  tabBar.className = 'subtabs';
  /** @type {{ btn: HTMLButtonElement, pane: HTMLElement }[]} */
  const tabs = [];
  /** @param {string} label @returns {HTMLElement} the pane to fill */
  const addTab = (label) => {
    const btn = /** @type {HTMLButtonElement} */ (mk('button', undefined, label));
    btn.type = 'button';
    btn.className = 'subtab';
    const pane = mk('div');
    pane.className = 'subtabpane';
    btn.addEventListener('click', () => {
      for (const t of tabs) {
        const on = t.btn === btn;
        t.btn.classList.toggle('active', on);
        t.pane.classList.toggle('active', on);
      }
    });
    tabBar.appendChild(btn);
    tabs.push({ btn, pane });
    return pane;
  };

  const wavePane = addTab('Expedition waves');
  twoCol(wavePane, [
    row('Reminders — enable', waveEnabledInput, 'auto-detect a returning wave + schedule a series'),
    block('Reminder schedule', waveEditor.element, 'each fires relative to the wave’s return'),
  ], waveTplEditor.element);

  const adhocPane = addTab('Ad-hoc');
  twoCol(adhocPane, [
    row('Lead time', adhocInput, 'before arrival, e.g. 1m'),
  ], adhocTplEditor.element);

  const fsPane = addTab('Fleet-save');
  twoCol(fsPane, [
    row('Reminders — enable', enabledInput, 'auto-detect a returning Fleet-save + schedule a series'),
    row('Ship threshold', thresholdInput, 'total ships that count as a "big" fleet'),
    row('Min flight time', minFlightInput, 'minutes-first, e.g. 10m · 0 = off'),
    block('Reminder schedule', fsEditor.element, 'each relative to landing (− before, 0 at, + after)'),
  ], fsTplEditor.element);

  body.appendChild(tabBar);
  body.appendChild(wavePane);
  body.appendChild(adhocPane);
  body.appendChild(fsPane);
  // Open the first tab by default.
  tabs[0].btn.classList.add('active');
  tabs[0].pane.classList.add('active');

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
    fsEditor.setFromString(cfg.fsOffsets);
  };

  /**
   * Populate the wave + ad-hoc widgets and all three message templates from a
   * per-server reminder config.
   * @param {import('../../domain/reminderConfig.js').ReminderConfig} cfg
   */
  const fillReminder = (cfg) => {
    waveEnabledInput.checked = cfg.reminderEnabled;
    waveEditor.setFromString(cfg.reminderSchedule);
    adhocInput.value = formatDuration(cfg.adhocOffsetSec);
    waveTplEditor.setFromTemplate(cfg.templates.wave);
    adhocTplEditor.setFromTemplate(cfg.templates.adhoc);
    fsTplEditor.setFromTemplate(cfg.templates.fleetSave);
  };

  const refresh = async () => {
    const uni = getUniverseId();
    if (!uni) {
      fillReminder(defaultReminderConfig());
      fillFs(defaultGalaxyScanConfig());
      setStatus('No universe selected — pick a server to configure reminders.', '#e6a23c');
      return;
    }
    fillReminder(normalizeReminderConfig(await chromeStore.get(reminderConfigKeyFor(uni))));
    fillFs(normalizeGalaxyScanConfig(await chromeStore.get(galaxyScanConfigKeyFor(uni))));
    setStatus('');
  };

  /**
   * Read the per-server fleet-save widgets into a partial config, validating
   * the numeric/duration fields. Returns null + sets an error status on a bad
   * value. The offsets come from the row editor (already validated per-row); an
   * empty list is allowed (no fleet-save pings).
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
    const offsets = fsEditor.collect();
    if (offsets === null) {
      setStatus('Fleet-save schedule — each reminder must be a duration like -10m, 0m, 10m.', '#e66');
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
   * Read the wave + ad-hoc widgets (enable / schedule / lead time) and all
   * three message templates into a complete per-server reminder config,
   * validating the schedule + lead-time durations. Returns null + sets an
   * error on a bad value. The wave schedule comes from the row editor (per-row
   * validated); an empty list is allowed (no wave pings). The message bodies
   * may be empty (a deliberate blank); unknown wildcards are a non-blocking
   * warning shown live in the editor.
   *
   * @returns {import('../../domain/reminderConfig.js').ReminderConfig | null}
   */
  const collectReminder = () => {
    const schedule = waveEditor.collect();
    if (schedule === null) {
      setStatus('Wave schedule — each reminder must be a duration like 0m, 10m, 30m.', '#e66');
      return null;
    }
    const adhoc = parseDuration(adhocInput.value);
    if (adhoc === null || adhoc < 0) {
      setStatus('Ad-hoc lead time — use e.g. 1m, 90s, 2h.', '#e66');
      return null;
    }
    return normalizeReminderConfig({
      reminderEnabled: waveEnabledInput.checked,
      reminderSchedule: schedule,
      adhocOffsetSec: adhoc,
      templates: {
        wave: waveTplEditor.collect(),
        adhoc: adhocTplEditor.collect(),
        fleetSave: fsTplEditor.collect(),
      },
    });
  };

  const save = async () => {
    const rc = collectReminder();
    if (!rc) return;
    const ownedFs = collectFs();
    if (!ownedFs) return;

    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected — pick a server to save reminder config.', '#e66'); return; }

    // Reminder config slot (per-universe): wave/ad-hoc + all three templates.
    await chromeStore.set(reminderConfigKeyFor(uni), rc);
    await chromeStore.set(reminderConfigTsKeyFor(uni), Date.now());

    // Galaxy-scan slot (per-universe, read-modify-write): the fleet-save knobs
    // only — the scan-config editor shares this slot, so overlay just ours.
    const stored = normalizeGalaxyScanConfig(await chromeStore.get(galaxyScanConfigKeyFor(uni)));
    const cfg = normalizeGalaxyScanConfig({ ...stored, ...ownedFs });
    await chromeStore.set(galaxyScanConfigKeyFor(uni), cfg);
    await chromeStore.set(galaxyScanConfigTsKeyFor(uni), Date.now());

    // One poke runs a full sync round-trip that pushes both per-universe slots.
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());

    fillReminder(rc);
    fillFs(cfg);
    setStatus('Saved.', '#67c23a');
  };

  saveBtn.addEventListener('click', () => { void save(); });
  resetBtn.addEventListener('click', () => {
    fillReminder(defaultReminderConfig());
    fillFs(defaultGalaxyScanConfig());
    setStatus('Defaults loaded — click Save to apply.', '#e6a23c');
  });

  return { refresh: () => void refresh() };
};
