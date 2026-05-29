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

/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the reminders feature. Idempotent.
 *
 * @returns {() => void} Dispose: tears down the UI then the producer.
 */
export const installReminders = () => {
  if (installed) return installed;
  const producer = installReminderProducer();
  const disposeUi = installEventListReminders({
    armAdhoc: producer.armAdhoc,
    disarmAdhoc: producer.disarmAdhoc,
    cancelWave: producer.cancelWave,
    resendWave: producer.resendWave,
  });
  installed = () => {
    disposeUi();
    producer.dispose();
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
