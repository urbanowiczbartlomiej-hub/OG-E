// @ts-check

// Discovery: src/features/traderMenuHighlight.js — dwa niezależne
//   przypomnienia (żółte: Licytator, czerwone: Import/Eksport), gasnące
//   dopiero po RZECZYWISTEJ akcji gracza, nie po samym otwarciu menu.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'trader-menu-highlight',
  category: 'game-ui',
  locale: 'pl',

  name: 'Trader pulse',
  oneLiner:
    'Dwa niezależne kolorowe podświetlenia na menu Kupca — żółte przypomina o licytacji, czerwone o codziennym imporcie/eksporcie — gasną dopiero, gdy naprawdę to zrobisz.',
  order: 5,

  idea: [
    'Dwa codzienne obowiązki Kupca giną w tle, bo wpis menu wygląda tak samo, niezależnie od tego, czy coś jest do zrobienia. Trader pulse dokłada dwa niezależne, kolorowe poświaty na przycisku menu i na kafelkach przeglądu Kupca: **żółtą** dla Licytatora i **czerwoną** dla Import/Eksportu.',
    'Żaden z pulsów nie gaśnie od samego otwarcia menu — to nic nie dowodzi (przycisk może być wyłączony, serwer może odrzucić). Gaśnie dopiero po Twojej faktycznej akcji: udanej licytacji (na ok. 30 minut, przybliżenie długości aukcji) albo odebraniu kontenera.',
  ],

  value: [
    'Codzienne mikro-zadania Kupca są łatwe do zapomnienia, a menu nie mówi, że coś czeka. Dwa osobne kolory od razu mówią, KTÓRE z dwóch zadań jeszcze zostało — bez klikania w środek, żeby się dowiedzieć.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **poświata na już istniejącym menu i kafelkach** — czysto dodatkowa (`AGENTS.md` §1.7). Sam Kupiec, Licytator i Import/Eksport wyglądają i działają dokładnie jak zawsze, bez żadnej podmiany czy przesłonięcia.',
      'Stan liczony jest z tego, co strony Kupca i tak pokazują po Twoim własnym wejściu, plus jedna decyzja o TRYBIE (dzienny/questowy) zapisana lokalnie — zero odpytywania serwera w tle, zero automatycznej licytacji czy zakupu.',
    ],
  },

  details: [
    'Import/Eksport ma dwa tryby przełączane chipami na stronie Kupca: dzienny kontener (widoczny od 14:00) albo tryb pod aktualny quest.',
    'Licytator świeci w typowych godzinach aukcji (~06:00–23:00), nie całą dobę.',
    'Włącza/wyłącza się w panelu Ustawień OG-E, kafelek „Trader pulse".',
  ],

  screenshots: [
    { id: 'menu', caption: 'Żółty i czerwony puls na menu Kupca.' },
  ],

  codeRefs: [
    'src/features/traderMenuHighlight.js',
  ],

  status: 'drafted',
};
