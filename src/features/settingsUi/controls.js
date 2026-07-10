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
import { injectStyle, parseSvg } from '../../lib/dom.js';
import { appendGlyph, installButtonChrome } from '../shared/buttonChrome.js';

/**
 * Shape of a single option in the SECTIONS config. Each `type` is
 * rendered differently in {@link buildRow} — think of this typedef as
 * the discriminated union of all control flavours the panel supports.
 *
 * `id` is both the `keyof Settings` field (for data-bound types) and
 * the suffix of the DOM id (`oge-setting-<id>`). For `static`
 * options the id is read-only (`static` may read from any data source,
 * not necessarily a Settings field); `moduleTiles` binds each TILE to its
 * own `tiles[].settingKey`, so its id is synthetic too.
 *
 * @typedef {object} SettingsOption
 * @property {string} id Option identifier — matches `Settings` field for data-bound types.
 * @property {string} label Human-readable row label.
 * @property {'checkbox' | 'range' | 'radio' | 'static' | 'moduleTiles' | 'prefTiles'} type Control flavour.
 * @property {number} [min] Slider minimum (range only).
 * @property {number} [max] Slider maximum (range only).
 * @property {number} [step] Slider step (range only; defaults to 1).
 * @property {string} [unit] Slider display unit suffix (range only, e.g. `'px'`).
 * @property {{ value: number, label: string }[]} [radioOptions] Choices for a horizontal radio group (radio only; values are written to the store as numbers).
 * @property {import('../shared/fabModules.js').FabModule[]} [tiles]
 *   Module identities for the multi-select tile bar (`moduleTiles` only) —
 *   one independent toggle tile per entry, bound to `entry.settingKey`.
 * @property {() => HTMLElement} [topSlot]
 *   `moduleTiles` only: builds an element rendered flush ABOVE the tiles
 *   inside the same bordered block (the Dashboard launcher).
 * @property {RangeSpec} [sizeSlider]
 *   `moduleTiles` only: a range spec rendered as the block's BOTTOM segment
 *   (the shared FAB size slider — it sizes the buttons the tiles preview,
 *   so it lives inside the block, not as its own row).
 * @property {PrefGroup[]} [prefGroups]
 *   Tile groups for the preferences panel (`prefTiles` only).
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
 * One self-indicating toggle tile of the preferences panel: a flat line
 * glyph + keyword caption bound to a boolean Settings field. Optional
 * extras: an embedded numeric segment (`seg` — its own field, radio
 * semantics, clicks don't toggle the tile) and a corner action pill
 * (`action` — fires independently of the toggle, e.g. the banner preview).
 *
 * @typedef {object} PrefTile
 * @property {keyof import('../../state/settings.js').Settings} key
 *   Boolean Settings field the tile toggles.
 * @property {string} caption Keyword label (full sentence goes in `hint`).
 * @property {string} glyph   Inner SVG markup (`0 0 64 64`, currentColor).
 * @property {string} [hint]  Tooltip — the old full-sentence row label.
 * @property {{
 *   key: keyof import('../../state/settings.js').Settings,
 *   caption: string,
 *   choices: number[],
 *   hint?: string,
 * }} [seg]
 * @property {{ label: string, run: () => void, hint?: string }} [action]
 */

/**
 * Minimal slider spec — the `range` fields of a {@link SettingsOption},
 * reusable standalone as a moduleTiles block's nested `sizeSlider`.
 *
 * @typedef {object} RangeSpec
 * @property {string} id `keyof Settings` field the slider binds to (numeric).
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} [unit]
 */

