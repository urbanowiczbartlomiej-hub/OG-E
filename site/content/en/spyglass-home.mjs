// @ts-check

// EN mirror of content/spyglass-home.mjs — same feature, same sections.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-home',
  category: 'spyglass',
  locale: 'en',

  name: 'Home watch',
  oneLiner:
    'Watches the systems you live in: it tells you who has just moved in next door, and which neighbour already keeps a fleet inside several of your systems at once.',
  flagship: true,
  order: 6,

  idea: [
    'Every look you take at the galaxy is compared with the previous one — and if somebody new has appeared in a system where you keep a planet or a moon, you are told once. Your own systems join the Spy button\'s "Look" plan on **their own cadence** (24 h by default, `0` = off): a neighbour does not move, somebody has to colonise first, so checking hourly buys nothing.',
    'The card lists **actors, not addresses**. One row per neighbour: colour = their `Danger`, `×N` = how many of your systems they already sit in. That second number is the escalation it is easy to miss — an account with a fleet in three of your systems can run a moon destruction on its own, in three places, with no travel time to plan around. Listed separately: **alliances whose members together reach further than any of them does alone**. Two people with the same tag in one of your systems is not an escalation (the reach is the same as one of them); four of your systems covered between them is.',
  ],

  value: [
    'Your neighbourhood is the one thing the highscore never shows: a hunter one system from your moon has no travel time at all, and sees your bodies in the galaxy view every time they open it. Home watch turns that into one sentence at the right moment — "the fleet-save you have been flying for months is no longer safe" — instead of something you learn from a combat report.',
  ],

  fairplay: {
    summary: [
      'The observation is **your own visit to the galaxy view** — nothing is initiated in the background, there is no timer and no polling. The whole feature is a comparison of what OG-E already recorded from your browsing: who was in the system then, who is there now. It holds no in-game action and never proposes an attack — this card answers a defensive question only.',
      'Nothing watches for you: if you do not open the game, you are told nothing, and that is by design. There is no phone notification, no sound, and no reading of hostile fleets outside the game tab. The baseline (the memory of "who lived here") is **device-local** and is never uploaded or shared.',
      'Your own alliance and your buddy list are **excluded by definition** — they are company, not exposure. The NEW flag clears itself a day after you read it; there is nothing to click and nothing to acknowledge.',
    ],
  },

  details: [
    'The `Home` field in the Spyglass settings is hours (`0` = off). 24 h by default — separate from `Re-look`, which is about watched players.',
    'The first look at a system produces **no arrivals** — it only seeds the baseline. Otherwise day one would report a dozen "new" neighbours and teach you to ignore the alert.',
    'Departures are not reported: a neighbour who left is good news, and the galaxy view cannot tell "abandoned" from "I looked at the wrong moment".',
    'The same player in **another** of your systems is fresh news (their `×N` grows). A second planet in a system they already occupy is not — they were already inside.',
    'The Spy button points you at the dashboard **only once the sweep of all your own systems is complete**, and only when there is something to read. One tap, and the nudge retires itself.',
  ],

  screenshots: [
    { id: 'card', caption: 'The Home watch card on the Spyglass tab — a fresh arrival, one row per neighbour, and the alliance-coalition line.' },
  ],

  demo: {
    id: 'home-watch',
    caption: 'The real OG-E component, rendered over invented data (nicknames, tags and coordinates belong to nobody). Row edge colour = Danger, `×N` = how many of your systems that player sits in, a lit tag = an alliance that reaches further together than any of its members alone.',
  },

  codeRefs: [
    'src/domain/homeWatch.js',
    'src/features/homeWatch/index.js',
    'src/state/homeWatch.js',
    'src/features/dashboard/homeWatch.js',
  ],

  status: 'drafted',
};
