// @ts-check

// EN mirror of ../planet-markers.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'planet-markers',
  category: 'game-ui',
  locale: 'en',

  name: 'Planet markers',
  oneLiner:
    'Tiny status dots next to every planet and moon in the right-hand bar — at a glance you see where an expedition is flying, where a fleet-save sits, and where an attack is inbound.',
  order: 3,

  idea: [
    'Each body in the planet bar gets up to three small markers, one per category, ranked by importance: an inbound attack (red **"!!!"**), your own aggression in flight, a fleet-save in flight or a fleet-save that has already landed (**"FR"** — a fleet reminder), an expedition, logistics (transport / deployment / ACS defend), and recycling. Markers are dots with no count and no direction — a "something is happening here" signal that does not spoil your nice planet skins.',
    'Everything is computed from what the game already displays on the event list — no extra request goes to the server. A "?" icon above the planet list shows the legend on hover/tap.',
  ],

  value: [
    'Without markers, the only way to know what is happening on which planet is to open the event list and spend time analysing it. Markers move that state to where you are already looking — the planet bar — so a glance replaces a separate check.',
  ],

  fairplay: {
    summary: [
      "Purely **cosmetic styling of DOM the game already renders** — the source is the game's own event list (`#eventContent`) and planet bar (`#planetList`), both already in front of you. Zero requests of its own, zero background polling.",
    ],
  },

  details: [
    'Toggled in the OG-E Settings panel, the "Planet markers" tile.',
  ],

  screenshots: [
    { id: 'legend', caption: 'The marker legend under the "?" icon above the planet list.' },
  ],

  codeRefs: [
    'src/features/badges/index.js',
    'src/features/badges/pure.js',
    'src/state/fleetSaveSet.js',
  ],

  status: 'drafted',
};
