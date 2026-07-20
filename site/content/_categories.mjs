// @ts-check

// Taksonomia user-facing, uporządkowana WEDŁUG WAGI PRODUKTOWEJ (nie wg
// katalogów kodu). Flagowiec to Przycisk OG-E (FAB) — hub, z którego odpalasz
// wszystkie akcje floty. Kolejne grupy to pozostali flagowcy, a UI/ustawienia
// są świadomie na końcu jako "dodatki". Kolejność tablicy = kolejność sekcji.

/**
 * @typedef {object} Category
 * @property {string} id     Id używane w `feature.category`.
 * @property {string} name   Nagłówek sekcji (PL).
 * @property {string} blurb  Jedno zdanie wprowadzające do grupy.
 */

/** @type {Category[]} */
export const CATEGORIES = [
  {
    id: 'fab',
    name: 'Przycisk OG-E',
    blurb: 'Flagowy hub OG-E: jeden pływający przycisk, z którego odpalasz wszystkie akcje floty jednym tapnięciem — wyprawy, polowanie na kolonie, discovery, codzienne trasy, przypomnienia.',
  },
  {
    id: 'spyglass',
    name: 'Spyglass — wywiad',
    blurb: 'Duży moduł wywiadu: podejrzyj i szpieguj, dossier przeciwnika, model zagrożenia, analiza rutyny wroga i okna offline oraz panel „kto Cię szpieguje". Wszystko z danych, które zebrałeś normalną grą.',
  },
  {
    id: 'alarms',
    name: 'Budzik i fleet-save',
    blurb: 'Budzik na powrót floty, który sam ustawiasz. Jedyna świadomie graniczna funkcja — mówimy o tym wprost w sekcji fair-play.',
  },
  {
    id: 'dashboard',
    name: 'Dashboard i analityka',
    blurb: 'Osobny panel OG-E: najlepsze miejsca na kolonie, patrol, trasy, statystyki i podgląd danych zebranych podczas normalnej gry.',
  },
  {
    id: 'sync',
    name: 'Synchronizacja i społeczność',
    blurb: 'Twoje dane na wielu urządzeniach oraz dzielenie się i dołączanie do wspólnej aktywności — bez śledzenia gry w tle.',
  },
  {
    id: 'qol',
    name: 'Usprawnienia UI (dodatki)',
    blurb: 'Czytelność, spójność i drobne ułatwienia interfejsu — dodatki do flagowych funkcji. Nic, co dotyka reklam, menu premium czy stopki gry.',
  },
];

/** Zbiór dozwolonych id — dla walidatora. */
export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
