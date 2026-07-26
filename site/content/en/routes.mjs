// @ts-check

// EN mirror of ../routes.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'routes',
  category: 'dashboard',
  locale: 'en',

  name: 'Routes',
  oneLiner:
    'A Dashboard editor for daily micro-fleet routes — define once where from, where to and with what, and Daily Run walks you through them in-game.',
  order: 30,

  idea: [
    'In the Dashboard you build **transport routes** per universe. A route is one or more **source bodies** (planets and/or moons) sharing one ordered **target list**, one **fleet** (ship + count) and a **mission**. A route can be paused with a toggle without deleting it.',
    'Own-body sources and targets are picked from the list of your planets and moons (captured in-game), so a coordinate can never be mistyped; external targets are typed by hand. The same per-universe keys are consumed in-game by Daily Run, which then walks you along the route.',
  ],

  value: [
    'A daily fleet-save across many bodies is a tedious round. Defining the routes once in a readable editor turns the daily ritual into clicking through a ready-made plan instead of retyping coordinates from scratch every day.',
  ],

  fairplay: {
    summary: [
      "It is a **pure configuration editor** — it saves your routes to the extension's local storage. It does not contact the game server, sends nothing, and schedules no background send-off.",
      'Own-body targets come from **the list of your planets the game already shows**. The actual send-off happens later, in the Daily Run feature, and always through a native click after your tap.',
    ],
  },

  details: [
    'Own-body endpoints missing from the captured inventory are flagged "stale" and removable in one click; external targets never go stale.',
    'Saving is debounced and flushed on universe switch and tab close, so your last edit is never lost.',
  ],

  screenshots: [
    { id: 'editor', caption: 'The routes editor in the Dashboard: sources, target list, fleet and mission.' },
    { id: 'stale', caption: 'A target flagged as "stale", removable in one click.' },
  ],

  codeRefs: [
    'src/features/dashboard/routes.js',
  ],

  status: 'drafted',
};
