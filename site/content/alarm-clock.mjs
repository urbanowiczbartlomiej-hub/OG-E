// @ts-check

// Discovery: src/features/alarmClock/index.js, producer.js, eventList.js,
//   src/sync/alarmClock.js, src/sync/ntfyReconciler.js.
// UWAGA: to JEDYNA funkcja świadomie graniczna — fairplay.borderline = true.
//   Cross-check: docs/fair-play.md §1.4 (przypomnienie ustawiane przez gracza,
//   presence-gated) oraz "OG-E's own, stricter internal rules".

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'alarm-clock',
  category: 'alarms',
  locale: 'pl',

  name: 'Budzik (alarm clock)',
  oneLiner:
    'Przypomnienie, które sam ustawiasz na powrót floty — dzwoni na telefonie o czasie, który wyznacza Twoja własna wysyłka.',
  flagship: true,
  order: 1,

  idea: [
    'Na liście zdarzeń gry każdy wiersz floty dostaje mały, klikalny znacznik w komórce z czasem przylotu. Tapasz go, żeby **uzbroić przypomnienie** względem tego lotu (np. na moment powrotu fleet-save), a drugie tapnięcie je zdejmuje. Fale powracających ekspedycji są rozpoznawane i sterowane jako całość — jeden znacznik na całą serię.',
    'Push jest **wstawiany do kolejki ntfy.sh** (usługi powiadomień, którą sam konfigurujesz tokenem w Ustawieniach) z czasem doręczenia wyliczonym z Twojej wysyłki. To ntfy trzyma i doręcza wiadomość o wyznaczonej godzinie — OG-E po ustawieniu przypomnienia niczego nie pilnuje.',
  ],

  value: [
    'Powrót floty czy koniec fleet-save trafia często w środek nocy albo w środek dnia pracy. Zamiast liczyć w głowie i wracać co chwilę, ustawiasz jedno przypomnienie i telefon odezwie się dokładnie wtedy, gdy flota ląduje.',
  ],

  fairplay: {
    borderline: true,
    summary: [
      'Mówimy o tym **wprost: to nasza jedyna świadomie graniczna funkcja**. Dlatego trzymamy ją po bezpiecznej stronie i zawężamy mocniej, niż wymagają reguły.',
      'To **przypomnienie ustawiane przez gracza dla jednej konkretnej wysyłki** — nie automat reagujący na zdarzenia w grze. Czas dzwonka wynika z Twojej własnej akcji (Twojej wysyłki), a nie z monitorowania serwera.',
      'Jest **presence-gated**: uzbrajane tylko wtedy, gdy jesteś obecny w grze. OG-E nie obserwuje gry w Twoim imieniu, gdy Cię nie ma — nie przeładowuje strony, nie czyta listy zdarzeń pod kątem wrogich flot, nie ma dźwięku, migającego tytułu karty ani powiadomień systemowych.',
      'Czas przylotu OG-E czyta **pasywnie z listy zdarzeń, którą gra i tak wyświetla** — bez ruchu do serwera gry. Sam push idzie przez ntfy.sh, usługę skonfigurowaną przez Ciebie, poza serwerem gry.',
    ],
  },

  details: [
    'Fleet-save jest wykrywany i planowany automatycznie; slot można anulować tylko w jego oknie anulowania tuż przed doręczeniem.',
    'Konfiguracja i tokeny — w panelu Ustawień OG-E; bez tokena ntfy budzik nie wysyła nic na zewnątrz.',
  ],

  screenshots: [
    { id: 'badge', caption: 'Klikalny znacznik budzika w komórce z czasem przylotu na liście zdarzeń.' },
    { id: 'wave', caption: 'Fala powracających ekspedycji sterowana jako jedna seria.' },
  ],

  codeRefs: [
    'src/features/alarmClock/index.js',
    'src/features/alarmClock/producer.js',
    'src/features/alarmClock/eventList.js',
    'src/sync/alarmClock.js',
    'src/sync/ntfyReconciler.js',
  ],

  status: 'drafted',
};
