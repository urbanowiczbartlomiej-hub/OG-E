// @ts-check

// EN mirror of ../trader-menu-highlight.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'trader-menu-highlight',
  category: 'game-ui',
  locale: 'en',

  name: 'Trader pulse',
  oneLiner:
    'Two independent coloured highlights on the Trader menu — yellow reminds you about the auction, red about the daily import/export — and they clear only once you really do them.',
  order: 5,

  idea: [
    'The two daily Trader chores get lost in the background, because the menu entry looks the same whether or not something is waiting. Trader pulse adds two independent coloured glows on the menu button and on the Trader-overview tiles: **yellow** for the Auctioneer and **red** for Import/Export.',
    'Neither pulse clears just because you opened the menu. It clears only after your actual action: a successful bid (for about 30 minutes) or taking the container.',
  ],

  value: [
    'Daily Trader micro-chores are easy to forget, and the menu does not say anything is waiting. Two separate colours tell you at once WHICH of the two chores is still open — no need to click in just to find out.',
    'The point is that you do not forget about the Import/Export items — they can be available more than once a day — nor about bidding against other players.',
  ],

  fairplay: {
    summary: [
      'This is only a **glow on an already-existing menu and its tiles** — strictly additive (`AGENTS.md` §1.7). The Trader, Auctioneer and Import/Export pages look and behave exactly as always, with nothing swapped or covered.',
      'The state is computed from what the Trader pages already show once you open them yourself, plus one locally-stored reminder-MODE choice — zero background polling, zero automatic bidding or purchase.',
    ],
  },

  details: [
    'Import/Export has two modes switched with chips on the Trader page: remind once a day, or 6 times a day (while such an event is running).',
    'The Auctioneer glows during typical auction hours (~06:00–23:00), not around the clock.',
    'Toggled in the OG-E Settings panel, the "Trader pulse" tile.',
  ],

  screenshots: [
    { id: 'menu', caption: 'The red pulse on the Trader entry in the left menu — Import/Export is still waiting.' },
  ],

  codeRefs: [
    'src/features/traderMenuHighlight.js',
  ],

  status: 'drafted',
};
