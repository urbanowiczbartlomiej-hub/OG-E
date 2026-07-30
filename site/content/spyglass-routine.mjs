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
    'Ze znaczników aktywności, które i tak widzisz, Spyglass składa dobę i tygodnie przeciwnika: kiedy zwykle jest przy grze, a kiedy stabilnie go nie ma.',
  flagship: true,
  order: 5,

  idea: [
    'Widok galaktyki i raport szpiegowski pokazują jedną rzecz: **jak dawno** na tym ciele coś się działo. OG-E przelicza ten wiek na punkt w czasie i po kilkudziesięciu takich punktach rysuje dobę gracza, nazywając jego szczyt — na przykład `evenings 19–23`. Znaczniki wywołane Twoimi własnymi sondami są przy tym odliczane, a kilka spojrzeń na tę samą sesję liczy się jako jedna.',
    'Drugi blok szuka **ciszy, nie ruchu**: cichy podgląd przy dobrym pokryciu jest mocnym dowodem nieobecności. Okno offline zostaje ogłoszone dopiero wtedy, gdy trzy kolejne godziny mają jednocześnie dość podglądów i konsekwentną ciszę — inaczej strona mówi wprost „patrz częściej". Te same dane można obejrzeć jako tygodnie, jako dobę, jako dzień×godzinę albo jako cykl miesiąca, a osobny detektor sprawdza, czy gracz **rotuje zmiany**.',
  ],

  value: [
    'To różnica między „wiem, że ma flotę" a „wiem, kiedy jej nie pilnuje" — i dokładnie ta różnica decyduje o tym, czy nalot się opłaca. Zamiast zgadywać z jednego raportu, dostajesz rytm przeciwnika, a przy zbyt małej próbce **uczciwą informację, że jeszcze nic z tego nie wynika**.',
  ],

  fairplay: {
    summary: [
      'Ten blok jest **czysto pasywny i czysto obliczeniowy**: liczy tylko znaczniki, które gra sama wyrysowała na stronach, jakie i tak otworzyłeś. Zero sond, zero dodatkowych żądań, zero timerów — nic nie „patrzy" za Ciebie w tle, a bez Twojego przeglądania galaktyki historia po prostu nie rośnie.',
      'Znaczniki wywołane **Twoimi własnymi sondami są odejmowane**, żeby nie mierzyć własnego rytmu. Strona nie udaje też wiedzy, której nie ma: „aktywność" to ostatnia interakcja z ciałem, a nie status „online" — i jest tak podpisana. Dopóki próbka jest za mała, OG-E odmawia postawienia tezy, zamiast dorysować wykres.',
      'Historia jest trzymana jako **godzinowa maska „był / cisza" per dzień** — bez koordynat i bez treści raportów. Dzięki temu da się ją scalać między Twoimi urządzeniami i (jeśli włączysz) z sojusznikami, a scalony materiał jest wyłącznie do podglądu: nie wpływa ani na ocenę zagrożenia, ani na plan skanów.',
    ],
  },

  details: [
    'Szczyt doby to najlepsze **pięć kolejnych godzin**; nazwa (`nights`, `mornings`, `afternoons`, `evenings`) bierze się z jej środka. Poniżej trzech obserwacji nie ma nic, przy małej próbce jest tylko „hint" bez etykiety.',
    'Okno offline wymaga **min. trzech kolejnych godzin**, każdej z realnym pokryciem i praktycznie bez śladów aktywności. Jednorazowy błysk w środku nie unieważnia okna, ale zostaje wypisany osobno.',
    'Detektor zmianowości potrzebuje **min. pięciu tygodni z rozpoznaną fazą** — przy mniejszej próbce mówi wprost „too thin". Weekendy ocenia osobno (bywa, że ktoś jest przy grze tylko w co drugą sobotę).',
    'Zakres analizy przełączasz między `30d`, `90d`, `6mo` i `All`, a dni możesz zawęzić do `Mon–Fri`, żeby weekend nie rozmywał rytmu pracy.',
    'W siatce jaśniejsza komórka znaczy „mało podglądów", nie „spokój" — pokrycie i wynik są rozdzielone, żeby brak danych nie wyglądał jak wniosek.',
  ],

  screenshots: [
    { id: 'presence', caption: 'Rutyna i obecność: doba gracza ze szczytem aktywności, ocena pokrycia i siatka tygodni z oknami offline.' },
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
