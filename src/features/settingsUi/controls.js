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
import { parseDuration, formatDuration } from '../../domain/duration.js';
import { maskTopic } from '../../sync/reminders.js';

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
 * @property {'checkbox' | 'range' | 'text' | 'password' | 'button' | 'static' | 'select' | 'radio' | 'duration' | 'asyncStatus'} type Control flavour.
 * @property {number} [min] Slider minimum (range only).
 * @property {number} [max] Slider maximum (range only).
 * @property {number} [step] Slider step (range only; defaults to 1).
 * @property {string} [unit] Slider display unit suffix (range only, e.g. `'px'`).
 * @property {string} [placeholder] Input placeholder (text / password / duration only).
 * @property {{ value: string, label: string }[]} [selectOptions] Choices (select only).
 * @property {{ value: number, label: string }[]} [radioOptions] Choices for a horizontal radio group (radio only; values are written to the store as numbers).
 * @property {string} [buttonText] Button label. `button`: label override (defaults to `label`). `asyncStatus`: renders a manual-refresh button. `static`: with `onclick`, renders an inline action button beside the text.
 * @property {() => void} [onclick] Button click handler (`button`, or `static` with `buttonText`).
 * @property {() => string} [getText] Dynamic text producer (static only).
 * @property {(s: import('../../state/settings.js').Settings) => string} [refreshKey]
 *   `asyncStatus` only: a string derived from settings (e.g. the token). The
 *   async producer re-runs only when this value changes (or the manual
 *   button is clicked), so a fetch isn't fired on every unrelated store tick.
 * @property {(s: import('../../state/settings.js').Settings) => Promise<string>} [fetchText]
 *   `asyncStatus` only: resolves the line to display. Must not throw for the
 *   common failure modes — return a `✗ …` string instead.
 * @property {string} [refreshEvent]
 *   `asyncStatus` / `static`: a `document` event name that, when fired,
 *   re-runs the row's text producer (`fetchText` / `getText`). Lets an
 *   external producer (e.g. the sync layer after a sync settles) push a
 *   fresh status into the row without a settings-store change.
 * @property {boolean} [secret]
 *   `asyncStatus` only: the produced value is a capability secret (the ntfy
 *   topic). Render it MASKED behind an eye reveal toggle, plus a Copy button.
 *   The full value is stashed on the span's `dataset.full`; the buttons act on
 *   that, so Copy works while masked and a re-mask never loses the value.
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
export const INPUT_ID_PREFIX = 'oge-setting-';

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
// Free-value controls (text / password / select / duration) fill their
// cell so the offset/token strings aren't clipped in a narrow box. The
// column width is set once in `index.js`; `border-box` keeps the input
// inside the cell regardless of padding.
const FULL_WIDTH_STYLE = 'width:100%;box-sizing:border-box;';
const STATUS_WRAP_STYLE = 'display:inline-flex;align-items:center;gap:8px;width:100%;';

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
 * Per-`asyncStatus`-row bookkeeping, keyed by option id:
 *   - `lastKey` — the `refreshKey` value the displayed line reflects, so a
 *     store tick that didn't change the key skips the re-fetch.
 *   - `seq` — monotonically-increasing request id; a resolved fetch only
 *     paints if it is still the latest in-flight one (drops stale races,
 *     e.g. the user edits the token again before the first probe returns).
 *
 * @type {Map<string, { lastKey: string | undefined, seq: number }>}
 */
const asyncStatusState = new Map();

/**
 * Option ids whose `refreshEvent` document listener has already been
 * registered, so a panel rebuild doesn't stack duplicates. Module-scope
 * because the listener outlives any single build.
 *
 * @type {Set<string>}
 */
const asyncRefreshEventBound = new Set();

/**
 * Get (or lazily create) the bookkeeping entry for an `asyncStatus` row.
 *
 * @param {string} id
 * @returns {{ lastKey: string | undefined, seq: number }}
 */
const asyncStateFor = (id) => {
  let st = asyncStatusState.get(id);
  if (!st) {
    st = { lastKey: undefined, seq: 0 };
    asyncStatusState.set(id, st);
  }
  return st;
};

