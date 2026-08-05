// @ts-check

// Discovery: src/features/dashboard/index.js (zakładka Spyglass),
//   src/features/sendSpy/*, src/domain/spyScan.js, src/state/watchList.js.
// To STRONA-WSTĘP całego rozdziału: model myślowy (dwa kanały + lista
//   obserwowanych) i spis sześciu pytań, na które odpowiadają kolejne strony.
//   Szczegóły algorytmów NIE tutaj — one żyją na stronach szczegółowych.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass',
  category: 'spyglass',
  locale: 'pl',

  name: 'Spyglass — wywiad',
  oneLiner:
    'Kompletny wywiad o graczach serwera: kto jest groźny, kogo warto uderzyć, gdzie leży łup i kiedy właściciela nie ma przy komputerze.',
  flagship: true,
  order: 1,

  idea: [
    'Spyglass ma **dwa źródła wiedzy i jeden kręgosłup**. Kanał galaktyki (`galaxy`) to zwykłe wejście do układu — darmowe, niewidoczne dla celu, daje znaczniki aktywności i informację o księżycach. Kanał sond (`probes`) to normalny raport szpiegowski — kosztuje sondy i cel go widzi, ale pokazuje flotę, obronę i surowce. Kręgosłupem jest **lista obserwowanych** (`Watchlist`): kogo tam wrzucisz, tym zajmuje się przycisk w grze i temu graczowi rośnie dossier.',
    'Funkcja żyje w dwóch miejscach. Pływający przycisk w grze proponuje **jedno następne** działanie wywiadowcze. Zakładka `Spyglass` w panelu OG-E jest czytelnią: ranking serwera, dossier, mapa i panel „kto Cię szpieguje" — bez ani jednego przycisku wysyłki. Ranking zagrożenia działa od pierwszego uruchomienia, z publicznych statystyk serwera; skanowanie tylko go pogłębia.',
  ],

  value: [
    'Wywiad w OGame to normalnie praca ręczna: setka raportów w skrzynce, notatnik z koordynatami, pamięć o tym, kto był groźny pół roku temu. Spyglass zamienia to w **sześć pytań z gotowymi odpowiedziami** — i tyle wystarczy wiedzieć, żeby z niego korzystać. Reszta rozdziału to szczegóły dla ciekawych, nie instrukcja obsługi.',
  ],

  fairplay: {
    summary: [
      'Wszystko, co Spyglass wie, pochodzi z trzech miejsc: **publicznych plików statystyk serwera** (tych samych, z których korzystają narzędzia społeczności), **stron gry, które sam otworzyłeś** (raporty, widok galaktyki, highscore sojuszy) i tego, co **sam wysłałeś**. Nie ma skanowania w tle: bez otwartej karty gry OG-E nie robi nic, a pliki statystyk mają termin świeżości i nie są odpytywane cyklicznie.',
      'Zakładka `Spyglass` to **czytelnia bez spustu** — nie ma w niej żadnej wysyłki. Sondę można wysłać wyłącznie z gry, świadomym tapnięciem na jedno ciało, przez natywny dwuetapowy formularz wysyłki floty. Nie istnieje przycisk „przeskanuj wszystko" ani żadna akcja obejmująca wiele celów.',
    ],
  },

  details: [
    '**Kogo unikać, a kogo można ruszyć?** — ranking zagrożenia (`Danger`).',
    '**Co obejrzeć jako następne?** — przycisk `Look` / `Spy` / `Strike`.',
    '**Czy warto go uderzyć i gdzie leży łup?** — dossier gracza.',
    '**Kiedy go nie ma?** — rutyna i okna offline.',
    '**Kto mnie dosięgnie?** — mapa pozycji i zasięg.',
    '**Kto mnie obwąchuje?** — panel „kto Cię szpieguje".',
  ],

  demo: {
    id: 'watchlist-cards',
    caption: 'Prawdziwy pasek kart obserwowanych na zmyślonej obsadzie — **werdykty liczy ten sam kod, co w rozszerzeniu**. Cztery karty, cztery różne odpowiedzi: Pipit jest gotową farmą, Boro jest pełny, ale mógłby odbić atak, u Kestrela nie ma teraz czego brać, a o Ilexie nie wiadomo nic, bo nikt go jeszcze nie obejrzał.',
  },

  screenshots: [
    { id: 'tab', caption: 'Zakładka Spyglass: lista obserwowanych, ustawienia skanów, panel „kto Cię szpieguje" i ranking graczy.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/sendSpy/index.js',
    'src/domain/spyScan.js',
    'src/state/watchList.js',
  ],

  status: 'drafted',
};