/**
 * One captioned group of preference tiles.
 *
 * @typedef {object} PrefGroup
 * @property {string} caption Thin muted group caption inside the panel.
 * @property {number} columns Grid columns; 1 = full-width two-zone row tiles.
 * @property {PrefTile[]} tiles
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

const RADIO_WRAP_STYLE = 'display:inline-flex;align-items:center;gap:16px;';
const RADIO_LABEL_STYLE =
  'display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:#ccc;';
const BUTTON_STYLE =
  'padding:4px 14px;background:#1a2a3a;border:1px solid #2a4a5a;' +
  'color:#4a9eff;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
const STATIC_STYLE = 'font-size:11px;color:#888;white-space:pre-line;';
const STATUS_WRAP_STYLE = 'display:inline-flex;align-items:center;gap:8px;width:100%;';

// ─── Range slider (injected stylesheet, not inline) ──────────────────────
//
// Native <input type=range> restyled to the panel's design language: slim
// rounded track, lit progress fill + a ringed round thumb in the panel's
// #4a9eff accent (the dark ring makes the knob read as a physical cap, not
// the browser default dot). Stylesheet (not inline) because tracks/thumbs
// are only reachable through vendor pseudo-elements. `-moz-range-progress`
// paints the filled side on Firefox (the shipping target); WebKit has no
// track-fill pseudo, so there the track stays uniformly dark. The wrap is
// layout-neutral — its seat comes from the host (`.oge-fab-size` inside the
// command block, or the standalone `.oge-range-row` margins).

/** Injected-once `<style>` id for the range slider. */
const RANGE_STYLE_ID = 'oge-setting-range-style';

const RANGE_CSS = [
  '.oge-range-wrap{display:flex;flex:1;align-items:center;gap:10px;min-width:0;}',
  // Standalone-row seat (a range option outside the command block): side
  // margins matching `.oge-pref-panel`, equal top/bottom.
  '.oge-range-row{margin:12px 10px;}',
  '.oge-range-wrap .oge-range-display{min-width:50px;text-align:right;',
  'font-size:11px;color:#8fa8c0;}',
  '.oge-range{flex:1;height:18px;margin:0;padding:0;background:transparent;',
  '-webkit-appearance:none;appearance:none;cursor:pointer;min-width:0;}',
  '.oge-range:focus-visible{outline:1px solid #4a9eff;outline-offset:3px;}',
  // Firefox track + progress fill + thumb.
  '.oge-range::-moz-range-track{height:5px;border-radius:3px;background:#223142;}',
  '.oge-range::-moz-range-progress{height:5px;border-radius:3px;background:#4a9eff;}',
  '.oge-range::-moz-range-thumb{width:16px;height:16px;border-radius:50%;',
  'background:#4a9eff;border:3px solid #0b1016;',
  'box-shadow:0 0 0 1px #2a3a4c,0 0 6px rgba(74,158,255,.55);}',
  '.oge-range:hover::-moz-range-thumb{background:#7db8ff;}',
  // WebKit track + thumb (thumb needs the -5.5px seat onto the 5px track).
  '.oge-range::-webkit-slider-runnable-track{height:5px;border-radius:3px;background:#223142;}',
  '.oge-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;',
  'margin-top:-5.5px;border-radius:50%;background:#4a9eff;border:3px solid #0b1016;',
  'box-shadow:0 0 0 1px #2a3a4c,0 0 6px rgba(74,158,255,.55);}',
  '.oge-range:hover::-webkit-slider-thumb{background:#7db8ff;}',
].join('');

// ─── Module-tiles bar (injected stylesheet, not inline) ──────────────────
//
// A tile is a 1:1 preview of the module's FAB satellite orb: the SAME
// `.oge-node` dome (buttonChrome.js) at 38px, over the module's `--mod`
// colour. ON = the orb lit in its signature colour (tinted tile + 2px bottom
// accent); OFF = the orb powered down to grey. Stylesheet (not inline)
// because the states are class-driven (`.on`, hover, focus, disabled).

/** Injected-once `<style>` id for the module-tiles bar. */
const TILES_STYLE_ID = 'oge-setting-module-tiles-style';

