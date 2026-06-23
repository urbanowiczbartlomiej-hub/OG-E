// @ts-check

// Display section of the OG-E settings tab. Currently a single
// readability-boost toggle. New visual-only toggles (event-box tweaks,
// fleet-movement link styling, etc.) belong here.

import { THREAT_HIGHLIGHT_TEST_EVENT } from '../../../lib/ogeEvents.js';

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
      // `id` is the legacy persisted key (was "Expedition badges") — kept so
      // existing users' saved toggle survives; only the label/home moved now
      // that the markers cover every fleet mission, not just expeditions.
      id: 'expeditionBadges',
      label: 'Fleet status markers on planets',
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
      // In-tab full-screen highlight while the open OGame tab shows an inbound
      // attack — purely a louder rendering of what the game already displays to
      // a player who is at the keyboard (no off-tab title/favicon signal, no
      // push). The inline button fires a 10s preview (works regardless of the
      // checkbox, so the player can see it before opting in) — the feature
      // listens for the event. `id` stays the legacy persisted key so existing
      // users' saved toggle survives the rename.
      id: 'threatHighlight',
      label: 'Under-attack highlight (full-screen banner in the open tab)',
      type: 'checkbox',
      buttonText: 'Preview',
      onclick: () => document.dispatchEvent(new CustomEvent(THREAT_HIGHLIGHT_TEST_EVENT)),
    },
  ],
};
