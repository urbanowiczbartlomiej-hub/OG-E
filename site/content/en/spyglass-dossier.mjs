// @ts-check

// EN mirror of ../spyglass-dossier.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-dossier',
  category: 'spyglass',
  locale: 'en',

  name: 'Player dossier',
  oneLiner:
    'Everything about one player: a one-line verdict, where the threat score comes from, and a table of their planets and moons with defence, fleet and resources.',
  order: 4,

  idea: [
    'On the left, the **verdict** — e.g. `loaded · heavily defended · loot ~16.27B · scan 25h old` — and one sentence on what to do about it. Below, the score breakdown and an interesting number: military points **minus** what your reports have seen gives the fleet that is nowhere to be found — usually in flight, on a fleet-save.',
    'On the right, the **body table**: for every planet and moon the scan age, last activity, defence, fleet, and the average and highest resources you ever found there (**loot avg**, **peak**).',
  ],

  value: [
    'This is where you decide: attack or skip, and if attack — where. Instead of twenty espionage reports from different weeks you get one table with history.',
  ],

  fairplay: {
    summary: [
      'Defence, fleet and resources come **only from espionage reports you opened yourself**. The dossier remembers and sorts them; it gathers nothing on its own.',
      'The dossier has no send button — you send a probe deliberately from the game.',
    ],
  },

  details: [
    'The loot in the verdict is **the single richest planet** scaled by the loot rate — because one attack takes from one body.',
    'Verdicts: `RAID NOW`, `loaded · fleet risk`, `loaded · heavily defended`, `skip — empty`, `scan first`, `can\'t hit` (outside your attack range), `friendly`.',
    '**Watch via** (galaxy / probes) and the per-body probe toggle decide where probes may be sent.',
  ],

  screenshots: [
    { id: 'report', caption: 'The dossier: verdict and score on the left, all the player\'s bodies on the right.' },
    { id: 'bodies', caption: 'The body table: scan age, activity, defence, fleet, and average and highest resources.' },
  ],

  codeRefs: [
    'src/features/dashboard/dossier.js',
    'src/domain/raidVerdict.js',
    'src/domain/threatModel.js',
    'src/domain/civilBaseline.js',
    'src/domain/lootRhythm.js',
  ],

  status: 'drafted',
};
