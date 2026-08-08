// @ts-check

// Discovery: src/domain/zoneScore.js (model rankingu — cztery kanały: safety/
//   farm/room/target), src/domain/regions.js, src/domain/heatField.js
//   (mapa temperatury serwera), src/features/dashboard/index.js (zakładka
//   Colonizations, sekcja UI podpisana w kodzie "Colony Scout" — na stronie
//   występuje pod nazwą marketingową "Best Colony Spots").

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'best-colony-spots',
  category: 'dashboard',
  locale: 'pl',

  name: 'Best Colony Spots — najlepsze miejsca na kolonie',
  oneLiner:
    'Analiza w Dashboardzie, która ocenia okolice Twoich zeskanowanych galaktyk i mówi, gdzie osiedlić się dla bezpieczeństwa, farmy albo PvP.',
  flagship: true,
  order: 2,

  idea: [
    'Best Colony Spots liczy dla każdej okolicy cztery niezależne kanały: **safety** (im mniej zasięgu wrogich flot, tym lepiej), **farm** (ile nieaktywnego łupu leży w zasięgu), **room** (ile wolnych slotów zostało w oknie) i **target** (gęstość aktywnych graczy — okazje PvP). Wybierasz jeden z trzech gotowych profili — **Safe zone**, **Farm hub**, **PvP zone** — a każdy to po prostu inna waga tych samych czterech liczb, więc wynik da się porównywać między profilami i uniwersami.',
    'Dwa tryby listy pokrywają dwa różne pytania. **Best spots** ocenia okolicę wokół każdego systemu, w którym choć JEDEN wybrany slot jest wolny — szybkie „gdzie jest cokolwiek wolnego". **Longest streaks** szuka ciągłych odcinków, w których KAŻDY wybrany slot stoi pusty — pod farmę wielu kolonii pod rząd. Dane słabiej zeskanowanego okna są świadomie przycinane w dół, żeby jeden szczęśliwy skan nie wybił się ponad okno zeskanowane dokładnie.',
  ],

  value: [
    'Ręczne przeglądanie galaktyk w poszukiwaniu dobrej okolicy to godziny przewijania i zgadywania „czy tu jest bezpiecznie". Best Colony Spots zamienia to w jedną posortowaną listę z Twoim własnym kryterium na czele — a że liczy z tych samych danych, których używa mapa temperatury serwera, ranking i kolory na mapie zawsze mówią to samo.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **analiza danych, które już masz** — Twoich własnych skanów galaktyki i, dla obszarów nieodwiedzonych, publicznego API statystyk serwera (to samo źródło co narzędzia społeczności). Nie ma tu żadnego zapytania do gry ponad to, co i tak wysyła przeglądanie galaktyki.',
      'Wynik jest **czysto informacyjny** — lista i mapa temperatury, bez przycisku wysyłki. Decyzję o kolonizacji podejmujesz Ty, a samo wysłanie kolonizatora dzieje się w module Kolonizacja (FAB) przez natywny formularz gry.',
    ],
  },

  details: [
    'Trzy profile — Safe zone / Farm hub / PvP zone — to gotowe wagi; nie trzeba ręcznie stroić żadnego suwaka, żeby dostać sensowny ranking.',
    'Zasięg slotów do sprawdzenia podajesz jako listę albo zakres (np. „8" albo „12-15").',
    'Ta sama mapa temperatury (server-wide) stoi za wynikiem listy i za kolorami na podglądzie galaktyki — jeden model, dwa widoki.',
  ],

  screenshots: [
    { id: 'zones', caption: 'Wybór profilu: Safe zone / Farm hub / PvP zone.' },
    { id: 'list', caption: 'Ranking okolic w trybie Best spots / Longest streaks.' },
  ],

  codeRefs: [
    'src/domain/zoneScore.js',
    'src/domain/regions.js',
    'src/domain/heatField.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
