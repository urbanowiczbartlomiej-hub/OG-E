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
// When the user types into a text input, our change handler updates
// the store, which fires the subscribe in `index.js`, which calls
// `syncInputsFromState`. Without the flag, the resync would overwrite
// the input mid-edit and reset the caret. The flag suppresses the
// resync during our own writes via `syncInputsFromState`'s early
// return.
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
 * the suffix of the DOM id (`oge-setting-<id>`). For `button` / `static`
 * options the id is read-only (`static` may read from any data source,
 * not necessarily a Settings field).
 *
 * @typedef {object} SettingsOption
 * @property {string} id Option identifier — matches `Settings` field for data-bound types.
 * @property {string} label Human-readable row label.
 * @property {'checkbox' | 'range' | 'text' | 'password' | 'button' | 'static'} type Control flavour.
 * @property {number} [min] Slider minimum (range only).
 * @property {number} [max] Slider maximum (range only).
 * @property {number} [step] Slider step (range only; defaults to 1).
 * @property {string} [unit] Slider display unit suffix (range only, e.g. `'px'`).
 * @property {string} [placeholder] Input placeholder (text / password only).
 * @property {string} [buttonText] Button label override (button only; defaults to `label`).
 * @property {() => void} [onclick] Button click handler (button only).
 * @property {() => string} [getText] Dynamic text producer (static only).
 */

/**
 * Shape of a single section in SECTIONS.
 *
 * @typedef {object} SettingsSection
 * @property {string} section Human-readable section title (rendered as a row header).
 * @property {SettingsOption[]} options Options within the section, rendered in order.
 */

/** Id prefix for input elements — used to find controls by option id on sync. */
export const INPUT_ID_PREFIX = 'oge-setting-';

// ─── Style constants ─────────────────────────────────────────────────────

const RANGE_WRAP_STYLE =
  'display:inline-flex;align-items:center;gap:6px;width:100%';
const RANGE_DISPLAY_STYLE =
  'min-width:50px;text-align:right;font-size:11px;color:#848484;';
const BUTTON_STYLE =
  'padding:4px 14px;background:#1a2a3a;border:1px solid #2a4a5a;' +
  'color:#4a9eff;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
const STATIC_STYLE = 'font-size:11px;color:#888;white-space:pre-line;';

// ─── Anti-loop flag + bound state helpers ────────────────────────────────

/**
 * Closure-held flag set whenever one of our own change listeners writes
 * to `settingsStore`. {@link syncInputsFromState} checks it and skips
 * the DOM resync in that case — otherwise typing into a text input
 * would loop: input.change → store.update → subscriber → input.value
 * = state, which in some browsers resets caret position mid-edit.
 *
 * Module-scope because both the builder closures (via writeSetting)
 * and `syncInputsFromState` need to see the same flag.
 */
let writingFromUi = false;

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
 * Render the text / password flavours. Shared because the only DOM
 * difference is `input.type`; the value-coercion + write-back logic is
 * identical. Detects numeric fields by the current runtime type of the
 * setting (pre-populated from the hydrated store), so adding a new
 * integer field to Settings requires zero edits here.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildInputControl = (opt, valueCell) => {
  const input = document.createElement('input');
  input.type = opt.type;
  input.id = INPUT_ID_PREFIX + opt.id;
  const currentValue = readSetting(opt.id);
  input.value = currentValue == null ? '' : String(currentValue);
  if (opt.placeholder) input.placeholder = opt.placeholder;
  // Capture the current value's TYPE at row-build time. Settings
  // typedef fields are either string or number in the text/password
  // flavour; we use the current runtime type to decide whether the
  // typed-in string should be coerced to a number on write-back.
  // Doing this on the current value (rather than consulting
  // SETTINGS_SCHEMA explicitly) keeps this module ignorant of the
  // schema shape — if a new int field gets added, as long as the
  // store holds a number we coerce correctly.
  const isNumberField = typeof currentValue === 'number';
  input.addEventListener('change', () => {
    const raw = input.value;
    /** @type {unknown} */
    let nextValue;
    if (isNumberField) {
      const n = parseInt(raw, 10);
      nextValue = Number.isFinite(n) ? n : currentValue;
    } else {
      nextValue = raw;
    }
    writeSetting(opt.id, nextValue);
  });
  valueCell.appendChild(input);
};

/**
 * Render the button flavour — not data-bound, just fires `opt.onclick`.
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildButtonControl = (opt, valueCell) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = INPUT_ID_PREFIX + opt.id;
  btn.textContent = opt.buttonText ?? opt.label;
  btn.style.cssText = BUTTON_STYLE;
  btn.addEventListener('click', () => {
    if (opt.onclick) opt.onclick();
  });
  valueCell.appendChild(btn);
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
  text: buildInputControl,
  password: buildInputControl,
  button: buildButtonControl,
  static: buildStaticControl,
};

/**
 * Build one `<tr>` for a single option: label cell + value cell. The
 * per-type work lives in {@link CONTROL_BUILDERS}; this function just
 * lays down the row skeleton and delegates.
 *
 * For data-bound types (checkbox / range / text / password) the control
 * is pre-populated from the current settings state and wired with a
 * change listener that writes back via {@link writeSetting}. For the
 * special types (button / static) the control is inert from the store's
 * perspective — a button calls `opt.onclick`, a static span calls
 * `opt.getText` once at build time.
 *
 * Text fields for fields that are numeric in the Settings typedef
 * auto-coerce via `parseInt`: typing a non-numeric string into e.g.
 * `colMinGap` keeps the previous numeric value (so the schema never
 * drifts into a string-typed field via UI input).
 *
 * @param {SettingsOption} opt
 * @returns {HTMLTableRowElement}
 */
export const buildRow = (opt) => {
  const tr = document.createElement('tr');

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
 * resync would be a no-op at best or (for text inputs) a caret-reset
 * at worst.
 *
 * Also refreshes the `static` rows by calling their `getText` — the
 * Status field's contents come from localStorage writes done outside
 * this module's awareness, so a subscriber-triggered refresh is the
 * closest natural moment to re-read them.
 *
 * @returns {void}
 */
export const syncInputsFromState = () => {
  if (writingFromUi) return;
  for (const section of SECTIONS) {
    for (const opt of section.options) {
      const el = document.getElementById(INPUT_ID_PREFIX + opt.id);
      if (!el) continue;
      if (opt.type === 'checkbox') {
        /** @type {HTMLInputElement} */ (el).checked = Boolean(readSetting(opt.id));
      } else if (opt.type === 'range') {
        const current = String(readSetting(opt.id));
        /** @type {HTMLInputElement} */ (el).value = current;
        // The display span is the slider's next sibling inside the
        // range wrapper — see {@link buildRangeControl}.
        const display = el.nextElementSibling;
        if (display) display.textContent = current + (opt.unit ?? '');
      } else if (opt.type === 'text' || opt.type === 'password') {
        const v = readSetting(opt.id);
        /** @type {HTMLInputElement} */ (el).value = v == null ? '' : String(v);
      } else if (opt.type === 'static') {
        if (opt.getText) el.textContent = opt.getText();
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
