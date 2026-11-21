// @ts-check

// EN mirror of ../anti-flicker-background.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'anti-flicker-background',
  category: 'other',
  locale: 'en',

  name: 'No white flash',
  oneLiner:
    'Removes the white flash on every game page reload — especially tiring in the evening and on a phone.',
  order: 3,

  idea: [
    'OGame reloads the page on almost every click. For a moment before the game is drawn, the browser paints a white background — on a dark theme that is a flash in your eyes. OG-E puts a black background there for that moment and removes it once the game has loaded.',
  ],

  value: [
    'Dozens of reloads a day means dozens of flashes fewer. Always on — nothing to switch.',
  ],

  fairplay: {
    summary: [
      'It is one **temporary background style** while the page loads. Nothing in the game is changed or hidden.',
    ],
  },

  screenshots: [
    { id: 'compare', caption: 'A page reload with and without OG-E.' },
  ],

  codeRefs: [
    'src/features/antiFlickerBackground.js',
  ],

  status: 'drafted',
};
