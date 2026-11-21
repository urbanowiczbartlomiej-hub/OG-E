// @ts-check

// EN mirror of ../event-menu-highlight.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'event-menu-highlight',
  category: 'game-ui',
  locale: 'en',

  name: 'Event pulse',
  oneLiner:
    'Highlights temporary events in the left menu, which look like regular entries and are easy to miss.',
  order: 4,

  idea: [
    'Every now and then the game adds temporary events to the left menu (e.g. rewards, the artifact shop). They look exactly like the permanent entries, so they blend in. **Event pulse** animates only those temporary entries.',
    'For rewards the pulse stops once everything on their page is claimed; for the artifact shop — once you have claimed every tier, until the event ends.',
  ],

  value: [
    'You do not miss an event day, so you do not lose rewards.',
  ],

  fairplay: {
    summary: [
      'It is only a **visual highlight of an existing menu entry** — nothing is hidden or covered.',
      'OG-E reads the "claimed" state from the event page you open yourself — nothing is checked in the background.',
    ],
  },

  details: [
    'On by default; switch it off with the "Event pulse" tile in OG-E Settings.',
  ],

  screenshots: [
    { id: 'menu', caption: 'A pulsing temporary event entry in the left menu.' },
  ],

  codeRefs: [
    'src/features/eventMenuHighlight.js',
    'src/features/rewardingWatcher.js',
  ],

  status: 'drafted',
};
