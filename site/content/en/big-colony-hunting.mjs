// @ts-check

// EN mirror of ../big-colony-hunting.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'big-colony-hunting',
  category: 'fab',
  locale: 'en',

  name: 'Colonisation (hunting for big colonies)',
  oneLiner:
    'One button points to the next-best free slot on the whole server and sends a colony ship — a second helps you abandon colonies that came out too small.',
  flagship: true,
  order: 3,

  idea: [
    'The **Colonisation** module points by itself to the next-best free slot in the whole universe (according to your preferences for positions and galaxies) and sends a colony ship there. It detects when a position is already taken and lets you set the next coordinates. Its "N free" counter shows live how many of your chosen positions are still open. Thanks to the minimum-gap counter between landing times, you can send dozens of missions one after another while keeping the time you need to abandon a colony that turns out too small.',
    'The rhythm is simple: **two taps is one colonisation mission sent** — 40 taps = 20 missions flying one after another. **Three taps** are enough to abandon a colony that turned out too small.',
    'The button is paired with an **Abandon colony** button. It detects colonisation missions about to land and offers to move to the new colony. It checks its size and runs the process of abandoning it if it is too small. That way the next colonisation mission can land just seconds later. Once abandoned, a slot only returns to the colonisation candidates after at least 24h (overnight, per the game rules).',
  ],

  value: [
    'Finding a big colony takes many colonisation attempts (hundreds, even). That means combing the galaxy for free slots — and that data is available from a free API. To send a whole wave of missions you must watch the gaps between landings and abandon the misses as fast as possible. This pair of buttons does that for you and runs the whole cycle, keeping it comfortable. You just tap.',
  ],

  fairplay: {
    summary: [
      'OG-E **sends the game no requests** — it clicks the native send and abandon elements, exactly the ones you would press yourself.',
      'The free-spot data comes from a **public, statistical API** (the same one community tools use) — that is, the server occupancy map. We combine it with our own data about abandonments and refresh it once a week.',
    ],
  },

  details: [
    "Free spots come from **OGame's public API** (the server's map of occupied planets) — candidate data, confirmed against the live galaxy view before a colony ship flies.",
    'The button watches the minimum gap between landings — if the next one would fall too close, it shows "Wait Ns".',
    'The landing countdown runs on server time and offers a refresh itself once the new colony is there.',
    'Target positions, foreign-galaxy preference, minimum landing gap, "too small a colony" threshold (per-universe config in the Dashboard).',
    'Password for abandoning colonies (required by the Abandon module).',
  ],

  screenshots: [
    { id: 'n-free', caption: 'The "Colonisation" module with an "N free" counter — how many chosen positions are still open.' },
    { id: 'wait', caption: 'The "Colonisation" module with an "N" second counter, ticking down the gap between sending consecutive colony ships.' },
    { id: 'landing-soon', caption: 'The "Abandon colony" module when in a few seconds you need to refresh the page to check whether the new colony is large.' },
    { id: 'landed', caption: 'The "Abandon colony" module when the colony ship has landed and the page needs a refresh.' },
    { id: 'abandon', caption: 'The "Abandon colony" module makes giving up a too-small new colony easy.' },
    { id: 'delete-confirm', caption: 'The "Abandon colony" module when you want to confirm giving up the colony for good.' },
    { id: 'settings', caption: 'The "Colonisation" module — settings for which planets to colonise and when to abandon them.' },
  ],

  codeRefs: [
    'src/features/sendColony/index.js',
    'src/features/abandon/index.js',
    'src/domain/apiOccupancy.js',
    'src/domain/galaxyScanConfig.js',
  ],

  status: 'drafted',
};
