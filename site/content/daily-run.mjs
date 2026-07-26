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
    'Codzienna wysyłka tych samych statków na tych samych trasach z jednego przycisku: wysyła stałe statki do tych samych celów i ściąga wszystko z powrotem na jedno wybrane ciało.',
  flagship: true,
  order: 5,

  idea: [
    'Przycisk **Daily Run** prowadzi Twoje codzienne ruchy flotą. Definiujesz raz **trasę** (skąd, dokąd, jaką flotą i z jaką misją), a potem przycisk prowadzi Cię przez wysyłanie zdefiniowanych tras. Górna strefa rozsyła zdefiniowane misje po wszystkich celach zdefiniowanych dla aktywnej planety będącej miejscem startu — możesz wybrać wiele celów z jednej planety, różne misje, wiele statków i wiele tras.',
    'Dolna strefa wysyła wszystko na wybraną planetę i przechodzi do kolejnej (**Collect**); jeśli ją przytrzymasz, zmienisz cel na aktywną planetę. Wysyła statki i surowce zgodnie z opcjami wybranymi w Dashboardzie.',
    'Cele, do których flota już leci, są pomijane, więc nie wyślesz przez pomyłkę dwa razy w to samo miejsce. Umożliwia to też farmienie nieaktywnych graczy.',
  ],

  value: [
    'Codzienna rutyna to żmudny rytuał: wybieranie statków, misji, celów i zbieranie codziennego zarobku, przechodząc po wszystkich ciałach i pilnując, co już zrobione. Daily Run prowadzi przez cały ten obchód krok po kroku, a Ty klikasz tylko jeden przycisk. Doskonałe na telefonie.',
  ],

  fairplay: {
    summary: [
      'To **prowadzenie gracza, nie bot**: OG-E nie wysyła floty samo — naciska natywny przycisk wysyłki, a wysyłkę wykonuje gra, po Twoim tapnięciu.',
      'Przycisk odczytuje z **listy lotów, które sam wysłałeś** — a nie z jakiegokolwiek śledzenia w tle.',
    ],
  },

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
