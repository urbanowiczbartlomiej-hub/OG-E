// @ts-check

// Status badge for a alarmClock card on the Dashboard ▸ AlarmClock preview.
//
// One vocabulary across all three kinds (expedition waves, ad-hoc fleets,
// fleet-saves). The preview is titled "Reminders set", so the badge answers the
// only question that matters there: *is this reminder still going to ring?* —
// NOT where the fleet is. (The old wave badge said "in flight" / "overdue",
// which described the mission's timing, not the reminder, and read as noise —
// every mission is "in flight".)
//
// IMPORTANT — wording is a fair-play contract (see docs/fair-play.md): the
// player SETS each reminder at send time for a return time they already know;
// the reminder RINGS at that time. OG-E does not "queue", "schedule", or "fire"
// anything, and never watches the game while away. The device is the "alarm
// clock"; an individual buzz is a "reminder" — never bare "alarm" (that reads
// as the forbidden event-alert). The internal `cls` keys (queued/fired/…) are
// just CSS colour hooks and stay as-is.
//
// States, in priority order:
//
//   - cancelled    — the user tore it down (waves tombstone; ad-hoc delete).
//   - reminders off — this KIND is switched off (its tab's master switch), so
//                    nothing was ever set for it. Distinguished from "not set"
//                    because the two need opposite fixes: flip the switch vs
//                    wait for sync / paste a token. A bare "not set" on a
//                    fleet-save the player deliberately isn't tracking reads
//                    as a fault in OG-E.
//   - not set      — nothing on ntfy: no token, or sync hasn't run yet.
//   - > 3 days out — detected but deferred: ntfy delivers at most 3 days ahead,
//                    so the reminder is set once the fleet is within range
//                    (fleet-save only).
//   - armed        — we KNOW the reminder is set (the gist holds its ids) but
//                    can't see ntfy's live list (the poll failed / no token at
//                    the dashboard origin). Honest "set, state unknown" rather
//                    than guessing rang vs still-to-ring.
//   - set          — at least one reminder is still going to ring.
//   - rang         — every reminder has already gone off.

/**
 * @typedef {object} AlarmClockBadge
 * @property {string} text  Human label shown in the pill.
 * @property {'queued'|'fired'|'scheduled'|'none'|'far'|'cancelled'|'off'} cls
 *   State key → maps to a `.rem-badge.<cls>` colour (see `dashboard.html`).
 */

/**
 * Resolve a alarmClock's ntfy-queue state to its badge. Pure.
 *
 * @param {object} o
 * @param {boolean} [o.cancelled]    Tombstoned / deleted by the user.
 * @param {number}  [o.scheduledCount] ntfy message ids the gist recorded for it.
 * @param {number}  [o.pendingCount]   Of those, how many ntfy still holds (not
 *   yet fired). Only meaningful when `hasNtfyData` is true.
 * @param {boolean} [o.hasNtfyData]   Whether the live ntfy queue was fetched
 *   (false ⇒ we can't tell pending from fired).
 * @param {boolean} [o.tooFar]        Deferred beyond ntfy's 3-day horizon.
 * @param {boolean} [o.kindOff]       This kind's master switch is off. Only
 *   consulted when nothing is scheduled: a reminder already set stays "set"
 *   (it will still ring) even if the kind was switched off afterwards.
 * @returns {AlarmClockBadge}
 */
export const alarmClockBadge = ({
  cancelled = false,
  scheduledCount = 0,
  pendingCount = 0,
  hasNtfyData = false,
  tooFar = false,
  kindOff = false,
} = {}) => {
  if (cancelled) return { text: 'cancelled', cls: 'cancelled' };
  if (scheduledCount <= 0) {
    if (kindOff) return { text: 'reminders off', cls: 'off' };
    return tooFar
      ? { text: '> 3 days out', cls: 'far' }
      : { text: 'not set', cls: 'none' };
  }
  if (!hasNtfyData) return { text: 'armed', cls: 'scheduled' };
  return pendingCount > 0
    ? { text: 'set', cls: 'queued' }
    : { text: 'rang', cls: 'fired' };
};
