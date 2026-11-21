// @ts-check

// EN mirror of ../patrol.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'patrol',
  category: 'spyglass',
  locale: 'en',

  name: 'Patrol',
  oneLiner:
    'Guards the area around your planets: shows who nearby is worth checking right now, and how long ago you looked.',
  order: 7,

  idea: [
    'You set a radius, e.g. **± 3 systems** around your planets (in the same galaxy). The **Patrol** card in Spyglass then shows two things: **moon opportunities** nearby (per the **Moon strike** setting) and how many occupied systems have a **fresh, stale or no** look.',
    'The Spyglass button walks you around that area (label **patrol (N)**). An interesting neighbour goes onto your watch list with one tap (**+ watch**).',
  ],

  value: [
    'The watch list is for hunting one specific player. Patrol is for guarding your own turf — the prey is anyone nearby who slips up.',
  ],

  fairplay: {
    summary: [
      'Patrol **only suggests**. Looks are your own Galaxy browsing, and a probe flies only after your tap — through the native fleet form.',
      'The card uses only data OG-E already has: your own looks and the public OGame API. There is no "send to everyone" button.',
    ],
  },

  details: [
    'Set the radius in the Spyglass settings (**Patrol ± N sys**); `0` = off (the default).',
    'A look counts as fresh according to the **Re-look** setting.',
    'Skipped: players in vacation mode, banned, admins, under newbie protection, your alliance and buddies.',
  ],

  screenshots: [
    { id: 'card', caption: 'The Patrol card: opportunities nearby and the state of your looks (fresh / stale / none).' },
  ],

  codeRefs: [
    'src/features/dashboard/patrol.js',
    'src/domain/patrol.js',
  ],

  status: 'drafted',
};
