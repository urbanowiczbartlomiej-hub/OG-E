// @ts-check

// EN mirror of ../spyglass-scan.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-scan',
  category: 'spyglass',
  locale: 'en',

  name: 'Scan: Look, Spy, Strike',
  oneLiner:
    'The Spyglass button in the game always gives one next action: a free look at a system, a probe, or a moon opportunity.',
  order: 3,

  idea: [
    '**Look** — go to a system in the Galaxy: free and invisible to the target. `×N` says how many watched bodies this one visit refreshes. **Spy** — a probe at one body, with the player\'s name: a tap fills in the fleet form and the button turns into **Send**, the next tap sends the probe. **Strike** — looks suggest a fleet parked on a moon; it suggests a probe to confirm.',
    'Looks come first, then probes: never-scanned bodies first, then those marked for a rescan, then stale ones — more dangerous players higher. **N left** — how many targets are still waiting.',
  ],

  value: [
    'You do not have to remember whom you scanned and when, or where a look is enough instead of a probe. You are left with one decision — tap or not. Best on a phone.',
  ],

  fairplay: {
    summary: [
      'Every action concerns **one** body. The probe is sent by the game\'s native fleet form (**Espionage** mission), the same as a manual dispatch, after your tap. Look is a plain move to a system.',
      'The plan is **a list of suggestions, not tasks** — no timers and no sending in the background.',
    ],
  },

  details: [
    'In the settings you choose: how often to rescan (**Re-scan**) and look (**Re-look**), how many probes, planets and/or moons, and which planet probes launch from.',
    '**Neighbours** and **Patrol** live there too — they add looks at your own surroundings.',
    'You can track a player with looks only — then they see nothing at all.',
    '**Moon strike** sets when Strike lights up (off / lone / newest / any).',
  ],

  screenshots: [
    { id: 'look', caption: '"Look": a look at a system — one visit refreshes two watched bodies.' },
    { id: 'spy', caption: '"Spy": a probe at one body — a tap prepares the dispatch, the next one sends it.' },
    { id: 'settings', caption: 'Scan settings: probes, planets/moons, launch planet, refresh intervals, Moon strike.' },
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
