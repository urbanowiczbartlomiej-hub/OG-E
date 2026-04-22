// Settings panel — OG-E's preferences UI injected as a tab at the bottom
// of the AntiGameReborn (AGR) options menu.
//
// # Why we integrate with AGR instead of rendering a standalone panel
//
// OG-E has always (back to 4.x) assumed AGR is installed alongside it —
// AGR's own options menu is the canonical place users of both extensions
// expect toggles to live. Rendering a second floating panel just for OG-E
// would split the "where do I change settings" mental model across two
// surfaces. By appending to `.ago_menu_content` we get a coherent UX: one
// menu open, both extensions visible.
//
// The hard dependency on AGR is a DESIGN.md §15 P3 decision — if AGR is
// not installed there simply is no settings UI. Users who want the
// feature set without the panel can still edit localStorage directly
// (keys under `oge5_` prefix — see `src/state/settings.js`), but that is
// not a supported workflow. See `src/state/settings.js` for the full
// argument on why persistence is per-key (AGR compatibility is the #1
// reason).
//
// # Lifecycle (one-shot install, not re-entrant)
//
//   1. `waitFor(() => document.querySelector('.ago_menu_content'), 10s)`.
//      If AGR never appears, the install silently no-ops. No error, no
//      warning — installing OG-E without AGR is a valid configuration
//      that just happens to hide this feature.
//   2. Once the container appears, we append a header div + a single
//      `<table>` of rows built from the declarative {@link SECTIONS}
//      config. Idempotent: the header's stable id short-circuits a
//      double-inject attempt.
//   3. Each row's control is wired with a change listener that writes
//      back to {@link settingsStore} via `.update`. We do NOT write to
//      localStorage directly — the settings store's own persist
//      subscription handles that, keeping this module purely a UI layer.
//   4. A single `settingsStore.subscribe` drives inbound reactivity:
//      when any other code path (bridge reaction, direct update from
//      devtools, a hypothetical second UI) mutates settings, our DOM
//      inputs re-sync so the panel is never stale. Crucially we use
//      a "writing" flag to avoid feedback loops: when the user types
//      into an input, our change handler updates the store, which fires
//      the subscriber, which would otherwise overwrite the input's
//      value mid-edit. The flag suppresses the sync-back during our
//      own writes.
//   5. Dispose tears down both the DOM and the subscription. Calling
//      dispose before AGR ever appeared is safe — the pending `waitFor`
//      promise will see the `disposed` closure flag and no-op on
//      resolution. This matters because install/dispose cycles happen
//      on every test case (via `_resetSettingsUiForTest`).
//
// # Why no bridges import
//
// Per v5 architecture, feature modules run in the isolated content-script
// world. They can call into state/lib/domain, but not bridges — those are
// page-world shims. The sync-status refresh + force-sync button both
// communicate via `document.dispatchEvent(new CustomEvent(...))` to
// sidestep the world boundary, matching how 4.x settings.js did it.
//
// @see ../state/settings.js — the store this module's controls bind to.
// @see ../../../settings.js — v4 AGR-injection code; behavioural
//   reference for buildRow / container selector / section grouping.

/** @ts-check */

import { settingsStore } from '../state/settings.js';
import { safeLS } from '../lib/storage.js';
import { waitFor } from '../lib/dom.js';

/** DOM id of the settings header element. Stable so idempotency can check it. */
const HEADER_ID = 'oge5-settings-header';

/** DOM id of the settings table element. Stable for dispose + query by tests. */
const TABLE_ID = 'oge5-settings-table';

/** Id prefix for input elements — used to find controls by option id on sync. */
const INPUT_ID_PREFIX = 'oge5-setting-';

/**
 * CSS selector for the AGR menu container. AGR owns this node; we only
 * append into it. If this class name changes upstream this module breaks
 * — the breakage is loud (no settings tab visible) but not silent DOM
 * poisoning, which is the right failure mode.
 */
const AGR_SELECTOR = '.ago_menu_content';

/**
 * Maximum time we wait for AGR to hydrate its container. Ten seconds is
 * generous — AGR typically renders within ~500 ms of DOMContentLoaded.
 * A user who waited past 10s for AGR either doesn't have it installed
 * or has a broken install; in both cases silently no-oping is correct.
 */
const AGR_TIMEOUT_MS = 10_000;

/**
 * Poll interval for the AGR wait. 200 ms balances responsiveness against
 * CPU cost (the timer fires for the entire 10 s timeout when AGR never
 * appears).
 */
const AGR_POLL_MS = 200;

