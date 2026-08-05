// @ts-check

// EN mirror of ../spyglass-scan.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-scan',
  category: 'spyglass',
  locale: 'en',

  name: 'Scan: Look, Spy, Strike',
  oneLiner:
    'The Spyglass button in the game offers one next intelligence action: a free look, a probe or a moon opportunity — always exactly that one.',
  order: 3,

  idea: [
    'The button shows **one proposal at a time**, picked from the scan plan for the players you watch. `Look` is a visit to a system in the galaxy view — free and undetectable; the label carries the target `[galaxy:system]` and `×N`, i.e. how many watched bodies that single visit refreshes. `Spy` is a probe on one body: the first tap arms it and shows who you are flying at, the second sends. `Strike` lights up when the looks alone suggest a fleet may be parked on a moon. `N left` tells you how many bodies in the plan are still waiting.',
    'The plan order is **danger × staleness × good moment**: never-scanned and overdue bodies first, and if the local hour falls inside an observed activity window of the target, the proposal is promoted. You set the deadlines yourself (`Re-scan`, `Re-look`), and likewise the number of probes per scan, whether to scan planets, moons or both, and whether probes launch from the nearest planet or from the one you are standing on.',
  ],

  value: [
    'Running intelligence by hand is bookkeeping: who was scanned, what went stale, where a look is enough instead of burning probes, which planet you skipped. The button keeps that ledger for you and leaves you one decision — tap or not. It works especially well on a phone, where clicking through the galaxy is the most tedious.',
  ],

  fairplay: {
    summary: [
      'One tap is one action. OG-E **does not send a probe by itself**: it fills in the native, two-step fleet dispatch form and presses the game\'s own button — the one you would press by hand — and only for **one** body. There is no "scan everything" and no multi-target action. `Look` is simply a move into a system in the galaxy view, exactly what a player does with the arrows.',
      'The scan plan is a **queue of proposals, not a queue of jobs**: there are no timers, no background sends, nothing starts without your tap, and with no game tab open the button does not exist at all. All the knowledge the ordering rests on is your own reports and your own browsing of the galaxy.',
    ],
  },

  details: [
    '`galaxy` and `probes` on a watched player\'s card are **two independent channels** — you can run a player on looks only, in which case the target sees absolutely nothing.',
    'Looks are always recorded for watched players while you browse the galaxy; the toggles only mute the *proposals*, not the recording.',
    '`Moon strike`: `off`, `lone` (only the moon glows, the rest reads as quiet), `newest` (the freshest interaction on the account is on the moon), `any`. Before a strike the button asks you to complete the picture of the whole account first.',
    '`↻` on a card marks all of a player\'s bodies as "due for a re-scan"; `never` means "never spied on".',
    'Bodies sent this session drop out of the plan, and bodies still within their deadline never enter it — you cannot accidentally double a probe.',
    'A configured patrol radius adds the neighbourhood of your colonies to the look plan (see "Patrol").',
  ],

  demo: {
    id: 'spy-fab-faces',
    caption: 'Four real faces of the Spy button — the wording comes from the same code that paints it in game. The button always says what the NEXT tap will do, and never claims more than the signals support: "fresh landing?" is a question, not a verdict. An armed `Spy` shows who the probe will fly at before you send it.',
  },

  screenshots: [
    { id: 'settings', caption: 'Scan settings: probe count, planets/moons, launch point, refresh deadlines, moon-hunting mode.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/sendSpy/pure.js',
    'src/domain/scanPriority.js',
    'src/domain/galaxyWatch.js',
    'src/domain/fleetLanding.js',
  ],

  status: 'drafted',
};
