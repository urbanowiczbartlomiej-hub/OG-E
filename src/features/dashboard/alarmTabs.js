// @ts-check
// Alarm clock section — the ONE-view shell: channel bar, three kind tiles and
// their settings drawers. (The file keeps its historical name; it used to drive
// a five-tab strip — General / Reminders set / Ad-hoc / Fleet-save /
// Expeditions — which this layout replaced.)
//
// What this module owns:
//
//  - **Drawers.** A tile opens its kind's settings drawer in the same block; at
//    most one is open, clicking the open tile closes it, and the choice is
//    remembered. The kind's own switch sits ON the tile (parked there by
//    `alarmClockConfig.js`), so a click on it must not toggle the drawer.
//  - **Gating.** Nothing past the channel bar works without a push channel:
//    the clock switched on AND a syntactically usable ntfy token. `#alarmTop`
//    carries `off` (clock off — only the switch remains) or `ready`; without
//    `ready` the tiles dim and go inert and the queue card hides (CSS).
//  - **Setup fold.** The token form + privacy text are needed once. The fold
//    opens by itself only while the token is missing; otherwise the Setup
//    button toggles it.
//  - **State on the tiles.** Each tile shows its reminder times (or "off") so
//    the shape of the whole setup reads without opening anything. Word +
//    colour, never a glyph (see CLAUDE.md).
//
// Everything is READ-ONLY here: the master switch + token are owned by
// `settingsControls.js`, the per-kind config by `alarmClockConfig.js`, the
// queued counts by `alarmClock.js`. This module mirrors them, repainting from
// `chrome.storage.onChanged` and from the host's `refresh()` on a universe
// switch.

import { chromeStore, safeLS } from '../../lib/storage.js';
import { SHARED_SETTINGS_KEY } from '../../state/sharedSettings.js';
import { alarmClockConfigKeyFor } from '../../state/alarmClockConfig.js';
import { galaxyScanConfigKeyFor } from '../../state/galaxyScanConfig.js';
import { isValidNtfyToken } from '../../sync/alarmClock.js';
import { normalizeAlarmClockConfig } from '../../domain/alarmClockConfig.js';
import { normalizeGalaxyScanConfig } from '../../domain/galaxyScanConfig.js';

/** Remembered open drawer (`''` = none), so a reload reopens where the player was. */
const ALARM_SUBTAB_LS_KEY = 'oge_alarmSubtab';

/** The three reminder kinds that have a tile + drawer. */
const KINDS = ['adhoc', 'fs', 'expo'];

/** @type {() => string} */
let getActiveUniverseId = () => '';

/** @type {boolean} */
let wired = false;

/** @type {(() => void) | null} */
let unsubscribeStorage = null;

/** The player toggled the Setup fold by hand — stop auto-opening/closing it. */
let setupTouched = false;

/** @returns {HTMLElement | null} */
const top = () => document.getElementById('alarmTop');

/** @returns {HTMLElement[]} */
const tiles = () => {
  const t = top();
  return t ? /** @type {HTMLElement[]} */ ([...t.querySelectorAll('.alarm-kind')]) : [];
};

/**
 * Open one kind's drawer, or close them all (`''` / unknown key).
 *
 * @param {string} key
 * @returns {void}
 */
const openDrawer = (key) => {
  const t = top();
  if (!t) return;
  const target = KINDS.includes(key) ? key : '';
  for (const tile of tiles()) {
    const on = tile.dataset.kind === target;
    tile.classList.toggle('open', on);
    tile.setAttribute('aria-expanded', String(on));
  }
  for (const d of t.querySelectorAll('.alarm-drawer')) {
    d.classList.toggle('open', /** @type {HTMLElement} */ (d).dataset.kind === target);
  }
  // The shared "Reset to defaults" row belongs to an open drawer only.
  const footer = document.getElementById('alarmCfgFooter');
  if (footer) footer.style.display = target ? '' : 'none';
};

/** @returns {string} The open drawer's kind, or `''`. */
const openKind = () => tiles().find((t) => t.classList.contains('open'))?.dataset.kind ?? '';

/**
 * Show / hide the Setup fold.
 *
 * @param {boolean} open
 * @returns {void}
 */
const setSetup = (open) => {
  const fold = document.getElementById('alarmSetup');
  const btn = document.getElementById('alarmSetupBtn');
  if (fold) fold.hidden = !open;
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', String(open));
  }
};

/**
 * A stored schedule ("-5m, 0m, 10m") as the tile's one-line summary.
 *
 * @param {string} schedule
 * @returns {string}
 */