/** localStorage keys used by the Status field. Written by sync code (v4 + v5). */
const LS_LAST_SYNC_AT = 'oge5_lastSyncAt';
const LS_LAST_DOWN_AT = 'oge5_lastDownAt';
const LS_LAST_SYNC_ERR = 'oge5_lastSyncErr';

/**
 * Read sync status from localStorage and compose a multi-line status
 * string. Each line is optional; the caller renders the span with
 * `white-space: pre-line` so `\n` becomes a visible break.
 *
 * Format:
 *   `↑ <upload time>`
 *   `↓ <download time>`
 *   `⚠ <error message>`   (only when `oge5_lastSyncErr` is set)
 *
 * A missing / unparseable timestamp renders as an em-dash. Unknown
 * localStorage failures (quota, private-mode) silently collapse to the
 * em-dash path since `safeLS.get` swallows them.
 *
 * @returns {string}
 */
const formatSyncStatus = () => {
  /**
   * @param {string | null} iso
   * @returns {string}
   */
  const fmt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  };
  const up = safeLS.get(LS_LAST_SYNC_AT);
  const down = safeLS.get(LS_LAST_DOWN_AT);
  const err = safeLS.get(LS_LAST_SYNC_ERR);
  const lines = ['↑ ' + fmt(up), '↓ ' + fmt(down)];
  if (err) lines.push('⚠ ' + err);
  return lines.join('\n');
};

/**
 * Shape of a single option in the {@link SECTIONS} config. Each `type`
 * is rendered differently in {@link buildRow} — think of this typedef as
 * the discriminated union of all control flavours the panel supports.
 *
 * `id` is both the `keyof Settings` field (for data-bound types) and
 * the suffix of the DOM id (`oge5-setting-<id>`). For `button` / `static`
 * options the id is read-only (`static` may read from any data source,
 * not necessarily a Settings field).
 *
 * @typedef {object} SettingsOption
 * @property {string} id Option identifier — matches {@link Settings} field for data-bound types.
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
 * Shape of a single section in {@link SECTIONS}.
 *
 * @typedef {object} SettingsSection
 * @property {string} section Human-readable section title (rendered as a row header).
 * @property {SettingsOption[]} options Options within the section, rendered in order.
 */

/**
 * Declarative layout of the entire settings panel. Grouped by section
 * for readability; each section renders a full-width header row followed
 * by one row per option.
 *
 * Every data-bound option's `id` MUST match a field of `Settings` —
 * typecheck catches the mismatch via the index read in `buildRow`.
 *
 * @type {SettingsSection[]}
 */
const SECTIONS = [
  {
    section: 'Expeditions',
    options: [
      { id: 'mobileMode', label: 'Send Exp button (floating)', type: 'checkbox' },
      { id: 'enterBtnSize', label: 'Send Exp button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px' },
      { id: 'expeditionBadges', label: 'Expedition badges on planets', type: 'checkbox' },
      { id: 'autoRedirectExpedition', label: 'After sending expedition, open the next planet', type: 'checkbox' },
      { id: 'maxExpPerPlanet', label: 'Max expeditions per planet', type: 'text', placeholder: 'e.g. 1' },
    ],
  },
  {
    section: 'Colonization',
    options: [
      { id: 'colonizeMode', label: 'Send Col button (floating)', type: 'checkbox' },
      { id: 'colBtnSize', label: 'Send Col button size', type: 'range', min: 40, max: 560, step: 10, unit: 'px' },
      { id: 'colPositions', label: 'Required target positions (only these will be colonized)', type: 'text', placeholder: 'e.g. 8,9,7,10,6' },
      { id: 'colPreferOtherGalaxies', label: 'Prefer neighbouring galaxies first (more predictable arrival times)', type: 'checkbox' },
      { id: 'colMinGap', label: 'Min gap between arrivals (sec)', type: 'text', placeholder: 'e.g. 20' },
      { id: 'colMinFields', label: 'Min fields to keep colony', type: 'text', placeholder: 'e.g. 200' },
      { id: 'colPassword', label: 'Account password (for abandon)', type: 'password' },
    ],
  },
  {
    section: 'Cloud sync',
    options: [
      { id: 'cloudSync', label: 'Enable cloud sync', type: 'checkbox' },
      { id: 'gistToken', label: 'GitHub Personal Access Token (gist scope)', type: 'password' },
      {
        id: 'syncForce',
        label: 'Force sync now',
        type: 'button',
        buttonText: 'Sync',
        onclick: () => document.dispatchEvent(new CustomEvent('oge5:syncForce')),
      },
      { id: 'syncStatus', label: 'Status', type: 'static', getText: () => formatSyncStatus() },
    ],
  },
];

