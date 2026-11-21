// @ts-check

// Discovery: src/features/dashboard/routes.js (edytor tras dla in-game
//   Daily Run; per-universe klucz oge_dailyRunRoutes).

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'routes',
  category: 'dashboard',
  locale: 'pl',

  name: 'Daily Run — trasy',
  oneLiner:
    'Raz definiujesz codzienne trasy małych flot w Dashboardzie — potem w grze przycisk Daily Run prowadzi Cię po nich tapnięciami.',
  order: 4,

  idea: [
    'W zakładce **Daily Run** w Dashboardzie budujesz **trasy**: skąd (jedna lub kilka Twoich planet/księżyców), czym (statki i liczba), z jaką misją i dokąd — lista celów w ustalonej kolejności.',
    'Własne planety i księżyce wybierasz z listy, cudze współrzędne wpisujesz ręcznie. Trasę można **wstrzymać** bez kasowania. Twoje ciało, którego już nie ma (np. porzucona kolonia), świeci się na czerwono — usuniesz je jednym kliknięciem.',
  ],

  value: [
    'Codzienne rozsyłanie surowców czy sond z wielu planet to żmudne wpisywanie współrzędnych. Tu ustawiasz to raz, a w grze już tylko tapiesz.',
  ],

  fairplay: {
    summary: [
      'To **tylko edytor ustawień** — zapisuje trasy w rozszerzeniu, nie łączy się z grą i niczego sam nie wysyła.',
      'Wysyłka dzieje się później w grze, przyciskiem Daily Run, zawsze po Twoim tapnięciu i natywnym formularzem floty.',
    ],
  },

  details: [
    '**⚙ Settings** ustala, co robi „Send All": misja (Stacjonuj / Transport), statki i surowce (Most / All). Cel zbiórki ustawiasz w grze, przytrzymując strefę Send All na przycisku.',
    'Trasy synchronizują się między urządzeniami razem z resztą danych.',
  ],

  screenshots: [
    { id: 'editor', caption: 'Dwie trasy: aktywna i wstrzymana. Czerwony cel [7:77:7] już nie istnieje — do usunięcia.' },
  ],

  codeRefs: [
    'src/features/dashboard/routes.js',
  ],

  status: 'drafted',
};
