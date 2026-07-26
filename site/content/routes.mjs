// @ts-check

// Discovery: src/features/dashboard/routes.js (edytor tras dla in-game
//   Daily Run; per-universe klucz oge_dailyRunRoutes).

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'routes',
  category: 'dashboard',
  locale: 'pl',

  name: 'Trasy (routes)',
  oneLiner:
    'Edytor codziennych tras mikro-flot w Dashboardzie — definiujesz raz, skąd, dokąd i czym, a Daily Run prowadzi Cię po nich w grze.',
  order: 30,

  idea: [
    'W Dashboardzie budujesz **trasy transportowe** per uniwersum. Trasa to jedno lub więcej **ciał źródłowych** (planety i/lub księżyce) dzielących wspólną, uporządkowaną listę **celów**, jedną **flotę** (statek + liczba) i **misję**. Trasę można wstrzymać przełącznikiem bez kasowania.',
    'Źródła i cele na własnych ciałach wybierasz z listy Twoich planet i księżyców (przechwyconych w grze), więc współrzędnej nie da się przekręcić; cele zewnętrzne wpisujesz ręcznie. Te same klucze per-universe czyta w grze funkcja Daily Run, która prowadzi Cię potem po tej trasie.',
  ],

  value: [
    'Codzienny fleet-save z wieloma ciałami to żmudny obchód. Zdefiniowanie tras raz w czytelnym edytorze sprawia, że codzienna rutyna sprowadza się do klikania przez gotowy plan zamiast wpisywania współrzędnych od nowa każdego dnia.',
  ],

  fairplay: {
    summary: [
      'To **czysty edytor konfiguracji** — zapisuje Twoje trasy do lokalnego magazynu rozszerzenia. Nie kontaktuje się z serwerem gry, niczego nie wysyła i nie planuje żadnej wysyłki w tle.',
      'Cele na własnych ciałach pochodzą z **listy Twoich planet, którą gra i tak pokazuje**. Sama wysyłka dzieje się dopiero później, w funkcji Daily Run, i zawsze przez natywne kliknięcie po Twoim tapnięciu.',
    ],
  },

  details: [
    'Cele na własnych ciałach, których brakuje w przechwyconym spisie, są oznaczane jako „przeterminowane" i usuwalne jednym kliknięciem; cele zewnętrzne nigdy nie przeterminowują.',
    'Zapis jest zdławiony (debounce) i wypychany przy przełączeniu uniwersum oraz zamknięciu karty, żeby nie zgubić ostatniej edycji.',
  ],

  screenshots: [
    { id: 'editor', caption: 'Edytor tras w Dashboardzie: źródła, lista celów, flota i misja.' },
    { id: 'stale', caption: 'Cel oznaczony jako „przeterminowany", usuwalny jednym kliknięciem.' },
  ],

  codeRefs: [
    'src/features/dashboard/routes.js',
  ],

  status: 'drafted',
};