/**
 * Closure-held flag set whenever one of our own change listeners writes
 * to `settingsStore`. The subscribe callback checks it and skips the
 * DOM resync in that case — otherwise typing into a text input would
 * loop: input.change → store.update → subscriber → input.value = state,
 * which in some browsers resets caret position mid-edit.
 *
 * Module-scope because both {@link buildRow} (via its listeners) and
 * {@link syncInputsFromState} (via the subscriber) need to see the
 * same flag. Re-initialised on every `installSettingsUi` call.
 */
let writingFromUi = false;

/**
 * Read the current {@link Settings} value for an option id. Centralised
 * so the cast from the heterogeneous `Settings` record to `unknown` lives
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
 * Write `value` under `id` via `settingsStore.update`. The `writingFromUi`
 * flag is raised for the duration of the update so the subscribe callback
 * knows to skip the DOM resync for this change.
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
      return /** @type {import('../state/settings.js').Settings} */ (
        /** @type {unknown} */ (spread)
      );
    });
  } finally {
    writingFromUi = false;
  }
};

/**
 * Build one `<tr>` for a single option. The row is a label cell + a
 * control cell; the control's exact DOM depends on `opt.type`.
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
const buildRow = (opt) => {
  const tr = document.createElement('tr');

  const labelCell = document.createElement('td');
  labelCell.className = 'ago_menu_label_bullet';
  labelCell.textContent = opt.label;
  tr.appendChild(labelCell);

  const valueCell = document.createElement('td');
  tr.appendChild(valueCell);

  if (opt.type === 'checkbox') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = INPUT_ID_PREFIX + opt.id;
    cb.checked = Boolean(readSetting(opt.id));
    cb.addEventListener('change', () => {
      writeSetting(opt.id, cb.checked);
    });
    valueCell.appendChild(cb);
  } else if (opt.type === 'range') {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;width:100%';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = INPUT_ID_PREFIX + opt.id;
    slider.min = String(opt.min ?? 0);
    slider.max = String(opt.max ?? 100);
    slider.step = String(opt.step ?? 1);
    slider.value = String(readSetting(opt.id));
    slider.style.flex = '1';

    const display = document.createElement('span');
    display.style.cssText = 'min-width:50px;text-align:right;font-size:11px;color:#848484;';
    display.textContent = slider.value + (opt.unit ?? '');

    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      display.textContent = v + (opt.unit ?? '');
      writeSetting(opt.id, v);
    });

    wrap.appendChild(slider);
    wrap.appendChild(display);
    valueCell.appendChild(wrap);
  } else if (opt.type === 'text' || opt.type === 'password') {
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
  } else if (opt.type === 'button') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = INPUT_ID_PREFIX + opt.id;
    btn.textContent = opt.buttonText ?? opt.label;
    btn.style.cssText = 'padding:4px 14px;background:#1a2a3a;border:1px solid #2a4a5a;color:#4a9eff;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
    btn.addEventListener('click', () => {
      if (opt.onclick) opt.onclick();
    });
    valueCell.appendChild(btn);
  } else if (opt.type === 'static') {
    const span = document.createElement('span');
    span.id = INPUT_ID_PREFIX + opt.id;
    span.style.cssText = 'font-size:11px;color:#888;white-space:pre-line;';
    span.textContent = opt.getText ? opt.getText() : '';
    valueCell.appendChild(span);
  }

  return tr;
};

/**
 * Sync every bound DOM input from current {@link settingsStore} state.
 * Called from the store subscriber when any other code path mutates
 * settings — this keeps the panel correct without forcing every UI
 * binding to listen individually.
 *
 * Skips when {@link writingFromUi} is `true` — in that case we just
 * wrote the value ourselves, so the DOM is already up to date and the
 * resync would be a no-op at best or (for text inputs) a caret-reset
 * at worst.
 *
 * Also refreshes the `static` rows by calling their `getText` — the
 * Status field's contents come from localStorage writes done outside
 * this module's awareness, so a subscriber-triggered refresh is the
 * closest natural moment to re-read them. (A settings change fires the
 * subscriber, and sync has typically just bumped one of the LS keys
 * shortly before the `syncForce` button updates `cloudSync` or similar.)
 *
 * @returns {void}
 */
