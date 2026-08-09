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
    'Podświetla tymczasowe wpisy wydarzeń w lewym menu, które wyglądają identycznie jak stałe pozycje Kupiec/Oficerowie/Sklep i łatwo je przeoczyć.',
  order: 4,

  idea: [
    'Gra od czasu do czasu wstawia do lewego paska tymczasowe wpisy (okna nagród, konkursy, sezonowe pozycje) pod tą samą klasą, którą mają stałe, zawsze obecne wpisy Kupiec/Oficerowie/Sklep. Wyglądając identycznie, giną w tle — Event pulse animuje TYLKO te tymczasowe wpisy, więc odróżniają się od stałych sąsiadów.',
    'Puls gaśnie sam, gdy wykryjemy, że wszystkie dzienne zadania na stronie Rewarding są już zrobione — nie trzeba go ręcznie kasować, żeby przestał przypominać o czymś, co już zrobiłeś.',
  ],

  value: [
    'Tymczasowe wydarzenia są łatwe do przegapienia w codziennym pośpiechu — wyglądają tak samo jak menu, które i tak ignorujesz. Event pulse daje im wyróżnienie, żebyś nie pominął ani jednego dnia, w którym wydarzenie jest już dostępne — dzięki temu zawsze odbierzesz wszystkie możliwe nagrody.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **wizualne podświetlenie już istniejącego elementu menu** — czysto dodatkowe (`AGENTS.md` §1.7), nic nie ukrywa ani nie zasłania: Kupiec, Oficerowie i Sklep wyglądają dokładnie tak jak zawsze.',
      'Stan „zrobione na dziś" czytany jest z tego, co strona Rewarding i tak pokazuje po Twoim własnym otwarciu — nic nie jest odpytywane w tle.',
    ],
  },

  details: [
    'Włącza/wyłącza się w panelu Ustawień OG-E, kafelek „Event pulse".',
  ],

  screenshots: [
    { id: 'menu', caption: 'Animowany wpis tymczasowego wydarzenia w lewym menu.' },
  ],

  codeRefs: [
    'src/features/eventMenuHighlight.js',
    'src/features/rewardingWatcher.js',
  ],

  status: 'drafted',
};
