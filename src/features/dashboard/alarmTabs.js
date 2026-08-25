// @ts-check

// AlarmClock section sub-tabs — the strip that turned the tab from one long
// stacked form (with the real settings buried in a ⚙ <details> at the very
// bottom) into General / Reminders set / Expeditions / Ad-hoc / Fleet-save.
//
// The strip itself is trivial (flip `.active` classes, remember the choice).
// What justifies a module is the two things a plain tab bar can't do:
//
//  - **Gating.** Every pane past General is inert until the alarm clock is
//    switched on AND carries a syntactically usable ntfy token — with no push
//    channel there is nothing for an expedition schedule to ring on. Those
//    tabs therefore LOCK (greyed, unclickable) until the channel is set up,
//    and an active tab that becomes locked falls back to General instead of
//    leaving the player staring at a form that cannot do anything.
//  - **State on the tab itself.** "Expeditions is off" has to be visible
//    WITHOUT opening the pane — otherwise the only way to learn the shape of
//    your own setup is to click through every tab. So each gated kind stamps
//    its per-universe enable flag onto its own tab as a short word (never a
//    glyph — see CLAUDE.md), and General reports whether the channel is off
//    or merely unconfigured.
//
// Everything is READ-ONLY here: the master switch + token are owned by
// `settingsControls.js`, the per-kind flags by `alarmClockConfig.js`. This
// module only mirrors them, repainting from `chrome.storage.onChanged` (both
// writers land in storage, and the event fires in this same page) and from the
// host's `refresh()` on a universe switch.

import { chromeStore, safeLS } from '../../lib/storage.js';
import { SHARED_SETTINGS_KEY } from '../../state/sharedSettings.js';
import { alarmClockConfigKeyFor } from '../../state/alarmClockConfig.js';
import { galaxyScanConfigKeyFor } from '../../state/galaxyScanConfig.js';
import { isValidNtfyToken } from '../../sync/alarmClock.js';
import { normalizeAlarmClockConfig } from '../../domain/alarmClockConfig.js';
import { normalizeGalaxyScanConfig } from '../../domain/galaxyScanConfig.js';

/** Remembered sub-tab, so a reload reopens where the player was working. */
const ALARM_SUBTAB_LS_KEY = 'oge_alarmSubtab';

/**
 * The tabs that need a working push channel. General is deliberately NOT in
 * here: it is where the channel gets set up, so it can never lock.
 *
 * @type {string[]}
 */
const GATED = ['reminders', 'expo', 'adhoc', 'fs'];

/** @type {() => string} */
let getActiveUniverseId = () => '';

/** @type {boolean} */
let wired = false;

/** @type {(() => void) | null} */
let unsubscribeStorage = null;

/** @returns {HTMLElement | null} */
const bar = () => document.getElementById('alarmSubtabs');

/**
 * The buttons of the strip, as an array (a live NodeList is awkward to reuse).
 *
 * @returns {HTMLButtonElement[]}
 */
const buttons = () => {
  const b = bar();
  return b ? /** @type {HTMLButtonElement[]} */ ([...b.querySelectorAll('.subtab')]) : [];
};

/**
 * Show one pane. Refuses unknown keys and LOCKED tabs, so a stale remembered
 * key or a mis-click can't open an inert pane.
 *
 * @param {string | undefined} key
 * @returns {boolean}  whether the switch happened
 */
const activate = (key) => {
  const btns = buttons();
  const target = btns.find((b) => b.dataset.subtab === key);
  if (!key || !target || target.classList.contains('locked')) return false;
  for (const b of btns) b.classList.toggle('active', b.dataset.subtab === key);
  // Direct children only (a nested `.subtabpane` inside a pane would belong to
  // some other strip). Walked rather than `:scope > ` — happy-dom, which the
  // behavioural tests run in, does not implement that selector.
  const section = document.getElementById('alarmClockSection');
  for (const child of section?.children ?? []) {
    if (!child.classList.contains('subtabpane')) continue;
    child.classList.toggle('active', /** @type {HTMLElement} */ (child).dataset.subtab === key);
  }
  // The shared "Reset to defaults" footer belongs to the three config panes
  // only — under General or Reminders set there is nothing for it to reset.
  const footer = document.getElementById('alarmCfgFooter');
  if (footer) footer.style.display = key === 'expo' || key === 'adhoc' || key === 'fs' ? '' : 'none';
  return true;
};

