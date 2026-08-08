// @ts-check

// EN mirror of ../trader-menu-highlight.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'trader-menu-highlight',
  category: 'game-ui',
  locale: 'en',

  name: 'Trader pulse',
  oneLiner:
    "Two independent coloured glows on the Trader menu — yellow for the auction, red for the daily import/export — that clear only once you actually do them.",
  order: 5,

  idea: [
    'Two daily Trader chores get lost in the noise because the menu entry looks the same whether or not something is waiting. Trader pulse adds two independent coloured glows on the menu button and on the Trader-overview tiles: **yellow** for the Auctioneer and **red** for Import/Export.',
    "Neither glow clears just because you opened the menu — that proves nothing (the button might be disabled, the server might reject it). It clears only after your actual action: a successful bid (for roughly 30 minutes, an approximation of an auction's length) or taking the container.",
  ],

  value: [
    "Daily Trader micro-chores are easy to forget, and the menu doesn't say anything is waiting. Two separate colours tell you at a glance WHICH of the two chores is still open — no need to click in just to find out.",
  ],

  fairplay: {
    summary: [
      'This is only a **glow on an already-existing menu and its tiles** — strictly additive (`AGENTS.md` §1.7). The Trader, Auctioneer and Import/Export pages look and behave exactly as always, with nothing swapped or covered.',
      'The state is computed from what the Trader pages already show once you open them yourself, plus one locally-stored MODE choice (daily vs. quest) — zero background polling, zero automatic bidding or purchase.',
    ],
  },

  details: [
    'Import/Export has two modes switched with chips on the Trader page: the daily container (visible from 14:00) or a mode tuned to your current quest.',
    'The Auctioneer glow shows during typical auction hours (~06:00–23:00), not around the clock.',
    'Toggled in the OG-E Settings panel, the "Trader pulse" tile.',
  ],

  screenshots: [
    { id: 'menu', caption: 'The yellow and red pulse on the Trader menu.' },
  ],

  codeRefs: [
    'src/features/traderMenuHighlight.js',
  ],

  status: 'drafted',
};
