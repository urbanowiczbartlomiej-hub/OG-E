// @ts-check

// EN mirror of ../spyglass.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass',
  category: 'spyglass',
  locale: 'en',

  name: 'Spyglass — intelligence',
  oneLiner:
    'Full intelligence on the players of your server: who is dangerous, who is worth hitting, where the loot sits and when the owner is away from the keyboard.',
  flagship: true,
  order: 1,

  idea: [
    'Spyglass has **two sources of knowledge and one backbone**. The galaxy channel (`galaxy`) is an ordinary visit to a system — free, invisible to the target, and it yields activity markers plus moon information. The probe channel (`probes`) is a normal spy report — it costs probes and the target sees it, but it shows fleet, defence and resources. The backbone is the **watch list** (`Watchlist`): whoever you put there is what the in-game button works on, and that is the player whose dossier grows.',
    'The feature lives in two places. The floating button in the game proposes **one next** intelligence action. The `Spyglass` tab in the OG-E dashboard is a reading room: server ranking, dossiers, map and the "who is spying on you" panel — without a single send button. The danger ranking works from the very first run, off the public server statistics; scanning only deepens it.',
  ],

  value: [
    'Intelligence in OGame is normally manual labour: a hundred reports in your inbox, a notepad of coordinates, and memory of who was dangerous half a year ago. Spyglass turns that into **six questions with ready answers** — and that is all you need to know to use it. The rest of this chapter is detail for the curious, not a manual.',
  ],

  fairplay: {
    summary: [
      'Everything Spyglass knows comes from three places: the **public server statistics files** (the same ones community tools use), **game pages you opened yourself** (reports, the galaxy view, alliance highscore) and what **you sent yourself**. There is no background scanning: with no game tab open OG-E does nothing, and the statistics files have a freshness deadline rather than being polled on a cycle.',
      'The `Spyglass` tab is a **reading room with no trigger** — there is no sending in it at all. A probe can only be launched from the game, by a deliberate tap on a single body, through the native two-step fleet dispatch form. There is no "scan everything" button and no action that covers multiple targets.',
    ],
  },

  details: [
    '**Who to avoid and who can be touched?** — the danger ranking (`Danger`).',
    '**What to look at next?** — the `Look` / `Spy` / `Strike` button.',
    '**Is he worth hitting and where is the loot?** — the player dossier.',
    '**When is he away?** — routine and offline windows.',
    '**Who can reach me?** — the position map and range.',
    '**Who is sniffing around me?** — the "who is spying on you" panel.',
  ],

  demo: {
    id: 'watchlist-cards',
    caption: 'The real watch-list card strip over an invented cast — **the verdicts are computed by the same code the extension runs**. Four cards, four different answers: Pipit is a farm ready to take, Boro is loaded but could bounce the raid, Kestrel has nothing worth taking right now, and nothing is known about Ilex because nobody has looked yet.',
  },

  screenshots: [
    { id: 'tab', caption: 'The Spyglass tab: watch list, scan settings, the "who is spying on you" panel and the player ranking.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/sendSpy/index.js',
    'src/domain/spyScan.js',
    'src/state/watchList.js',
  ],

  status: 'drafted',
};