// `--mod-on` (per tile, inline) carries the module colour; the class-level
// `--mod` swap below is what flips the dome between grey and lit — an inline
// `--mod` would beat the `.on` class and pin the tile permanently lit.
const TILES_CSS = [
  // The block: ONE bordered rounded box holding the optional top slot (the
  // Dashboard launcher) flush above the module tiles — they read as a single
  // command block.
  '.oge-fab-block{width:100%;box-sizing:border-box;',
  'border:1px solid #2a3a4c;border-radius:8px;overflow:hidden;background:#0b1016;}',
  // Top segment — the Dashboard launcher (structure in sections/data.js).
  // Class-driven (not inline) so hover/focus rules can win. Same anatomy as
  // the module tiles below (glyph over caption, same paddings/gap) so the
  // whole block reads as one family; the gold lens + label is what says
  // "primary CTA, not a module toggle".
  '.oge-dash-launch{display:flex;width:100%;box-sizing:border-box;flex-direction:column;',
  'align-items:center;justify-content:center;gap:7px;padding:12px 6px 11px;margin:0;border:none;',
  'border-bottom:1px solid #223142;background:#0e141c;color:#e6c054;',
  'font-size:12px;font-weight:bold;cursor:pointer;}',
  '.oge-dash-launch:hover{background:#131c28;color:#f0d27a;}',
  '.oge-dash-launch:focus-visible{outline:1px solid #4a9eff;outline-offset:-2px;}',
  // Bottom segment — the shared size slider, fused into the block (it sizes
  // the very buttons the tiles above preview, so it belongs to the block,
  // not floating under it). Same chrome shade as the launcher segment, so
  // the block reads launcher / tiles / slider top-to-bottom.
  '.oge-fab-size{display:flex;box-sizing:border-box;width:100%;',
  'border-top:1px solid #223142;background:#0e141c;padding:11px 12px;}',
  '.oge-module-tiles{display:flex;width:100%;box-sizing:border-box;}',
  '.oge-module-tiles.oge-tiles-disabled{opacity:.35;pointer-events:none;}',
  '.oge-module-tile{flex:1 1 0;display:flex;flex-direction:column;align-items:center;',
  'gap:7px;padding:12px 6px 11px;margin:0;border:none;background:transparent;',
  'cursor:pointer;--mod:#4d5866;}',
  '.oge-module-tile + .oge-module-tile{border-left:1px solid #223142;}',
  '.oge-module-tile.on{--mod:var(--mod-on);',
  'background:color-mix(in oklab,var(--mod) 13%,transparent);',
  'box-shadow:inset 0 -2px 0 var(--mod);}',
  '.oge-module-tile:hover{background:color-mix(in oklab,var(--mod) 20%,transparent);}',
  '.oge-module-tile:focus-visible{outline:1px solid #4a9eff;outline-offset:-2px;}',
  // position:relative — the dome hosts appendGlyph's absolutely-inset
  // `.oge-art` layer, which needs a positioned ancestor to fill.
  '.oge-module-tile-dome{position:relative;width:38px;height:38px;}',
  '.oge-module-tile:not(.on) .oge-module-tile-dome{--art-opacity:.45;}',
  '.oge-module-tile-cap{font-size:11px;line-height:1;color:#66727f;}',
  '.oge-module-tile.on .oge-module-tile-cap{color:#dfe7f2;}',
].join('');

// ─── Preferences panel (injected stylesheet, not inline) ─────────────────
//
// Self-indicating toggle tiles in one bordered panel (same chrome as the FAB
// command block). Deliberately FLAT glyphs + ONE neutral accent (the panel's
// #4a9eff blue): the radial dome and the per-module colours are reserved for
// the FAB module bar — the settings panel stays calm so the bar above remains
// the only colourful element.

/** Injected-once `<style>` id for the preferences panel. */
const PREF_STYLE_ID = 'oge-setting-pref-style';

