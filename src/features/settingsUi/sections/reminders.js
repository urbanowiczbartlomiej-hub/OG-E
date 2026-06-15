// @ts-check

// Reminders section of the OG-E settings tab. The umbrella for every
// ntfy.sh push OG-E can schedule — expedition-wave auto-reminders, ad-hoc
// per-fleet reminders, and fleet-save (FS) auto-detection.
//
// # Label convention
//
// Every row reads `Group — attribute`, with the same attribute words
// (`enable`, `schedule`, `fires at`) reused across groups so the panel is
// systematic and scannable. No units in labels — the VALUE carries the
// unit (minutes-first with an `s`/`m`/`h` suffix; see `domain/duration.js`).
//
// Layout, top to bottom:
//
//   1. Reminders — master switch. With no (valid) token there is no push
//      channel, so the credential + its status lead the section.
//   2. ntfy.sh — access token. The PREREQUISITE for everything below: the
//      topic is derived from it, the producer skips scheduling without it.
//   3. ntfy.sh — account status. Async probe of `/v1/account`: confirms the
//      token is accepted and shows today's message usage vs the daily
//      limit. Turns a wrong token (previously silent) into explicit
//      feedback. Manual "Check now" re-runs the probe.
//   3b. ntfy.sh — your topic. The push topic derived from the token; what
//      you subscribe to in the ntfy app on your phone. Read-only.
//   4. Expedition-wave reminders — enable / schedule. Detect a returning
//      expedition wave and schedule a reminder SERIES. The schedule is a
//      free-form minutes-first list of offsets AFTER the wave returns
//      (e.g. `0m, 10m, 30m, 60m`).
//   5. Ad-hoc reminders — lead time. Always on: the event-list badges arm a
//      per-fleet ping; lead time is how long before arrival it fires
//      (captured per reminder at arm time).
//
// Fleet-save reminders (enable / ship threshold / min flight time / schedule)
// used to live here too, but they are SERVER-SCOPED — moved to the dashboard's
// Reminders tab, backed by the per-universe galaxyScanConfig store (see
// REFRESH-PLAN.md B3). The topic is automatic (derived from the token); it's
// shown read-only both here (row 3b) and on that dashboard tab.

import { isValidNtfyToken, deriveNtfyTopic } from '../../../sync/reminders.js';
import { fetchNtfyAccount } from '../../../sync/ntfyAccount.js';
import { formatNtfyAccountStatus } from '../../../domain/ntfyAccount.js';
import { NTFY_CHECK_NOW_EVENT } from '../../../lib/ogeEvents.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

// NTFY_CHECK_NOW_EVENT (lib/ogeEvents.js) is dispatched by the master row's
// "Check now" button to force the account-status row to re-probe. The status
// row listens for it via `refreshEvent`, mirroring the Sync section: there the
// master row's "Sync now" drives the status line through an event rather than
// a direct call, so the trigger and the line it refreshes can live on
// different rows.

/**
 * The reminder sub-options (wave, ad-hoc, fleet-save) are locked until the
 * section is switched on AND a valid token is entered — the token is the
 * credential everything rides on. Used as each sub-option's `disabledWhen`.
 *
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const sectionLocked = (s) => !s.remindersMasterEnabled || !isValidNtfyToken(s.reminderNtfyToken);

/**
 * Each reminder group (wave / ad-hoc / fleet-save) has its own `enable`
 * checkbox above its option rows. A group's options lock when the SECTION is
 * locked OR that group's own enable is off — so unchecking "… — enable" greys
 * just that group's schedule/threshold/offset rows, while the enable
 * checkbox itself stays governed by `sectionLocked` alone. Used as each
 * sub-option's `disabledWhen`.
 *
 * @param {import('../../../state/settings.js').Settings} s
 * @returns {boolean}
 */
const waveLocked = (s) => sectionLocked(s) || !s.reminderEnabled;

