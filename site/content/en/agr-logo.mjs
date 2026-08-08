// @ts-check

// EN mirror of ../agr-logo.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'agr-logo',
  category: 'other',
  locale: 'en',

  name: 'The AGR logo as a settings shortcut',
  oneLiner:
    "AntiGameReborn's otherwise-idle logo button gets the OG-E icon and opens the options menu together with the OG-E Settings tab in one click.",
  order: 2,

  idea: [
    "AGR has a logo button in the corner that does almost nothing by default when clicked. Instead of painting a second, separate button on the bar, OG-E takes over this one — swaps its image for the OG-E icon and wires the click to two things at once: opening AGR's options menu and auto-expanding the OG-E Settings tab inside it.",
    "This is purely a cosmetic image swap plus one click listener — the rest of AGR's menu behaves exactly as it always has.",
  ],

  value: [
    "One click instead of two (open the menu, then find the OG-E tab) — and as a bonus you can tell at a glance the extension is active, since the icon in the corner is no longer AGR's default logo.",
  ],

  fairplay: {
    summary: [
      "This is purely an **image swap and a shortcut into an already-existing menu** — it adds no new function or request to the game, just a faster path to settings that were already reachable through AGR.",
      "If AGR doesn't load within 10 seconds, the module silently does nothing — the AGR logo stays unchanged, no error shown on screen.",
    ],
  },

  screenshots: [
    { id: 'logo', caption: "The OG-E icon in place of AGR's default logo, in the corner of the bar." },
  ],

  codeRefs: [
    'src/features/agrLogo.js',
  ],

  status: 'drafted',
};
