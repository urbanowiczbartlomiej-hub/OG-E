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
    'Głośny przycisk w karcie, który przypomina, że Twój fleet-save wrócił i stoi odsłonięty — żebyś wysłał go od razu ponownie.',
  order: 6,

  idea: [
    'Gdy Twój fleet-save wróci i stanie odsłonięty na ciele, pojawia się **wyraźny, „głośniejszy" przycisk** widoczny na każdej stronie gry. Tapnięcie prowadzi Cię do właściwego ciała i pozwala od razu wysłać flotę ponownie; przy dłuższej bezczynności przycisk zaczyna pulsować, żeby zwrócić uwagę.',
    'Przypomnienie znika dopiero, gdy sprawę domkniesz (ponowna wysyłka albo ręczne zamknięcie) — nie kasuje się „samo z siebie".',
  ],

  value: [
    'Wrócona flota stojąca na postoju to łatwy łup. O ponownym fleet-save najłatwiej zapomnieć akurat wtedy, gdy wracasz do gry po przerwie — ten przycisk jest po to, żeby nie umknęło.',
  ],

  fairplay: {
    summary: [
      'Działa **wyłącznie przy otwartej karcie** i nic nie robi w tle: gdy karta jest ukryta, nawet nie pulsuje. Wie o wróconej flocie z **listy zdarzeń, którą gra i tak wyświetla** — nie z żadnego śledzenia serwera.',
      'To warstwa w karcie; ewentualne powiadomienie push, gdy jesteś offline, jest osobną funkcją opisaną uczciwie przy budziku.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Przycisk „Fleet reminder" — flota wróciła i stoi odsłonięta.' },
    { id: 'pulse', caption: 'Pulsowanie po dłuższej bezczynności — sygnał „odśwież i ogarnij flotę".' },
  ],

  codeRefs: [
    'src/features/alarmClock/guardian.js',
    'src/features/alarmClock/producer.js',
    'src/state/fleetReminders.js',
  ],

  status: 'drafted',
};