const timesLine = (schedule) =>
  schedule.split(',').map((s) => s.trim()).filter(Boolean).join(' · ');

/**
 * @param {string} kind
 * @param {string} text
 * @returns {void}
 */
const setTimes = (kind, text) => {
  const el = top()?.querySelector(`[data-kind-times="${kind}"]`);
  if (el) el.textContent = text;
};

/**
 * Read the sources of truth and repaint gating, channel state and the tiles.
 *
 * @returns {Promise<void>}
 */
const paint = async () => {
  const t = top();
  if (!t) return;
  const raw = await chromeStore.get(SHARED_SETTINGS_KEY);
  const shared = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const masterOn = shared.alarmClockMasterEnabled === true;
  const hasToken = isValidNtfyToken(shared.alarmClockNtfyToken);
  const ready = masterOn && hasToken;
  t.classList.toggle('off', !masterOn);
  t.classList.toggle('ready', ready);

  // The channel state says WHICH prerequisite is missing; nothing when off
  // (the switch itself already says so).
  const state = document.getElementById('alarmChannelState');
  if (state) {
    state.textContent = masterOn ? (hasToken ? 'ntfy connected' : 'Set up ntfy') : '';
    state.classList.toggle('warn', masterOn && !hasToken);
  }
  // Setup is needed once: open by itself only while the token is missing.
  if (!setupTouched) setSetup(masterOn && !hasToken);
  // No channel — no inert drawer left on screen.
  if (!ready) openDrawer('');

  // Per-kind config is per-universe: the tiles follow the server selector.
  const uni = getActiveUniverseId();
  if (!uni) {
    for (const k of KINDS) setTimes(k, '');
    return;
  }
  const [rc, gs] = await Promise.all([
    chromeStore.get(alarmClockConfigKeyFor(uni)),
    chromeStore.get(galaxyScanConfigKeyFor(uni)),
  ]);
  const ac = normalizeAlarmClockConfig(rc);
  const fs = normalizeGalaxyScanConfig(gs);
  // Ad-hoc has no enable flag (it is armed per fleet in game).
  setTimes('adhoc', timesLine(ac.adhocSchedule));
  setTimes('fs', fs.fsEnabled ? timesLine(fs.fsOffsets) : 'off');
  setTimes('expo', ac.alarmClockEnabled ? timesLine(ac.alarmClockSchedule) : 'off');
};

/**
 * Wire the shell. Idempotent; the host installs once at boot.
 *
 * @param {{ getUniverseId?: () => string }} [opts]
 * @returns {{ refresh: () => void }}
 */
export const installAlarmTabs = (opts = {}) => {
  if (opts.getUniverseId) getActiveUniverseId = opts.getUniverseId;
  if (wired) return { refresh: () => { void paint(); } };
  if (!top()) return { refresh: () => {} };
  wired = true;

  for (const tile of tiles()) {
    const toggle = () => {
      const key = tile.dataset.kind ?? '';
      const next = openKind() === key ? '' : key;
      openDrawer(next);
      safeLS.set(ALARM_SUBTAB_LS_KEY, next);
    };
    tile.addEventListener('click', (e) => {
      // The kind's own switch lives on the tile — flipping it is not "open".
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.ak-switch')) return;
      toggle();
    });
    tile.addEventListener('keydown', (e) => {
      if (e.target !== tile || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggle();
    });
  }
  document.getElementById('alarmSetupBtn')?.addEventListener('click', () => {
    setupTouched = true;
    setSetup(Boolean(document.getElementById('alarmSetup')?.hidden));
  });

  // Paint the gating BEFORE restoring the remembered drawer, so a drawer is
  // never reopened behind a missing channel.
  void paint().then(() => {
    if (top()?.classList.contains('ready')) openDrawer(safeLS.get(ALARM_SUBTAB_LS_KEY) || '');
  });

  unsubscribeStorage = chromeStore.onChanged((changes) => {
    if (SHARED_SETTINGS_KEY in changes) { void paint(); return; }
    const uni = getActiveUniverseId();
    if (!uni) return;
    if (alarmClockConfigKeyFor(uni) in changes || galaxyScanConfigKeyFor(uni) in changes) {
      void paint();
    }
  });

  return { refresh: () => { void paint(); } };
};

/**
 * Test-only reset: drop the storage subscription and return to the
 * just-loaded state so a fresh install in a new test starts clean.
 *
 * @returns {void}
 */
export const _resetAlarmTabsForTest = () => {
  unsubscribeStorage?.();
  unsubscribeStorage = null;
  wired = false;
  setupTouched = false;
  getActiveUniverseId = () => '';
};
