// @ts-check

// EN mirror of ../event-menu-highlight.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'event-menu-highlight',
  category: 'game-ui',
  locale: 'en',

  name: 'Event pulse',
  oneLiner:
    'Highlights temporary event entries in the left menu that look identical to the permanent Trader/Officers/Shop items and are easy to miss.',
  order: 4,

  idea: [
    'The game occasionally inserts ephemeral entries (reward windows, contests, seasonal items) into the left toolbar under the same class the permanent, always-present Trader/Officers/Shop entries use. Looking identical, they get lost in the noise — Event pulse animates ONLY the temporary entries, so they stand out from their permanent neighbours.',
    'The pulse clears itself once every daily task on the Rewarding page is done (until the 14:00 reset) — no need to dismiss it by hand once there is nothing left to remind you of.',
  ],

  value: [
    "Ephemeral events are easy to miss in the daily rush — they look exactly like the menu you already ignore. Event pulse gives them attention proportional to the fact that they're about to expire, and turns itself off once there's nothing left to do.",
  ],

  fairplay: {
    summary: [
      'This is purely a **visual highlight of an already-existing menu element** — strictly additive (`AGENTS.md` §1.7), hiding or obscuring nothing: Trader, Officers and Shop look exactly as they always do.',
      'The "done for today" state is read from what the Rewarding page already shows after you open it yourself — nothing is polled in the background.',
    ],
  },

  details: [
    'Detecting temporary entries relies on the same CSS class as the permanent menu items (`premiumHighligt`), filtered to highlight only the new/ephemeral ones.',
    'Toggled in the OG-E Settings panel, the "Event pulse" tile.',
  ],

  screenshots: [
    { id: 'menu', caption: 'An animated temporary-event entry in the left menu.' },
  ],

  codeRefs: [
    'src/features/eventMenuHighlight.js',
    'src/features/rewardingWatcher.js',
  ],

  status: 'drafted',
};
