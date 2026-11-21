// @ts-check

// EN mirror of ../routes.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'routes',
  category: 'dashboard',
  locale: 'en',

  name: 'Daily Run — routes',
  oneLiner:
    'Define your daily small-fleet routes once in the Dashboard — then the Daily Run button walks you through them in the game, tap by tap.',
  order: 4,

  idea: [
    'In the **Daily Run** tab of the Dashboard you build **routes**: from where (one or more of your planets/moons), with what (ships and count), with which mission and to where — a list of targets in a fixed order.',
    'Your own planets and moons are picked from a list; other coordinates are typed by hand. A route can be **paused** without deleting it. One of your bodies that no longer exists (e.g. an abandoned colony) turns red — remove it with one click.',
  ],

  value: [
    'Sending resources or probes from many planets every day means typing coordinates over and over. Here you set it up once, and in the game you only tap.',
  ],

  fairplay: {
    summary: [
      'It is **only a settings editor** — it saves routes in the extension, does not talk to the game and sends nothing by itself.',
      'Sending happens later in the game, with the Daily Run button, always after your tap and through the native fleet form.',
    ],
  },

  details: [
    '**⚙ Settings** sets what "Send All" does: mission (Deployment / Transport), ships and resources (Most / All). The collect target is set in the game by holding the Send All zone of the button.',
    'Routes sync between devices together with the rest of your data.',
  ],

  screenshots: [
    { id: 'editor', caption: 'Two routes: one active, one paused. The red target [7:77:7] no longer exists — ready to remove.' },
  ],

  codeRefs: [
    'src/features/dashboard/routes.js',
  ],

  status: 'drafted',
};
