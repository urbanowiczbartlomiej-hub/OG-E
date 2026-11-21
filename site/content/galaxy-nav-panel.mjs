// @ts-check

// Discovery: src/features/galaxyNavPanel.js — panel nawigacji galaktyki
//   pod tabelą systemu, +50px cele dotykowe, PROXY natywnych kontrolek
//   (nie re-implementacja). Gated na settings.readabilityBoost (ten sam
//   przełącznik co "Readability" — patrz rozdział "Interfejs gry").

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'galaxy-nav-panel',
  category: 'other',
  locale: 'pl',

  name: 'Przyciski nawigacji galaktyki',
  oneLiner:
    'Duże przyciski galaktyki i układu, wygodne pod kciuk — zamiast malutkich natywnych.',
  order: 1,

  idea: [
    'Natywne strzałki galaktyki i układu oraz przyciski Phalanx / Spy / Discovery są malutkie, szczególnie na telefonie. OG-E zastępuje je **dużym panelem**: **−/+** dla galaktyki i układu, **Start** pośrodku, a rzadziej używane Phalanx / Spy / Discovery można zwinąć.',
    'Panel stoi **pod tabelą** (domyślnie) albo **nad nią** — przełącznik **BTM / TOP / BOTH** w zwijanym wierszu; BOTH zostawia też natywny nagłówek gry.',
  ],

  value: [
    'Przeglądasz Galaktykę kciukiem, bez przybliżania ekranu za każdym razem, gdy chcesz zmienić układ.',
  ],

  fairplay: {
    summary: [
      'Każdy przycisk panelu **klika ten sam natywny element gry**, który kliknąłbyś sam — nawigacja zostaje zasadami gry.',
      'Jeśli przycisk w grze jest nieaktywny (np. brak Falangi czujników), w panelu też jest nieaktywny.',
    ],
  },

  details: [
    'Działa razem z „Readability" w Ustawieniach OG-E (domyślnie włączone).',
    'Strzałki na klawiaturze w oknach Phalanx / Spy / Discovery przeskakują dokładnie o jeden układ.',
  ],

  screenshots: [
    { id: 'panel', caption: 'Panel w pozycji TOP: −/+ galaktyki i układu, Start, oraz Phalanx / Spy / Discovery.' },
  ],

  codeRefs: [
    'src/features/galaxyNavPanel.js',
  ],

  status: 'drafted',
};
