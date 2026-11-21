// @ts-check

// Discovery: src/features/antiFlickerBackground.js — czarne tło wstrzykiwane
//   na document_start, usuwane ~300ms po window.load. Zero zależności.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'anti-flicker-background',
  category: 'other',
  locale: 'pl',

  name: 'Bez białego błysku',
  oneLiner:
    'Gasi biały błysk przy każdym przeładowaniu strony gry — szczególnie męczący wieczorem i na telefonie.',
  order: 3,

  idea: [
    'OGame przeładowuje stronę niemal przy każdym kliknięciu. Na chwilę przed narysowaniem gry przeglądarka maluje białe tło — na ciemnym motywie to błysk w oczy. OG-E podkłada czarne tło na ten moment i zdejmuje je, gdy gra się załaduje.',
  ],

  value: [
    'Kilkadziesiąt przeładowań dziennie to kilkadziesiąt błysków mniej. Działa zawsze — nie trzeba nic włączać.',
  ],

  fairplay: {
    summary: [
      'To jeden **tymczasowy styl tła** na czas ładowania strony. Nic w grze nie jest zmieniane ani ukrywane.',
    ],
  },

  screenshots: [
    { id: 'compare', caption: 'Przeładowanie strony z OG-E i bez niego.' },
  ],

  codeRefs: [
    'src/features/antiFlickerBackground.js',
  ],

  status: 'drafted',
};
