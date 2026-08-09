// @ts-check

// EN mirror of ../og-e-button.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'og-e-button',
  category: 'fab',
  locale: 'en',

  name: 'The OG-E button (FAB)',
  oneLiner:
    'A smart floating button you can hit easily with your thumb, driving all your everyday actions.',
  flagship: true,
  order: 1,

  idea: [
    'The FAB (Floating Action Button) is one floating button that makes fleet actions easier: Expeditions, Colonisation, Lifeform Discovery, Daily routes, Fleet Save, Activity Watch and Spying. Each button is described in its own section. You always see one active button in the centre and a few smaller "orbs" around it; tapping an orb switches the active button, and tapping the centre runs its action on the current page.',
    'You drag the button anywhere you like (its position and your choice are remembered), and each button knows for itself which page you are on and what you can do there.',
  ],

  value: [
    'It is built **mobile-first**: on a phone OGame scales the page so its native buttons become tiny and hard to hit. The FAB gives you one **big, comfortable target under your thumb** and gathers scattered actions in one place — it works on desktop too, but the phone is the main scenario.',
  ],

  details: [
    'Button bar — turn a button on or off if you do not use the feature and do not want to see it on the FAB orbits.',
    'The button size is set with a slider (changes live).',
    'Position and the selected button are remembered per device; after a reload the FAB returns to the same spot (clamped to the visible screen).',
    'Long-press has a separate meaning depending on the active button (e.g. "skip this planet").',
    'One of the orbs is **Spyglass**: you turn it on and manage it from the `Spyglass` tab in the OG-E Dashboard (the watch list, scan settings), while in-game it proposes the next look at the galaxy or a spy-probe send — see the separate "Spyglass — intelligence" chapter.',
  ],

  fairplay: {
    summary: [
      'The FAB **sends the game no requests**. It passes your click on to the same native interface element you would press yourself — if the game contacts the server in response, it does so itself, after your tap, exactly as with a manual click.',
      'It only acts on what you already have open: it reads what the game already displays and does nothing in the background — it does not refresh the page, scan, or track the game.',
    ],
  },

  screenshots: [
    { id: 'orbits', caption: 'The floating button: one active button in the centre, the rest as orbs around it.' },
    { id: 'module-bar', caption: 'The button bar in settings — tiles turn individual buttons on and off.' },
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
