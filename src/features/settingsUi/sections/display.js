// @ts-check

// Display section of the OG-E settings tab. Currently a single
// readability-boost toggle. New visual-only toggles (event-box tweaks,
// fleet-movement link styling, etc.) belong here.

import { ATTACK_ALARM_TEST_EVENT } from '../../../lib/ogeEvents.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const displaySection = {
  section: 'Display',
  options: [
    {
      id: 'readabilityBoost',
      label: 'Readability boost (event box + fleet movement link)',
      type: 'checkbox',
    },
    {
      id: 'eventMenuHighlight',
      label: 'Event reminder (pulse menu button)',
      type: 'checkbox',
    },
    {
      id: 'traderMenuHighlight',
      label: 'Trader reminder (pulse menu button)',
      type: 'checkbox',
    },
    {
      // Loud full-screen alert while under attack. The inline button fires a
      // 10s preview (works regardless of the checkbox, so the player can see
      // it before opting in) — the alarm feature listens for the event.
      id: 'attackAlarm',
      label: 'Attack alarm (full-screen alert when under attack)',
      type: 'checkbox',
      buttonText: 'Preview',
      onclick: () => document.dispatchEvent(new CustomEvent(ATTACK_ALARM_TEST_EVENT)),
    },
  ],
};
