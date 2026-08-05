// @ts-check

// EN mirror of ../spyglass-danger.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-danger',
  category: 'spyglass',
  locale: 'en',

  name: 'Danger ranking',
  oneLiner:
    'The whole server in one table, sorted from the most dangerous down: a 0–100 number and a one-word archetype tell you who not to poke and who you can hit.',
  flagship: true,
  order: 2,

  idea: [
    'The `Players` table is the entire server ordered by the `Danger` column. That number does not measure "how many points someone has" but **how many of those points can fly at you**: military points include defence, and defence does not attack — so OG-E splits them into a mobile and an immobile part, judges hull quality (the cost of a single ship) and compares the result against the whole server. On top of that it adds predator signals: destruction percentage, bandit tier, colony spread (how much of the server he actually reaches) and alliance class.',
    'Next to the number stands an **archetype** — one word instead of a table: `Apex hunter`, `Bandit raider`, `Fleeter`, `Cargo swarm`, `Fortress`, `Turtle`, `Economist`, `Declawed bandit`, `Friendly`. The `Fleet` column shows `≤`, because it is a **ceiling, not a measurement** — only a complete set of your own reports brings it down to an exact number and the `≤` sign disappears.',
  ],

  value: [
    'The highscore lies in both directions: a turtle with a mountain of defence points looks scarier than a fleeter who would actually wipe you out, and a vault with no fleet looks like a predator. One column separates those cases, so picking a target and judging risk is a glance rather than an investigation — and you have it for the whole server before sending your first probe.',
  ],

  fairplay: {
    summary: [
      'The whole table is **arithmetic over the public server statistics files** — the same ones community tools use. Nothing here is stolen: these are numbers everyone sees in the highscore, only arranged into an answer to "who is dangerous". The files have a freshness deadline and are read while you happen to be visiting the game, not on a cycle.',
      'The table **sends nothing** and contains no in-game action — the `+ watch` star only adds a player to your own note. Data from alliance mates (if you enable sharing) is **view-only**: by design it feeds neither the `Danger` number nor the scan plan.',
    ],
  },

  details: [
    'Zero ships is always `Danger 0`; your own alliance and buddies are 0 as well. Anyone with something to fly has at least 8.',
    'The cost of a single hull splits the fleet into classes: below ~20k resources — `civilian` (cargos, probes), 20–100k — `combat`, above that — `capitals`, or `defence?` if your scans have not confirmed it yet.',
    'Aggressor bonuses (bandit, range, warrior class) **do not stack without limit** — they fill up the headroom to 100. That way a peaceful giant never becomes an "apex".',
    '`Apex hunter` requires at least two of six signals, including **at least one aggressive one** (destruction, range, colony placement) — fleet size alone is not enough.',
    'Filters: hide inactive, watch list only, a military-points range, `top 50 / 100 / 200 / all`. Searching by name also finds filtered-out players and shows why they were hidden.',
  ],

  demo: {
    id: 'targets-table',
    caption: 'The real Players table over an invented cast — **the Danger column is computed by the same model the extension runs**, not typed into the demo. Kestrel scores 76 and carries the highest fleet ceiling; Boro, ranked higher overall, scores 18: those points sit in mines, not in hulls.',
  },

  screenshots: [
    { id: 'breakdown', caption: 'The score breakdown inside the dossier: where the number came from and which signals raised it.' },
  ],

  codeRefs: [
    'src/domain/dangerScore.js',
    'src/domain/dangerJoin.js',
    'src/domain/players.js',
    'src/features/dashboard/targets.js',
  ],

  status: 'drafted',
};
