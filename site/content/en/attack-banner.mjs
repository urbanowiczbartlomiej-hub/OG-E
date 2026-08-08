// @ts-check

// EN mirror of ../attack-banner.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'attack-banner',
  category: 'game-ui',
  locale: 'en',

  name: 'Attack banner',
  oneLiner:
    'A loud, full-screen banner in the open game tab the instant OGame itself flags an inbound fleet — so you never miss what the top bar already shows.',
  order: 6,

  idea: [
    "When the game marks an inbound hostile fleet in its own top bar, the banner turns that into something impossible to miss on a small phone screen — inside the SAME open tab. It is only a louder rendering of information the game already displays, nothing more.",
    'Off by default. Settings has a **"Preview"** button that shows the banner for 10 seconds before you decide to turn it on.',
  ],

  value: [
    "On a phone it's easy to miss a small flag in the corner of the bar, especially mid-task elsewhere in the game. The attack banner gives that same information a size you cannot miss — as long as you happen to be looking at the open tab.",
  ],

  fairplay: {
    summary: [
      'This is only a **different rendering of data the game already shows in its bar** — not a separate source of attack information and not a way around anything.',
      'Zero off-tab signal: it never touches the tab title or favicon, plays no sound, and sends no system notification or push of any kind. A player who is not looking at the open game tab learns nothing — the banner exists only inside that tab, at the moment you would have seen it anyway.',
    ],
  },

  details: [
    'Off by default — deliberately opt-in, with a preview before you enable it.',
    'Toggled in the OG-E Settings panel, Display section.',
  ],

  screenshots: [
    { id: 'preview', caption: 'The attack-banner preview triggered by the "Preview" button in Settings.' },
  ],

  codeRefs: [
    'src/features/threatHighlight/index.js',
    'src/features/settingsUi/sections/preferences.js',
  ],

  status: 'drafted',
};
