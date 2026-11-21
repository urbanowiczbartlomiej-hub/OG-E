// @ts-check

// Discovery: src/features/agrLogo.js — przejmuje bezczynny do tej pory
//   przycisk logo AntiGameReborn (AGR): podmienia obrazek na ikonę OG-E i
//   spina klik z otwarciem menu AGR + rozwinięciem zakładki Ustawień OG-E.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'agr-logo',
  category: 'other',
  locale: 'pl',

  name: 'Logo AGR jako skrót do ustawień',
  oneLiner:
    'Kliknięcie ikony AntiGameReborn w menu otwiera od razu Ustawienia OG-E.',
  order: 2,

  idea: [
    'Ikona AGR w lewym menu na zmianę pokazuje logo **AGR** i **OG-E**. Kliknięcie otwiera menu AGR i od razu rozwija zakładkę **Ustawień OG-E**.',
  ],

  value: [
    'Jedno kliknięcie zamiast dwóch — i od razu widać, że OG-E działa.',
  ],

  fairplay: {
    summary: [
      'To tylko **grafika i skrót do istniejącego menu** — bez nowej funkcji i bez kontaktu z grą.',
    ],
  },

  details: [
    'Wymaga zainstalowanego AntiGameReborn (AGR) — tak jak cały panel Ustawień OG-E.',
  ],

  screenshots: [
    { id: 'logo', caption: 'Ikona przy „AntiGameReborn" przenika się między logo AGR i OG-E.' },
  ],

  codeRefs: [
    'src/features/agrLogo.js',
  ],

  status: 'drafted',
};