/**
 * Kick off (or refresh) an `asyncStatus` row's probe. Self-guards on
 * {@link asyncStateFor}'s `lastKey`: a no-op when the key is unchanged
 * unless `force` is set (the manual button). Paints `Checking…` while the
 * `fetchText` promise is in flight and the result only if no newer request
 * has started since.
 *
 * @param {SettingsOption} opt
 * @param {boolean} [force]
 * @returns {void}
 */
const refreshAsyncStatus = (opt, force = false) => {
  // Resolve the span FIRST and bail before touching `lastKey` if it isn't in
  // the document yet. The control builder fires an initial probe while its
  // row is still a DETACHED node (rows are appended to the table after
  // building), so `getElementById` misses it. If we recorded `lastKey` on
  // that miss, the post-append `syncInputsFromState` refresh would see an
  // unchanged key and skip painting — leaving the row blank until the token
  // changed. Bailing without recording lets that later, in-DOM call paint it.
  const span = document.getElementById(INPUT_ID_PREFIX + opt.id);
  if (!span || !opt.fetchText) return;
  const key = opt.refreshKey ? opt.refreshKey(settingsStore.get()) : '';
  const st = asyncStateFor(opt.id);
  if (!force && key === st.lastKey) return;
  st.lastKey = key;
  const seq = ++st.seq;
  span.textContent = 'Checking…';
  Promise.resolve(opt.fetchText(settingsStore.get()))
    .then((txt) => {
      if (st.seq !== seq) return;
      if (opt.secret) paintSecretValue(span, txt);
      else span.textContent = txt;
    })
    .catch(() => {
      if (st.seq === seq) span.textContent = '✗ check failed';
    });
};

/**
 * Paint a `secret` row's value: stash the full string on the span's dataset and
 * display it masked unless the row is currently revealed. The eye/copy buttons
 * read `dataset.full`, so they always act on the true value (Copy works while
 * masked; a re-probe re-mask never loses it). A non-topic value (placeholder)
 * passes through {@link maskTopic} unchanged.
 *
 * @param {HTMLElement} span
 * @param {string} txt
 * @returns {void}
 */
