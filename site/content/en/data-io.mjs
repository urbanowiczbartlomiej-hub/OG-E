// @ts-check

// EN mirror of ../data-io.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'data-io',
  category: 'dashboard',
  locale: 'en',

  name: 'Import / export / CSV',
  oneLiner:
    "Save the selected universe's whole dataset to a JSON file, load it back by merging, and dump the colony history to CSV.",
  order: 40,

  idea: [
    'From the Dashboard you **export** the selected universe\'s data to a single JSON file and **import** it back. Import does not overwrite wholesale — each dataset is **merged** with the same reconciler as gist sync: additive, local-first. An Export → Import round-trip behaves exactly like a gist download.',
    'Separately you **dump the colony history to CSV** to open it in a spreadsheet. Everything goes through local files (Blob) — the module never touches the network.',
  ],

  value: [
    'A backup, a transfer of your data to a new device without configuring a gist, or working the colony history in a spreadsheet — with no cloud and no account. You hold the file, you decide where it goes.',
  ],

  fairplay: {
    summary: [
      'Import/export is **local only**: no `fetch`, no contact with the game server or any other. Downloads go through a Blob, and loading reads the file you point at yourself.',
      'The file is **safe to hand over**: secrets (the GitHub token, the ntfy token) and sync bookkeeping never enter it. It is your own data, gathered by normal play, packed into one file.',
    ],
  },

  details: [
    'The watch-list import rides its own LWW+tombstone merge: an un-star in a newer file propagates, exactly like sync.',
    "The file carries only extension-storage data; per-universe settings stored in the game's localStorage remain gist-sync-only.",
  ],

  screenshots: [
    { id: 'buttons', caption: 'The Export / Import / CSV buttons in the OG-E Dashboard.' },
    { id: 'summary', caption: 'The import summary: how many entries were added in each dataset after merging.' },
  ],

  codeRefs: [
    'src/features/dashboard/io.js',
    'src/features/dashboard/autosave.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
