// @ts-check

// Status badge for a reminder card on the Dashboard ▸ Reminders preview.
//
// One vocabulary across all three kinds (expedition waves, ad-hoc fleets,
// fleet-saves). The preview is titled "Currently queued", so the badge answers
// the only question that matters there: *what is this reminder's state ON
// ntfy?* — NOT where the fleet is. (The old wave badge said "in flight" /
// "overdue", which described the mission's timing, not the push channel, and
// read as noise — every mission is "in flight".)
//
// States, in priority order:
//
//   - cancelled      — the user tore it down (waves tombstone; ad-hoc delete).
//   - not scheduled  — nothing on ntfy: no token, or sync hasn't run yet.
//   - > 3 days out   — detected but deferred: ntfy schedules at most 3 days
//                      ahead, so the series queues once the fleet is within
//                      range (fleet-save only).
//   - scheduled      — we KNOW pushes are armed (the gist holds their ids) but
//                      can't see the live queue (the ntfy poll failed / no
//                      token at the dashboard origin). Honest "armed, state
//                      unknown" rather than guessing fired vs pending.
//   - queued         — at least one push is still pending on ntfy.
//   - fired          — every push has already gone out.

/**
 * @typedef {object} ReminderBadge
 * @property {string} text  Human label shown in the pill.
 * @property {'queued'|'fired'|'scheduled'|'none'|'far'|'cancelled'} cls
 *   State key → maps to a `.rem-badge.<cls>` colour (see `dashboard.html`).
 */

/**
 * Resolve a reminder's ntfy-queue state to its badge. Pure.
 *
 * @param {object} o
 * @param {boolean} [o.cancelled]    Tombstoned / deleted by the user.
 * @param {number}  [o.scheduledCount] ntfy message ids the gist recorded for it.
 * @param {number}  [o.pendingCount]   Of those, how many ntfy still holds (not
 *   yet fired). Only meaningful when `hasNtfyData` is true.
 * @param {boolean} [o.hasNtfyData]   Whether the live ntfy queue was fetched
 *   (false ⇒ we can't tell pending from fired).
 * @param {boolean} [o.tooFar]        Deferred beyond ntfy's 3-day horizon.
 * @returns {ReminderBadge}
 */
export const reminderBadge = ({
  cancelled = false,
  scheduledCount = 0,
  pendingCount = 0,
  hasNtfyData = false,
  tooFar = false,
} = {}) => {
  if (cancelled) return { text: 'cancelled', cls: 'cancelled' };
  if (scheduledCount <= 0) {
    return tooFar
      ? { text: '> 3 days out', cls: 'far' }
      : { text: 'not scheduled', cls: 'none' };
  }
  if (!hasNtfyData) return { text: 'scheduled', cls: 'scheduled' };
  return pendingCount > 0
    ? { text: 'queued', cls: 'queued' }
    : { text: 'fired', cls: 'fired' };
};
