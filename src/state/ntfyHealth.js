// @ts-check

// ntfy delivery health — what the last alarm-clock sync could NOT queue.
//
// Scheduling a reminder can fail: the ntfy account's daily message budget is
// spent, the access token is wrong or revoked, the publish is rate-limited,
// the network is gone. Every one of those used to be silent — the reconcile
// threw, the round aborted, and the only symptom was a push that never came,
// which by construction arrives too late to act on.
//
// This module is the handoff between the sync that discovered the failure
// (`sync/alarmClock.js`) and the in-game notice that reports it
// (`features/alarmClock/ntfyAlert.js`). A plain `read*/write*` key-owner over
// per-origin localStorage — the sanctioned non-store exception documented in
// CLAUDE.md (cf. `state/badgeCache.js`): it is read on demand at the one place
// that paints the notice, so a reactive store would be pure overhead.
//
// # Kinds are NOT equal, and that is the whole point
//
// A missed EXPEDITION reminder costs idle minutes. A missed FLEET-SAVE
// reminder can cost the fleet, and with it months of play. An AD-HOC reminder
// was armed deliberately and we do not know what it guards, so it is treated
// like a fleet-save. {@link CRITICAL_KINDS} encodes that ordering, and the
// notice is loud or quiet accordingly.
//
// Health is per-universe by construction (per-origin localStorage), which is
// what we want: a budget spent on one server says nothing about another.

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the health envelope. */
export const NTFY_HEALTH_KEY = 'oge-ntfy-health';

/**
 * Kinds whose failure can cost a fleet. Fleet-save is the obvious one; ad-hoc
 * joins it because the player armed it on purpose and we cannot see what for,
 * and the guardian because it is the last warning before a bare fleet is
 * someone's farm. Expedition waves are deliberately NOT here.
 *
 * @type {ReadonlySet<string>}
 */
export const CRITICAL_KINDS = new Set(['fleetSave', 'adhoc', 'guardian']);

/**
 * Human label per kind, for the notice. Kept here beside
 * {@link CRITICAL_KINDS} so adding a kind forces a decision about both.
 *
 * @type {Record<string, string>}
 */
export const KIND_LABELS = {
  fleetSave: 'fleet-save',
  adhoc: 'armed fleet',
  guardian: 'bare-fleet',
  wave: 'expedition',
};

/**
 * @typedef {object} NtfyHealth
 * @property {number} at      Epoch SECONDS of the sync that recorded this.
 * @property {Record<string, string>} failed  kind → short reason. Empty when
 *   the last sync queued everything it wanted to.
 */

/**
 * Read the last recorded health. Never throws; a malformed or absent value
 * reads as "nothing wrong", which is the right failure direction — a broken
 * cache must not invent an alarm.
 *
 * @returns {NtfyHealth | null}
 */
export const readNtfyHealth = () => {
  const raw = safeLS.get(NTFY_HEALTH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const failed = parsed.failed && typeof parsed.failed === 'object' ? parsed.failed : {};
    return { at: Number(parsed.at) || 0, failed };
  } catch {
    return null;
  }
};

/**
 * Record what the sync just failed to queue. An empty `failed` map clears the
 * notice — written on every successful sync, so a transient failure heals by
 * itself on the next page view rather than nagging until dismissed.
 *
 * @param {Record<string, string>} failed  kind → short reason.
 * @param {number} now  Epoch SECONDS.
 * @returns {void}
 */
export const writeNtfyHealth = (failed, now) => {
  if (Object.keys(failed).length === 0) {
    safeLS.remove(NTFY_HEALTH_KEY);
    return;
  }
  safeLS.set(NTFY_HEALTH_KEY, JSON.stringify({ at: now, failed }));
};

/**
 * Does this health record contain a kind whose failure can cost a fleet?
 *
 * @param {NtfyHealth | null} health
 * @returns {boolean}
 */
export const hasCriticalFailure = (health) =>
  Object.keys(health?.failed ?? {}).some((k) => CRITICAL_KINDS.has(k));
