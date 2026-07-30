// @ts-check

// Discovery: src/features/whosSpyingPanel.js, src/domain/proximityDigest.js,
//   src/state/proximityReports.js, src/features/dashboard/index.js
//   (ten sam materiał jako panel na zakładce Spyglass).

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'who-is-spying',
  category: 'spyglass',
  locale: 'pl',

  name: 'Kto Cię szpieguje',
  oneLiner:
    'Alerty „obca flota w pobliżu" zebrane w jedną tabelę: kto Cię ostatnio sondował, jak często i z jakich układów — najświeżsi i najbliżsi na górze.',
  order: 7,

  idea: [
    'Na stronie wiadomości OG-E zbiera alerty „obca flota w pobliżu Twojej planety" w **jedną tabelę**: jeden wiersz na szpiega, z tym kto, jak dawno, jak często i skąd Cię zaczepia. Najświeższe i najbliższe zagrożenia są na górze, a szpieg z flotą **w Twoim własnym układzie** jest osobno oznaczony, bo dosięga Cię najszybciej.',
    'Ten sam materiał wraca jako panel na zakładce `Spyglass`, z zakresami `1d / 7d / 1m / 3m`. Stamtąd jednym tapnięciem wrzucasz szpiega na listę obserwowanych albo otwierasz jego dossier — czyli **odwracasz role**: ten, kto Cię obwąchał, staje się celem Twojego wywiadu.',
  ],

  value: [
    'OGame rozrzuca „kto Cię sondował" po pojedynczych wiadomościach, które łatwo przeoczyć. Tabela odpowiada na jedno pytanie obronne — **czy ktoś się mną interesuje i jak blisko jest?** — zanim przełoży się to na atak. A ponieważ prowadzi prosto do dossier, ta sama informacja od razu staje się materiałem do kontrataku.',
  ],

  fairplay: {
    summary: [
      'Panel jest **czysto prezentacyjny**: pokazuje alerty, które sam otworzyłeś podczas normalnej gry. Nie inicjuje żadnego kliknięcia w grze, nie wysyła żądań, nie ma timera ani powiadomienia poza kartą.',
      'To ta sama wiedza, którą OGame już Ci pokazał — tylko **zebrana w jedną czytelną tabelę** zamiast rozsypana po wiadomościach. Możesz zresztą podejrzeć surowe alerty, z których powstały wiersze.',
    ],
  },

  details: [
    'Przełącznik `Coords` / `Names` zmienia wiersze między koordynatami a nazwami ciał — jak Ci wygodniej czytać.',
    '`show raw log` rozwija surowe alerty, na których oparty jest wiersz — nic nie jest ukryte przed sprawdzeniem.',
  ],

  screenshots: [
    { id: 'dashboard', caption: 'Panel „kto Cię szpieguje" na zakładce Spyglass: wiersz na szpiega, zakres czasu i wejście na listę obserwowanych albo w dossier.' },
    { id: 'panel', caption: 'Ta sama tabela na stronie wiadomości w grze, nad przeglądem raportów AGR.' },
    { id: 'same-system', caption: 'Wiersz oznaczony jako zagrożenie z Twojego własnego układu — zawsze na górze listy.' },
  ],

  codeRefs: [
    'src/features/whosSpyingPanel.js',
    'src/domain/proximityDigest.js',
    'src/state/proximityReports.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
