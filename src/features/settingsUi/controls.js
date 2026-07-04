// @ts-check

// Control builders + per-row rendering for the OG-E settings tab.
// The orchestrator (`./index.js`) calls `buildRow(opt)` for every option
// in the SECTIONS config and `syncInputsFromState()` after every store
// update.
//
// # Type discipline
//
// `SettingsOption` is the discriminated union over control flavours;
// the builder for each flavour lives below and is dispatched via
// `CONTROL_BUILDERS`. Adding a new flavour:
//   1. extend the `type` union in `SettingsOption`,
//   2. write one `buildXxxControl`,
//   3. add one entry to `CONTROL_BUILDERS`,
//   4. extend the type-switch in `syncInputsFromState`.
//
// # writingFromUi anti-loop flag
//
// When the user changes a control, our handler updates the store, which
// fires the subscribe in `index.js`, which calls `syncInputsFromState`.
// The flag is raised for the duration of our own write so that resync
// early-returns instead of redundantly re-reading the value we just wrote
// back into the same control.
//
// @see ./sections/  — per-section configs whose options drive these builders.
// @see ./index.js   — orchestrator that wires the subscription.

import { settingsStore } from '../../state/settings.js';
import { SECTIONS } from './sections/index.js';

/**
 * Shape of a single option in the SECTIONS config. Each `type` is
 * rendered differently in {@link buildRow} — think of this typedef as
 * the discriminated union of all control flavours the panel supports.
 *
 * `id` is both the `keyof Settings` field (for data-bound types) and
 * the suffix of the DOM id (`oge-setting-<id>`). For `static`
 * options the id is read-only (`static` may read from any data source,
 * not necessarily a Settings field).
 *
 * @typedef {object} SettingsOption
 * @property {string} id Option identifier — matches `Settings` field for data-bound types.
 * @property {string} label Human-readable row label.
 * @property {'checkbox' | 'range' | 'radio' | 'static'} type Control flavour.
 * @property {number} [min] Slider minimum (range only).
 * @property {number} [max] Slider maximum (range only).
 * @property {number} [step] Slider step (range only; defaults to 1).
 * @property {string} [unit] Slider display unit suffix (range only, e.g. `'px'`).
 * @property {{ value: number, label: string }[]} [radioOptions] Choices for a horizontal radio group (radio only; values are written to the store as numbers).
 * @property {string} [buttonText] Inline action-button label (`checkbox` / `static` with `onclick`): renders a button beside the primary control.
 * @property {() => void} [onclick] Inline action-button click handler (`checkbox` / `static` with `buttonText`).
 * @property {() => string} [getText] Dynamic text producer (static only).
 * @property {string} [refreshEvent]
 *   `static` only: a `document` event name that, when fired, re-runs the
 *   row's `getText` producer. Lets an external producer (e.g. the sync layer
 *   after a sync settles) push fresh text into the row without a
 *   settings-store change.
 * @property {boolean} [fullWidth]
 *   Render the row as a single cell spanning BOTH columns, with the label as a
 *   heading above the control instead of the 434/220 label-value split. For
 *   rows whose content doesn't fit the narrow 220px value column — the ntfy
 *   topic (masked value + reveal/copy buttons overflowed into a horizontal
 *   scroll) and the topic-privacy note (a paragraph squeezed into a sliver).
 * @property {(s: import('../../state/settings.js').Settings) => boolean} [disabledWhen]
 *   Optional predicate over current settings; when it returns true the
 *   control is rendered disabled (greyed). Re-evaluated on every store
 *   change so a dependency (e.g. a master switch) greys/un-greys it live.
 * @property {(s: import('../../state/settings.js').Settings) => boolean} [buttonDisabledWhen]
 *   `checkbox` / `static` inline-button rows only: predicate that disables
 *   the INLINE BUTTON independently of the primary control. Lets a master
 *   checkbox stay enabled while its own "do it now" button greys out when
 *   the feature is off. Re-evaluated on every store change.
 */

/**
 * Shape of a single section in SECTIONS.
 *
 * @typedef {object} SettingsSection
 * @property {string} section Human-readable section title (rendered as a row header).
 * @property {SettingsOption[]} options Options within the section, rendered in order.
 */

/** Id prefix for input elements — used to find controls by option id on sync. */
const INPUT_ID_PREFIX = 'oge-setting-';

// ─── Style constants ─────────────────────────────────────────────────────

const RANGE_WRAP_STYLE =
  'display:inline-flex;align-items:center;gap:6px;width:100%';
const RANGE_DISPLAY_STYLE =
  'min-width:50px;text-align:right;font-size:11px;color:#848484;';