const syncInputsFromState = () => {
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
        // range wrapper — see buildRow.
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
 * Module-scope install handle. Holds the dispose fn between install
 * and dispose; `null` otherwise. Used to make {@link installSettingsUi}
 * idempotent (second call returns the same dispose without touching
 * DOM) and to let in-flight AGR-wait resolutions exit early when the
 * install has been disposed before AGR ever appeared.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the OG-E settings panel into the AGR options menu.
 *
 * Lifecycle:
 *   1. Waits up to 10 s for `.ago_menu_content` (the AGR container).
 *      Silent no-op on timeout — OG-E without AGR has no settings UI.
 *   2. On availability, appends header + table; binds each row's
 *      control to {@link settingsStore}.
 *   3. Subscribes to settings for outbound-change resync.
 *   4. Returns a dispose fn that removes the injected DOM and cuts
 *      the subscription.
 *
 * Idempotent: a second `installSettingsUi()` while already installed
 * returns the SAME dispose fn as the first call. If the first call is
 * still waiting for AGR when the second call fires, the second call
 * sees `installed !== null` and also returns the same dispose handle —
 * the pending wait-then-inject continues as a single render.
 *
 * Dispose-before-ready: calling the returned dispose while the AGR
 * wait is still pending cancels the render via a closure `disposed`
 * flag; when AGR eventually appears the resolution callback sees the
 * flag and no-ops. This lets test cycles tear down cleanly even when
 * AGR is deliberately never provided.
 *
 * @returns {() => void} Dispose handle.
 */
export const installSettingsUi = () => {
  if (installed) return installed.dispose;

  // Closure flag tied to THIS install. Flipped by the dispose fn; the
  // AGR-resolution callback checks it to decide whether to render.
  // Using a closure (rather than re-checking `installed === sentinel`)
  // means re-installs after dispose work cleanly: a brand-new install
  // gets a brand-new `disposed` flag in a brand-new closure.
  let disposed = false;

  /**
   * Unsubscribe from `settingsStore`. Set inside the AGR-ready branch,
   * so calling dispose BEFORE AGR appears is a no-op for this line —
   * which is the correct behaviour (nothing to unsubscribe yet).
   * @type {(() => void) | null}
   */
  let unsubSettings = null;

  /** @type {HTMLElement | null} */
  let headerEl = null;

  /** @type {HTMLTableElement | null} */
  let tableEl = null;

  // Compose a dispose fn that handles both phases:
  //   - Before AGR appears: flip the flag so the resolution no-ops.
  //   - After AGR appears: remove DOM + unsubscribe.
  // Assigning to `installed.dispose` before the wait resolves means
  // the caller can dispose at any moment without caring which phase
  // we are in.
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (unsubSettings) unsubSettings();
    if (headerEl) headerEl.remove();
    if (tableEl) tableEl.remove();
    installed = null;
  };

  installed = { dispose };

  waitFor(() => document.querySelector(AGR_SELECTOR), {
    timeoutMs: AGR_TIMEOUT_MS,
    intervalMs: AGR_POLL_MS,
  }).then((container) => {
    // Bail if dispose has been called, or AGR never appeared, or
    // someone has already injected our header (test re-entrancy).
    if (disposed) return;
    if (!container) return;
    if (document.getElementById(HEADER_ID)) return;

    headerEl = document.createElement('div');
    headerEl.id = HEADER_ID;
    headerEl.textContent = 'OG-E v5 Settings';
    headerEl.style.cssText = 'font-weight:bold;margin:8px 0;color:#4a9eff;';
    container.appendChild(headerEl);

    tableEl = document.createElement('table');
    tableEl.id = TABLE_ID;
    for (const section of SECTIONS) {
      const sectionRow = document.createElement('tr');
      const sectionCell = document.createElement('td');
      sectionCell.colSpan = 2;
      sectionCell.textContent = section.section;
      sectionCell.style.cssText = 'font-weight:bold;padding:8px 0;color:#4a9eff;';
      sectionRow.appendChild(sectionCell);
      tableEl.appendChild(sectionRow);
      for (const opt of section.options) {
        tableEl.appendChild(buildRow(opt));
      }
    }
    container.appendChild(tableEl);

    unsubSettings = settingsStore.subscribe(() => {
      if (disposed) return;
      syncInputsFromState();
    });
  });

  return dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Runs the
 * current dispose (if any) so each test case starts with a clean DOM
 * and no leaked subscribers. Exported with a `_` prefix to signal
 * "do not import from production code".
 *
 * Also clears {@link writingFromUi} defensively — a test that crashes
 * mid-write could theoretically leave the flag set; clearing it here
 * guarantees the next test starts from a clean state.
 *
 * @returns {void}
 */
export const _resetSettingsUiForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  writingFromUi = false;
};
