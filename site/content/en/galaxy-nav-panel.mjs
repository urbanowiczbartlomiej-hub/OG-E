// @ts-check

// EN mirror of ../galaxy-nav-panel.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'galaxy-nav-panel',
  category: 'other',
  locale: 'en',

  name: 'Galaxy navigation buttons',
  oneLiner:
    'Big, thumb-friendly galaxy and system buttons — instead of the tiny native ones.',
  order: 1,

  idea: [
    'The native galaxy and system arrows and the Phalanx / Spy / Discovery buttons are tiny, especially on a phone. OG-E replaces them with a **big panel**: **−/+** for galaxy and system, **Start** in the middle, and the less-used Phalanx / Spy / Discovery can be folded away.',
    'The panel sits **below the table** (default) or **above it** — the **BTM / TOP / BOTH** switch in the foldable row; BOTH also keeps the game\'s native header.',
  ],

  value: [
    'You browse the Galaxy with your thumb, without zooming in every time you want to change the system.',
  ],

  fairplay: {
    summary: [
      'Every panel button **clicks the same native game element** you would click yourself — navigation stays under the game\'s rules.',
      'If a button is disabled in the game (e.g. no Sensor Phalanx), it is disabled in the panel too.',
    ],
  },

  details: [
    'Works together with "Readability" in OG-E Settings (on by default).',
    'Arrow keys in the Phalanx / Spy / Discovery windows move exactly one system.',
  ],

  screenshots: [
    { id: 'panel', caption: 'The panel in the TOP position: galaxy and system −/+, Start, and Phalanx / Spy / Discovery.' },
  ],

  codeRefs: [
    'src/features/galaxyNavPanel.js',
  ],

  status: 'drafted',
};
