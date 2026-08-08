// @ts-check

// EN mirror of ../colony-hunting-dashboard.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'colony-hunting-dashboard',
  category: 'dashboard',
  locale: 'en',

  name: 'Big Colony Hunting — histogram & settings',
  oneLiner:
    "The Colonizations tab in the Dashboard: a histogram of the field sizes you've personally visited, plus the knobs the FAB's Colonisation button reads.",
  flagship: true,
  order: 1,

  idea: [
    'The **"Planet sizes"** histogram counts the sizes (field counts) of every planet and moon you\'ve ever viewed in the body overview — globally and per galaxy — so you can tell at a glance whether your colonies so far are actually large, or whether hunting further is worth it.',
    "Next to the histogram sits the settings editor the FAB's **Colonisation** button reads from: target positions (a list or range, e.g. \"8,10-12,15\"), whether to prefer neighbouring galaxies, whether to target the farthest or nearest free system within your home galaxy, the minimum gap between colony-ship landings, and the size threshold plus password for abandoning colonies that turn out too small.",
  ],

  value: [
    "The histogram answers \"are my colonies actually large\", a question the plain planet list can't answer. The settings next to it keep everything the Colonisation button needs to know in one place — without it, every run of that module would mean typing the same numbers by hand.",
  ],

  fairplay: {
    summary: [
      "This is purely a **data view and a configuration form** — the histogram counts from your own, already-saved observations, and the settings are plain values read later by the FAB module. Nothing here sends or saves anything to the game.",
      "The abandon password is stored locally and used only to fill the native colony give-up confirmation form — the same one you would fill by hand.",
    ],
  },

  details: [
    'Saving is automatic (debounced autosave) — there is no "Save" button.',
    'These same settings (except the password) travel through opt-in cross-device sync — see "Cross-device sync".',
    'How the Colonisation button uses these settings — see "Colonisation (big-colony hunting)" in the "The OG-E Button" chapter.',
  ],

  screenshots: [
    { id: 'histogram', caption: 'The field-size histogram — global and per galaxy.' },
    { id: 'settings', caption: 'The colonisation settings editor: positions, preferences, landing gap, abandon threshold.' },
  ],

  codeRefs: [
    'src/domain/histogram.js',
    'src/domain/galaxyScanConfig.js',
    'src/features/dashboard/scanConfig.js',
  ],

  status: 'drafted',
};
