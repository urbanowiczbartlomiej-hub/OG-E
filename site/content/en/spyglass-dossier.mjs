// @ts-check

// EN mirror of ../spyglass-dossier.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-dossier',
  category: 'spyglass',
  locale: 'en',

  name: 'Player dossier',
  oneLiner:
    'The expanded row of a player: a one-sentence verdict, the danger-score breakdown and a table of all his bodies with scan age, defence, fleet and loot history.',
  order: 4,

  idea: [
    'The left column is **judgement**. A header like `loaded · heavily defended · loot ~16.27B · scan 25h old` sums up the situation, and one sentence below it says what to do about it. Then comes the danger-score breakdown and the most interesting arithmetic: public military points **minus** the defence and fleet your reports have seen leaves **a remainder nobody can see** — that is the fleet in the air, usually on a fleet-save. Until you have the complete set of bodies, that number is marked as provisional.',
    'The right column is **evidence**: one row per body (moons indented under their planet) with the age of your scan, the last interaction, defence, visible fleet, and the average and peak loot you have ever found there. A star marks the body with the largest visible fleet, a vault marker the home planet. Chips in the header say how many planets and moons you already have scanned and what is missing for a complete picture.',
  ],

  value: [
    'This is where you make the call: hit or pass, and if hit, which body. Instead of clicking through twenty reports from different weeks and doing the maths in your head, you get one table with history — you see not only what sits there today but also what *usually* sits there and where this player really keeps his wealth.',
  ],

  fairplay: {
    summary: [
      'Every hard number — defence, fleet, resources, loot — comes **exclusively from spy reports you opened yourself**. The dossier does not acquire them: it remembers and organises them so you do not have to keep a notepad. The rest is arithmetic over public points and over your own browsing of the galaxy.',
      'The dossier is a **reading room**: it holds no send button. The only thing you can "fire" from it is marking a body as due for a refresh — the probe itself you send deliberately, from the game.',
    ],
  },

  details: [
    'Loot is the **single best planet** from the freshest report, run through the plunder percentage — never the sum of a whole empire, because a single raid takes from one body anyway.',
    'The verdicts it can reach: `RAID NOW`, `loaded · fleet risk`, `loaded · heavily defended`, `skip — empty`, `scan first`, `can\'t hit`, `friendly`.',
    '`Civil baseline` compares the player against the server median of "how many ships a builder with this economy has"; the surplus is a combat-fleet ceiling. It deliberately **does not feed** the danger score — it is a separate, more cautious hint.',
    'A complete set of scans (planets **and** moons) turns the fleet estimate into an exact number and drops the `≤` sign in the ranking.',
    'The `Watch via galaxy | probes` toggle and the per-body toggle let you cut out of the scan plan whatever you do not want to touch with probes.',
  ],

  demo: {
    id: 'dossier',
    caption: 'The real dossier, expanded under a player\'s row, over invented data. The coverage line says how many of their bodies you have actually seen (3/5 — so the fleet figure is an UPPER BOUND, not a measurement), the danger breakdown spells out every signal, and the body table carries scan age, defence, visible fleet and loot.',
  },

  screenshots: [
    { id: 'bodies', caption: 'The body table: scan age, last interaction, defence, visible fleet and average plus peak loot — moons under their planets.' },
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
