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
//   2. ntfy.sh — access token. The PREREQUISITE for everything: the topic is
//      derived from it, the producer skips scheduling without it.
//   3. ntfy.sh — account status. Async probe of `/v1/account`: confirms the
//      token is accepted and shows today's message usage vs the daily
//      limit. Turns a wrong token (previously silent) into explicit
//      feedback. Manual "Check now" re-runs the probe.
//   3b. ntfy.sh — your topic. The push topic derived from the token; what
//      you subscribe to in the ntfy app on your phone. Read-only.
//
// That's the whole AGR section now: master switch + required credential + its
// read-only status rows. The DETAILED reminder config moved to the dashboard's
// Reminders tab (see REFRESH-PLAN.md B3): the per-server fleet-save knobs to
// the per-universe galaxyScanConfig store (B3b), and the GLOBAL wave
// enable/schedule + ad-hoc lead time to the reminderGlobalConfig store (B3c).
// The token must stay here (it's the required credential); a one-line signpost
// under the master switch points at the Dashboard for the rest.

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
      // Signpost: the schedules + fleet-save config moved to the Dashboard
      // (B3). Only the master switch + token (the required credential) stay
      // here. Not a Settings field — `static`, DOM-only id.
      id: 'remindersDashboardHint',
      label: 'Reminders — configuration',
      type: 'static',
      getText: () => 'Schedules + fleet-save config live in the OG-E Dashboard → Reminders.',
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
  ],
};