/**
 * Set (or clear) a tab's state marker. An empty string removes it from view —
 * `.subtab-state:empty` is `display:none`, so a tab in its normal state stays
 * a plain word and the strip doesn't turn into a wall of badges.
 *
 * @param {string} key
 * @param {string} text
 * @returns {void}
 */
const setState = (key, text) => {
  const btn = buttons().find((b) => b.dataset.subtab === key);
  if (!btn) return;
  let mark = btn.querySelector('.subtab-state');
  if (!mark) {
    mark = document.createElement('span');
    mark.className = 'subtab-state';
    btn.appendChild(mark);
  }
  mark.textContent = text;
};

/**
 * Read the two sources of truth and repaint the strip's locks + markers.
 *
 * @returns {Promise<void>}
 */
const paint = async () => {
  if (!bar()) return;
  const raw = await chromeStore.get(SHARED_SETTINGS_KEY);
  const shared = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const masterOn = shared.alarmClockMasterEnabled === true;
  const hasToken = isValidNtfyToken(shared.alarmClockNtfyToken);
  const ready = masterOn && hasToken;

  // General says WHICH prerequisite is missing, so the lock on the other tabs
  // is self-explaining: "Off" = flip the switch, "Set up" = paste a token.
  setState('general', masterOn ? (hasToken ? '' : 'Set up') : 'Off');

  for (const btn of buttons()) {
    const key = btn.dataset.subtab ?? '';
    const locked = GATED.includes(key) && !ready;
    btn.classList.toggle('locked', locked);
    btn.disabled = locked;
    btn.setAttribute('aria-disabled', String(locked));
    btn.title = locked
      ? 'Enable the alarm clock and set a valid ntfy token on the General tab first.'
      : '';
  }

  // Per-kind flags are per-universe: the strip follows the dashboard's server
  // selector, same as every other surface here. Ad-hoc has no enable flag at
  // all (it is armed per entry in-game), so it never carries a marker.
  const uni = getActiveUniverseId();
  if (uni) {
    const [rc, gs] = await Promise.all([
      chromeStore.get(alarmClockConfigKeyFor(uni)),
      chromeStore.get(galaxyScanConfigKeyFor(uni)),
    ]);
    setState('expo', normalizeAlarmClockConfig(rc).alarmClockEnabled ? '' : 'Off');
    setState('fs', normalizeGalaxyScanConfig(gs).fsEnabled ? '' : 'Off');
  } else {
    setState('expo', '');
    setState('fs', '');
  }

  // A tab the player was sitting on may have just locked (they switched the
  // clock off, or cleared the token) — don't leave an inert pane on screen.
  const active = buttons().find((b) => b.classList.contains('active'));
  if (active?.classList.contains('locked')) activate('general');
};

/**
 * Wire the strip. Idempotent; the host installs once at boot.
 *
 * @param {{ getUniverseId?: () => string }} [opts]
 * @returns {{ refresh: () => void }}
 */
export const installAlarmTabs = (opts = {}) => {
  if (opts.getUniverseId) getActiveUniverseId = opts.getUniverseId;
  if (wired) return { refresh: () => { void paint(); } };
  if (!bar()) return { refresh: () => {} };
  wired = true;

  for (const btn of buttons()) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.subtab;
      if (!activate(key)) return;
      safeLS.set(ALARM_SUBTAB_LS_KEY, key ?? '');
    });
  }

  // Paint the locks BEFORE restoring the remembered tab: `activate` refuses a
  // locked tab, so restoring first would silently keep General anyway.
  void paint().then(() => { activate(safeLS.get(ALARM_SUBTAB_LS_KEY) || undefined); });

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
