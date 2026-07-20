// @ts-check

// EN mirror of ../send-expedition.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'send-expedition',
  category: 'fab',
  locale: 'en',

  name: 'Send expedition',
  oneLiner:
    'Daily expeditions from many planets as a series of taps on one big button, with an automatic jump to the next planet.',
  flagship: true,
  order: 2,

  idea: [
    'The **Expeditions** module turns your daily expedition round into a series of taps on one big button. The fleet composition, target and mission type are decided by the **AGR** routine you run anyway — OG-E merely presses the right native game button at the right moment.',
    'Once you have sent as many expeditions from a planet as you want, the button **moves on to the next** planet with a free slot by itself — until the limits are exhausted.',
  ],

  value: [
    'Without it, sending expeditions from a dozen-odd planets is dozens of precise clicks on a tiny native button. Here you do the whole round with your thumb, without even remembering which planets you have already covered.',
  ],

  fairplay: {
    summary: [
      'OG-E **sends the game no requests**: it clicks the AGR routine and the native "send" button — the same elements you would press yourself. The dispatch is done by the game, after your tap. The composition and target of the expedition are set by AGR, not OG-E.',
      'The automatic jump to the next planet only hints to the game which page to show after a dispatch — it generates no traffic of its own to the server. The button never moves anyone else\'s fleet, nor a manually armed one.',
    ],
  },

  settings: [
    'Auto next planet — automatically open the next planet after a dispatch (opt-out).',
    'Max/planet — cap on simultaneous expeditions per planet (1 or 2).',
  ],

  screenshots: [
    { id: 'button', caption: 'The "Expeditions" module — label depends on the page (Exped / Send).' },
    { id: 'auto-next', caption: 'Automatic jump to the next planet with a free slot after a dispatch.' },
  ],

  codeRefs: [
    'src/features/sendExpedition/index.js',
    'src/bridges/expeditionRedirect.js',
    'src/domain/fleetOwnership.js',
  ],

  status: 'drafted',
};
