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
    'Duże, kciukiem trafialne strzałki i wejścia do galaktyki/systemu pod tabelą — bo natywny nagłówek na telefonie jest ~16 px wysoki.',
  order: 1,

  idea: [
    'Widok galaktyki jest zaprojektowany pod desktop: przełączanie galaktyki/systemu, strzałki i przyciski Start / phalanx / spy / discovery w nagłówku mają na telefonie ok. 16 px wysokości — praktycznie nietrafialne bez zoomu. Panel OG-E dokłada te same kontrolki jeszcze raz, **pod tabelą systemu**, w celach dotykowych ~50 px: stepper galaktyki i systemu po lewej/prawej, przycisk „Start" po środku, a rzadziej używane Phalanx/Spy/Discovery chowają się pod składaną „pokrywką".',
    'Panel niczego nie re-implementuje — **klika te same natywne przyciski i pola**, które są w nagłówku. Krok galaktyki/systemu przesuwa natywne strzałki (zawijanie i koszt deuteru zostają regułą gry), a „Start" wypełnia natywne pola i klika natywny submit. Jeśli przycisk jest wyłączony w nagłówku (np. phalanx niedostępny na tym ciele), panel pokazuje to samo.',
  ],

  value: [
    'Bez tego panelu przeglądanie wielu systemów na telefonie to ciągłe szczypanie i przybliżanie, żeby trafić w mikroskopijną strzałkę, a potem odsuwanie z powrotem do tabeli. Panel trzyma nawigację w zasięgu kciuka, dokładnie tam, gdzie i tak patrzysz.',
  ],

  fairplay: {
    summary: [
      'Panel **nie dodaje żadnej akcji, której nie było w nagłówku** — każdy przycisk to kliknięcie tego samego natywnego elementu, który nacisnąłbyś sam. Liczba żądań do gry jest identyczna jak przy ręcznej nawigacji.',
      'Stan przycisków (włączony/wyłączony) jest **kopiowany z nagłówka**, nie liczony od nowa — więc nie może pokazać czegoś, czego natywny UI już nie mówi.',
    ],
  },

  details: [
    'Ten sam przełącznik co „Readability" w Ustawieniach OG-E (Display) włącza i wyłącza ten panel.',
    'Osobna, zawsze aktywna poprawka: strzałki klawiatury w oknie phalanx/spy/discovery czasem gubią fokus i przeskakują system dwa razy zamiast raz — panel to koryguje niezależnie od reszty.',
  ],

  screenshots: [
    { id: 'panel', caption: 'Panel nawigacji pod tabelą systemu: stepper galaktyki/systemu i przyciski Start / Phalanx / Spy / Discovery.' },
  ],

  codeRefs: [
    'src/features/galaxyNavPanel.js',
  ],

  status: 'drafted',
};
