// @ts-check

// EN mirror of ../best-colony-spots.mjs. Code discovery lives in the PL base file.
// Marketing name "Best Colony Spots" — the code's own UI label is "Colony Scout".

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'best-colony-spots',
  category: 'dashboard',
  locale: 'en',

  name: 'Best Colony Spots — the best places for colonies',
  oneLiner:
    'A Dashboard analysis that scores the players in a galaxy and tells you where to settle in line with your strategy (safe, farm, pvp).',
  flagship: true,
  order: 2,

  idea: [
    'Best Colony Spots computes four independent channels for every neighbourhood: **safety** (the less hostile-fleet reach, the better), **farm** (how much inactive loot sits within reach), **room** (how many free slots remain in the window), and **target** (active-player density — PvP opportunity). You pick one of three ready-made profiles — **Safe zone**, **Farm hub**, **PvP zone** — each simply a different weighting of the same four numbers, so the result stays comparable across profiles and universes.',
    'Two list modes answer two different questions. **Best spots** scores the area around every system where AT LEAST ONE selected slot is free — a quick "where is anything open". **Longest streaks** hunts contiguous runs where EVERY selected slot is empty — for several colonies close together. The data is fetched from the **public OGame API** and refreshed once a week.',
  ],

  value: [
    'Browsing galaxies by hand for a good neighbourhood means hours of scrolling and guessing "is it safe here". Best Colony Spots turns that into one sorted list led by your own criterion — and because it scores from the same data behind the server heat map, the ranking and the map colours always say the same thing.',
  ],

  fairplay: {
    summary: [
      'This is purely an **analysis of data we get from a publicly available API** (the same source community tools use).',
      "The output is **purely informational** — a list and a heat map, with no send button. You decide where to colonise; sending the colony ship itself happens in the Colonisation FAB module through the game's own native form.",
    ],
  },

  details: [
    'The three profiles — Safe zone / Farm hub / PvP zone — are ready-made weights; you do not have to tune any slider by hand to get a sensible ranking.',
    'You say which slots interest you, and the algorithm looks for free positions among them.',
    'The map has two modes: **Threat / farm** sums and averages to build the temperature of an area, while **Occupancy** shows each position separately — a player, a farm, or empty space.',
  ],

  screenshots: [
    { id: 'settings-map', caption: 'The analysis settings (profile, slots, ranges) and the server map in Occupancy mode.' },
    { id: 'spot-details', caption: 'Details of a proposed spot: the system window, population, threats, and the most dangerous neighbours.' },
  ],

  codeRefs: [
    'src/domain/zoneScore.js',
    'src/domain/regions.js',
    'src/domain/heatField.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
