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
  DEFAULT_ICON_ID,
  renderTemplate,
  unknownTokens,
} from '../../domain/reminderTemplates.js';
import {
  parseDuration, formatDuration, parseDurationList,
  humanizeOffset, humanizeReturnOffset, humanizeArrivalOffset, summarizeSchedule,
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
 * @param {(sec: number) => string} o.previewLong  Full phrase used as the chip's
 *   hover title (the long-form single source of truth shared with the push).
 * @param {string} o.placeholder
 * @param {'landing' | 'return' | 'arrival'} o.reference  Point the combined
 *   summary line below the chips measures from ("… before/after landing|return|arrival").
 * @returns {OffsetEditor}
 */
const makeOffsetEditor = ({ idBase, signed, previewLong, placeholder, reference }) => {
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
    inp.placeholder = placeholder;
    inp.value = value;
    const rm = /** @type {HTMLButtonElement} */ (mk('button', undefined, '✕'));
    rm.type = 'button';
    rm.className = 'oge-offset-remove';
    rm.title = 'Remove this reminder';

    const refresh = () => {
      const t = inp.value.trim();
      const sec = parseDuration(t);
      const valid = sec !== null && (signed || sec >= 0);
      r.classList.toggle('invalid', t !== '' && !valid);
      // The chip face is JUST the (borderless) value — no separate phrase span,
      // which is what made these chips bulky next to Daily Run's. The full
      // impact phrase lives on hover (same long-form helper the push body uses)
      // and the reference point ("return" / "landing") is stated once in the
      // section hint. Size the field to its content so the pill hugs the value.
      r.title = valid && t !== '' ? previewLong(/** @type {number} */ (sec)) : '';
      inp.size = Math.max(2, (t || placeholder || '').length);
      updateSummary();
    };
    inp.addEventListener('input', refresh);
    rm.addEventListener('click', () => { r.remove(); updateSummary(); });

    r.append(inp, rm);
    wrap.insertBefore(r, addBtn);
    refresh();
    return inp;
  };

  addBtn.addEventListener('click', () => { addRow().focus(); updateSummary(); });
  wrap.appendChild(addBtn);

  // Combined readout BELOW the chips: the whole schedule in one sentence
  // ("15m & 5m before landing · at landing · 20m after landing"), so the user
  // can sanity-check what every chip adds up to without decoding each pill.
  const summary = mk('div');
  summary.className = 'oge-offset-summary';
  const root = mk('div');
  root.append(wrap, summary);

  const updateSummary = () => {
    /** @type {number[]} */
    const secs = [];
    for (const inp of /** @type {HTMLInputElement[]} */ (
      [...wrap.querySelectorAll('.oge-offset-input')]
    )) {
      const sec = parseDuration(inp.value.trim());
      if (sec !== null && (signed || sec >= 0)) secs.push(sec);
    }
    summary.textContent = summarizeSchedule(secs, reference);
  };

  return {
    element: root,
    setFromString: (str) => {
      wrap.querySelectorAll('.oge-offset-row').forEach((el) => el.remove());
      for (const sec of parseDurationList(str, { signed })) addRow(formatDuration(sec));
      updateSummary();
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
 * Resolve a packaged icon asset to a URL usable from the dashboard page.
 * Prefers the WebExtension runtime (`browser`/`chrome.runtime.getURL`); falls
 * back to a path relative to the dashboard document (also the test path, where
 * no runtime exists). Mirrors the resolution in `features/agrLogo.js`.
 *
 * @param {string} file  asset filename under `icons/`.
 * @returns {string}
 */
const iconAssetUrl = (file) => {
  const g = /** @type {any} */ (globalThis);
  return (
    g.browser?.runtime?.getURL?.('icons/' + file) ||
    g.chrome?.runtime?.getURL?.('icons/' + file) ||
    'icons/' + file
  );
};

/**
 * @typedef {object} PickerControl
 * @property {HTMLElement} element  The control container.
 * @property {() => any} get        Current value.
 * @property {(v: any) => void} set Set the value + repaint.
 */

/**
 * Icon picker — one clickable swatch per {@link PRESET_ICONS} entry showing the
 * REAL icon image (a native `<option>` can't hold an `<img>`). With only a
 * couple of presets this reads better than a dropdown. The selected swatch
 * carries `.selected`; `get`/`set` round-trip the stored icon id and an unknown
 * id falls back to {@link DEFAULT_ICON_ID}.
 *
 * @param {string} id  container id (so collect + tests find this control).
 * @returns {PickerControl}
 */
const makeIconPicker = (id) => {
  const wrap = mk('div', 'display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;');
  wrap.id = id;
  let value = DEFAULT_ICON_ID;
  /** @type {HTMLButtonElement[]} */
  const swatches = [];
  const paint = () =>
    swatches.forEach((b) => b.classList.toggle('selected', b.dataset.icon === value));
  for (const p of PRESET_ICONS) {
    const b = /** @type {HTMLButtonElement} */ (mk('button'));
    b.type = 'button';
    b.className = 'oge-icon-swatch';
    b.dataset.icon = p.id;
    b.title = p.label;
    b.setAttribute('aria-label', p.label);
    const img = /** @type {HTMLImageElement} */ (document.createElement('img'));
    img.src = iconAssetUrl(p.file);
    img.alt = p.label;
    b.appendChild(img);
    b.addEventListener('click', () => { value = p.id; paint(); });
    swatches.push(b);
    wrap.appendChild(b);
  }
  return {
    element: wrap,
    get: () => value,
    set: (v) => { value = PRESET_ICONS.some((p) => p.id === v) ? v : DEFAULT_ICON_ID; paint(); },
  };
};

/**
 * ntfy priority levels (1–5): human name + a calm→alarm colour. Colours are
 * applied inline (per segment) so the ramp needs no per-level CSS rule.
 */
const PRIORITY_META = [
  { v: 1, name: 'Min', color: '#5b6b78' },
  { v: 2, name: 'Low', color: '#4a78b5' },
  { v: 3, name: 'Default', color: '#4a9e8a' },
  { v: 4, name: 'High', color: '#e6a23c' },
  { v: 5, name: 'Max', color: '#e0524a' },
];

/**
 * Priority picker — a 1–5 segmented control. Each segment wears its level's
 * colour (a low→high ramp), the selected one is filled, and the active level's
 * name shows beside it. Clearer than a dropdown or a bare slider for five
 * discrete, ordered levels. `get`/`set` round-trip the clamped int (1–5).
 *
 * @param {string} id  container id (so collect + tests find this control).
 * @returns {PickerControl}
 */
const makePriorityPicker = (id) => {
  const wrap = mk('div', 'display:inline-flex;gap:8px;align-items:center;');
  wrap.id = id;
  let value = 3;
  const segs = mk('div', 'display:inline-flex;gap:3px;');
  const name = mk('span', 'font-size:12px;font-weight:bold;min-width:52px;');
  /** @type {HTMLButtonElement[]} */
  const btns = [];
  const paint = () => {
    for (const b of btns) {
      const m = PRIORITY_META[Number(b.dataset.prio) - 1];
      const on = Number(b.dataset.prio) === value;
      b.classList.toggle('selected', on);
      b.style.background = on ? m.color : 'transparent';
      b.style.borderColor = m.color;
      b.style.color = on ? '#0d1117' : '#9fb3c0';
    }
    const meta = PRIORITY_META[value - 1];
    name.textContent = meta.name;
    name.style.color = meta.color;
  };
  for (const m of PRIORITY_META) {
    const b = /** @type {HTMLButtonElement} */ (mk('button', undefined, String(m.v)));
    b.type = 'button';
    b.className = 'oge-prio-seg';
    b.dataset.prio = String(m.v);
    b.title = `${m.v} — ${m.name}`;
    b.addEventListener('click', () => { value = m.v; paint(); });
    btns.push(b);
    segs.appendChild(b);
  }
  wrap.append(segs, name);
  return {
    element: wrap,
    get: () => value,
    set: (v) => {
      const n = Math.round(Number(v));
      value = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
      paint();
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

  // Icon + priority pickers on one row. Both are custom controls, not <select>:
  // the icon picker shows the ACTUAL icon images as swatches (a native <option>
  // can't render an <img>), and priority is a 1–5 segmented control with a
  // calm→alarm colour ramp so the chosen level reads at a glance.
  const selRow = mk('div', 'display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:12px;color:#aaa;');
  const iconPick = makeIconPicker(idBase + 'Icon');
  const prioPick = makePriorityPicker(idBase + 'Priority');
  const iconLabel = mk('label', 'display:inline-flex;align-items:center;gap:8px;', 'Icon');
  iconLabel.appendChild(iconPick.element);
  const prioLabel = mk('label', 'display:inline-flex;align-items:center;gap:8px;', 'Priority');
  prioLabel.appendChild(prioPick.element);
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
      iconPick.set(t.icon);
      prioPick.set(t.priority);
      refreshPreview();
    },
    collect: () => ({
      body: body.value,
      icon: iconPick.get(),
      priority: prioPick.get(),
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
    previewLong: humanizeReturnOffset,
    placeholder: '10m',
    reference: 'return',
  });

  const adhocEditor = makeOffsetEditor({
    idBase: 'remCfgAdhocOffsets',
    signed: true,
    previewLong: humanizeArrivalOffset,
    placeholder: '-1m',
    reference: 'arrival',
  });

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
    previewLong: humanizeOffset,
    placeholder: '-10m',
    reference: 'landing',
  });

  const guardianEnableInput = /** @type {HTMLInputElement} */ (mk('input'));
  guardianEnableInput.type = 'checkbox';
  guardianEnableInput.id = 'remCfgGuardianEnabled';

  const guardianIntervalInput = /** @type {HTMLInputElement} */ (mk('input'));
  guardianIntervalInput.type = 'text';
  guardianIntervalInput.id = 'remCfgGuardianInterval';
  guardianIntervalInput.size = 8;
  guardianIntervalInput.placeholder = 'e.g. 20';
  guardianIntervalInput.title =
    'Minutes after a fleet-save lands that the guardian push fires if it is still sitting bare.';

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
    block('Reminder schedule', adhocEditor.element, 'each relative to arrival (− before, 0 at, + after)'),
  ], adhocTplEditor.element);

  const fsPane = addTab('Fleet-save');
  twoCol(fsPane, [
    row('Reminders — enable', enabledInput, 'auto-detect a returning Fleet-save + schedule a series'),
    row('Ship threshold', thresholdInput, 'total ships that count as a "big" fleet'),
    row('Min flight time', minFlightInput, 'minutes-first, e.g. 10m · 0 = off'),
    block('Reminder schedule', fsEditor.element, 'each relative to landing (− before, 0 at, + after)'),
    row('Guardian — enable', guardianEnableInput, 'push when a landed fleet-save sits exposed'),
    row('Guardian interval', guardianIntervalInput, 'minutes after landing to fire if still bare'),
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
    guardianEnableInput.checked = cfg.guardianEnabled;
    guardianIntervalInput.value = String(cfg.guardianIntervalMin);
  };

  /**
   * Populate the wave + ad-hoc widgets and all three message templates from a
   * per-server reminder config.
   * @param {import('../../domain/reminderConfig.js').ReminderConfig} cfg
   */
  const fillReminder = (cfg) => {
    waveEnabledInput.checked = cfg.reminderEnabled;
    waveEditor.setFromString(cfg.reminderSchedule);
    adhocEditor.setFromString(cfg.adhocSchedule);
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
   * @returns {Pick<import('../../domain/galaxyScanConfig.js').GalaxyScanConfig, 'fsEnabled' | 'fsThreshold' | 'fsMinFlightSec' | 'fsOffsets' | 'guardianEnabled' | 'guardianIntervalMin'> | null}
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
    const guardianIntervalMin = parseInt(guardianIntervalInput.value, 10);
    if (!Number.isFinite(guardianIntervalMin) || guardianIntervalMin < 1) {
      setStatus('Guardian interval must be a whole number of minutes (≥ 1).', '#e66');
      return null;
    }
    // Never-enters net: the guardian arms on ENTRY, so a player who never
    // re-enters after landing would get no warning at all. With the guardian on,
    // guarantee the classic FS reminder still pings them — auto-add a post-landing
    // reminder at the guardian interval if none already fires at or after it. The
    // injected chip shows in the editor so the change is visible.
    let fsOffsets = offsets;
    if (guardianEnableInput.checked) {
      const need = guardianIntervalMin * 60;
      const parsed = parseDurationList(offsets, { signed: true });
      if (!parsed.some((o) => o >= need)) {
        fsOffsets = [...new Set([...parsed, need])].sort((a, b) => a - b).map(formatDuration).join(', ');
        fsEditor.setFromString(fsOffsets);
      }
    }
    return {
      fsEnabled: enabledInput.checked,
      fsThreshold: threshold,
      fsMinFlightSec: minFlight,
      fsOffsets,
      guardianEnabled: guardianEnableInput.checked,
      guardianIntervalMin,
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
    const adhocSchedule = adhocEditor.collect();
    if (adhocSchedule === null) {
      setStatus('Ad-hoc schedule — each reminder must be a duration like -10m, 0m, 10m.', '#e66');
      return null;
    }
    return normalizeReminderConfig({
      reminderEnabled: waveEnabledInput.checked,
      reminderSchedule: schedule,
      adhocSchedule,
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