const paintSecretValue = (span, txt) => {
  span.dataset.full = txt;
  span.textContent = span.dataset.revealed === '1' ? txt : maskTopic(txt);
};

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
  input.style.cssText = FULL_WIDTH_STYLE;
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
 * Render the select (dropdown) flavour. Data-bound like the input
 * flavours: the current Settings value selects the matching `<option>`,
 * and a change writes the chosen value back through {@link writeSetting}.
 * Used for the few preferences that are an enumerated choice rather than
 * a free value (e.g. the reminder schedule preset).
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildSelectControl = (opt, valueCell) => {
  const select = document.createElement('select');
  select.id = INPUT_ID_PREFIX + opt.id;
  select.style.cssText = FULL_WIDTH_STYLE;
  const current = String(readSetting(opt.id) ?? '');
  for (const choice of opt.selectOptions ?? []) {
    const optionEl = document.createElement('option');
    optionEl.value = choice.value;
    optionEl.textContent = choice.label;
    if (choice.value === current) optionEl.selected = true;
    select.appendChild(optionEl);
  }
  select.addEventListener('change', () => {
    writeSetting(opt.id, select.value);
  });
  valueCell.appendChild(select);
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

  // Optional external refresh trigger (same contract as asyncStatus): re-run
  // getText into the span whenever the named document event fires — e.g. the
  // sync layer's SYNC_STATUS_EVENT after a sync settles. Bound once per id;
  // the handler re-finds the span by id, so it survives panel rebuilds.
  if (opt.refreshEvent && opt.getText && !asyncRefreshEventBound.has(opt.id)) {
    asyncRefreshEventBound.add(opt.id);
    const getText = opt.getText;
    document.addEventListener(opt.refreshEvent, () => {
      const el = document.getElementById(INPUT_ID_PREFIX + opt.id);
      if (el) el.textContent = getText();
    });
  }

  // Optional inline action button beside the text (e.g. the sync "Sync now"
  // trigger) — laid out exactly like the asyncStatus row's button so a
  // status-line-plus-button reads the same everywhere. The span keeps its
  // id, so the live `getText` refresh in syncInputsFromState still finds it.
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
 * Render the duration flavour — a text input over an INT-SECONDS Settings
 * field, displayed and edited in the minutes-first grammar (see
 * `domain/duration.js`). The store always holds canonical seconds; this
 * control is the only place the user sees/types the `Nm`/`Ns` form.
 *
 * On edit: parse the typed token; if it's well-formed, write the seconds
 * and re-render the canonical form (so `90` snaps to `90s`, `1.5m` to
 * `90s`); if it's garbage, revert to the stored value rather than writing a
 * NaN.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildDurationControl = (opt, valueCell) => {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = INPUT_ID_PREFIX + opt.id;
  input.style.cssText = FULL_WIDTH_STYLE;
  if (opt.placeholder) input.placeholder = opt.placeholder;
  input.value = formatDuration(Number(readSetting(opt.id)));
  input.addEventListener('change', () => {
    const sec = parseDuration(input.value);
    if (sec === null) {
      input.value = formatDuration(Number(readSetting(opt.id)));
      return;
    }
    writeSetting(opt.id, sec);
    input.value = formatDuration(sec);
  });
  valueCell.appendChild(input);
};

/**
 * Build the vertical stack for a `secret` asyncStatus row: a right-aligned
 * button bar (eye reveal toggle + Copy) above the masked value span. Both
 * buttons act on the span's `dataset.full`, so Copy works while masked and a
 * re-probe re-mask never loses the value. Appends the whole stack to `valueCell`.
 *
 * @param {SettingsOption} opt
 * @param {HTMLElement} span The (already-styled) value span, with its id set.
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildSecretStack = (opt, span, valueCell) => {
  const col = document.createElement('span');
  col.style.cssText =
    'display:flex;flex-direction:column;align-items:flex-end;gap:4px;width:100%;';

  const bar = document.createElement('span');
  bar.style.cssText = 'display:inline-flex;align-items:center;gap:8px;';

  const eye = document.createElement('button');
  eye.type = 'button';
  eye.id = INPUT_ID_PREFIX + opt.id + '-eye';
  eye.textContent = '👁';
  eye.title = 'Show';
  eye.setAttribute('aria-label', 'Show topic');
  eye.setAttribute('aria-pressed', 'false');
  eye.style.cssText = BUTTON_STYLE;
  eye.addEventListener('click', () => {
    const revealed = span.dataset.revealed === '1';
    span.dataset.revealed = revealed ? '0' : '1';
    const full = span.dataset.full || '';
    span.textContent = revealed ? maskTopic(full) : full;
    eye.title = revealed ? 'Show' : 'Hide';
    eye.setAttribute('aria-label', revealed ? 'Show topic' : 'Hide topic');
    eye.setAttribute('aria-pressed', String(!revealed));
  });
  bar.appendChild(eye);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.id = INPUT_ID_PREFIX + opt.id + '-copy';
  copy.textContent = 'Copy';
  copy.style.cssText = BUTTON_STYLE;
  let copyTimer = 0;
  copy.addEventListener('click', async () => {
    // Copy the REAL value, never the (masked) display text.
    const full = span.dataset.full || '';
    if (!full.startsWith('oge-')) return;
    let ok = true;
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      ok = false;
    }
    copy.textContent = ok ? 'Copied!' : 'Copy failed';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copy.textContent = 'Copy'; copyTimer = 0; }, 1200);
  });
  bar.appendChild(copy);

  col.appendChild(bar);
  col.appendChild(span);
  valueCell.appendChild(col);
};

/**
 * Render the asyncStatus flavour — a read-only line whose text is produced
 * by an ASYNC `fetchText` (e.g. an ntfy account probe), plus an optional
 * manual-refresh button. Not data-bound; the producer reads settings
 * itself. Refresh policy lives in {@link refreshAsyncStatus}: auto on
 * `refreshKey` change (and once at build), on demand via the button.
 *
 * Secret rows (the ntfy topic) delegate their layout to {@link buildSecretStack}.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildAsyncStatusControl = (opt, valueCell) => {
  const span = document.createElement('span');
  span.id = INPUT_ID_PREFIX + opt.id;

  if (opt.secret) {
    // Secret rows (the ntfy topic) lay the value out as a VERTICAL stack: a
    // right-aligned [reveal][copy] button bar ABOVE the masked value, so it
    // reads label-on-the-left / value-on-the-right with the controls sitting
    // over the value (mirrors how the master row's "Check now" sits above the
    // token row). The narrow 220px value column couldn't fit value + two
    // buttons on one line — that inline layout overflowed into a scroll.
    span.style.cssText = STATIC_STYLE + 'text-align:right;overflow-wrap:anywhere;';
    buildSecretStack(opt, span, valueCell);
  } else {
    const wrap = document.createElement('span');
    wrap.style.cssText = STATUS_WRAP_STYLE;
    span.style.cssText = STATIC_STYLE + 'flex:1;';
    wrap.appendChild(span);

    if (opt.buttonText) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = INPUT_ID_PREFIX + opt.id + '-btn';
      btn.textContent = opt.buttonText;
      btn.style.cssText = BUTTON_STYLE;
      btn.addEventListener('click', () => refreshAsyncStatus(opt, true));
      wrap.appendChild(btn);
    }

    valueCell.appendChild(wrap);
  }

  // Initial probe (lastKey starts undefined, so this always runs once).
  refreshAsyncStatus(opt);

  // Optional external refresh trigger: re-run fetchText whenever the named
  // document event fires (e.g. the sync layer's `oge:syncStatus` after a
  // sync settles). Bound once per id — the panel is built once, but the
  // guard keeps a rebuild (tests) from stacking duplicate listeners. The
  // handler re-finds the span by id, so it stays correct across rebuilds.
  if (opt.refreshEvent && !asyncRefreshEventBound.has(opt.id)) {
    asyncRefreshEventBound.add(opt.id);
    document.addEventListener(opt.refreshEvent, () => refreshAsyncStatus(opt, true));
  }
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
  select: buildSelectControl,
  radio: buildRadioControl,
  button: buildButtonControl,
  static: buildStaticControl,
  duration: buildDurationControl,
  asyncStatus: buildAsyncStatusControl,
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
 * `colonyMinGap` keeps the previous numeric value (so the schema never
 * drifts into a string-typed field via UI input).
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
  for (const section of SECTIONS) {
    for (const opt of section.options) {
      const el = document.getElementById(INPUT_ID_PREFIX + opt.id);
      if (!el) continue;
      // asyncStatus: the disable target is the manual button (the text span
      // can't be disabled), and a refreshKey change re-probes. Handled
      // ALWAYS (like static), then short-circuited.
      if (opt.type === 'asyncStatus') {
        const btn = document.getElementById(INPUT_ID_PREFIX + opt.id + '-btn');
        if (btn && opt.disabledWhen) {
          /** @type {HTMLButtonElement} */ (btn).disabled = opt.disabledWhen(settingsStore.get());
        }
        refreshAsyncStatus(opt);
        continue;
      }
      // Enable/disable a control from a predicate over current settings
      // (e.g. the reminder sub-options are disabled until the master switch
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
      // Static rows are read-only derived text (e.g. the reminder-series
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
      } else if (opt.type === 'text' || opt.type === 'password') {
        const v = readSetting(opt.id);
        /** @type {HTMLInputElement} */ (el).value = v == null ? '' : String(v);
      } else if (opt.type === 'select') {
        /** @type {HTMLSelectElement} */ (el).value = String(readSetting(opt.id) ?? '');
      } else if (opt.type === 'radio') {
        const current = Number(readSetting(opt.id));
        const sel = /** @type {HTMLInputElement | null} */ (
          el.querySelector(`input[value="${current}"]`)
        );
        if (sel) sel.checked = true;
      } else if (opt.type === 'duration') {
        // Re-render the canonical minutes-first form from stored seconds.
        /** @type {HTMLInputElement} */ (el).value = formatDuration(Number(readSetting(opt.id)));
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
