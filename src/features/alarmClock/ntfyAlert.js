// @ts-check

// ntfy failure notice — tells the player, in game, when a reminder could
// NOT be queued.
//
// # Why this exists
//
// Until now every scheduling failure was silent. The ntfy account's daily
// message budget runs out, or the token is refused, or the publish is
// rate-limited — the reconcile threw, the sync round moved on, and the only
// symptom was a push that never arrived. That symptom shows up at exactly
// the moment it is useless: after the fleet was supposed to be saved.
//
// The cost is not uniform, and the notice says so. A missed EXPEDITION
// reminder costs idle minutes; a missed FLEET-SAVE reminder can cost the
// fleet, and with it months of play. `state/ntfyHealth.js` owns that
// ordering (`CRITICAL_KINDS`); this module only renders it:
//
//   - a critical kind failed → a red banner that states which reminder is
//     missing and that the fleet is unguarded. Dismissible per page view,
//     back on the next load while the condition holds — the same "a hard
//     problem keeps reminding" stance as the AGR guard.
//   - only expedition waves failed → a muted one-line notice. Worth
//     knowing (the budget is spent), not worth alarm.
//
// The notice NEVER invents an alarm: the health record is cleared by every
// sync that queues everything it wanted to, so a transient failure heals on
// the next page view instead of nagging until dismissed.
//
// # Why a banner rather than the settings panel
//
// The player has to see this without opening anything — the whole failure
// mode is "you believed a reminder existed". The banner follows
// `features/agrGuard.js`'s shape (own DOM, own stylesheet, dismiss ×) for
// exactly that reason.
//
// @see ../../state/ntfyHealth.js — the health record + the kind weighting.
// @see ../../sync/alarmClock.js  — records the failures (and reconciles the
//   dangerous kinds first, so the expendable one is what fails under budget).
// @see ../agrGuard.js            — the banner pattern this mirrors.

import { injectStyle } from '../../lib/dom.js';
import { ALARM_CLOCK_SYNCED_EVENT } from '../../lib/ogeEvents.js';
import { readNtfyHealth, CRITICAL_KINDS, KIND_LABELS } from '../../state/ntfyHealth.js';

/** Stable id for the banner — lets dispose find it and collapses a double-install. */
const BANNER_ID = 'oge-ntfy-alert';

/** Stable id for the banner stylesheet (`:hover` can't be expressed inline). */
const STYLE_ID = 'oge-ntfy-alert-style';

const CSS = [
  `#${BANNER_ID}{position:relative;z-index:9998;display:flex;align-items:flex-start;`,
  'gap:10px;margin:0 0 6px;padding:9px 12px;font:12px Verdana,sans-serif;',
  'line-height:1.45;border-radius:0 0 6px 6px;}',
  // Critical — a fleet may be unguarded right now.
  `#${BANNER_ID}.crit{background:#2a1416;border-bottom:2px solid #c0564d;color:#f1d7d4;}`,
  // Informational — the budget is spent, but only expendable pings were lost.
  `#${BANNER_ID}.info{background:#15202b;border-bottom:1px solid #2c3c4c;color:#9fb0c0;}`,
  `#${BANNER_ID} b{color:#fff;font-weight:700;}`,
  `#${BANNER_ID} .oge-na-why{display:block;margin-top:3px;opacity:.75;font-size:11px;}`,
  `#${BANNER_ID} .oge-na-x{margin-left:auto;flex:0 0 auto;cursor:pointer;`,
  'background:none;border:0;color:inherit;opacity:.6;font:14px/1 Verdana,sans-serif;',
  'padding:2px 4px;}',
  `#${BANNER_ID} .oge-na-x:hover{opacity:1;}`,
].join('');

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Build the banner's message from the failed kinds. Names the kinds rather
 * than echoing the raw transport error: "ntfy publish 429" tells the player
 * nothing, "your fleet-save reminder was not scheduled" tells them what to
 * do in the next minute.
 *
 * @param {Record<string, string>} failed  kind → reason.
 * @returns {{ critical: boolean, text: string, why: string }}
 */
