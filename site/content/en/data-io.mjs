// @ts-check

// EN mirror of ../data-io.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'data-io',
  category: 'dashboard',
  locale: 'en',

  name: 'Import / export / CSV',
  oneLiner:
    'A backup of a server\'s data in one JSON file — no cloud, no account. Plus your colony history for a spreadsheet (CSV).',
  order: 6,

  idea: [
    '**Export JSON** on the Dashboard\'s top bar saves the selected server\'s data to a file (on a narrow screen the buttons hide under the server name). **Import JSON** loads a file into the **currently selected server** and merges it with what you already have — the same way sync does.',
    'The **CSV** button next to the Big Colony Hunting chart saves your colony history for a spreadsheet.',
  ],

  value: [
    'A backup, or moving your data to a new device without setting up sync. You keep the file, you decide where it goes.',
  ],

  fairplay: {
    summary: [
      'Everything happens **locally**: saving and loading a file, with no contact with the game server or anyone else.',
      'The file is safe to share — **tokens and passwords never go into it**.',
    ],
  },

  details: [
    'The file does not include settings stored in the game or the colony-abandon password — it is a data backup, not a full device move.',
  ],

  screenshots: [
    { id: 'buttons', caption: 'Export JSON and Import JSON next to the server picker, on the Dashboard\'s top bar.' },
  ],

  codeRefs: [
    'src/features/dashboard/io.js',
    'src/features/dashboard/autosave.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