const PREF_CSS = [
  // Side margins match `.oge-range-wrap` above — the inset slider + inset
  // panel read as one aligned column under the full-bleed command block.
  '.oge-pref-panel{box-sizing:border-box;margin:0 10px;',
  'border:1px solid #2a3a4c;border-radius:8px;overflow:hidden;background:#0b1016;}',
  // Group captions carry the same typographic weight as the Dashboard
  // launcher's label (12px bold) so the groups scan as real headings, but
  // stay in the panel's muted blue-grey — gold remains the launcher's mark.
  '.oge-pref-cap{padding:9px 12px 3px;font-size:12px;font-weight:bold;',
  'letter-spacing:.02em;color:#a7b8cb;}',
  '.oge-pref-cap.sep{border-top:1px solid #1a2735;}',
  '.oge-pref-grid{display:grid;}',
  // A tile is a <div role="button"> (not <button>): the row variant nests the
  // segment's and the pill's REAL buttons inside, and interactive content
  // inside a native button is invalid HTML.
  '.oge-pref-tile{position:relative;display:flex;flex-direction:column;align-items:center;',
  'justify-content:center;gap:7px;padding:13px 6px 12px;margin:0;',
  'cursor:pointer;user-select:none;color:#5a6672;}',
  '.oge-pref-tile svg{width:26px;height:26px;overflow:visible;}',
  '.oge-pref-tile-cap{font-size:11px;line-height:1;color:#66727f;}',
  '.oge-pref-tile:hover{background:rgba(74,158,255,.07);}',
  '.oge-pref-tile.on{background:rgba(74,158,255,.10);box-shadow:inset 0 -2px 0 #4a9eff;color:#7db8ff;}',
  '.oge-pref-tile.on .oge-pref-tile-cap{color:#dfe7f2;}',
  '.oge-pref-tile:focus-visible{outline:1px solid #4a9eff;outline-offset:-2px;}',
  // Hairline separators for the 3-column grid (first column / first row skip).
  '.oge-pref-grid.cols3 .oge-pref-tile:not(:nth-child(3n+1)){border-left:1px solid #1a2735;}',
  '.oge-pref-grid.cols3 .oge-pref-tile:nth-child(n+4){border-top:1px solid #1a2735;}',
  // Row variant (columns:1) — a full-width two-zone control: tile body =
  // toggle, embedded segment = its own numeric field.
  '.oge-pref-tile.row{flex-direction:row;justify-content:flex-start;gap:10px;',
  'padding:11px 12px;text-align:left;}',
  '.oge-pref-tile.row .oge-pref-tile-cap{font-size:12px;}',
  '.oge-pref-spacer{flex:1;}',
  '.oge-pref-segcap{font-size:11px;color:#5f6c7b;}',
  '.oge-pref-seg{display:inline-flex;border:1px solid #2a3a4c;border-radius:6px;overflow:hidden;}',
  '.oge-pref-seg button{border:none;margin:0;padding:4px 14px;background:transparent;',
  'color:#66727f;font-size:12px;cursor:pointer;font-family:inherit;}',
  '.oge-pref-seg button + button{border-left:1px solid #2a3a4c;}',
  '.oge-pref-seg button.on{background:rgba(74,158,255,.16);color:#cfe4ff;',
  'box-shadow:inset 0 -2px 0 #4a9eff;}',
  '.oge-pref-pill{position:absolute;top:6px;right:6px;padding:2px 8px;margin:0;',
  'border:1px solid #3a4a5c;border-radius:9px;background:#101823;color:#8fa8c0;',
  'font-size:11px;cursor:pointer;font-family:inherit;}',
  // Hover reddens toward the banner it previews.
  '.oge-pref-pill:hover{border-color:#fb7185;color:#ffb3bd;}',
].join('');

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
  const wrap = buildRangeWrap(opt);
  wrap.classList.add('oge-range-row');
  valueCell.appendChild(wrap);
};

/**
 * Build the bare slider + value-display wrap (layout-neutral — the caller
 * seats it: {@link buildRangeControl} adds the standalone-row margins,
 * {@link buildModuleTilesControl} drops it into the command block's bottom
 * segment).
 *
 * @param {RangeSpec} opt
 * @returns {HTMLElement}
 */
const buildRangeWrap = (opt) => {
  injectStyle(RANGE_STYLE_ID, RANGE_CSS);

  const wrap = document.createElement('span');
  wrap.className = 'oge-range-wrap';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = INPUT_ID_PREFIX + opt.id;
  slider.className = 'oge-range';
  slider.min = String(opt.min ?? 0);
  slider.max = String(opt.max ?? 100);
  slider.step = String(opt.step ?? 1);
  slider.value = String(readSetting(opt.id));

  const display = document.createElement('span');
  display.className = 'oge-range-display';
  display.textContent = slider.value + (opt.unit ?? '');

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    display.textContent = v + (opt.unit ?? '');
    writeSetting(opt.id, v);
  });

  wrap.appendChild(slider);
  wrap.appendChild(display);
  return wrap;
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
 * Flip one module tile between lit (module visible) and powered-down.
 * Shared by the builder's click handler and {@link syncInputsFromState}.
 *
 * @param {Element} btn  A `.oge-module-tile` button.
 * @param {boolean} on
 * @returns {void}
 */
const setTilePressed = (btn, on) => {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
};

