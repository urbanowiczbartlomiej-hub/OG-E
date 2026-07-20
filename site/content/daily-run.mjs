// @ts-check

// Discovery: src/features/dailyRun/*, src/state/dailyRunRoutes.js,
//   src/bridges/deployRedirect.js.
// UWAGA: to funkcja fleet-save / mikro-flot (routes + collect), NIE zbieracz
// ekspedycji/kolonii/discovery.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'daily-run',
  category: 'fab',
  locale: 'pl',

  name: 'Daily run (codzienne trasy)',
  oneLiner:
    'Codzienny fleet-save z jednego przycisku: rozsyła stałe mikro-floty po trasie i ściąga wszystko z powrotem na jedno ciało.',
  flagship: true,
  order: 5,

  idea: [
    'Moduł **Daily Run** prowadzi Twój codzienny fleet-save. Definiujesz raz **trasę** (skąd, dokąd, jaką mikro-flotą), a potem przycisk prowadzi Cię od ciała do ciała: górna strefa **rozsyła** stałe mikro-floty po celach trasy, dolna **ściąga** wszystko z powrotem na wybrane ciało zbiorcze.',
    'Cele, do których flota już leci, są pomijane — więc nie wyślesz przez pomyłkę dwa razy w to samo miejsce.',
  ],

  value: [
    'Codzienny fleet-save z wieloma planetami to żmudny rytuał: rozstaw, potem pozbieraj, przechodząc ręcznie po wszystkich ciałach i pilnując, co już zrobione. Daily Run prowadzi przez cały ten obchód krok po kroku.',
  ],

  fairplay: {
    summary: [
      'To **prowadzenie gracza, nie bot**: OG-E nie wysyła floty samo — naciska natywny przycisk wysyłki, a wysyłkę wykonuje gra, po Twoim tapnięciu.',
      'Co jest „już zrobione", przycisk poznaje z **listy lotów, którą gra i tak wyświetla** — a nie z jakiegokolwiek śledzenia w tle.',
    ],
  },

  details: [
    'Trasy, cel zbiorczy, misja zbiórki i ile surowców zabierać — konfiguracja per-universe w Dashboardzie.',
  ],

  screenshots: [
    { id: 'two-zones', caption: 'Przycisk Daily Run z dwoma strefami: góra „rozsyłka", dół „zbiórka".' },
    { id: 'route-config', caption: 'Konfiguracja trasy w Dashboardzie OG-E.' },
  ],

  codeRefs: [
    'src/features/dailyRun/index.js',
    'src/state/dailyRunRoutes.js',
    'src/bridges/deployRedirect.js',
  ],

  status: 'drafted',
};
