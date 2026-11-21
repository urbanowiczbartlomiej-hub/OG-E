// @ts-check

// EN mirror of ../who-is-spying.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'who-is-spying',
  category: 'spyglass',
  locale: 'en',

  name: 'Who is spying on you',
  oneLiner:
    'Alerts about other players\' probes in one table: who spied on you, how often and from where.',
  order: 7,

  idea: [
    'On the messages page, in the **Espionage** tab, OG-E gathers the alerts about foreign probes you opened into **one table** — one row per player: when, how many times, from where and near which of your planets. Range: **1d / 7d / 1m / 3m**.',
    'The row colour shows the player\'s **Danger**, and clicking the name opens their dossier — whoever spied on you becomes your target. The same table is in the Dashboard, in the Spyglass tab (**Who\'s spying**).',
  ],

  value: [
    'OGame scatters these alerts across single messages. The table answers one question at a glance: **is someone interested in me, and how close are they?**',
  ],

  fairplay: {
    summary: [
      'The table **only sorts** messages the game has already shown you. It clicks nothing and sends nothing.',
      'You can look at the raw alerts (**show raw log**) — nothing is hidden.',
    ],
  },

  details: [
    'A player spying from your own system is flagged and listed first.',
    '**Mute** silences a player whose probes you do not care about (e.g. an ally).',
    'The **Coords** / **Names** button switches rows between coordinates and planet names.',
    'The in-game table is on by default; switch it off with the "Who\'s spying" tile in OG-E Settings (Display).',
  ],

  screenshots: [
    { id: 'panel', caption: 'The table on the in-game messages page: two players, their alert counts and the planets of yours they showed up near.' },
    { id: 'dashboard', caption: 'The same table in the Dashboard, in the Spyglass tab.' },
  ],

  codeRefs: [
    'src/features/whosSpyingPanel.js',
    'src/domain/proximityDigest.js',
    'src/state/proximityReports.js',
  ],

  status: 'drafted',
};
