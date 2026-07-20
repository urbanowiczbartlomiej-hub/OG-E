// @ts-check

// Discovery: src/features/whosSpyingPanel.js, src/domain/proximityDigest.js,
//   src/state/proximityReports.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'who-is-spying',
  category: 'spyglass',
  locale: 'pl',

  name: 'Kto Cię szpieguje',
  oneLiner:
    'Tabela na stronie wiadomości pokazująca, kto ostatnio sondował Twoje planety — najświeżsi i najbliżsi na górze.',

  idea: [
    'Na stronie wiadomości OG-E zbiera alerty „obca flota w pobliżu Twojej planety" w **jedną tabelę**: jeden wiersz na szpiega, z tym kto, jak dawno, jak często i skąd Cię zaczepia. Najświeższe i najbliższe zagrożenia są na górze, a szpieg z flotą **w Twoim własnym układzie** jest osobno oznaczony (dosięga Cię najszybciej).',
  ],

  value: [
    'OGame rozrzuca „kto Cię sondował" po pojedynczych wiadomościach, które łatwo przeoczyć. Tabela odpowiada na jedno pytanie obronne — **czy ktoś się mną interesuje i jak blisko jest?** — zanim przełoży się to na atak.',
  ],

  fairplay: {
    summary: [
      'Panel jest **czysto prezentacyjny**: pokazuje alerty, które sam otworzyłeś podczas normalnej gry. Nie inicjuje żadnego kliknięcia w grze, nie wysyła żądań, nie ma timera ani powiadomienia poza kartą.',
      'To ta sama wiedza, którą OGame już Ci pokazał — tylko **zebrana w jedną czytelną tabelę** zamiast rozsypana po wiadomościach.',
    ],
  },

  screenshots: [
    { id: 'panel', caption: 'Panel „Kto Cię szpieguje" na górze zakładki Szpieguj, nad przeglądem AGR.' },
    { id: 'same-system', caption: 'Wiersz oznaczony jako zagrożenie z Twojego układu — na górze listy.' },
  ],

  codeRefs: [
    'src/features/whosSpyingPanel.js',
    'src/domain/proximityDigest.js',
    'src/state/proximityReports.js',
  ],

  status: 'drafted',
};