const RADIO_WRAP_STYLE = 'display:inline-flex;align-items:center;gap:16px;';
const RADIO_LABEL_STYLE =
  'display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:#ccc;';
const BUTTON_STYLE =
  'padding:4px 14px;background:#1a2a3a;border:1px solid #2a4a5a;' +
  'color:#4a9eff;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
const STATIC_STYLE = 'font-size:11px;color:#888;white-space:pre-line;';
const STATUS_WRAP_STYLE = 'display:inline-flex;align-items:center;gap:8px;width:100%;';

// ─── Anti-loop flag + bound state helpers ────────────────────────────────

/**
 * Closure-held flag set whenever one of our own change listeners writes
 * to `settingsStore`. {@link syncInputsFromState} checks it and skips the
 * DOM resync in that case — otherwise every control change would loop:
 * control.change → store.update → subscriber → control re-set to the same
 * value we just wrote.
 *
 * Module-scope because both the builder closures (via writeSetting)
 * and `syncInputsFromState` need to see the same flag.
 */
let writingFromUi = false;

/**
 * Option ids whose `refreshEvent` document listener has already been
 * registered, so a panel rebuild doesn't stack duplicates. Module-scope
 * because the listener outlives any single build.
 *
 * @type {Set<string>}
 */
const asyncRefreshEventBound = new Set();

/**
 * Read the current `Settings` value for an option id. Centralised so
 * the cast from the heterogeneous `Settings` record to `unknown` lives
 * in one place rather than scattered across every control branch.
 *
 * @param {string} id Option id — must match a keyof Settings for bound types.
 * @returns {unknown}
 */
const readSetting = (id) => {
  const state = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (settingsStore.get())
  );
  return state[id];
};

/**
 * Write `value` under `id` via `settingsStore.update`. The
 * {@link writingFromUi} flag is raised for the duration of the update
 * so the subscribe callback knows to skip the DOM resync for this
 * change.
 *
 * @param {string} id
 * @param {unknown} value
 * @returns {void}
 */
const writeSetting = (id, value) => {
  writingFromUi = true;
  try {
    settingsStore.update((prev) => {
      const spread = {
        .../** @type {Record<string, unknown>} */ (/** @type {unknown} */ (prev)),
        [id]: value,
      };
      return /** @type {import('../../state/settings.js').Settings} */ (
        /** @type {unknown} */ (spread)
      );
    });
  } finally {
    writingFromUi = false;
  }
};

// ─── Per-type control builders ───────────────────────────────────────────
//
// Each builder appends ONE control (plus any wrapping / display span it
// needs) to the passed `valueCell`. No return value — the row's label +
// value cell structure is owned by {@link buildRow}, these functions
// only fill the control. Adding a new control type = write one new
// `buildXxxControl` and add one entry to {@link CONTROL_BUILDERS}; no
// edit to `buildRow` or `syncInputsFromState` needed.

