// @ts-check

// EN mirror of ../colony-hunting-dashboard.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'colony-hunting-dashboard',
  category: 'dashboard',
  locale: 'en',

  name: 'Big Colony Hunting — histogram and settings',
  oneLiner:
    "The Colonizations tab in the Dashboard: a histogram of the field sizes of the colonies you have found, and the configuration the FAB's Colonisation button needs.",
  flagship: true,
  order: 1,

  idea: [
    'The **"Planet sizes"** histogram counts the sizes (field counts) of the planets you have colonised — so you can see at once whether your colonies so far are large, or whether it is worth hunting further.',
    'Next to the histogram sits the settings editor the **Colonisation** button on the FAB reads from: target positions (a list or range, e.g. "8,10-12,15"), whether to prefer neighbouring galaxies, whether to aim for the farthest or the nearest free system within your home galaxy, the minimum gap between colony-ship landings, and the size threshold plus password for abandoning colonies that turn out too small. The password is there to auto-fill the field the game requires when you abandon a colony that is too small.',
  ],

  value: [
    'The histogram answers the question "are my colonies large at all". The settings next to it keep everything the Colonisation button has to know in one place.',
    'Together with the FAB button, this is what makes hunting for big colonies possible. And hunting is far easier when you know how far you are from your dream planet size.',
  ],

  fairplay: {
    summary: [
      'This is purely a **data view and a configuration form** — the histogram counts from your own, already-saved observations, and the settings are plain values read later by the FAB module. Nothing here sends or saves anything to the game.',
      'The abandon password is stored locally and used only to fill the native colony give-up confirmation form — the same one you would fill by hand.',
    ],
  },

  details: [
    'Saving is automatic (debounced autosave) — there is no "Save" button.',
    'These same settings (except the password) travel through opt-in cross-device sync — see the "Cross-device sync" chapter.',
  ],

  screenshots: [
    { id: 'tab', caption: 'The Big Colony Hunting tab: the field-size histogram and, below it, the colonisation settings — positions, landing gap, abandon threshold, password.' },
  ],

  codeRefs: [
    'src/domain/histogram.js',
    'src/domain/galaxyScanConfig.js',
    'src/features/dashboard/scanConfig.js',
  ],

  status: 'drafted',
};
