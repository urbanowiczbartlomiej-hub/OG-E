// @ts-check

// EN mirror of ../who-is-spying.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'who-is-spying',
  category: 'spyglass',
  locale: 'en',

  name: 'Who is spying on you',
  oneLiner:
    'A table on the messages page showing who has recently probed your planets — the freshest and closest at the top.',
  order: 7,

  idea: [
    'On the messages page OG-E gathers "hostile fleet near your planet" alerts into **one table**: one row per spy, with who, how long ago, how often and from where they poke you. The freshest and closest threats are at the top, and a spy with a fleet **in your own system** is flagged separately (they reach you the fastest).',
  ],

  value: [
    'OGame scatters "who probed you" across individual messages that are easy to miss. The table answers one defensive question — **is someone interested in me, and how close are they?** — before it turns into an attack.',
  ],

  fairplay: {
    summary: [
      'The panel is **purely presentational**: it shows alerts you opened yourself during normal play. It initiates no click in the game, sends no requests, and has no timer or notification outside the tab.',
      'It is the same knowledge OGame already showed you — just **gathered into one readable table** instead of scattered across messages.',
    ],
  },

  screenshots: [
    { id: 'panel', caption: 'The "Who is spying on you" panel at the top of the Spy tab, above the AGR overview.' },
    { id: 'same-system', caption: 'A row flagged as a threat from your own system — at the top of the list.' },
  ],

  codeRefs: [
    'src/features/whosSpyingPanel.js',
    'src/domain/proximityDigest.js',
    'src/state/proximityReports.js',
  ],

  status: 'drafted',
};
