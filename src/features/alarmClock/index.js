// @ts-check

// AlarmClock feature install — wires the game-side producer (the single
// writer of the per-universe alarmClock state; reconciles expedition waves
// + ad-hoc fleet alarmClock) to the event-list badge UI that drives it.
//
// Top-frame only (the caller gates on `window.top === window.self`): the
// producer does gist IO and the event box lives in the top frame.
//
// @see ./producer.js   — sync owner + arm/disarm/cancel API
// @see ./eventList.js  — the badge UI (API consumer)

import { installAlarmClockProducer } from './producer.js';
import { installEventListAlarmClock } from './eventList.js';
import { installGuardian } from './guardian.js';

/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the alarmClock feature. Idempotent.
 *
 * @returns {() => void} Dispose: tears down the UI then the producer.
 */
export const installAlarmClock = () => {
  if (installed) return installed;
  // Late-bound so the producer can notify the UI after each sync without a
  // construction-order cycle (producer is built first to hand the UI its
  // arm/disarm/cancel/resend API).
  let uiRefresh = () => {};
  const producer = installAlarmClockProducer({ onSynced: () => uiRefresh() });
  const ui = installEventListAlarmClock({
    armAdhoc: producer.armAdhoc,
    disarmAdhoc: producer.disarmAdhoc,
    cancelWave: producer.cancelWave,
    resendWave: producer.resendWave,
    cancelFsSlot: producer.cancelFsSlot,
  });
  uiRefresh = ui.refresh;
  // The post-landing guardian. Reads the unified fleet-reminder store
  // (state/fleetReminders.js) for its warning button; the producer
  // schedules/cancels the guardian's ntfy push, and the button's long-press
  // dismiss routes back through producer.guardianDismiss (the synced FR
  // tombstone).
  const guardian = installGuardian({
    dismiss: producer.guardianDismiss,
    ack: producer.guardianAck,
  });
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
export const _resetAlarmClockForTest = () => {
  if (installed) installed();
  installed = null;
};
