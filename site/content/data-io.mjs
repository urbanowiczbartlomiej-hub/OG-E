// @ts-check

// Discovery: src/features/dashboard/io.js (Export/Import JSON + CSV kolonii),
//   src/features/dashboard/autosave.js, src/sync/merge.js (reużyty reconciler).

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'data-io',
  category: 'dashboard',
  locale: 'pl',

  name: 'Import / eksport / CSV',
  oneLiner:
    'Kopia zapasowa danych serwera w jednym pliku JSON — bez chmury i bez konta. Plus historia kolonii do arkusza (CSV).',
  order: 6,

  idea: [
    '**Export JSON** na górnym pasku Dashboardu zapisuje dane wybranego serwera do pliku (na wąskim ekranie przyciski kryją się pod nazwą serwera). **Import JSON** wczytuje plik do **aktualnie wybranego serwera** i łączy go z tym, co już masz — tak samo jak sync.',
    'Przycisk **CSV** przy wykresie Big Colony Hunting zapisuje historię kolonii do arkusza.',
  ],

  value: [
    'Kopia zapasowa albo przeniesienie danych na nowe urządzenie bez konfigurowania syncu. Ty trzymasz plik, Ty decydujesz, gdzie trafia.',
  ],

  fairplay: {
    summary: [
      'Wszystko dzieje się **lokalnie**: pobranie i wczytanie pliku, bez kontaktu z serwerem gry ani z żadnym innym.',
      'Plik można bezpiecznie przekazać — **tokeny i hasła nigdy do niego nie trafiają**.',
    ],
  },

  details: [
    'Plik nie zawiera ustawień zapisanych w grze ani hasła do porzucania kolonii — to kopia danych, nie pełna przeprowadzka urządzenia.',
  ],

  screenshots: [
    { id: 'buttons', caption: 'Export JSON i Import JSON obok wyboru serwera, na górnym pasku Dashboardu.' },
  ],

  codeRefs: [
    'src/features/dashboard/io.js',
    'src/features/dashboard/autosave.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
