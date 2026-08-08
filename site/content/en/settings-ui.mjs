// @ts-check

// EN mirror of ../settings-ui.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'settings-ui',
  category: 'game-ui',
  locale: 'en',

  name: 'OG-E settings in the AGR panel',
  oneLiner:
    "Every OG-E toggle lives as one tab inside AGR's existing options menu — one place to look, no separate panel to hunt for.",
  order: 1,

  idea: [
    "OG-E attaches to the **AntiGameReborn (AGR)** options menu instead of building its own floating panel — the same menu you already have open gets one extra tab. At the top sits an **\"Open Dashboard\"** button (leads to OG-E's full-page panel), below it the FAB module bar — tiles turn individual orb buttons on or off (Expeditions, Colonisation, Discovery, Daily Run, Spyglass…) — and a button-size slider.",
    'Below that, one headerless **Preferences** tile grouped under quiet captions instead of gold AGR headers: an **Expeditions** group (e.g. max expeditions per planet) and a **Display** group — Readability, Planet markers, Event pulse, Trader pulse, Attack banner, and "Who\'s spying". Every tile has a one-word caption and a longer description on hover/tap.',
  ],

  value: [
    'Two separate settings panels are two places to remember. By living inside the one menu AGR users already look for, OG-E adds no second mental model of "where do I turn this on" — everything sits in one place, reachable from any game page.',
  ],

  fairplay: {
    summary: [
      'This is purely a **configuration panel** — every toggle saves a value locally and sends nothing to the game or outward. Changing a setting is not an in-game action.',
      "The AGR integration only appends a tab to the menu's already-existing DOM (`#ago_menu_content`) — nothing in AGR's own interface is hidden or swapped.",
    ],
  },

  details: [
    'Requires AGR to be installed — without it there is nowhere to inject the tab (settings can be edited by hand in localStorage, but that is not a supported path).',
    "The tab re-injects itself if AGR rebuilds its container (a DOM observer), so toggles don't vanish after the menu refreshes.",
  ],

  screenshots: [
    { id: 'tab', caption: "The OG-E tab in AGR's options menu: the Dashboard button, the FAB module bar, and the Expeditions/Display groups." },
  ],

  codeRefs: [
    'src/features/settingsUi/index.js',
    'src/features/settingsUi/sections/data.js',
    'src/features/settingsUi/sections/floatingButton.js',
    'src/features/settingsUi/sections/preferences.js',
  ],

  status: 'drafted',
};
