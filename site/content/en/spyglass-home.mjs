// @ts-check

// EN mirror of content/spyglass-home.mjs — same feature, same sections.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-home',
  category: 'spyglass',
  locale: 'en',

  name: 'Your neighbours',
  oneLiner:
    'Tells you who has just moved into the systems where you have planets — and who already sits next to you in several places at once.',
  flagship: true,
  order: 6,

  idea: [
    'Every time you look at the Galaxy, OG-E compares the system with what it saw before. When someone new shows up in a system with your planet or moon, **Your neighbours** lights up in Spyglass with a count of new arrivals.',
    'One row per neighbour, the colour is their **Danger**. If a player sits in several of your systems, the row shows **×N** — and that is what matters most: someone in three of your systems can hit three places with almost no flight time.',
    'The Spyglass button suggests your own systems to look at — once a day by default — and after the round shows **Home** if there are new neighbours.',
  ],

  value: [
    'A dangerous neighbour right next to your moon does not show up in any ranking. You find out before you lose a fleet, not from the combat report.',
  ],

  fairplay: {
    summary: [
      'OG-E detects new neighbours only from **your own browsing of the Galaxy**; the public OGame API fills in the list. Nothing is checked in the background.',
      'The feature only informs — there is no in-game action in it. Your alliance and buddies do not count as a threat.',
    ],
  },

  details: [
    'Set how often with the **Neighbours** field in the Spyglass settings (in hours, `0` = off).',
    'The first look at a system only remembers the state — you will not be flooded with "new" neighbours on day one.',
    'The NEW flag goes out a day after you see it (after 7 days at the latest).',
  ],

  screenshots: [
    { id: 'card', caption: 'The "Your neighbours" panel in Spyglass — new arrivals and neighbours present in several of your systems.' },
  ],

  demo: {
    id: 'home-watch',
    caption: 'The real OG-E component on made-up data. Edge colour = Danger, `×N` = in how many of your systems this player sits.',
  },

  codeRefs: [
    'src/domain/homeWatch.js',
    'src/features/homeWatch/index.js',
    'src/state/homeWatch.js',
    'src/features/dashboard/homeWatch.js',
  ],

  status: 'drafted',
};