/**
 * Render the moduleTiles (multi-select tile bar) flavour: one toggle tile
 * per `opt.tiles` entry, each bound to its OWN boolean Settings field
 * (`entry.settingKey`) — unlike radio, every tile flips independently. The
 * tile's dome reuses buttonChrome's `.oge-node` + `appendGlyph`, so it is
 * pixel-identical to the module's FAB satellite orb: the control IS a
 * preview of what it toggles.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildModuleTilesControl = (opt, valueCell) => {
  // Both idempotent — on a page where the FAB is live the chrome sheet is
  // already in, and panel rebuilds must not stack tile sheets.
  installButtonChrome();
  injectStyle(TILES_STYLE_ID, TILES_CSS);

  const block = document.createElement('div');
  block.className = 'oge-fab-block';
  if (opt.topSlot) block.appendChild(opt.topSlot());

  const wrap = document.createElement('span');
  wrap.id = INPUT_ID_PREFIX + opt.id;
  wrap.className = 'oge-module-tiles';

  for (const tile of opt.tiles ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'oge-module-tile';
    btn.dataset.key = tile.settingKey;
    btn.style.setProperty('--mod-on', tile.color);

    const dome = document.createElement('span');
    dome.className = 'oge-node oge-module-tile-dome';
    dome.setAttribute('aria-hidden', 'true');
    appendGlyph(dome, tile.glyph);

    const cap = document.createElement('span');
    cap.className = 'oge-module-tile-cap';
    cap.textContent = tile.name;

    btn.appendChild(dome);
    btn.appendChild(cap);
    setTilePressed(btn, Boolean(readSetting(tile.settingKey)));
    btn.addEventListener('click', () => {
      const next = !readSetting(tile.settingKey);
      writeSetting(tile.settingKey, next);
      // Our own write skips the store-driven resync (writingFromUi), so the
      // clicked tile repaints itself — same pattern as the range display.
      setTilePressed(btn, next);
    });
    wrap.appendChild(btn);
  }

  block.appendChild(wrap);

  // Bottom segment — the nested size slider (see the `sizeSlider` typedef
  // note; synced by the moduleTiles branch of syncInputsFromState).
  if (opt.sizeSlider) {
    const seg = document.createElement('div');
    seg.className = 'oge-fab-size';
    seg.appendChild(buildRangeWrap(opt.sizeSlider));
    block.appendChild(seg);
  }

  valueCell.appendChild(block);
};

/**
 * Build the embedded numeric segment of a row tile (its OWN Settings field,
 * radio semantics — exactly one choice lit). Clicks stop propagating so they
 * never toggle the host tile.
 *
 * @param {NonNullable<PrefTile['seg']>} seg
 * @returns {HTMLElement}
 */
const buildPrefSeg = (seg) => {
  const wrap = document.createElement('span');
  wrap.className = 'oge-pref-seg';
  wrap.dataset.key = seg.key;
  if (seg.hint) wrap.title = seg.hint;
  const current = Number(readSetting(seg.key));
  for (const choice of seg.choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(choice);
    b.dataset.value = String(choice);
    b.classList.toggle('on', choice === current);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      writeSetting(seg.key, choice);
      for (const sib of wrap.querySelectorAll('button')) {
        sib.classList.toggle('on', sib === b);
      }
    });
    wrap.appendChild(b);
  }
  return wrap;
};

/**
 * Build one preference tile: flat glyph + keyword caption over a boolean
 * Settings field, with the optional embedded segment / corner action pill.
 * The tile itself is a `role="button"` div (see the PREF_CSS note) with
 * Enter/Space handling, so nesting the extras' real buttons stays valid.
 *
 * @param {PrefTile} tile
 * @param {boolean} rowLayout  columns:1 group — horizontal two-zone layout.
 * @returns {HTMLElement}
 */
const buildPrefTile = (tile, rowLayout) => {
  const el = document.createElement('div');
  el.className = 'oge-pref-tile' + (rowLayout ? ' row' : '');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.dataset.key = tile.key;
  if (tile.hint) el.title = tile.hint;

  el.appendChild(
    parseSvg(
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">' +
        tile.glyph +
        '</svg>',
    ),
  );
  const cap = document.createElement('span');
  cap.className = 'oge-pref-tile-cap';
  cap.textContent = tile.caption;
  el.appendChild(cap);

  if (tile.seg) {
    const spacer = document.createElement('span');
    spacer.className = 'oge-pref-spacer';
    const segCap = document.createElement('span');
    segCap.className = 'oge-pref-segcap';
    segCap.textContent = tile.seg.caption;
    el.append(spacer, segCap, buildPrefSeg(tile.seg));
  }
  if (tile.action) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'oge-pref-pill';
    pill.textContent = tile.action.label;
    if (tile.action.hint) pill.title = tile.action.hint;
    const run = tile.action.run;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    el.appendChild(pill);
  }

  setTilePressed(el, Boolean(readSetting(tile.key)));
  const toggle = () => {
    const next = !readSetting(tile.key);
    writeSetting(tile.key, next);
    setTilePressed(el, next);
  };
  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return el;
};

