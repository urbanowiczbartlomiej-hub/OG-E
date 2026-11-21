// @ts-check

// EN mirror of ../spyglass.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass',
  category: 'spyglass',
  locale: 'en',

  name: 'Spyglass — intelligence',
  oneLiner:
    'Intel on the server\'s players in one place: who is dangerous, who is worth attacking, where the resources are and when the owner is away.',
  flagship: true,
  order: 1,

  idea: [
    'Spyglass gathers knowledge in two ways: a **look** at a system in the Galaxy (free, the target sees nothing) and an **espionage probe** (the report shows fleet, defence and resources, but the target knows). It is built around the **watch list** — plus your own surroundings (**Neighbours**, **Patrol**).',
    'In the game, the **Spyglass button** suggests one next action. In the Dashboard, the **Spyglass** tab is the reading room: player ranking, dossier, map, neighbours and "who is spying on you". The ranking works from the first run — from the server\'s public statistics.',
  ],

  value: [
    'Instead of a hundred espionage reports in your inbox and a notebook of coordinates — ready answers to six questions (below). The following pages of this chapter cover each one.',
  ],

  fairplay: {
    summary: [
      'Spyglass uses the **server\'s public statistics**, **game pages you opened yourself** and **your own espionage reports** (optionally also data shared by alliance-mates). Without the game open, nothing happens.',
      'The Dashboard tab **has no send button at all**. You send a probe only from the game, with the Spyglass button, always at one body. There is no "scan everything".',
    ],
  },

  details: [
    '**Whom to avoid, whom can I attack?** — the threat ranking (Danger).',
    '**What to check next?** — the Look / Spy / Strike button.',
    '**Is it worth attacking, and where are the resources?** — the player dossier.',
    '**When is he away?** — routine and offline windows.',
    '**Who can reach me?** — the position map and reach.',
    '**Who is spying on me, and who lives next door?** — "Who is spying on you" and "Your neighbours".',
  ],

  screenshots: [
    { id: 'tab', caption: 'The Spyglass tab: watch list, scan settings and the player ranking.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/sendSpy/index.js',
    'src/domain/spyScan.js',
    'src/state/watchList.js',
  ],

  status: 'drafted',
};
