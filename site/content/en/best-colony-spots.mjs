// @ts-check

// EN mirror of ../best-colony-spots.mjs. Code discovery lives in the PL base file.
// Marketing name "Best Colony Spots" — the code's own UI label is "Colony Scout".

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'best-colony-spots',
  category: 'dashboard',
  locale: 'en',

  name: 'Best Colony Spots',
  oneLiner:
    'A Dashboard analysis that scores the neighbourhoods in your scanned galaxies and tells you where to settle for safety, farming, or PvP.',
  flagship: true,
  order: 2,

  idea: [
    'Best Colony Spots computes four independent channels for every neighbourhood: **safety** (the less hostile-fleet reach, the better), **farm** (how much inactive loot sits within reach), **room** (how many free slots remain in the window), and **target** (active-player density — PvP opportunity). You pick one of three ready-made profiles — **Safe zone**, **Farm hub**, **PvP zone** — each just a different weighting of the same four numbers, so the score stays comparable across profiles and universes.',
    'Two list modes answer two different questions. **Best spots** scores the area around every system where AT LEAST ONE selected slot is free — a quick "where is anything open". **Longest streaks** hunts contiguous runs where EVERY selected slot is empty — built for landing several colonies in a row. A window with thin scan coverage is deliberately pulled toward a cautious baseline, so one lucky scan can\'t outrank a window that is fully known.',
  ],

  value: [
    'Manually browsing galaxies for a good neighbourhood means hours of scrolling and guessing "is this safe". Best Colony Spots turns that into one sorted list led by your own criterion — and because it scores from the same data behind the server heat map, the ranking and the map colours always agree.',
  ],

  fairplay: {
    summary: [
      "This is purely an **analysis of data you already have** — your own galaxy scans and, for unvisited areas, the public server-statistics API (the same source community tools use). No request goes to the game beyond what browsing the galaxy already sends.",
      'The output is **purely informational** — a list and a heat map, with no send button. You decide where to settle; sending the colony ship itself happens in the Colonisation FAB module through the game\'s own native form.',
    ],
  },

  details: [
    'The three profiles — Safe zone / Farm hub / PvP zone — are ready-made weights; there is no slider to tune by hand to get a sensible ranking.',
    'The slot range to check is given as a list or a range (e.g. "8" or "12-15").',
    'The same server-wide heat map drives both the list score and the galaxy-preview colours — one model, two views.',
  ],

  screenshots: [
    { id: 'zones', caption: 'Profile picker: Safe zone / Farm hub / PvP zone.' },
    { id: 'list', caption: 'Neighbourhood ranking in Best spots / Longest streaks mode.' },
  ],

  codeRefs: [
    'src/domain/zoneScore.js',
    'src/domain/regions.js',
    'src/domain/heatField.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