/**
 * Render the prefTiles (preferences panel) flavour: captioned groups of
 * self-indicating toggle tiles inside one bordered panel. Each tile binds
 * its own Settings field via `data-key` (same discipline as moduleTiles);
 * {@link syncInputsFromState} repaints per key on outside writes.
 *
 * @param {SettingsOption} opt
 * @param {HTMLTableCellElement} valueCell
 * @returns {void}
 */
const buildPrefTilesControl = (opt, valueCell) => {
  injectStyle(PREF_STYLE_ID, PREF_CSS);

  const panel = document.createElement('div');
  panel.id = INPUT_ID_PREFIX + opt.id;
  panel.className = 'oge-pref-panel';

  let first = true;
  for (const group of opt.prefGroups ?? []) {
    const cap = document.createElement('div');
    cap.className = 'oge-pref-cap' + (first ? '' : ' sep');
    cap.textContent = group.caption;
    panel.appendChild(cap);
    first = false;

    const grid = document.createElement('div');
    grid.className = 'oge-pref-grid' + (group.columns === 3 ? ' cols3' : '');
    grid.style.gridTemplateColumns = `repeat(${group.columns},1fr)`;
    for (const tile of group.tiles) {
      grid.appendChild(buildPrefTile(tile, group.columns === 1));
    }
    panel.appendChild(grid);
  }

  valueCell.appendChild(panel);
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
  moduleTiles: buildModuleTilesControl,
  prefTiles: buildPrefTilesControl,
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
  // An empty label leaves the cell blank WITHOUT the bullet class, which
  // would still paint its lone bullet.
  if (opt.label) {
    labelCell.className = 'ago_menu_label_bullet';
    labelCell.textContent = opt.label;
  }
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
        const disabled = opt.disabledWhen(settingsStore.get());
        if (opt.type === 'moduleTiles') {
          // The bar is a wrapper <span> — no native `disabled`; the class
          // gates it (opacity + pointer-events) like the dashboard's
          // `.chip-group.disabled`.
          el.classList.toggle('oge-tiles-disabled', disabled);
        } else {
          /** @type {HTMLInputElement} */ (el).disabled = disabled;
        }
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
      } else if (opt.type === 'moduleTiles') {
        // Each tile binds its own Settings field — re-read per tile so an
        // outside write (e.g. cross-device settings sync) repaints the bar.
        for (const btn of el.querySelectorAll('.oge-module-tile')) {
          const key = /** @type {HTMLElement} */ (btn).dataset.key;
          if (key) setTilePressed(btn, Boolean(readSetting(key)));
        }
        // The nested size slider is this option's second binding — sync it
        // the same way the standalone range branch does.
        if (opt.sizeSlider) {
          const slider = /** @type {HTMLInputElement | null} */ (
            document.getElementById(INPUT_ID_PREFIX + opt.sizeSlider.id)
          );
          if (slider) {
            const current = String(readSetting(opt.sizeSlider.id));
            slider.value = current;
            const display = slider.nextElementSibling;
            if (display) display.textContent = current + (opt.sizeSlider.unit ?? '');
          }
        }
      } else if (opt.type === 'prefTiles') {
        // Same per-key repaint as moduleTiles, plus the embedded segments'
        // numeric fields.
        for (const t of el.querySelectorAll('.oge-pref-tile')) {
          const key = /** @type {HTMLElement} */ (t).dataset.key;
          if (key) setTilePressed(t, Boolean(readSetting(key)));
        }
        for (const segEl of el.querySelectorAll('.oge-pref-seg')) {
          const key = /** @type {HTMLElement} */ (segEl).dataset.key;
          if (!key) continue;
          const current = Number(readSetting(key));
          for (const b of segEl.querySelectorAll('button')) {
            b.classList.toggle(
              'on',
              Number(/** @type {HTMLElement} */ (b).dataset.value) === current,
            );
          }
        }
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
