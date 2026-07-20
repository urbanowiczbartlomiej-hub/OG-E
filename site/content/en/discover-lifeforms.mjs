// @ts-check

// EN mirror of ../discover-lifeforms.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'discover-lifeforms',
  category: 'fab',
  locale: 'en',

  name: 'Lifeform discovery',
  oneLiner:
    'One button finds the nearest undiscovered system by itself and lets you discover it with a single tap — hunting for lifeform artifacts.',
  flagship: true,
  order: 4,

  idea: [
    'The **Lifeforms** module walks you through discovering systems: it points to the **nearest undiscovered** system, moves the view there and lets you discover it with a single tap. It skips recently discovered systems so you do not waste an action.',
    'On top of that, when you visit the lifeform research page, it shows how many artifacts you have already gathered — a signal for when it is worth spending them.',
  ],

  value: [
    'Discovering systems yields **lifeform artifacts** for research. By hand it is a tedious sweep of the map looking for what is still undiscovered — the button takes that navigation off your hands and keeps you from clicking systems on cooldown.',
  ],

  fairplay: {
    summary: [
      'OG-E **does not initiate a discovery itself** — it clicks the native "discover system" button, and the game sends the fleet, exactly as with your own manual click.',
      'The artifact counter is read **only from what the game already displays**, during your natural visit to the research page — with no background queries.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'The "Lifeforms" module in the galaxy view — ready to discover the current system.' },
    { id: 'artifact-cap', caption: 'The gathered-artifacts signal — time to check lifeform research.' },
  ],

  codeRefs: [
    'src/features/sendLifeform/index.js',
    'src/bridges/systemDiscoveryObserver.js',
    'src/state/lifeformArtifacts.js',
  ],

  status: 'drafted',
};
