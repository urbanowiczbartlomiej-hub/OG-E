// @ts-check

// EN mirror of ../spyglass-button.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-button',
  category: 'fab',
  locale: 'en',

  name: 'Spyglass (the button)',
  oneLiner:
    'A gold button with an eye: it tells you which system to look at and where to send a probe — and it only shows up when there is something to do.',
  order: 7,

  idea: [
    'The **Spyglass** button appears by itself when you have watched players, **Neighbours** on (it is by default, once a day) or a **Patrol** radius set — and it disappears when there is nothing to do. You do not switch it on with a tile like the others.',
    'The label says what is next: **Look** — look at this system in the Galaxy, **Spy** — a probe on one body (the second tap, **Send**, sends it), **Strike** — a moon opportunity. **neighbours** and **patrol (N)** are a round of your surroundings, **Reports** — new espionage reports are waiting, **Home** — new neighbours to review in the Dashboard.',
    'What to check and how often, you set once in the **Spyglass** tab of the Dashboard.',
  ],

  value: [
    'Instead of remembering whom you looked at and when, you just tap. The button builds the queue of systems and probes from your own settings.',
  ],

  details: [
    'The analysis itself — threat ranking, dossier, routine, map, patrol — is described in the "Spyglass — intelligence" chapter.',
    'Holding the button for 2 s clears the **Home** nudge.',
  ],

  fairplay: {
    summary: [
      '**Look** is a plain move to a system in the Galaxy. A probe takes two taps: the first fills in the native fleet form (ship, target, **Espionage** mission), the second presses the game\'s send button. Always one body, nothing in the background.',
      'The button uses what you saw in the game, the public OGame API and your own settings.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Spyglass on the OG-E button: "Look" — look at system [1:116], 79 targets left.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