/** @type {SettingsSection} */
export const remindersSection = {
  section: 'Reminders (ntfy.sh)',
  options: [
    // Master switch + credential first. Until BOTH are set, everything
    // below is greyed out (see `sectionLocked`).
    {
      // Master switch + the manual "Check now" account probe on its right
      // (mirrors the Sync master row's "Sync now"). The checkbox stays the
      // section toggle; the button dispatches NTFY_CHECK_NOW_EVENT, which the
      // account-status row below re-probes on via its `refreshEvent`. The
      // button greys while the section is off (probing is pointless without
      // the channel on); the master checkbox itself always stays live.
      id: 'remindersMasterEnabled',
      label: 'Reminders — master switch',
      type: 'checkbox',
      buttonText: 'Check now',
      onclick: () => document.dispatchEvent(new CustomEvent(NTFY_CHECK_NOW_EVENT)),
      buttonDisabledWhen: (s) => !s.remindersMasterEnabled,
    },
    {
      id: 'reminderNtfyToken',
      label: 'ntfy.sh — access token',
      type: 'password',
      placeholder: 'tk_…',
      // Editable only once the section is switched on (the token is the
      // credential the whole section unlocks behind).
      disabledWhen: (s) => !s.remindersMasterEnabled,
    },
    {
      // Async probe of the ntfy account: re-runs whenever the token changes
      // (and on the manual button). Gives the token explicit validation +
      // shows today's usage against the daily limit. Editable/usable as
      // soon as the section is on — even an invalid token gets feedback
      // (the probe short-circuits to a "not a valid token" line, no
      // request). Not a Settings field — the id is DOM-only.
      id: 'ntfyAccountStatus',
      label: 'ntfy.sh — account status',
      type: 'asyncStatus',
      refreshKey: (s) => s.reminderNtfyToken,
      fetchText: async (s) => formatNtfyAccountStatus(await fetchNtfyAccount(s.reminderNtfyToken)),
      // The manual re-probe trigger ("Check now") moved up onto the master
      // row; it dispatches this event, which we re-probe on.
      refreshEvent: NTFY_CHECK_NOW_EVENT,
    },
    {
      // The push topic OG-E derives from the token (a private hash). This is
      // what you subscribe to in the ntfy app on your phone to receive the
      // reminders. Read-only + async (the derivation hashes the token), so
      // it rides the same asyncStatus control as the account status and
      // re-derives whenever the token changes. Painted on load (not only
      // after a token edit) so the topic is always there, ready to copy.
      // Also shown on the OG-E Dashboard's Reminders tab.
      id: 'ntfyTopic',
      label: 'ntfy.sh — your topic (subscribe on phone)',
      type: 'asyncStatus',
      refreshKey: (s) => s.reminderNtfyToken,
      fetchText: async (s) =>
        isValidNtfyToken(s.reminderNtfyToken)
          ? await deriveNtfyTopic(s.reminderNtfyToken)
          : '— (enter a valid token first)',
    },
    {
      id: 'reminderEnabled',
      label: 'Expedition-wave reminders — enable',
      type: 'checkbox',
      disabledWhen: sectionLocked,
    },
    {
      // Free-form schedule: comma-separated minutes-first offsets AFTER the
      // wave returns (e.g. `0m, 10m, 30m, 60m`). Resolved by
      // `offsetsForSchedule`; negatives are dropped (can't fire before the
      // wave is back). The explicit series lives in the read-only row below.
      id: 'reminderSchedule',
      label: 'Expedition-wave reminders — schedule',
      type: 'text',
      placeholder: '0m, 10m, 30m, 60m',
      disabledWhen: waveLocked,
    },
    {
      // How long before arrival an ad-hoc ping fires. Minutes-first; default
      // 60 s (shown as `1m`). Captured per reminder at arm time, so changing
      // it here only affects reminders armed afterwards. Ad-hoc reminders are
      // always on (no enable toggle); this row only locks with the section.
      id: 'adhocOffsetSec',
      label: 'Ad-hoc reminders — lead time',
      type: 'duration',
      placeholder: '1m',
      disabledWhen: sectionLocked,
    },
  ],
};
