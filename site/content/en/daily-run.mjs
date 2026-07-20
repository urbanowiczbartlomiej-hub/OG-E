// @ts-check

// EN mirror of ../daily-run.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'daily-run',
  category: 'fab',
  locale: 'en',

  name: 'Daily run (daily routes)',
  oneLiner:
    'A daily fleet-save from one button: it spreads fixed micro-fleets along a route and pulls everything back to a single body.',
  flagship: true,
  order: 5,

  idea: [
    'The **Daily Run** module runs your daily fleet-save. You define a **route** once (from where, to where, with which micro-fleet), and then the button walks you body to body: the top zone **spreads** the fixed micro-fleets across the route targets, the bottom **pulls** everything back to your chosen collector body.',
    'Targets a fleet is already flying to are skipped — so you will not accidentally send to the same place twice.',
  ],

  value: [
    'A daily fleet-save across many planets is a tedious ritual: deploy, then collect, going through every body by hand and keeping track of what is done. Daily Run walks you through the whole round step by step.',
  ],

  fairplay: {
    summary: [
      'This is **player guidance, not a bot**: OG-E does not send the fleet itself — it presses the native dispatch button, and the game performs the dispatch, after your tap.',
      'What is "already done" the button learns from **the flight list the game displays anyway** — not from any background tracking.',
    ],
  },

  settings: [
    'Routes, collector body, collection mission and how many resources to carry — per-universe config in the Dashboard.',
  ],

  screenshots: [
    { id: 'two-zones', caption: 'The Daily Run button with two zones: top "deploy", bottom "collect".' },
    { id: 'route-config', caption: 'Route configuration in the OG-E Dashboard.' },
  ],

  codeRefs: [
    'src/features/dailyRun/index.js',
    'src/state/dailyRunRoutes.js',
    'src/bridges/deployRedirect.js',
  ],

  status: 'drafted',
};
