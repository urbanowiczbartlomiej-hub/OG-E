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
    'Żaden z pulsów nie gaśnie od samego otwarcia menu. Gaśnie dopiero po Twojej faktycznej akcji: udanej licytacji (na ok. 30 minut) albo odebraniu kontenera.',
  ],

  value: [
    'Codzienne mikro-zadania Kupca są łatwe do zapomnienia, a menu nie mówi, że coś czeka. Dwa osobne kolory od razu mówią, KTÓRE z dwóch zadań jeszcze zostało — bez klikania w środek, żeby się dowiedzieć.',
    'Chodzi o to, żebyś nie zapomniał o przedmiotach z Import/Eksportu — bywają dostępne częściej niż raz dziennie — ani o licytowaniu się z innymi graczami.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **poświata na już istniejącym menu i kafelkach** — czysto dodatkowa (`AGENTS.md` §1.7). Sam Kupiec, Licytator i Import/Eksport wyglądają i działają dokładnie jak zawsze, bez żadnej podmiany czy przesłonięcia.',
      'Stan liczony jest z tego, co strony Kupca i tak pokazują po Twoim własnym wejściu, plus jedna decyzja o TRYBIE przypominania zapisana lokalnie — zero odpytywania serwera w tle, zero automatycznej licytacji czy zakupu.',
    ],
  },

  details: [
    'Import/Eksport ma dwa tryby przełączane chipsami na stronie Kupca: przypominaj raz dziennie albo 6 razy dziennie (gdy trwa takie wydarzenie).',
    'Licytator świeci w typowych godzinach aukcji (~06:00–23:00), nie całą dobę.',
    'Włącza/wyłącza się w panelu Ustawień OG-E, kafelek „Trader pulse".',
  ],

  screenshots: [
    { id: 'menu', caption: 'Czerwony puls na wpisie Kupca w lewym menu — Import/Eksport wciąż czeka.' },
  ],

  codeRefs: [
    'src/features/traderMenuHighlight.js',
  ],

  status: 'drafted',
};
