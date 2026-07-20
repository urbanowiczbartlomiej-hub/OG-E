// @ts-check

// EN mirror of ../og-e-button.mjs — same slug/category/order/screenshots,
// prose translated. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'og-e-button',
  category: 'fab',
  locale: 'en',

  name: 'The OG-E button (FAB)',
  oneLiner:
    'One floating button under your thumb that fires every fleet action — designed first and foremost for the phone.',
  flagship: true,
  order: 1,

  idea: [
    'The FAB is **a single floating button** that hosts your fleet-action modules — expeditions, colonisation, discovery, daily routes, reminders. You always see one active module in the centre and a few smaller "orbs" around it; tapping an orb **switches** the active module, and tapping the centre runs its action on the current page.',
    'You **drag** the button anywhere you like (its position is remembered), and each module knows which game page it makes sense on.',
  ],

  value: [
    "It is built **mobile-first**: on a phone OGame scales the page so its native buttons become tiny and hard to hit. The FAB gives you one **big, comfortable target under your thumb** and gathers scattered fleet actions in one place — it works on desktop too, but the phone is the main scenario.",
  ],

  details: [
    'You turn modules on and off with tiles in settings; the button size is a live slider.',
    'Position and the selected module are remembered per device; after a reload the button returns to the same spot (clamped to the visible screen).',
    'Long-press has a separate, module-dependent meaning (e.g. "skip this planet").',
  ],

  fairplay: {
    summary: [
      "The FAB **sends the game no requests**. It clicks the same native UI element for you that you would press yourself — if the game contacts the server in response, it does so itself, after your tap, exactly as with a manual click.",
      'It only acts on what you already have open: it reads what the game already displays and does nothing in the background — it does not refresh the page, scan, or track the game.',
    ],
  },

  settings: [
    'Module bar — enable/disable individual commands (no master switch; all off = no button).',
    'Button-size slider (live).',
  ],

  screenshots: [
    { id: 'orbits', caption: 'The floating button: one active module in the centre, the rest as orbs around it.' },
    { id: 'dragging', caption: 'Dragging the button under your thumb — position remembered per device.' },
    { id: 'module-bar', caption: 'The module bar in settings — tiles enable/disable commands.' },
  ],

  codeRefs: [
    'src/features/shared/unifiedFab.js',
    'src/features/shared/draggableButton.js',
    'src/features/shared/button.js',
    'src/features/shared/fabModules.js',
    'src/features/settingsUi/sections/floatingButton.js',
  ],

  status: 'drafted',
};
