// @ts-check

// Discovery: src/features/alarmClock/index.js, producer.js, eventList.js,
//   src/sync/alarmClock.js, src/sync/ntfyReconciler.js.
// UWAGA: to JEDYNA funkcja świadomie graniczna — fairplay.borderline = true.
//   Cross-check: docs/fair-play.md §1.4 (przypomnienie ustawiane przez gracza,
//   presence-gated) oraz "OG-E's own, stricter internal rules".

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'alarm-clock',
  category: 'dashboard',
  locale: 'pl',

  name: 'Budzik (alarm clock)',
  oneLiner:
    'Telefon zadzwoni, gdy wraca Twój fleet-save albo fala ekspedycji — o czasie, który wynika z Twojej własnej wysyłki.',
  flagship: true,
  order: 3,

  idea: [
    'Budzik planuje powiadomienia na telefon przez **ntfy.sh** — bezpłatną aplikację do powiadomień. Potrzebne są dwa tokeny: **ntfy** (zakładka **Alarm clock** w Dashboardzie) i **GitHub** (zakładka **Sync**) — w Twoim prywatnym giście budzik trzyma listę przypomnień. Potem włączasz **Enable alarm clock** i subskrybujesz swój temat na telefonie.',
    'Trzy rodzaje przypomnień, każdy włączasz osobno: **Fleet-save** (wykrywany sam — duża flota w długim locie), **Expeditions** (cała fala powrotów jako jedna seria) i **Ad-hoc** (dzwonek ustawiony ręcznie na dowolny lot z listy zdarzeń). Dla każdego wybierasz, kiedy ma dzwonić względem lądowania.',
    'Zaplanowane przypomnienia dzwonią także przy zamkniętej grze. Wszystkie widzisz w podzakładce **Reminders set**.',
  ],

  value: [
    'Fleet-save wraca o 3 w nocy albo w środku pracy. Zamiast liczyć w głowie i wracać do gry „na wszelki wypadek", ustawiasz to raz — telefon odezwie się wtedy, gdy flota ląduje.',
  ],

  fairplay: {
    borderline: true,
    summary: [
      'Mówimy wprost: **to nasza jedyna funkcja na granicy zasad**, dlatego trzymamy ją wąsko.',
      'To **budzik na czas, który już znasz** z własnej wysyłki — nie strażnik gry. Nie obserwuje wrogich flot i nie przeładowuje strony. Przypomnienia planuje tylko wtedy, gdy sam masz otwartą grę.',
      'Czas lądowania OG-E czyta z listy zdarzeń, którą gra i tak pokazuje. Powiadomienie wysyła ntfy.sh, a listę przypomnień przechowuje Twój gist — usługi, które sam konfigurujesz. Serwer gry nie ma z tym nic wspólnego.',
    ],
  },

  details: [
    'Fleet-save to domyślnie flota od 100 000 statków w locie dłuższym niż 10 minut — oba progi zmienisz w ustawieniach.',
    '**Landed-fleet reminder** dzwoni (domyślnie 20 min po lądowaniu), jeśli fleet-save po wylądowaniu wciąż stoi na planecie.',
    'ntfy planuje najwyżej 3 dni do przodu. Dalszy fleet-save czy falę OG-E zaplanuje przy kolejnym wejściu do gry; ad-hoc dalej niż 3 dni się nie da.',
    'Gdy przypomnienia nie da się zaplanować (np. wyczerpany dzienny limit ntfy), w grze pojawia się wyraźny komunikat.',
  ],

  screenshots: [
    { id: 'reminders', caption: 'Reminders set — zaplanowane dzwonki: fala ekspedycji, lot ad-hoc i fleet-save.' },
    { id: 'fleetsave', caption: 'Ustawienia fleet-save: od ilu statków flota liczy się jako FS, kiedy dzwonić, treść powiadomienia i Landed-fleet reminder.' },
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