/**
 * Render the checkbox flavour.
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildCheckboxControl = (opt, valueCell) => {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = INPUT_ID_PREFIX + opt.id;
  cb.checked = Boolean(readSetting(opt.id));
  cb.addEventListener('change', () => {
    writeSetting(opt.id, cb.checked);
  });

  // Optional inline action button pushed to the right (e.g. the sync master
  // row's "Sync now"): the checkbox stays the section toggle, the button
  // triggers the one-off action. Its enabled state is governed separately
  // by `buttonDisabledWhen` so the master checkbox can stay live while the
  // action greys out when the feature is off.
  if (opt.buttonText && opt.onclick) {
    const wrap = document.createElement('span');
    wrap.style.cssText = STATUS_WRAP_STYLE;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = INPUT_ID_PREFIX + opt.id + '-btn';
    btn.textContent = opt.buttonText;
    btn.style.cssText = BUTTON_STYLE + 'margin-left:auto;';
    btn.addEventListener('click', () => {
      if (opt.onclick) opt.onclick();
    });
    wrap.appendChild(cb);
    wrap.appendChild(btn);
    valueCell.appendChild(wrap);
    return;
  }

  valueCell.appendChild(cb);
};

/**
 * Render the range (slider + value display) flavour.
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildRangeControl = (opt, valueCell) => {
  const wrap = document.createElement('span');
  wrap.style.cssText = RANGE_WRAP_STYLE;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = INPUT_ID_PREFIX + opt.id;
  slider.min = String(opt.min ?? 0);
  slider.max = String(opt.max ?? 100);
  slider.step = String(opt.step ?? 1);
  slider.value = String(readSetting(opt.id));
  slider.style.flex = '1';

  const display = document.createElement('span');
  display.style.cssText = RANGE_DISPLAY_STYLE;
  display.textContent = slider.value + (opt.unit ?? '');

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    display.textContent = v + (opt.unit ?? '');
    writeSetting(opt.id, v);
  });

  wrap.appendChild(slider);
  wrap.appendChild(display);
  valueCell.appendChild(wrap);
};

/**
 * Render the radio (horizontal choice group) flavour. Data-bound like
 * select, but renders inline radios and writes the chosen value back as a
 * NUMBER (the few fields that use it are small integer caps, e.g. the
 * per-planet expedition limit). The wrapper carries the option id so
 * {@link syncInputsFromState} can re-check the matching radio.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildRadioControl = (opt, valueCell) => {
  const wrap = document.createElement('span');
  wrap.id = INPUT_ID_PREFIX + opt.id;
  wrap.style.cssText = RADIO_WRAP_STYLE;
  const name = INPUT_ID_PREFIX + opt.id;
  const current = Number(readSetting(opt.id));
  for (const choice of opt.radioOptions ?? []) {
    const lbl = document.createElement('label');
    lbl.style.cssText = RADIO_LABEL_STYLE;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = String(choice.value);
    radio.checked = choice.value === current;
    radio.addEventListener('change', () => {
      if (radio.checked) writeSetting(opt.id, choice.value);
    });
    lbl.appendChild(radio);
    lbl.appendChild(document.createTextNode(choice.label));
    wrap.appendChild(lbl);
  }
  valueCell.appendChild(wrap);
};

/**
 * Render the static (read-only text) flavour. `getText` is called once
 * at build time; subsequent refreshes flow through
 * {@link syncInputsFromState}.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildStaticControl = (opt, valueCell) => {
  const span = document.createElement('span');
  span.id = INPUT_ID_PREFIX + opt.id;
  span.style.cssText = STATIC_STYLE;
  span.textContent = opt.getText ? opt.getText() : '';

  // Optional external refresh trigger: re-run getText into the span whenever
  // the named document event fires — e.g. the sync layer's SYNC_STATUS_EVENT
  // after a sync settles. Bound once per id; the handler re-finds the span by
  // id, so it survives panel rebuilds.
  if (opt.refreshEvent && opt.getText && !asyncRefreshEventBound.has(opt.id)) {
    asyncRefreshEventBound.add(opt.id);
    const getText = opt.getText;
    document.addEventListener(opt.refreshEvent, () => {
      const el = document.getElementById(INPUT_ID_PREFIX + opt.id);
      if (el) el.textContent = getText();
    });
  }

  // Optional inline action button beside the text (e.g. the sync "Sync now"
  // trigger) — a status-line-plus-button laid out in a flex wrapper. The span
  // keeps its id, so the live `getText` refresh in syncInputsFromState still
  // finds it.
  if (opt.buttonText && opt.onclick) {
    const wrap = document.createElement('span');
    wrap.style.cssText = STATUS_WRAP_STYLE;
    span.style.cssText = STATIC_STYLE + 'flex:1;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = INPUT_ID_PREFIX + opt.id + '-btn';
    btn.textContent = opt.buttonText;
    btn.style.cssText = BUTTON_STYLE;
    btn.addEventListener('click', () => {
      if (opt.onclick) opt.onclick();
    });
    wrap.appendChild(span);
    wrap.appendChild(btn);
    valueCell.appendChild(wrap);
    return;
  }

  valueCell.appendChild(span);
};

/**
 * Dispatch table from `opt.type` → control builder. Adding a new type is:
 *   1. extend the `type` union in {@link SettingsOption}
 *   2. write one `buildXxxControl`
 *   3. add the entry here
 *   4. extend the type switch in {@link syncInputsFromState}
 *
 * @type {Record<SettingsOption['type'], (opt: SettingsOption, valueCell: HTMLTableCellElement) => void>}
 */
const CONTROL_BUILDERS = {
  checkbox: buildCheckboxControl,
  range: buildRangeControl,
  radio: buildRadioControl,
  static: buildStaticControl,
};

/**
 * Build one `<tr>` for a single option: label cell + value cell. The
 * per-type work lives in {@link CONTROL_BUILDERS}; this function just
 * lays down the row skeleton and delegates.
 *
 * For data-bound types (checkbox / range / radio) the control is
 * pre-populated from the current settings state and wired with a change
 * listener that writes back via {@link writeSetting}. The `static` type is
 * inert from the store's perspective — its span calls `opt.getText` once at
 * build time (and again on a `refreshEvent`).
 *
 * @param {SettingsOption} opt
 * @returns {HTMLTableRowElement}
 */
