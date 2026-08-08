// @ts-check

// EN mirror of ../anti-flicker-background.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'anti-flicker-background',
  category: 'other',
  locale: 'en',

  name: 'No white flash',
  oneLiner:
    'Kills the white flash between one page reload and the next — painful on a dark theme, especially at night, especially on Firefox mobile.',
  order: 3,

  idea: [
    "OGame reloads the entire page on nearly every action — clicking a planet, switching tabs, dispatching a mission. The browser's default white paint between closing the old page and the new page's first render reads like a flash of light on a dark theme. OG-E injects a black background before the browser has a chance to paint anything, and removes it about 300ms after the page fully loads — once the game/AGR's real background has already taken over the screen.",
  ],

  value: [
    "Dozens of reloads a day mean dozens of white flashes if you play with a dark theme — tiring on the eyes, especially at night or on a phone. This fix is invisible when it works: the flash just isn't there any more.",
  ],

  fairplay: {
    summary: [
      'This is purely **one temporary CSS style** for the duration of the page reload — nothing is hidden for longer than the first full render, and the game content underneath is not changed in any way.',
      'Zero logic beyond that — no dependencies, no requests, no state to save.',
    ],
  },

  screenshots: [
    { id: 'compare', caption: 'A page reload with and without the injected black background.' },
  ],

  codeRefs: [
    'src/features/antiFlickerBackground.js',
  ],

  status: 'drafted',
};
