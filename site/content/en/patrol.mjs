// @ts-check

// EN mirror of ../patrol.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'patrol',
  category: 'spyglass',
  locale: 'en',

  name: 'Patrol',
  oneLiner:
    'A card on the Spy tab watching your grounds: what is catchable to strike right now, and whether your observation coverage is healthy.',
  order: 7,

  idea: [
    "Patrol treats your colonies as a **coverage lattice** and looks at every system within ±a few systems of your bodies (same galaxy, honouring the map wrap). The card answers two questions: **what is catchable right now** in the grounds (the strike list — the same signals the Spy OG-E button flags) and **whether coverage is healthy** (how many systems have a fresh, stale, or no look).",
    'A neighbour on the strike list is promoted onto the watch-list with one tap (patrol → star → snipe). The card only shows while a patrol radius is set — at zero there is no UI at all.',
  ],

  value: [
    "The watch-list is the sniper's tool — one player, worked over. Patrol is the territorial predator's: the prey is whoever nearby slips (a returning fleet-save on a forgetful neighbour's moon), not a name hunted for months. The card shows whether the grounds are actually being walked.",
  ],

  fairplay: {
    summary: [
      "Everything stays **passive and propose-only**. Patrol looks are your own galaxy browsing (undetectable), and a strike is still one deliberate tap per probe — OG-E sends nothing itself, it initiates a native click in the game's galaxy view.",
      'The card is computed **from data OG-E already holds** — your scans and the public API read while a game tab is open. The grounds are a finite set of systems, so recording is bounded by nature. The card sends nothing; it only shows intel and has no "send-all" control.',
    ],
  },

  details: [
    'The patrol radius (in systems) is one knob, set on the Spy tab; 0 = patrol off.',
    'Noise filters strip out self, vacation/banned/admin, buddies, your own alliance, and noob-protected players.',
  ],

  screenshots: [
    { id: 'card', caption: 'The Patrol card on the Spy tab with the strike list and coverage summary.' },
    { id: 'watch', caption: 'Promoting a neighbour onto the watch-list with a single "star" tap.' },
  ],

  codeRefs: [
    'src/features/dashboard/patrol.js',
    'src/domain/patrol.js',
  ],

  status: 'drafted',
};
