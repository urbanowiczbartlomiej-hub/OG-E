// @ts-check

// Discovery: src/features/eventMenuHighlight.js (animacja wpisów eventowych
//   w lewym menu), src/features/rewardingWatcher.js (wykrywa "wszystko zrobione
//   na dziś" na stronie Rewarding i wygasza puls do resetu 14:00).

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'event-menu-highlight',
  category: 'game-ui',
  locale: 'pl',

  name: 'Event pulse',
  oneLiner:
    'Wyróżnia tymczasowe wydarzenia w lewym menu, które wyglądają jak zwykłe pozycje i łatwo je przeoczyć.',
  order: 4,

  idea: [
    'Gra co jakiś czas dokłada do lewego menu tymczasowe wydarzenia (np. nagrody, sklep z artefaktami). Wyglądają identycznie jak stałe pozycje, więc giną w tle. **Event pulse** animuje tylko te tymczasowe wpisy.',
    'Przy nagrodach puls gaśnie, gdy na ich stronie wszystko jest już odebrane; przy sklepie z artefaktami — gdy odbierzesz wszystkie progi, aż do końca wydarzenia.',
  ],

  value: [
    'Nie przegapisz dnia wydarzenia, więc nie tracisz nagród.',
  ],

  fairplay: {
    summary: [
      'To tylko **wizualne podświetlenie istniejącego elementu menu** — nic nie jest ukrywane ani zasłaniane.',
      'Stan „odebrane" OG-E czyta ze strony wydarzenia, którą sam otwierasz — nic nie jest sprawdzane w tle.',
    ],
  },

  details: [
    'Domyślnie włączone; wyłączysz kafelkiem „Event pulse" w Ustawieniach OG-E.',
  ],

  screenshots: [
    { id: 'menu', caption: 'Pulsujący wpis tymczasowego wydarzenia w lewym menu.' },
  ],

  codeRefs: [
    'src/features/eventMenuHighlight.js',
    'src/features/rewardingWatcher.js',
  ],

  status: 'drafted',
};
