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
//    remembered.
//  - **Gating.** Nothing past the channel grid works without a push channel:
//    the clock switched on AND a syntactically usable ntfy token. `#alarmTop`
//    carries `off` (clock off — the whole block hides, only the switch on the
//    intro line remains) or `ready`; without `ready` the tiles dim and go
//    inert and the queue card hides (CSS).
//  - **State on the tiles.** Each tile shows an on/off pill and its reminder
//    times, so the shape of the whole setup reads without opening anything.
//    The switch itself lives inside the drawer. Word + colour, never a glyph
//    (see CLAUDE.md).
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

/** @returns {HTMLElement | null} */
const top = () => document.getElementById('alarmTop');

/** The three kind sections (each its own card: tile header + drawer). */
/** @returns {HTMLElement | null} */
const kindsRoot = () => document.getElementById('alarmKinds');

/** @returns {HTMLElement[]} */
const tiles = () => {
  const k = kindsRoot();
  return k ? /** @type {HTMLElement[]} */ ([...k.querySelectorAll('.alarm-kind')]) : [];
};

/**
 * Open one kind's drawer, or close them all (`''` / unknown key).
 *
 * @param {string} key
 * @returns {void}
 */
const openDrawer = (key) => {
  const t = kindsRoot();
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
  // The shared "Reset to defaults" row belongs to an open drawer only — and
  // sits right under it, inside that kind's card.
  const footer = document.getElementById('alarmCfgFooter');
  if (footer) {
    footer.style.display = target ? '' : 'none';
    const open = t.querySelector('.alarm-drawer.open');
    if (open && open.nextElementSibling !== footer) open.insertAdjacentElement('afterend', footer);
  }
};

/** @returns {string} The open drawer's kind, or `''`. */
const openKind = () => tiles().find((t) => t.classList.contains('open'))?.dataset.kind ?? '';

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
  const el = kindsRoot()?.querySelector(`[data-kind-times="${kind}"]`);
  if (el) el.textContent = text;
};

/**
 * The tile's state pill: green "on", amber "off", nothing for `null` — ad-hoc
 * (armed per fleet in game) and fleet-save (always on) have no switch.
 *
 * @param {string} kind
 * @param {boolean | null} on
 * @returns {void}
 */
const setKindState = (kind, on) => {
  const el = kindsRoot()?.querySelector(`[data-kind-state="${kind}"]`);
  if (!el) return;
  el.textContent = on === null ? '' : on ? 'on' : 'off';
  el.classList.toggle('warn', on === false);
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
  // The master switch reads as its own state: "On" / "Off".
  const master = document.getElementById('remMasterToggle');
  if (master) master.textContent = masterOn ? 'On' : 'Off';

  // The channel state says WHICH prerequisite is missing; nothing when off
  // (the switch itself already says so).
  const state = document.getElementById('alarmChannelState');
  if (state) {
    // Only the PROBLEM speaks: a token that merely looks valid proves no
    // connection (the Validate button does), so there is no "connected" badge.
    state.textContent = masterOn && !hasToken ? 'Set up ntfy' : '';
    state.classList.toggle('warn', masterOn && !hasToken);
  }
  // No channel — no inert drawer left on screen.
  if (!ready) openDrawer('');

  // Per-kind config is per-universe: the tiles follow the server selector.
  const uni = getActiveUniverseId();
  if (!uni) {
    for (const k of KINDS) { setTimes(k, ''); setKindState(k, null); }
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
  setTimes('fs', timesLine(fs.fsOffsets));
  setTimes('expo', timesLine(ac.alarmClockSchedule));
  setKindState('adhoc', null);
  setKindState('fs', null);
  setKindState('expo', ac.alarmClockEnabled);
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
    tile.addEventListener('click', toggle);
    tile.addEventListener('keydown', (e) => {
      if (e.target !== tile || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggle();
    });
  }

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
  getActiveUniverseId = () => '';
};
