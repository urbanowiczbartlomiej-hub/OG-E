// @ts-check

// WZORZEC (golden sample) — pierwszy w pełni opisany feature. Kolejne pliki
// treści kopiują tę strukturę. Źródła discovery:
//   src/features/whosSpyingPanel.js, src/domain/proximityDigest.js,
//   src/state/proximityReports.js, docs/fair-play.md §Spyglass.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'who-is-spying',
  category: 'intel',
  locale: 'pl',

  name: 'Kto Cię szpieguje',
  oneLiner:
    'Tabela na stronie wiadomości pokazująca, kto ostatnio sondował Twoje planety — najświeżsi i najbliżsi na górze.',

  where: [
    'Strona **Wiadomości** (`?page=ingame&component=messages`), zakładka **Szpieguj**. Panel wstrzykiwany jest na samej górze — nad przeglądem raportów szpiegowskich AntiGameReborn (AGR).',
    'To defensywne lustro ofensywnej listy AGR: AGR podsumowuje farmy, które **Ty** przeskanowałeś; ten panel podsumowuje, kto sondował **Ciebie**.',
  ],

  how: [
    'Panel czyta wyłącznie alerty typu „Obca flota dostrzeżona w pobliżu Twojej planety", które **sam otworzyłeś** podczas normalnej gry (przechwytywane pasywnie przez `targetsIngest`). Nie wykonuje żadnych własnych zapytań do gry.',
    'Log alertów jest zwijany do **jednego wiersza na szpiega**: kolumny **Prober** (kto), **Seen** (jak dawno), **Alerts** (ile alertów), **From** (skąd startował), **Near you** (które Twoje ciało zaczepił). Sortowanie: najpierw zagrożenia z tego samego układu, potem najświeższe, potem najliczniejsze.',
    'Szpieg, którego ciało-źródło leży w **tym samym układzie** co zaczepione ciało Twoje, dostaje flagę **💀** — flota zaparkowana w Twoim systemie dosięga Cię szybko nawet najwolniejszymi Gwiazdami Śmierci (zasięg RIP). Pod nazwą pokazywana jest linia dystansu do najbliższego Twojego ciała.',
    'Przełącznik **Coords / Names** w nagłówku zamienia kolumnę „Near you" między surowymi koordynatami a nazwami Twoich ciał (wybór zapamiętywany per urządzenie). Przycisk **Spyglass** przy wierszu otwiera pełne dossier tego gracza w dashboardzie OG-E (zakładka Spyglass).',
    'Panel utrzymuje się na miejscu mimo przeładowań AJAX gry (`MutationObserver`), odświeża się przy nowym alercie i wolnym tyknięciu zegara (relatywne czasy). Jest **domyślnie włączony**, można go ukryć w ustawieniach OG-E (sekcja „Wyświetlanie"). Gdy nie ma żadnego szpiega — panel znika (zero bałaganu).',
  ],

  purpose: [
    'OGame rozrzuca informację „kto Cię sondował" po pojedynczych wiadomościach, które łatwo przeoczyć. Ten panel skupia ją w jednym, skanowalnym miejscu dokładnie tam, gdzie i tak przeglądasz szpiegostwo.',
    'Odpowiada na jedno pytanie obronne: **czy ktoś się mną interesuje i jak blisko jest?** — zanim przełoży się to na atak.',
  ],

  advantage: [
    'Wczesne rozpoznanie **powtarzających się zwiadowców** i szczególnie zagrożeń **z tego samego układu** (zasięg RIP). To sygnał, żeby zrobić fleet-save, przenieść flotę albo przygotować kontrę — zanim atak wyląduje.',
    'Zamiast klikać po pojedynczych raportach, jednym rzutem oka widzisz kto, jak często i skąd — czyli świadomość sytuacyjną, którą inaczej trzeba by mozolnie składać ręcznie.',
  ],

  fairplay: {
    classification: 'green',
    summary: [
      'Panel jest **czysto prezentacyjny**: agreguje i wyświetla alerty, które gracz sam otworzył podczas normalnej gry. Nie przechwytuje żadnych nowych danych, nie wysyła żadnego zapytania do gry, nie ma timera ani powiadomienia poza kartą.',
      'Mieści się w gwarancji pochodzenia danych całego workbenchu Spyglass (dane wyłącznie z raportów otwartych przez gracza + publiczne API czytane tylko przy otwartej karcie gry). Dlatego w `docs/fair-play.md` jest sklasyfikowany jako **zielony** — dozwolony bez zastrzeżeń.',
    ],
    ref: '§Spyglass intelligence workbench (v3)',
  },

  settings: [
    'Wyświetlanie → pokaż/ukryj panel „Kto Cię szpieguje" (domyślnie włączony).',
    'Przełącznik Coords / Names w nagłówku panelu — per urządzenie.',
  ],

  screenshots: [
    { id: 'panel', caption: 'Panel „Kto Cię szpieguje" na górze zakładki Szpieguj, nad przeglądem AGR.' },
    { id: 'same-system', caption: 'Wiersz z flagą 💀 — szpieg z ciałem w Twoim układzie (zasięg RIP), na górze listy.' },
    { id: 'names-toggle', caption: 'Przełącznik Coords / Names — kolumna „Near you" pokazuje nazwy Twoich ciał.' },
  ],

  codeRefs: [
    'src/features/whosSpyingPanel.js',
    'src/domain/proximityDigest.js',
    'src/state/proximityReports.js',
  ],

  status: 'drafted',
};
