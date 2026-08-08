// @ts-check

// Discovery: src/features/threatHighlight/ — pełnoekranowy baner W OTWARTEJ
//   karcie gry, w chwili gdy sama gra już zgłasza nadlot. Opt-in, z
//   przyciskiem "Preview" w Ustawieniach.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'attack-banner',
  category: 'game-ui',
  locale: 'pl',

  name: 'Baner ataku',
  oneLiner:
    'Głośny, pełnoekranowy baner w otwartej karcie gry w chwili, gdy OGame samo zgłasza nadlatującą flotę — żeby nie przegapić tego, co i tak już widać w pasku.',
  order: 6,

  idea: [
    'Gdy gra oznaczy w swoim pasku nadlot wroga, baner **w tej samej, otwartej karcie** zamienia to w coś, czego nie da się nie zauważyć na małym ekranie telefonu. To wyłącznie głośniejsze pokazanie informacji, którą gra już wyświetla — nic więcej.',
    'Domyślnie wyłączony. W Ustawieniach jest przycisk **„Preview"**, który na 10 sekund pokazuje, jak baner wygląda, zanim się na niego zdecydujesz.',
  ],

  value: [
    'Na telefonie łatwo nie zauważyć małej flagi w rogu paska, zwłaszcza w środku innej czynności w grze. Baner ataku daje tej samej informacji rozmiar, którego nie da się przegapić — o ile akurat patrzysz na otwartą kartę.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **inne wyświetlenie danych, które gra już pokazuje w pasku** — nie osobne źródło informacji o ataku i nie próba obejścia niczego.',
      'Zero sygnału poza kartą: nie rusza tytułu karty ani favikony, nie odtwarza dźwięku i nie wysyła żadnego powiadomienia systemowego ani push. Gracz, który nie patrzy na otwartą kartę gry, nie dowie się niczego — baner istnieje wyłącznie wewnątrz tej karty, w momencie, w którym i tak byś to zobaczył.',
    ],
  },

  details: [
    'Wyłączony domyślnie — świadomie opt-in, z podglądem przed włączeniem.',
    'Włącza/wyłącza się w panelu Ustawień OG-E, sekcja Display.',
  ],

  screenshots: [
    { id: 'preview', caption: 'Podgląd banera ataku wywołany przyciskiem „Preview" w Ustawieniach.' },
  ],

  codeRefs: [
    'src/features/threatHighlight/index.js',
    'src/features/settingsUi/sections/preferences.js',
  ],

  status: 'drafted',
};
