// @ts-check

// Reminders feature install — wires the game-side producer (the single
// writer of the per-universe reminder state; reconciles expedition waves
// + ad-hoc fleet reminders) to the event-list badge UI that drives it.
//
// Top-frame only (the caller gates on `window.top === window.self`): the
// producer does gist IO and the event box lives in the top frame.
//
// @see ./producer.js   — sync owner + arm/disarm/cancel API
// @see ./eventList.js  — the badge UI (API consumer)

import { installReminderProducer } from './producer.js';
import { installEventListReminders } from './eventList.js';
import { installGuardian } from './guardian.js';

/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the reminders feature. Idempotent.
 *
 * @returns {() => void} Dispose: tears down the UI then the producer.
 */
export const installReminders = () => {
  if (installed) return installed;
  // Late-bound so the producer can notify the UI after each sync without a
  // construction-order cycle (producer is built first to hand the UI its
  // arm/disarm/cancel/resend API).
  let uiRefresh = () => {};
  const producer = installReminderProducer({ onSynced: () => uiRefresh() });
  const ui = installEventListReminders({
    armAdhoc: producer.armAdhoc,
    disarmAdhoc: producer.disarmAdhoc,
    cancelWave: producer.cancelWave,
    resendWave: producer.resendWave,
    cancelFsSlot: producer.cancelFsSlot,
  });
  uiRefresh = ui.refresh;
  // The post-landing guardian (Etap 1: DOM-only). Consumes the producer's
  // published landed-FS set (state/fleetSaveSet.readLandedFs) and shows the
  // warning button (tap = go re-save, long-press = dismiss).
  const guardian = installGuardian();
  installed = () => {
    ui.dispose();
    producer.dispose();
    guardian();
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetRemindersForTest = () => {
  if (installed) installed();
  installed = null;
};
