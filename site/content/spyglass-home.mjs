// @ts-check

// Discovery: src/domain/homeWatch.js (systemy własne, diff sąsiadów, zasięg
//   gracza `rankHomeNeighbours`, koalicje sojuszu `findHomeCoalitions`,
//   wykluczenie swoich `friendlyNeighbourIds`), src/features/homeWatch/ (czytnik
//   in-game: scans → diff), src/state/homeWatch.js (baseline + log przybyć,
//   wygasanie flagi NEW), src/features/dashboard/homeWatch.js (karta).
// UWAGA: to jedyna funkcja Spyglassa patrząca DO WEWNĄTRZ ("kto może uderzyć w
//   MNIE"), nie na zewnątrz. Nie proponuje ataku i nie ma w sobie żadnej akcji.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-home',
  category: 'spyglass',
  locale: 'pl',

  name: 'Sąsiedzi (Your neighbours)',
  oneLiner:
    'Mówi, kto właśnie wprowadził się do układów, w których masz planety — i kto siedzi już obok Ciebie w kilku miejscach naraz.',
  flagship: true,
  order: 6,

  idea: [
    'Przy każdym Twoim spojrzeniu na Galaktykę OG-E porównuje układ z tym, co widział poprzednio. Gdy w układzie z Twoją planetą lub księżycem pojawi się ktoś nowy, w Spyglassie zapala się **Your neighbours** z licznikiem nowych sąsiadów.',
    'Jeden wiersz na sąsiada, kolor to jego **Danger**. Jeśli gracz siedzi w kilku Twoich układach, wiersz pokazuje **×N** — i to jest najważniejsze: kto jest w trzech Twoich układach, może uderzyć w trzy miejsca prawie bez czasu lotu.',
    'Przycisk Spyglass sam podsuwa Twoje układy do obejrzenia — domyślnie raz na dobę — a po obchodzie pokazuje **Home**, jeśli są nowi sąsiedzi.',
  ],

  value: [
    'Groźny sąsiad tuż obok Twojego księżyca nie pojawia się w żadnym rankingu. Dowiesz się o nim, zanim stracisz flotę, a nie z raportu wojennego.',
  ],

  fairplay: {
    summary: [
      'Nowych sąsiadów OG-E wykrywa wyłącznie z **Twojego własnego przeglądania Galaktyki**; listę uzupełnia publiczne API OGame. Nic nie jest sprawdzane w tle.',
      'Funkcja tylko informuje — nie ma w niej żadnej akcji w grze. Twój sojusz i przyjaciele nie są liczeni jako zagrożenie.',
    ],
  },

  details: [
    'Częstotliwość ustawiasz polem **Neighbours** w ustawieniach Spyglassa (w godzinach, `0` = wyłączone).',
    'Pierwsze spojrzenie na układ tylko zapamiętuje stan — nie zasypie Cię „nowymi" sąsiadami pierwszego dnia.',
    'Oznaczenie NEW gaśnie dobę po tym, jak je zobaczysz (najpóźniej po 7 dniach).',
  ],

  screenshots: [
    { id: 'card', caption: 'Panel „Your neighbours" w Spyglassie — nowe przybycia i sąsiedzi obecni w kilku Twoich układach.' },
  ],

  demo: {
    id: 'home-watch',
    caption: 'Prawdziwy komponent OG-E na zmyślonych danych. Kolor krawędzi = Danger, `×N` = w ilu Twoich układach siedzi ten gracz.',
  },

  codeRefs: [
    'src/domain/homeWatch.js',
    'src/features/homeWatch/index.js',
    'src/state/homeWatch.js',
    'src/features/dashboard/homeWatch.js',
  ],

  status: 'drafted',
};
