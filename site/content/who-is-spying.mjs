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
    'Alerty o cudzych sondach w jednej tabeli: kto Cię szpiegował, jak często i skąd.',
  order: 7,

  idea: [
    'Na stronie wiadomości, w zakładce **Szpieguj**, OG-E zbiera otwarte przez Ciebie alerty o obcych sondach w **jedną tabelę** — jeden wiersz na gracza: kiedy ostatnio, ile razy, skąd i przy których Twoich planetach. Zakres: **1d / 7d / 1m / 3m**.',
    'Kolor wiersza pokazuje **Danger** gracza, a kliknięcie nicku otwiera jego dossier — ten, kto Cię szpiegował, sam staje się celem. Ta sama tabela jest w Dashboardzie, w zakładce Spyglass (**Who\'s spying**).',
  ],

  value: [
    'OGame rozrzuca te alerty po pojedynczych wiadomościach. Tabela od razu odpowiada na pytanie: **czy ktoś się mną interesuje i jak blisko jest?**',
  ],

  fairplay: {
    summary: [
      'Tabela **tylko porządkuje** wiadomości, które gra już Ci pokazała. Nic nie klika, nic nie wysyła.',
      'Surowe alerty możesz podejrzeć (**show raw log**) — nic nie jest ukryte.',
    ],
  },

  details: [
    'Gracz szpiegujący z Twojego własnego układu jest oznaczony i stoi na górze.',
    '**Mute** wycisza gracza, którego sondy Cię nie obchodzą (np. sojusznika).',
    'Przycisk **Coords** / **Names** przełącza wiersze między współrzędnymi a nazwami planet.',
    'Tabela w grze jest domyślnie włączona; wyłączysz ją kafelkiem „Who\'s spying" w Ustawieniach OG-E (Display).',
  ],

  screenshots: [
    { id: 'panel', caption: 'Tabela na stronie wiadomości w grze: dwóch graczy, liczba alertów i Twoje planety, przy których się pojawili.' },
    { id: 'dashboard', caption: 'Ta sama tabela w Dashboardzie, w zakładce Spyglass.' },
  ],

  codeRefs: [
    'src/features/whosSpyingPanel.js',
    'src/domain/proximityDigest.js',
    'src/state/proximityReports.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
