// @ts-check

// EN mirror of ../planet-markers.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'planet-markers',
  category: 'game-ui',
  locale: 'en',

  name: 'Planet markers',
  oneLiner:
    "Tiny status dots next to every planet and moon in the left-hand bar — see at a glance where an expedition is flying, where a fleet-save sits, and where an attack is inbound.",
  order: 3,

  idea: [
    "Each body in the planet bar gets up to three small markers, one per category, ranked by priority: an inbound attack (a red square — the only 'foreign' shape, everything else is yours), your own outgoing aggression, a fleet-save in flight or landed and exposed, an expedition, logistics (transport / deployment / ACS defend), and recycling. Markers are dots with no count and no direction — a glanceable 'something is happening here', not a readout to click.",
    "Everything is computed from what the game already displays on the event list and planet bar — no extra request goes to the server. A '?' icon above the planet list reveals the legend on hover/tap.",
  ],

  value: [
    "Without markers, the only way to know what is happening on which planet is opening the event list and counting in your head. Markers move that state to where you're already looking — the planet bar — so a glance replaces a separate check.",
  ],

  fairplay: {
    summary: [
      "Purely **cosmetic styling of DOM the game already renders** — the source is the game's own event list (`#eventContent`) and planet bar (`#planetList`), both already in front of you. Zero requests of its own, zero background polling.",
      'Markers only **display**, they propose nothing and send nothing — there is no action to click here.',
    ],
  },

  details: [
    'The legacy settings key is "expeditionBadges" — a name from when the marker only showed expeditions; it now covers every mission category.',
    'Toggled in the OG-E Settings panel, the "Planet markers" tile.',
  ],

  screenshots: [
    { id: 'legend', caption: "The marker legend under the '?' icon above the planet list." },
  ],

  codeRefs: [
    'src/features/badges/index.js',
    'src/features/badges/pure.js',
    'src/state/fleetSaveSet.js',
  ],

  status: 'drafted',
};
