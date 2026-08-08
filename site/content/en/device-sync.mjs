// @ts-check

// EN mirror of ../device-sync.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'device-sync',
  category: 'dashboard',
  locale: 'en',

  name: 'Cross-device sync',
  oneLiner:
    'Your collected data (galaxy scans, colony history) travels between your computer and phone through your own private GitHub gist.',
  flagship: true,
  order: 5,

  idea: [
    'In Settings you connect **your own GitHub token** (a classic PAT with the single `gist` permission), and OG-E keeps your locally-collected data in a **private gist that belongs to you**. Every device pushes and pulls through `api.github.com` — nowhere else.',
    'Merging the two sides is **additive and local-first**: on a pull, remote entries are added to local (the newer scan wins), nothing is wholesale overwritten. Uploads are debounced by a 15-second window, so a burst of scans while scrolling the galaxy coalesces into one upload instead of a dozen.',
  ],

  value: [
    'You play on several devices, and the knowledge gathered by normal play — scan classifications, colony observations — drifts apart between them. Sync means every device sees the same merged, current picture after boot, with no manual transfer.',
  ],

  fairplay: {
    summary: [
      "Sync **never contacts the game server**. All traffic goes to a service you control (your GitHub gist), off the game's channel. That is OG-E's position in the terms of service: we only read game pages rendered in your own browser, and your data syncs through a separate channel.",
      'It is **entirely opt-in**: with no token pasted by you, nothing leaves your machine. The token holds the smallest possible permission (`gist`) and lives locally. Only your own data, gathered by playing, is synced — there is no background game tracking.',
    ],
  },

  details: [
    'Secrets (the GitHub token, the ntfy token) never enter the synced file or an export.',
    "On GitHub rate-limit errors (403/429) the module backs off and does not hammer the API pointlessly — it stays inside GitHub's 5000 req/h budget.",
  ],

  screenshots: [
    { id: 'settings', caption: 'The GitHub token field in OG-E Settings — sync is opt-in.' },
    { id: 'merge', caption: 'Two devices see the same current data picture after merging.' },
  ],

  codeRefs: [
    'src/sync/gist.js',
    'src/sync/scheduler.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
