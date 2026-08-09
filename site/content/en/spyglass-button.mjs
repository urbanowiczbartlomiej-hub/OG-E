// @ts-check

// EN mirror of ../spyglass-button.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-button',
  category: 'fab',
  locale: 'en',

  name: 'Spyglass (the button)',
  oneLiner:
    'The Spyglass orb on the FAB walks you through the galaxy and suggests who to look at and who to send a probe to.',
  order: 7,

  idea: [
    'Spyglass is one of the orbs on the OG-E button. It invents nothing on the spot — **it works exactly according to the settings in the Spyglass tab in the Dashboard**: that is where you keep the list of watched players, the re-scan deadlines, and whether you care about planets, moons, or both.',
    'In game the button reduces that to a single tap: it helps you **watch the galaxy** (offering the next system worth a look) and **send spy probes** where the data has gone stale. The next tap leads to the next target on the list.',
  ],

  value: [
    'Without it, intelligence means clicking through the galaxy by hand and remembering who you looked at and when. The button turns that into a rhythm of taps, and makes the whole "what next" decision from the settings you defined once.',
  ],

  details: [
    'Each intelligence feature — the threat ranking, the dossier, the routine, the map, the patrol — has its own description in the "Spyglass — intelligence" chapter.',
    'You turn the orb on and off like any other: with a tile on the button bar in the OG-E Settings.',
  ],

  fairplay: {
    summary: [
      'The button **sends the game no requests** — it clicks the native galaxy-view elements and the native probe dispatch, exactly the ones you would press yourself. You set the pace: there is no loop running in the background or without your tap.',
      'Everything the button knows comes from the screens you opened yourself and from the settings you saved in the Dashboard.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'The Spyglass orb on the OG-E button — it suggests the next look at the galaxy or a probe to send.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
