// @ts-check

// EN mirror of ../big-colony-hunting.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'big-colony-hunting',
  category: 'fab',
  locale: 'en',

  name: 'Colony hunting (+ abandoning small ones)',
  oneLiner:
    'One button points to the next-best free slot on the whole server and sends a colony ship — a second helps you abandon colonies that came out too small.',
  flagship: true,
  order: 3,

  idea: [
    'The **Colonisation** module points to the **next-best free slot** across the whole universe (per your position and galaxy preferences) and sends a colony ship there — skipping spots the game has just flagged as occupied. An "N free" counter shows live how many of your chosen positions are still open.',
    'It comes with an **Abandon colony** module: it catches a freshly settled planet that is **too small** and walks you through abandoning it, so you can try elsewhere. A slot once abandoned never returns as a suggestion on any of your devices.',
  ],

  value: [
    'Hunting for big colonies otherwise means combing galaxies by hand, watching the gaps between landings and abandoning the misses. This duo runs the whole cycle: find a free spot → send → if too small, abandon and keep trying.',
  ],

  details: [
    "Free spots come from **OGame's public API** (the server's map of occupied planets) — candidate data, confirmed against the live galaxy view before a colony ship flies.",
    'The button watches the minimum gap between landings — if the next one would fall too close, it shows "Wait Ns".',
    'The landing countdown runs on server time and offers a refresh itself once the new colony is there.',
  ],

  fairplay: {
    summary: [
      'OG-E **sends the game no requests** — it clicks the native send and abandon elements, exactly the ones you would press yourself. The planet size for the abandon decision is read from the **already displayed** overview, with no extra query.',
      'The free-spot data comes from a **public, statistical API** (the same one community tools use) — that is, the server occupancy map, not any background mass scanning. Without that data the button only works on what you have scanned yourself by playing normally.',
    ],
  },

  settings: [
    'Target positions, foreign-galaxy preference, minimum landing gap, "too small a colony" threshold (per-universe config in the Dashboard).',
    'Password for abandoning colonies (required by the Abandon module).',
  ],

  screenshots: [
    { id: 'n-free', caption: 'The "Colonisation" module with an "N free" counter — how many chosen positions are still open.' },
    { id: 'abandon', caption: 'The "Abandon colony" module on the overview of a too-small, fresh colony.' },
  ],

  codeRefs: [
    'src/features/sendColony/index.js',
    'src/features/abandon/index.js',
    'src/domain/apiOccupancy.js',
    'src/domain/galaxyScanConfig.js',
  ],

  status: 'drafted',
};
