// @ts-check

// EN mirror of ../spyglass-map.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-map',
  category: 'spyglass',
  locale: 'en',

  name: 'Position map and reach',
  oneLiner:
    'Your planets and those of watched players on one map — marking the ones from which you can be reached in under 8 hours.',
  order: 6,

  idea: [
    'The **Positions map** card is the server from above: rows are galaxies, systems run across. A dot is a planet — the more dangerous the player, the bigger it is. Your planets are white. A tap shows the name and coordinates, a second one opens the player\'s dossier.',
    'The **who can reach you (≤8 h)** toggle marks planets from which any of your planets can be reached within **8 hours even with the slowest fleet**, and shows the flight time.',
  ],

  value: [
    'A dangerous player on the far side of the server is a theoretical problem. An average one three systems away is a practical one. The map shows it in a second: for fleet-saves, picking targets and placing a new colony.',
  ],

  fairplay: {
    summary: [
      'Positions come from the **server\'s public map**, and flight times are arithmetic on the game\'s rules. The map sends nothing.',
    ],
  },

  details: [
    'The map shows planets only — yours and watched players\' (no moons).',
    'Player chip: colour, hide from map (eye) or stop watching (cross). The **You** chip hides your own planets.',
  ],

  screenshots: [
    { id: 'positions', caption: 'The position map: a dot per planet, size grows with threat, your planets in white.' },
    { id: 'chips', caption: 'Player chips and the "who can reach you (≤8 h)" toggle.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/dashboard/mapPrimitives.js',
    'src/domain/geometry.js',
  ],

  status: 'drafted',
};
