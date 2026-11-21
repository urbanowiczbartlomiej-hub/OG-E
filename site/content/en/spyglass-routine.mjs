// @ts-check

// EN mirror of ../spyglass-routine.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-routine',
  category: 'spyglass',
  locale: 'en',

  name: 'Routine and offline windows',
  oneLiner:
    'From activity markers, Spyglass builds your opponent\'s day: when they usually play, and when they are reliably away.',
  flagship: true,
  order: 5,

  idea: [
    'The Galaxy and espionage reports show **how long ago** something happened on a planet. OG-E collects these traces and draws the player\'s day with a named peak — e.g. `evenings 19–23`.',
    'Separately it looks for **offline windows**: at least three hours in a row in which you looked often enough and consistently saw nothing. Not enough data? The page says plainly that you need to look more often, instead of guessing.',
  ],

  value: [
    'Knowing someone has a fleet is one thing. Knowing **when they are not watching it** is what decides whether an attack pays off.',
  ],

  fairplay: {
    summary: [
      'It only counts activity markers the game itself showed — in the Galaxy and in reports you opened. No extra requests, no timers.',
      'Traces left by **your own probes are subtracted**, so your own activity is not measured.',
    ],
  },

  details: [
    'Range: `30d`, `90d` (default), `6mo`, `All`; you can limit it to working days (`Mon–Fri`).',
    'A faint cell in the grid means "few observations", not "quiet".',
  ],

  screenshots: [
    { id: 'presence', caption: 'Routine: the player\'s day with its activity peak and the week grid with offline windows.' },
  ],

  codeRefs: [
    'src/domain/routine.js',
    'src/domain/presence.js',
    'src/domain/presenceLedger.js',
    'src/domain/shiftPattern.js',
    'src/state/activityObs.js',
  ],

  status: 'drafted',
};
