// @ts-check

// Discovery: src/domain/histogram.js (histogram rozmiarów pól, tally per
//   galaktyka), src/domain/galaxyScanConfig.js (pozycje, preferencje,
//   minimalny odstęp lądowań, próg porzucania, hasło), src/features/dashboard/
//   scanConfig.js (edytor), src/features/dashboard/index.js (zakładka
//   Colonizations). Strona-towarzysz do `big-colony-hunting` (kategoria
//   `fab`) — tam jest sam przycisk, tu dane i ustawienia za nim. Ta sama
//   nazwa marketingowa celowo w dwóch rozdziałach: FAB = akcja, Dashboard =
//   dane i konfiguracja.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'colony-hunting-dashboard',
  category: 'dashboard',
  locale: 'pl',

  name: 'Big Colony Hunting — histogram i ustawienia',
  oneLiner:
    'Zakładka Colonizations w Dashboardzie: histogram rozmiarów pól, które osobiście odwiedziłeś, i pokrętła, którymi steruje przycisk Kolonizacja na FAB-ie.',
  flagship: true,
  order: 1,

  idea: [
    'Histogram **„Planet sizes"** liczy rozmiary (liczbę pól) planet i księżyców, które kiedykolwiek widziałeś w przeglądzie ciała — osobno globalnie i osobno per galaktyka — więc od razu widać, czy Twoje dotychczasowe kolonie są duże, czy warto polować dalej.',
    'Obok histogramu siedzi edytor ustawień, z którego korzysta przycisk **Kolonizacja** na FAB-ie: docelowe pozycje (lista/zakres, np. „8,10-12,15"), czy preferować sąsiednie galaktyki, czy w macierzystej galaktyce celować w najdalszy wolny system, czy w najbliższy, minimalny odstęp między lądowaniami kolonizatorów oraz próg wielkości i hasło do porzucania za małych kolonii.',
  ],

  value: [
    'Histogram odpowiada na pytanie „czy moje kolonie są w ogóle duże", którego nie da się wyczytać z samej listy planet. Ustawienia obok trzymają w jednym miejscu wszystko, co przycisk Kolonizacja i tak musi znać — bez tego każde uruchomienie modułu wymagałoby ręcznego wpisywania tych samych liczb.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **widok danych i formularz konfiguracji** — histogram liczy z Twoich własnych, już zapisanych obserwacji, a ustawienia to zwykłe wartości czytane później przez moduł FAB. Nic tu nie wysyła ani nie zapisuje niczego do gry.',
      'Hasło do porzucania jest trzymane lokalnie i używane wyłącznie do wypełnienia natywnego formularza potwierdzenia porzucenia kolonii — tego samego, który wypełniłbyś ręcznie.',
    ],
  },

  details: [
    'Zapis jest automatyczny (autosave z debounce) — nie ma przycisku „Zapisz".',
    'Te same ustawienia (poza hasłem) jadą przez opt-in sync między urządzeniami — patrz rozdział „Sync między urządzeniami".',
    'Jak przycisk Kolonizacja korzysta z tych ustawień — patrz „Kolonizacja (polowanie na duże kolonie)" w rozdziale „Przycisk OG-E".',
  ],

  screenshots: [
    { id: 'histogram', caption: 'Histogram rozmiarów pól — globalnie i per galaktyka.' },
    { id: 'settings', caption: 'Edytor ustawień kolonizacji: pozycje, preferencje, odstęp lądowań, próg porzucania.' },
  ],

  codeRefs: [
    'src/domain/histogram.js',
    'src/domain/galaxyScanConfig.js',
    'src/features/dashboard/scanConfig.js',
  ],

  status: 'drafted',
};
