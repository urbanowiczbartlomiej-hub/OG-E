// @ts-check

// EN mirror of ../agr-logo.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'agr-logo',
  category: 'other',
  locale: 'en',

  name: 'The AGR logo as a settings shortcut',
  oneLiner:
    'Clicking the AntiGameReborn icon in the menu opens OG-E Settings straight away.',
  order: 2,

  idea: [
    'The AGR icon in the left menu alternates between the **AGR** and **OG-E** logos. Clicking it opens the AGR menu and expands the **OG-E Settings** tab right away.',
  ],

  value: [
    'One click instead of two — and you can see at a glance that OG-E is running.',
  ],

  fairplay: {
    summary: [
      'It is only **a graphic and a shortcut to an existing menu** — no new feature and no contact with the game.',
    ],
  },

  details: [
    'Needs AntiGameReborn (AGR) installed — like the whole OG-E Settings panel.',
  ],

  screenshots: [
    { id: 'logo', caption: 'The icon next to "AntiGameReborn" fades between the AGR and OG-E logos.' },
  ],

  codeRefs: [
    'src/features/agrLogo.js',
  ],

  status: 'drafted',
};
