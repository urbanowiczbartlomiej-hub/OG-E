// @ts-check

// The preferences panel — the HEADERLESS second section of the settings tab:
// every remaining toggle as a self-indicating tile inside ONE bordered panel
// (same chrome as the FAB command block above it), grouped by thin muted
// captions instead of gold AGR section headers. Replaces the old Expeditions
// + Display checkbox sections; every tile writes the SAME Settings key as its
// old row did, so nothing migrates.
//
// Wording: tile captions are keywords (UI rule); each old full-sentence label
// survives as the tile's tooltip (`hint` → title attribute).

import { THREAT_HIGHLIGHT_TEST_EVENT } from '../../../lib/ogeEvents.js';
import { EYE_GLYPH } from '../../shared/buttonGlyphs.js';
import {
  NEXT_PLANET_GLYPH,
  READABILITY_GLYPH,
  PLANET_MARKERS_GLYPH,
  EVENT_PULSE_GLYPH,
  TRADER_PULSE_GLYPH,
  ATTACK_BANNER_GLYPH,
} from '../prefGlyphs.js';

/**
 * @typedef {import('../controls.js').SettingsSection} SettingsSection
 */

/** @type {SettingsSection} */
export const preferencesSection = {
  // Empty title — the panel carries its own group captions.
  section: '',
  options: [
    {
      id: 'prefPanel',
      label: '',
      type: 'prefTiles',
      fullWidth: true,
      prefGroups: [
        {
          caption: 'Expeditions',
          // One two-zone row control (like a split FAB button): the tile body
          // toggles the auto-redirect, the embedded segment holds the send
          // cap. The cap applies regardless of the toggle (it limits the send
          // counter, not the redirect), so the segment keeps its own lit
          // selection even while the tile is dormant.
          columns: 1,
          tiles: [
            {
              key: 'autoRedirectExpedition',
              caption: 'Auto next planet',
              hint: 'After sending expedition, open the next planet',
              glyph: NEXT_PLANET_GLYPH,
              seg: {
                key: 'maxExpeditionsPerPlanet',
                caption: 'Max / planet',
                choices: [1, 2],
                hint: 'Max expeditions per planet',
              },
            },
          ],
        },
        {
          caption: 'Display',
          columns: 3,
          tiles: [
            {
              key: 'readabilityBoost',
              caption: 'Readability',
              hint: 'Readability boost (event box, fleet movement link, galaxy touch nav)',
              glyph: READABILITY_GLYPH,
            },
            {
              // Legacy persisted key (was "Expedition badges") — kept so
              // existing users' saved toggle survives; the markers cover
              // every fleet mission now.
              key: 'expeditionBadges',
              caption: 'Planet markers',
              hint: 'Fleet status markers on planets',
              glyph: PLANET_MARKERS_GLYPH,
            },
            {
              key: 'eventMenuHighlight',
              caption: 'Event pulse',
              hint: 'Event highlight (pulse menu button)',
              glyph: EVENT_PULSE_GLYPH,
            },
            {
              key: 'traderMenuHighlight',
              caption: 'Trader pulse',
              hint: 'Trader highlight (pulse menu button)',
              glyph: TRADER_PULSE_GLYPH,
            },
            {
              // In-tab full-screen highlight while the open OGame tab shows an
              // inbound attack — a louder rendering of what the game already
              // displays (no off-tab signal, no push). The corner pill fires a
              // 10s preview regardless of the toggle, so the player can see it
              // before opting in. `key` stays the legacy persisted name.
              key: 'threatHighlight',
              caption: 'Attack banner',
              hint: 'Under-attack highlight (full-screen banner in the open tab)',
              glyph: ATTACK_BANNER_GLYPH,
              action: {
                label: 'Preview',
                hint: 'Show a 10s preview of the banner',
                run: () => document.dispatchEvent(new CustomEvent(THREAT_HIGHLIGHT_TEST_EVENT)),
              },
            },
            {
              // The defensive "Who's spying on you" table on the messages
              // spy-report tab; `whosSpyingPanel` self-gates on the flag.
              key: 'showWhosSpying',
              caption: "Who's spying",
              hint: "Who's spying on you (panel on the messages spy-report tab)",
              glyph: EYE_GLYPH,
            },
          ],
        },
      ],
    },
  ],
};
