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
    'From time to time the game inserts temporary entries into the left bar (reward windows, contests, seasonal items) under the same class the permanent, always-present Trader/Officers/Shop entries use. Looking identical, they get lost in the background — Event pulse animates ONLY those temporary entries, so they stand out from their permanent neighbours.',
    'The pulse clears itself once we detect that every daily task on the Rewarding page is already done — no need to dismiss it by hand for it to stop reminding you of something you have already finished.',
  ],

  value: [
    'Temporary events are easy to miss in the daily rush — they look exactly like the menu you ignore anyway. Event pulse makes them stand out so you never skip a day on which an event is already available — that way you always collect every reward you can.',
  ],

  fairplay: {
    summary: [
      'This is purely a **visual highlight of an already-existing menu element** — strictly additive (`AGENTS.md` §1.7), hiding or obscuring nothing: Trader, Officers and Shop look exactly as they always do.',
      'The "done for today" state is read from what the Rewarding page already shows after you open it yourself — nothing is polled in the background.',
    ],
  },

  details: [
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
