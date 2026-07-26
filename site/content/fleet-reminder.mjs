// @ts-check

// Discovery: src/features/alarmClock/{guardian,producer}.js,
//   src/state/fleetReminders.js.
// UWAGA: to warstwa IN-TAB (guardian). Push/ntfy offline to osobna funkcja
// (budzik) — patrz [[alarm-clock]].

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'fleet-reminder',
  category: 'fab',
  locale: 'pl',

  name: 'Przypomnienie o flocie',
  oneLiner:
    'Przycisk w karcie, który przypomina, że Twój fleet-save wrócił i stoi odsłonięty, żebyś wysłał go od razu ponownie.',
  order: 6,

  idea: [
    'Gdy Twój fleet-save wróci i będzie dostępny na planecie, pojawia się wyraźny, nowy przycisk przypominający o flocie. Włączysz go ręcznie w panelu Fleet1, albo włączy się sam, gdy FS wyląduje.',
    'Wyłączysz go, wysyłając ponownie flotę tym przyciskiem — użyje wtedy konfiguracji AGR dla fleet-save — albo ręcznie: w panelu Fleet1 lub długim przytrzymaniem przycisku. Tapnięcie prowadzi Cię do właściwej planety i pozwala od razu wysłać flotę ponownie; przy dłuższej bezczynności przycisk zaczyna pulsować, żeby zwrócić uwagę.',
    'Działa tylko na karcie, na której jesteś — jeśli jesteś na innej karcie, nie zostaniesz o tym poinformowany. Nie odtwarza żadnych dźwięków.',
  ],

  value: [
    'Wrócona flota stojąca na postoju to łatwy łup, a o jej ponownej wysyłce łatwo zapomnieć, nawet gdy jesteś aktywny online, ale zajęty czym innym. Ten przycisk pilnuje, żebyś wysłał FS zanim pójdziesz offline — żeby nic Ci nie umknęło.',
  ],

  fairplay: {
    summary: [
      'Działa **wyłącznie przy otwartej karcie** i nic nie robi w tle: gdy karta jest ukryta, nawet nie pulsuje. Wie o wróconej flocie z **listy zdarzeń, którą gra i tak wyświetla** — nie z żadnego śledzenia serwera.',
      'To warstwa w karcie; ewentualne powiadomienie push, gdy jesteś offline, jest osobną funkcją opisaną uczciwie przy budziku.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Przycisk „Fleet Reminder" w panelu Fleet1 — flota czeka na ponowną wysyłkę.' },
    { id: 'pulse', caption: 'Podświetlony orb „Fleet Reminder" obok aktywnego przycisku innej funkcji — sygnał, że flota wciąż czeka.' },
  ],

  codeRefs: [
    'src/features/alarmClock/guardian.js',
    'src/features/alarmClock/producer.js',
    'src/state/fleetReminders.js',
  ],

  status: 'drafted',
};
