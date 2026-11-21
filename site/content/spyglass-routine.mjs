// @ts-check

// Discovery: src/domain/routine.js (doba, szczyt aktywności, odliczanie
//   własnych sond), src/domain/presence.js (obecność, okna offline, próg
//   pokrycia), src/domain/presenceLedger.js (godzinowa historia per dzień),
//   src/domain/shiftPattern.js (detektor zmianowości, weekendy),
//   src/state/activityObs.js (pasywny zapis znaczników).
// UWAGA: „aktywność" = ostatnia interakcja z ciałem, NIE „online". Uczciwość
//   statystyczna (odmowa tezy przy małej próbce) jest częścią funkcji — pisz o niej.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-routine',
  category: 'spyglass',
  locale: 'pl',

  name: 'Rutyna i okna offline',
  oneLiner:
    'Ze znaczników aktywności Spyglass składa dzień przeciwnika: kiedy zwykle gra, a kiedy stale go nie ma.',
  flagship: true,
  order: 5,

  idea: [
    'Galaktyka i raporty szpiegowskie pokazują, **jak dawno** coś działo się na planecie. OG-E zbiera te ślady i rysuje dzień gracza z nazwanym szczytem — np. `evenings 19–23`.',
    'Osobno szuka **okien offline**: co najmniej trzech godzin z rzędu, w których dobrze patrzyłeś i konsekwentnie nic się nie działo. Za mało danych? Strona mówi wprost, że trzeba patrzeć częściej, zamiast zgadywać.',
  ],

  value: [
    'Wiedzieć, że ktoś ma flotę, to jedno. Wiedzieć, **kiedy jej nie pilnuje** — to decyduje, czy atak się opłaci.',
  ],

  fairplay: {
    summary: [
      'Liczy tylko znaczniki aktywności, które gra sama pokazała — w Galaktyce i w raportach, które otworzyłeś. Bez dodatkowych zapytań, bez timerów.',
      'Ślady po **Twoich własnych sondach są odejmowane**, żeby nie mierzyć własnej aktywności.',
    ],
  },

  details: [
    'Zakres: `30d`, `90d` (domyślnie), `6mo`, `All`; możesz ograniczyć do dni roboczych (`Mon–Fri`).',
    'Blada komórka w siatce znaczy „mało obserwacji", a nie „spokój".',
  ],

  screenshots: [
    { id: 'presence', caption: 'Rutyna: dzień gracza ze szczytem aktywności i siatka tygodni z oknami offline.' },
  ],

  codeRefs: [
    'src/domain/routine.js',
    'src/domain/presence.js',
    'src/domain/presenceLedger.js',
    'src/domain/shiftPattern.js',
    'src/state/activityObs.js',
  ],

  status: 'drafted',
};
