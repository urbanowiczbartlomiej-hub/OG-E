// @ts-check

// EN mirror of ../spyglass-danger.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-danger',
  category: 'spyglass',
  locale: 'en',

  name: 'Threat ranking (Danger)',
  oneLiner:
    'The whole server in one table, most dangerous first: a 0–100 number tells you whom not to mess with and whom you can attack.',
  flagship: true,
  order: 2,

  idea: [
    'The **Players** table sorts the server by the **Danger** column. The number does not measure points but **how much of them can fly at you**: defence does not attack, so OG-E separates it from the fleet, checks whether the fleet is cargo or warships, and adds signs of aggression (destruction, bandit, colony spread, alliance class).',
    'The **Fleet** column shows **≤** — an upper bound, not a measurement. Once you have scanned all of a player\'s bodies, the sign goes away and the exact number stays.',
  ],

  value: [
    'The highscore misleads: a player with a mountain of defence looks more dangerous than the one who can actually destroy your fleet. Danger tells them apart — for the whole server, before your first probe.',
  ],

  fairplay: {
    summary: [
      'It is **arithmetic on the server\'s public statistics** — the same ones community tools use.',
      'The table sends nothing. **+ watch** only adds the player to your own watch list.',
    ],
  },

  details: [
    'Anyone with at least one ship scores at least 8. Your alliance and buddies are marked `friendly`.',
    'The account type (e.g. `fleet-heavy`, `defence only`, `miner`) and the reasons behind the score are in the player\'s dossier.',
    'Filters: top 50 / 100 / 200 / all, **watch list**, **miners**, hide inactive, a military points range (type e.g. `15M` or `2.5b`). The search finds players by name, alliance and tag.',
  ],

  screenshots: [
    { id: 'players', caption: 'The player ranking sorted by Danger — next to it the fleet upper bound, military points and ship type.' },
    { id: 'breakdown', caption: 'The score breakdown in the dossier: where the number comes from.' },
  ],

  codeRefs: [
    'src/domain/dangerScore.js',
    'src/domain/dangerJoin.js',
    'src/domain/players.js',
    'src/features/dashboard/targets.js',
  ],

  status: 'drafted',
};
