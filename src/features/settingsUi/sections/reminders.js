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
//   4. Expedition-wave reminders — enable / schedule / fires at. Detect a
//      returning expedition wave and schedule a reminder SERIES. The
//      schedule is a free-form minutes-first list of offsets AFTER the wave
//      returns (e.g. `0m, 10m, 30m, 60m`); "fires at" previews it live.
//   5. Ad-hoc reminders — enable / lead time. The event-list badges; lead
//      time is how long before arrival an ad-hoc ping fires (captured per
//      reminder at arm time).
//   6. Fleet-save reminders — enable / ship threshold / min flight time /
//      schedule / fires at. Auto-detect a big own fleet and schedule a
//      series RELATIVE to landing (negative = before, 0 = at, positive =
//      after). Min flight time excludes short planet⇄moon hops.
//
// The topic is automatic (derived from the token); it's shown read-only
// both here (row 3b) and on the OG-E Dashboard's Reminders tab.

import { offsetsForSchedule } from '../../../sync/ntfyScheduler.js';
import { settingsStore } from '../../../state/settings.js';
import { isValidNtfyToken, deriveNtfyTopic } from '../../../sync/reminders.js';
import { fetchNtfyAccount } from '../../../sync/ntfyAccount.js';
import { formatNtfyAccountStatus } from '../../../domain/ntfyAccount.js';
import { NTFY_CHECK_NOW_EVENT } from '../../../lib/ogeEvents.js';
import { parseFsOffsets } from '../../../domain/fleetSave.js';
import { formatDuration } from '../../../domain/duration.js';

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
/** @param {import('../../../state/settings.js').Settings} s @returns {boolean} */
const adhocLocked = (s) => sectionLocked(s) || !s.adhocEnabled;
/** @param {import('../../../state/settings.js').Settings} s @returns {boolean} */
const fsLocked = (s) => sectionLocked(s) || !s.fsEnabled;

/**
 * Render an offset list (whole seconds) as a canonical minutes-first
 * series, e.g. `[0, 600, 1800, 3600]` → `"0m, 10m, 30m, 60m"`. Used by the
 * read-only wave "fires at" preview.
 *
 * @param {number[]} offsetsSec
 * @returns {string}
 */
const offsetsList = (offsetsSec) => offsetsSec.map(formatDuration).join(', ');

/**
 * Spell out a fleet-save offset list as a human phrase relative to landing,
 * e.g. `[-600, 0, 600]` → `"10m before, at landing, 10m after"`. Empty /
 * all-invalid input reads as "(none)" so the player sees that no FS push
 * would be scheduled.
 *
 * @param {number[]} offsetsSec
 * @returns {string}
 */
const fsOffsetsText = (offsetsSec) =>
  offsetsSec.length
    ? offsetsSec
        .map((o) =>
          o < 0 ? `${formatDuration(-o)} before` : o > 0 ? `${formatDuration(o)} after` : 'at landing',
        )
        .join(', ')
    : '(none — no FS pushes scheduled)';

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
      // Read-only: spells out WHEN the wave schedule's reminders fire,
      // updating live as the field changes. Always-visible + full-width so
      // the times can't get clipped. Not a Settings field — DOM-only id.
      id: 'reminderScheduleTimes',
      label: 'Expedition-wave reminders — fires at',
      type: 'static',
      getText: () =>
        `${offsetsList(offsetsForSchedule(settingsStore.get().reminderSchedule))} after the wave returns`,
    },
    {
      id: 'adhocEnabled',
      label: 'Ad-hoc reminders — enable',
      type: 'checkbox',
      disabledWhen: sectionLocked,
    },
    {
      // How long before arrival an ad-hoc ping fires. Minutes-first; default
      // 60 s (shown as `1m`). Captured per reminder at arm time, so changing
      // it here only affects reminders armed afterwards.
      id: 'adhocOffsetSec',
      label: 'Ad-hoc reminders — lead time',
      type: 'duration',
      placeholder: '1m',
      disabledWhen: adhocLocked,
    },
    {
      // Fleet-save auto-detection: any of your own fleets whose total ship
      // count crosses the threshold is flagged 🛡 in the event list and gets
      // a reminder series. Auto-detected (never armed by hand); each slot can
      // only be cancelled from its badge in its final 2 minutes.
      id: 'fsEnabled',
      label: 'Fleet-save reminders — enable',
      type: 'checkbox',
      disabledWhen: sectionLocked,
    },
    {
      // The "big fleet" cutoff (a ship COUNT, not a duration). Default 100 000.
      id: 'fsThreshold',
      label: 'Fleet-save reminders — ship threshold',
      type: 'text',
      placeholder: '100000',
      disabledWhen: fsLocked,
    },
    {
      // Second gate: exclude short planet⇄moon hops. A big fleet on a short
      // flight is a logistics shuffle, not a save. Server-speed dependent,
      // so configurable. Default 600 s (`10m`). 0 disables the gate.
      id: 'fsMinFlightSec',
      label: 'Fleet-save reminders — min flight time',
      type: 'duration',
      placeholder: '10m',
      disabledWhen: fsLocked,
    },
    {
      // Free-form reminder schedule, RELATIVE to arrival (comma-separated
      // minutes-first offsets; negative = before landing, 0 = at landing,
      // positive = after). e.g. `-10m, 0m, 10m` ⇒ 10 min before, at, and
      // 10 min after.
      id: 'fsOffsets',
      label: 'Fleet-save reminders — schedule',
      type: 'text',
      placeholder: '-10m, 0m, 10m',
      disabledWhen: fsLocked,
    },
    {
      // Read-only: spells out the parsed FS offsets, updating live.
      id: 'fsOffsetsTimes',
      label: 'Fleet-save reminders — fires at',
      type: 'static',
      getText: () => fsOffsetsText(parseFsOffsets(settingsStore.get().fsOffsets)),
    },
  ],
};
