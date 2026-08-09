// @ts-check

// Discovery: src/features/badges/index.js (obserwator DOM: #eventContent +
//   #planetList), src/features/badges/pure.js (klasyfikacja, czysta),
//   src/state/fleetSaveSet.js (kanał flag fleet-save z alarmClock).
// Persisted key legacy: "expeditionBadges" (settings), pokrywa dziś WSZYSTKIE
//   kategorie misji, nie tylko ekspedycje — kept dla zgodności zapisanego stanu.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'planet-markers',
  category: 'game-ui',
  locale: 'pl',

  name: 'Znaczniki na planetach',
  oneLiner:
    'Maleńkie kropki statusu obok każdej planety i księżyca na pasku po prawej — jednym rzutem oka widzisz, gdzie leci ekspedycja, gdzie fleet-save, a gdzie nadciąga atak.',
  order: 3,

  idea: [
    'Przy każdym ciele na pasku planet dostawiane są maks. trzy małe znaczniki, po jednym na kategorię, uszeregowane wg ważności: nadlatujący atak (czerwone **„!!!"**), Twoja własna agresja w locie, fleet-save w locie albo już wylądowany fleet-save (**„FR"** — przypomnienie o flocie), ekspedycja, logistyka (transport / rozstawienie / ACS obrony) i recykling. Znaczniki to kropki bez liczby ani kierunku — informacja „coś tu się dzieje", która nie narusza Twoich ładnych skinów planet.',
    'Wszystko liczone jest z tego, co gra już wyświetla na liście zdarzeń — żaden dodatkowy request nie leci do serwera. Ikona „?" nad listą planet pokazuje legendę pod hoverem/tapnięciem.',
  ],

  value: [
    'Bez znaczników jedyny sposób, żeby wiedzieć „co się dzieje na której planecie", to otwieranie listy zdarzeń i długotrwałe analizowanie. Znaczniki przenoszą ten stan tam, gdzie i tak patrzysz — na pasek planet — więc rzut oka wystarcza zamiast osobnego sprawdzania.',
  ],

  fairplay: {
    summary: [
      'Czysto **kosmetyczne stylowanie już wyświetlonego DOM-u** — źródłem jest lista zdarzeń gry (`#eventContent`) i pasek planet (`#planetList`), które i tak masz przed oczami. Zero własnego zapytania do serwera, zero odpytywania w tle.',
    ],
  },

  details: [
    'Włącza/wyłącza się w panelu Ustawień OG-E, kafelek „Planet markers".',
  ],

  screenshots: [
    { id: 'legend', caption: 'Legenda znaczników pod ikoną „?" nad listą planet.' },
  ],

  codeRefs: [
    'src/features/badges/index.js',
    'src/features/badges/pure.js',
    'src/state/fleetSaveSet.js',
  ],

  status: 'drafted',
};
