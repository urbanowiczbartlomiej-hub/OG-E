// @ts-check

// EN mirror of ../send-expedition.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'send-expedition',
  category: 'fab',
  locale: 'en',

  name: 'Send expedition',
  oneLiner:
    'Sending hundreds of expeditions from many planets every day? Now you do it with one big, comfortable FAB button, with an automatic jump to the next planet.',
  flagship: true,
  order: 2,

  idea: [
    'The **Expeditions** button detects whether you are on the fleet page — if not, it takes you there. The next tap requires an expedition set-up in **AGR**. The fleet composition, target and mission type are decided by the AGR routine — OG-E merely presses the right native game button at the right moment. If the AGR expedition routine does not allow an expedition to be sent, the button reacts accordingly.',
    'The button **moves on to the next** planet with a free slot by itself, until the limits are exhausted. It skips the ones it has already sent an expedition from, and jumps to the next one if the fleet is not sufficient.',
    'You can **long-press** the button to explicitly skip the active planet and jump to the next one.',
    'In practice the whole round is a rhythm of **two taps per expedition**: the first opens the fleet page of the right planet, the second sends. 30 taps = 15 expeditions sent — and all that without aiming at tiny native buttons.',
  ],

  value: [
    'Without it, sending expeditions from a dozen-odd planets is dozens of precise clicks on a tiny native button. Here you do the whole round with your thumb, without even remembering which planets you have already covered.',
  ],

  fairplay: {
    summary: [
      'OG-E **sends the game no requests**: it clicks the AGR routine and the native "send" button — the same elements you would press yourself. The dispatch is done by the game, after your tap. The composition and target of the expedition are set by AGR, not OG-E.',
      'The automatic jump to the next planet only hints to the game which page to show after a dispatch — it generates no traffic of its own to the server.',
    ],
  },

  details: [
    'Auto next planet — automatically open the next planet after a dispatch (you can turn this off in settings).',
    'Max/planet — cap on simultaneous expeditions per planet (1 or 2).',
  ],

  screenshots: [
    { id: 'button', caption: 'The "Expeditions" module — label depends on the page (Exped / Send).' },
  ],

  codeRefs: [
    'src/features/sendExpedition/index.js',
    'src/bridges/expeditionRedirect.js',
    'src/domain/fleetOwnership.js',
  ],

  status: 'drafted',
};