export const buildRow = (opt) => {
  const tr = document.createElement('tr');

  // Full-width rows: the 220px value column is too cramped for this row's
  // content, so it spans both columns with the label as a heading above the
  // control. The control builders just append into whatever cell they're
  // given, so the same builder fills a wide cell unchanged.
  if (opt.fullWidth) {
    const cell = document.createElement('td');
    cell.colSpan = 2;
    // An empty label drops the heading entirely (no bullet, no gap) — used by
    // the topic-privacy note, which reads as a standalone paragraph under the
    // topic row rather than its own labelled row.
    if (opt.label) {
      const labelEl = document.createElement('div');
      // Reuse AGR's label class for the bullet + colour; force block display so
      // its (table-cell-oriented) styling stacks above the control as a heading.
      labelEl.className = 'ago_menu_label_bullet';
      labelEl.style.cssText = 'display:block;margin-bottom:4px;';
      labelEl.textContent = opt.label;
      cell.appendChild(labelEl);
    }
    const buildFull = CONTROL_BUILDERS[opt.type];
    if (buildFull) buildFull(opt, cell);
    tr.appendChild(cell);
    return tr;
  }

  const labelCell = document.createElement('td');
  labelCell.className = 'ago_menu_label_bullet';
  labelCell.textContent = opt.label;
  tr.appendChild(labelCell);

  const valueCell = document.createElement('td');
  tr.appendChild(valueCell);

  const build = CONTROL_BUILDERS[opt.type];
  if (build) build(opt, valueCell);

  return tr;
};

/**
 * Sync every bound DOM input from current {@link settingsStore} state.
 * Called from the store subscriber in `./index.js` when any other code
 * path mutates settings — this keeps the panel correct without forcing
 * every UI binding to listen individually.
 *
 * Skips when {@link writingFromUi} is `true` — in that case we just
 * wrote the value ourselves, so the DOM is already up to date and the
 * resync would be a redundant no-op.
 *
 * Also refreshes the `static` rows by calling their `getText` — the
 * Status field's contents come from localStorage writes done outside
 * this module's awareness, so a subscriber-triggered refresh is the
 * closest natural moment to re-read them.
 *
 * @returns {void}
 */
export const syncInputsFromState = () => {
  for (const section of SECTIONS) {
    for (const opt of section.options) {
      const el = document.getElementById(INPUT_ID_PREFIX + opt.id);
      if (!el) continue;
      // Enable/disable a control from a predicate over current settings
      // (e.g. the alarmClock sub-options are disabled until the master switch
      // is on AND a token is set). Applied ALWAYS — including during our own
      // UI write — so flipping the master switch greys/un-greys dependents
      // immediately. Toggling `.disabled` never resets a caret.
      if (opt.disabledWhen) {
        /** @type {HTMLInputElement} */ (el).disabled =
          opt.disabledWhen(settingsStore.get());
      }
      // Inline action button (checkbox/static rows) greys independently of
      // its row's primary control — e.g. the sync master stays on while its
      // "Sync now" button disables when sync is off.
      if (opt.buttonDisabledWhen) {
        const btn = document.getElementById(INPUT_ID_PREFIX + opt.id + '-btn');
        if (btn) {
          /** @type {HTMLButtonElement} */ (btn).disabled =
            opt.buttonDisabledWhen(settingsStore.get());
        }
      }
      // Static rows are read-only derived text (e.g. the alarmClock-series
      // times that depend on the schedule select). Refresh them ALWAYS —
      // same reasoning as above.
      if (opt.type === 'static') {
        if (opt.getText) el.textContent = opt.getText();
        continue;
      }
      if (writingFromUi) continue;
      if (opt.type === 'checkbox') {
        /** @type {HTMLInputElement} */ (el).checked = Boolean(readSetting(opt.id));
      } else if (opt.type === 'range') {
        const current = String(readSetting(opt.id));
        /** @type {HTMLInputElement} */ (el).value = current;
        // The display span is the slider's next sibling inside the
        // range wrapper — see {@link buildRangeControl}.
        const display = el.nextElementSibling;
        if (display) display.textContent = current + (opt.unit ?? '');
      } else if (opt.type === 'radio') {
        const current = Number(readSetting(opt.id));
        const sel = /** @type {HTMLInputElement | null} */ (
          el.querySelector(`input[value="${current}"]`)
        );
        if (sel) sel.checked = true;
      }
    }
  }
};

/**
 * Test-only: clear the {@link writingFromUi} flag. Called by
 * `index.js`'s `_resetSettingsUiForTest` so a test that crashes
 * mid-write doesn't leak the flag into the next case. Exported with a
 * `_` prefix to signal "do not import from production code".
 *
 * @returns {void}
 */
export const _clearWritingFromUiForTest = () => {
  writingFromUi = false;
};
