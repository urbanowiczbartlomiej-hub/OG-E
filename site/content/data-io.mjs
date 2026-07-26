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
    'Zapis całego zestawu danych wybranego uniwersum do pliku JSON, wczytanie go z powrotem przez scalanie oraz zrzut historii kolonii do CSV.',
  order: 40,

  idea: [
    'Z Dashboardu **eksportujesz** dane wybranego uniwersum do jednego pliku JSON i **importujesz** go z powrotem. Import nie nadpisuje hurtowo — każdy zestaw jest **scalany** tym samym reconcilerem co sync gista: przyrostowo, lokalne-najpierw. Runda Eksport → Import zachowuje się dokładnie jak pobranie z gista.',
    'Osobno robisz **zrzut historii kolonii do CSV**, żeby otworzyć ją w arkuszu. Wszystko idzie przez pliki lokalne (Blob) — moduł nie dotyka sieci.',
  ],

  value: [
    'Kopia zapasowa, przeniesienie danych na nowe urządzenie bez konfigurowania gista, albo obróbka historii kolonii w arkuszu — bez chmury i bez konta. Ty trzymasz plik, Ty decydujesz, gdzie trafia.',
  ],

  fairplay: {
    summary: [
      'Import/eksport jest **wyłącznie lokalny**: żadnego `fetch`, żadnego kontaktu z serwerem gry ani żadnym innym. Pobrania idą przez Blob, a wczytanie czyta plik, który sam wskazujesz.',
      'Plik jest **bezpieczny do przekazania**: sekrety (token GitHub, token ntfy) i księgowość synchronizacji nigdy do niego nie trafiają. To Twoje dane zebrane normalną grą, spakowane do jednego pliku.',
    ],
  },

  details: [
    'Import listy obserwowanych jedzie po swoim merge z tombstone (LWW): odgwiazdkowanie w nowszym pliku propaguje się, dokładnie jak w syncu.',
    'Plik niesie tylko dane z magazynu rozszerzenia; ustawienia per-universe zapisane w localStorage gry pozostają domeną wyłącznie gista.',
  ],

  screenshots: [
    { id: 'buttons', caption: 'Przyciski Eksport / Import / CSV w Dashboardzie OG-E.' },
    { id: 'summary', caption: 'Podsumowanie importu: ile wpisów dołożono w każdym zestawie po scaleniu.' },
  ],

  codeRefs: [
    'src/features/dashboard/io.js',
    'src/features/dashboard/autosave.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
