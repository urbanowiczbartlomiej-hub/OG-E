// @ts-check

// EN mirror of ../daily-run.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'daily-run',
  category: 'fab',
  locale: 'en',

  name: 'Daily run (daily routes)',
  oneLiner:
    'A daily send-off of the same ships on the same routes from one button: it sends fixed ships to the same targets and pulls everything back to one chosen body.',
  flagship: true,
  order: 5,

  idea: [
    'The **Daily Run** button runs your daily fleet moves. You define a **route** once (from where, to where, with which fleet and which mission), and then the button walks you through sending the defined routes. The top zone dispatches the defined missions to all targets defined for the active planet that is the starting point — you can pick multiple targets from one planet, different missions, multiple ships, and multiple routes.',
    'The bottom zone sends everything to the chosen planet and moves on to the next one (**Collect**); holding it changes the target to the active planet. It sends ships and resources according to the options chosen in the Dashboard.',
    'Targets a fleet is already flying to are skipped, so you will not accidentally send to the same place twice. This also enables farming inactive players.',
  ],

  value: [
    'The daily routine is a tedious ritual: picking ships, missions, targets, and collecting the daily income by going through every body while keeping track of what is already done. Daily Run walks you through the whole round step by step, and you just tap one button. Great on mobile.',
  ],

  fairplay: {
    summary: [
      'This is **player guidance, not a bot**: OG-E does not send the fleet itself — it presses the native dispatch button, and the game performs the dispatch, after your tap.',
      'The button reads from **the flight list which missions you sent yourself** — not from any background tracking.',
    ],
  },

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
