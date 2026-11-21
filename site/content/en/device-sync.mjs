// @ts-check

// EN mirror of ../device-sync.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'device-sync',
  category: 'dashboard',
  locale: 'en',

  name: 'Cross-device sync',
  oneLiner:
    'Your computer and your phone see the same OG-E data — through your own private GitHub gist.',
  flagship: true,
  order: 5,

  idea: [
    'In the **Sync** tab of the Dashboard you switch on **Sync across devices** and paste your **GitHub token** (the `gist` permission is enough). From then on OG-E keeps a copy of your data in **your private gist** and pulls it onto every device.',
    'What cannot be rebuilt gets synced: colony history, Spyglass intel, the watch list, Daily Run routes and settings. Galaxy scans and the player list are rebuilt on each device from the public API.',
    'Data is **merged**: lists (colonies, reports) fill each other in, while settings and routes are taken whole from the newer version.',
  ],

  value: [
    'Playing on a computer and a phone? Without sync each device knows something different. With it you see the same everywhere, without moving anything by hand.',
  ],

  fairplay: {
    summary: [
      'Sync **never talks to the game server** — only to GitHub, to a gist that belongs to you.',
      'It is **optional** and off by default: without your token nothing leaves the browser. Only your own data, gathered while playing, is synced.',
    ],
  },

  details: [
    '**Stored on this device** shows how much data each server has on this device and when it last synced.',
    'Done with a server? **Abandon** downloads an archive and deletes the data from this device (the gist copy stays).',
    '**Alliance share (Spyglass)** is a separate, optional intel exchange with your alliance-mates.',
  ],

  screenshots: [
    { id: 'settings', caption: 'The Sync tab: GitHub token, "Sync now" and a summary of the server\'s data on this device.' },
  ],

  codeRefs: [
    'src/sync/gist.js',
    'src/sync/scheduler.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
