// @ts-check

// Taksonomia user-facing. NIE kopiuje struktury katalogów kodu (`src/features/`)
// — użytkownik nie myśli w `features/`, myśli w kategoriach zadań w grze.
// Kolejność w tablicy = kolejność sekcji na stronie głównej.

/**
 * @typedef {object} Category
 * @property {string} id     Id używane w `feature.category`.
 * @property {string} name   Nagłówek sekcji (PL).
 * @property {string} blurb  Jedno zdanie wprowadzające do grupy.
 */

/** @type {Category[]} */
export const CATEGORIES = [
  {
    id: 'fleet',
    name: 'Automatyzacja floty',
    blurb: 'Szybkie wysyłki floty jednym tapnięciem — wyprawy, kolonizacja, szpiegowanie, discovery, daily run. Zawsze 1 tap = 1 akcja.',
  },
  {
    id: 'intel',
    name: 'Wywiad i zagrożenia',
    blurb: 'Wiedza o przeciwnikach i o tym, kto interesuje się Tobą — raporty szpiegowskie, model zagrożenia, panele defensywne.',
  },
  {
    id: 'dashboard',
    name: 'Dashboard i analityka',
    blurb: 'Osobny panel OG-E: patrol, trasy, statystyki i podgląd danych zebranych podczas normalnej gry.',
  },
  {
    id: 'galaxy',
    name: 'Nawigacja i galaktyka',
    blurb: 'Poruszanie się po galaktyce i mapie imperium oraz wyróżnianie tego, co ważne — bez auto-przeglądania.',
  },
  {
    id: 'alarms',
    name: 'Fleet-save i przypomnienia',
    blurb: 'Budzik na powrót floty ustawiany przez gracza. Sekcja świadomie graniczna wobec reguł — patrz sekcja fair-play.',
  },
  {
    id: 'qol',
    name: 'Jakość życia i UI',
    blurb: 'Czytelność, spójność i drobne usprawnienia interfejsu — nic, co dotyka reklam, menu premium czy stopki gry.',
  },
];

/** Zbiór dozwolonych id — dla walidatora. */
export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
