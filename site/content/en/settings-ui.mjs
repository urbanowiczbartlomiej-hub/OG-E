// @ts-check

// EN mirror of ../settings-ui.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'settings-ui',
  category: 'game-ui',
  locale: 'en',

  name: 'OG-E settings in the AGR panel',
  oneLiner:
    "Every OG-E toggle lives as one tab inside AGR's existing options menu — one place, with no separate panel to hunt for.",
  order: 1,

  idea: [
    'OG-E attaches itself to the **AntiGameReborn (AGR)** options menu instead of putting up its own floating panel — the same menu that is already added to the game gets one extra tab. At its top sits an **"Open Dashboard"** button (leading to the full-page OG-E panel), below it the FAB button bar — tiles turn individual orbit buttons on and off (Expeditions, Colonisation, Discovery, Daily Run) — and a button-size slider.',
    'Below that sit the configuration options for the Expeditions button and the **Display** group — interface changes inside the game itself. Every tile has a one-word caption and a longer description on hover; all of them are described further on.',
  ],

  value: [
    'Two separate settings panels are two places to remember. By sticking to the one menu AGR users look for anyway, OG-E adds no second mental model of "where do I turn this on" — all the more so since OG-E requires AGR to work properly regardless.',
  ],

  fairplay: {
    summary: [
      'This is purely a **configuration panel** — every toggle saves a value locally and sends nothing to the game or outward. Changing a setting is not an in-game action.',
      "The AGR integration only appends a tab to the menu's already-existing DOM (`#ago_menu_content`) — nothing in AGR's interface is hidden or swapped.",
    ],
  },

  details: [
    'Requires AGR to be installed — without it there is nowhere to inject the tab (settings can be edited by hand in localStorage, but that is not a supported path).',
  ],

  screenshots: [
    { id: 'tab', caption: "The OG-E tab in AGR's options menu: the Dashboard button, the FAB button bar, and the Expeditions/Display groups." },
  ],

  codeRefs: [
    'src/features/settingsUi/index.js',
    'src/features/settingsUi/sections/data.js',
    'src/features/settingsUi/sections/floatingButton.js',
    'src/features/settingsUi/sections/preferences.js',
  ],

  status: 'drafted',
};
