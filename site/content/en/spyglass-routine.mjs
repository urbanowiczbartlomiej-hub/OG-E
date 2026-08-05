// @ts-check

// EN mirror of ../spyglass-routine.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-routine',
  category: 'spyglass',
  locale: 'en',

  name: 'Routine and offline windows',
  oneLiner:
    'From activity markers you see anyway, Spyglass reconstructs an opponent\'s day and weeks: when he is usually at the game, and when he is reliably away.',
  flagship: true,
  order: 5,

  idea: [
    'The galaxy view and a spy report show one thing: **how long ago** something happened on that body. OG-E converts that age into a point in time and, after a few dozen such points, draws the player\'s day and names his peak — for example `evenings 19–23`. Markers caused by your own probes are subtracted, and several looks at the same session count as one.',
    'The second block looks for **silence, not movement**: a quiet look with good coverage is strong evidence of absence. An offline window is only declared once three consecutive hours have both enough looks and consistent silence — otherwise the page says plainly "look more often". The same data can be viewed as weeks, as a day, as day×hour or as a monthly cycle, and a separate detector checks whether the player **rotates shifts**.',
  ],

  value: [
    'This is the difference between "I know he has a fleet" and "I know when he is not watching it" — and that difference is exactly what decides whether a raid pays off. Instead of guessing from a single report you get the opponent\'s rhythm, and when the sample is too small, **honest information that nothing follows from it yet**.',
  ],

  fairplay: {
    summary: [
      'This block is **purely passive and purely computational**: it counts only the markers the game itself drew on pages you opened anyway. Zero probes, zero extra requests, zero timers — nothing "watches" for you in the background, and without your browsing of the galaxy the history simply does not grow.',
      'Markers caused by **your own probes are subtracted**, so you do not measure your own rhythm. The page also does not pretend to knowledge it lacks: "activity" is the last interaction with a body, not an "online" status — and it is labelled that way. As long as the sample is too small, OG-E refuses to state a conclusion instead of drawing a chart anyway.',
      'History is kept as an **hourly "present / quiet" mask per day** — no coordinates, no report contents. That makes it mergeable across your own devices and (if you enable it) with alliance mates, and the merged material is view-only: it affects neither the danger score nor the scan plan.',
    ],
  },

  details: [
    'The peak of the day is the best **five consecutive hours**; its name (`nights`, `mornings`, `afternoons`, `evenings`) comes from its middle. Below three observations there is nothing, and on a small sample only a "hint" without a label.',
    'An offline window requires **at least three consecutive hours**, each with real coverage and practically no traces of activity. A one-off blip in the middle does not invalidate the window, but it is listed separately.',
    'The shift detector needs **at least five weeks with a recognised phase** — on a smaller sample it says plainly "too thin". Weekends are judged separately (some people are only at the game every other Saturday).',
    'The analysis range switches between `30d`, `90d`, `6mo` and `All`, and days can be narrowed to `Mon–Fri` so the weekend does not blur a work rhythm.',
    'In the grid a lighter cell means "few looks", not "quiet" — coverage and result are kept apart so missing data never looks like a conclusion.',
  ],

  screenshots: [
    { id: 'presence', caption: 'Routine and presence: the player\'s day with its activity peak, the coverage verdict and the week grid with offline windows.' },
  ],

  codeRefs: [
    'src/domain/routine.js',
    'src/domain/presence.js',
    'src/domain/presenceLedger.js',
    'src/domain/shiftPattern.js',
    'src/state/activityObs.js',
  ],

  status: 'drafted',
};