export const alertTextFor = (failed) => {
  const kinds = Object.keys(failed);
  const critical = kinds.filter((k) => CRITICAL_KINDS.has(k));
  /** @param {string[]} list */
  const names = (list) => list.map((k) => KIND_LABELS[k] ?? k).join(' and ');
  // One reason stands for all of them — they share a cause far more often
  // than not (one budget, one token, one network).
  const why = failed[critical[0] ?? kinds[0]] ?? '';
  /** @param {string[]} list */
  const verb = (list) => (list.length > 1 ? 'reminders were' : 'reminder was');
  if (critical.length) {
    return {
      critical: true,
      text: `No ${names(critical)} ${verb(critical)} scheduled. Any fleet you are counting on ${critical.length > 1 ? 'them' : 'it'} for is unguarded — check it yourself.`,
      why,
    };
  }
  return {
    critical: false,
    text: `No ${names(kinds)} ${verb(kinds)} scheduled this time.`,
    why,
  };
};

/**
 * Short, human cause for the footnote. ntfy answers a spent budget with 429,
 * a bad token with 401/403; anything else is reported as-is so a cause we
 * have not seen yet is still legible.
 *
 * @param {string} reason  Raw error text from the reconciler.
 * @returns {string}
 */
export const humanReason = (reason) => {
  if (/\b429\b/.test(reason)) return 'The ntfy daily message limit looks spent.';
  if (/\b401\b|\b403\b/.test(reason)) return 'ntfy refused the access token.';
  if (/failed to fetch|networkerror/i.test(reason)) return 'ntfy could not be reached.';
  return reason.slice(0, 160);
};

/**
 * Paint (or repaint) the banner for the current health record. Removes it
 * when there is nothing to report, so a sync that fixes the condition clears
 * the notice without a reload.
 *
 * @returns {void}
 */
const render = () => {
  const existing = document.getElementById(BANNER_ID);
  const health = readNtfyHealth();
  const failed = health?.failed ?? {};
  if (!document.body || Object.keys(failed).length === 0) {
    if (existing) existing.remove();
    return;
  }
  // Dismissed for this page view — leave it down until the next load.
  if (existing?.dataset.dismissed === '1') return;

  const { critical, text, why } = alertTextFor(failed);
  const banner = existing ?? document.createElement('div');
  banner.id = BANNER_ID;
  banner.className = critical ? 'crit' : 'info';
  banner.textContent = '';

  const msg = document.createElement('div');
  const lead = document.createElement('b');
  lead.textContent = critical ? 'Reminder not scheduled. ' : 'Reminder skipped. ';
  msg.appendChild(lead);
  msg.appendChild(document.createTextNode(text));
  if (why) {
    const sub = document.createElement('span');
    sub.className = 'oge-na-why';
    sub.textContent = humanReason(why);
    msg.appendChild(sub);
  }
  banner.appendChild(msg);

  const close = document.createElement('button');
  close.className = 'oge-na-x';
  close.type = 'button';
  close.title = 'Dismiss for this page view';
  close.textContent = '×';
  close.addEventListener('click', () => {
    banner.dataset.dismissed = '1';
    banner.remove();
  });
  banner.appendChild(close);

  if (!existing) document.body.insertBefore(banner, document.body.firstChild);
};

/**
 * Install the ntfy failure notice. Idempotent — a second call returns the
 * same dispose fn. Repaints whenever the alarm-clock producer finishes a
 * sync, which is the only thing that moves the health record.
 *
 * @returns {() => void} Dispose handle.
 */
export const installNtfyAlert = () => {
  if (installed) return installed.dispose;
  injectStyle(STYLE_ID, CSS);

  const onSynced = () => render();
  document.addEventListener(ALARM_CLOCK_SYNCED_EVENT, onSynced);
  if (document.body) render();
  else document.addEventListener('DOMContentLoaded', () => render(), { once: true });

  installed = {
    dispose: () => {
      document.removeEventListener(ALARM_CLOCK_SYNCED_EVENT, onSynced);
      document.getElementById(BANNER_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset.
 * @returns {void}
 */
export const _resetNtfyAlertForTest = () => {
  installed?.dispose();
  installed = null;
};
