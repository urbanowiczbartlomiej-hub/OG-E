// @ts-check

// Discovery: src/features/antiFlickerBackground.js — czarne tło wstrzykiwane
//   na document_start, usuwane ~300ms po window.load. Zero zależności.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'anti-flicker-background',
  category: 'other',
  locale: 'pl',

  name: 'Bez białego rozbłysku',
  oneLiner:
    'Gasi biały błysk między jednym przeładowaniem strony a drugim — dotkliwy na ciemnym motywie, zwłaszcza wieczorem, zwłaszcza na Firefoksie mobilnym.',
  order: 3,

  idea: [
    'OGame przeładowuje całą stronę przy niemal każdej akcji — kliknięciu planety, zmianie zakładki, wysyłce misji. Domyślne białe tło przeglądarki, malowane między zamknięciem starej strony a pierwszym renderem nowej, na ciemnym motywie wygląda jak błysk światła w oczy. OG-E wstrzykuje czarne tło, zanim przeglądarka zdąży cokolwiek namalować, i zdejmuje je ~300 ms po pełnym załadowaniu — kiedy właściwe tło gry/AGR już przejęło ekran.',
  ],

  value: [
    'Kilkadziesiąt przeładowań dziennie to kilkadziesiąt białych błysków, jeśli grasz z ciemnym motywem — męczące dla oczu, szczególnie wieczorem albo na telefonie. Ta poprawka jest niewidoczna, gdy działa: po prostu nie ma już błysku.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **jeden tymczasowy styl CSS** na czas przeładowania strony — nic nie jest ukrywane na dłużej niż do pierwszego pełnego renderu, a treść gry pod spodem nie jest w żaden sposób zmieniana.',
      'Zero logiki poza tym — brak zależności, brak zapytań, brak stanu do zapisania.',
    ],
  },

  screenshots: [
    { id: 'compare', caption: 'Przeładowanie strony z i bez wstrzykniętego czarnego tła.' },
  ],

  codeRefs: [
    'src/features/antiFlickerBackground.js',
  ],

  status: 'drafted',
};
