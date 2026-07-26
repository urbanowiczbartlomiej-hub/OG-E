// @ts-check

// EN mirror of ../discover-lifeforms.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'discover-lifeforms',
  category: 'fab',
  locale: 'en',

  name: 'Lifeform discovery',
  oneLiner:
    'One button that knows where the nearest undiscovered system is and lets you discover it with a single tap, so you can easily gather lifeform artifacts.',
  flagship: true,
  order: 4,

  idea: [
    'The **Lifeforms** button walks you through discovering systems: it points to the **nearest undiscovered** system, moves the view there and lets you discover it with a single tap. It skips recently discovered systems so you do not waste an action — and comes back to them once they are available again.',
    'On top of that, when you visit the lifeform research page, it reads how many artifacts you currently have, and if you have not been there in a while it suggests going there. All to remind you that you already have 3600 of them or more.',
  ],

  value: [
    'By hand it is a tedious sweep of the galaxy looking for what is still undiscovered — the button takes that navigation off your hands and keeps you from clicking systems you have already discovered. It is also convenient on mobile.',
  ],

  fairplay: {
    summary: [
      'OG-E **does not initiate a discovery itself** — it clicks the native "discover system" button, only when you tap it, and the game sends the fleet, exactly as with your own manual click.',
      'The artifact counter is read **only from what the game already displays**, during your natural visit to the research page — with no background queries.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'The "Lifeforms" button in the galaxy view — ready to discover the current system.' },
    { id: 'sent-count', caption: 'The signal for 8 discovery missions sent.' },
  ],

  codeRefs: [
    'src/features/sendLifeform/index.js',
    'src/bridges/systemDiscoveryObserver.js',
    'src/state/lifeformArtifacts.js',
  ],

  status: 'drafted',
};
