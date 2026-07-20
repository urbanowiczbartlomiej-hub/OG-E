// @ts-check

// Kontrakt treści dla dokumentacji OG-E (site/).
//
// Każdy feature to jeden plik `content/<slug>.mjs` eksportujący DOMYŚLNIE
// obiekt zgodny z poniższym opisem. Generator (`site/build.mjs`) waliduje
// każdy plik tym modułem i PRZERYWA build przy brakującym/niepoprawnym polu —
// to nasz "test spójności": nie da się dodać feature'a bez kompletu sekcji.
//
// Treść jest DANE, nie ręczny HTML — dzięki temu (1) każdy feature ma ten sam
// zestaw sekcji, (2) tłumaczenie = podmiana `locale` + stringów, bez dotykania
// szablonu. Bazowy język to PL.
//
// # Idea, nie implementacja (ZASADA NACZELNA)
//
// Opisujemy IDEĘ działania — krótko, tak by dało się to przeczytać w kilka
// sekund. NIE opisujemy każdego stanu przycisku ani najdrobniejszej mechaniki:
// szczegóły zmieniają się z każdym commitem i dezaktualizują dokument, a idea
// zostaje. Dwie sekcje prozą (`idea`, `value`) mają być KRÓTKIE (1–2 zwięzłe
// akapity każda). Konkretne, zmienne detale — TYLKO jeśli naprawdę pomagają —
// idą do opcjonalnego `details` (punkty), świadomie oszczędnie.
//
// Pola prozą (`idea`, `value`, `fairplay.summary`) to TABLICE akapitów
// (string[]). W tekście wolno używać lekkiego formatowania:
//   **pogrubienie**  oraz  `kod`
// — generator zamienia je na <strong>/<code>, całą resztę escapuje.
//
// # Fair-play — polityka strony
//
// Strona NIE stosuje klasyfikacji zielony/żółty/czerwony (to zostaje wewnętrzne,
// w `docs/fair-play.md`). Publicznie zawsze dajemy **interpretację pozytywną** —
// argumenty ZA tym, że funkcja jest fair. Jedyny wyjątek, gdzie uczciwie
// przyznajemy graniczność, to budzik (alarm clock): tam `fairplay.borderline`
// = true i generator dokłada szczery komentarz.
//
// UWAGA na sformułowania: OG-E NIE „wysyła żądań" (nawet ograniczonych do
// jednego na tap). Poprawny model: OG-E inicjuje kliknięcie natywnego elementu
// interfejsu gry — a to sama GRA (jeśli w ogóle) kontaktuje się z serwerem,
// dokładnie tak, jak przy ręcznym kliknięciu gracza. Nie pisz „1 tap = 1
// żądanie"; pisz o inicjowaniu natywnego kliknięcia.
//
// # Warstwa infrastruktury
//
// Zaplecze danych (apiContext, ownProfile, colonyRecorder, allianceClassIngest)
// NIE ma własnych stron. Skąd biorą się dane opisujemy WEWNĄTRZ funkcji, które
// je konsumują (pole `idea`/`fairplay.summary`) — np. "z raportów, które sam
// otworzyłeś" albo "z publicznego API czytanego przy otwartej karcie gry".

/**
 * @typedef {object} Shot
 * @property {string} id       Klucz zrzutu (plik: assets/shots/<slug>--<id>.png).
 * @property {string} caption  Podpis PL — co obrazek ma pokazywać.
 */

/**
 * @typedef {object} FairPlay
 * @property {string[]} summary   Argumenty ZA tym, że funkcja jest fair —
 *   pisane pod czytelnika publicznego (pozytywna interpretacja). Tu wplatamy też
 *   pochodzenie danych, jeśli funkcja czyta zaplecze (apiContext itd.).
 * @property {boolean} [borderline]  Ustaw TYLKO dla budzika (alarm clock) —
 *   jedynej funkcji, przy której szczerze przyznajemy graniczność. Generator
 *   dokłada wtedy uczciwy komentarz.
 */

/**
 * @typedef {'todo'|'drafted'|'verified'} DocStatus
 *   todo     = jeszcze nieopisany (placeholder w katalogu),
 *   drafted  = opis napisany z kodu, czeka na weryfikację użytkownika,
 *   verified = użytkownik potwierdził zgodność z realną grą.
 */

/**
 * @typedef {object} Feature
 * @property {string} id          Slug = nazwa pliku bez rozszerzenia.
 * @property {string} category    Id kategorii z `_categories.mjs`.
 * @property {'pl'|'en'} locale   Język treści (PL = baza; EN = lustro w content/en/).
 * @property {string} name        Nazwa jaką widzi użytkownik.
 * @property {string} oneLiner    Jedno zdanie "co to robi".
 * @property {boolean} [flagship] True = funkcja flagowa (wyróżniana na stronie).
 * @property {number} [order]     Kolejność w obrębie kategorii (rosnąco; brak =
 *   na koniec, potem alfabetycznie). Hero danej kategorii dostaje najniższy.
 * @property {string[]} idea      "Jak to działa" — IDEA działania, krótko
 *   (1–2 zwięzłe akapity). Nie mechanika krok-po-kroku, nie stany przycisku.
 * @property {string[]} value     "Po co to" — jaki problem gracza rozwiązuje i
 *   co zyskuje. Krótko (zwykle 1 akapit).
 * @property {FairPlay} fairplay  Pozytywne argumenty za fair-play (+ borderline dla budzika).
 * @property {string[]} [details] "Dodatkowe informacje" — opcjonalne PUNKTY z
 *   konkretniejszymi detalami. Dodawaj oszczędnie i tylko gdy wnoszą wartość
 *   (są bardziej podatne na dezaktualizację niż idea).
 * @property {Shot[]} screenshots  Lista zrzutów (min. 1; placeholder do czasu realnego).
 * @property {string[]} codeRefs   Pliki src/... (dla nas, do utrzymania).
 * @property {DocStatus} status    Stan dokumentacji tego feature'a.
 */

const STATUSES = new Set(['todo', 'drafted', 'verified']);

/**
 * Waliduje jeden obiekt feature'a. Zwraca listę błędów (pustą = OK).
 * @param {any} f          Wyeksportowany obiekt.
 * @param {string} slug    Slug wyprowadzony z nazwy pliku.
 * @param {Set<string>} categoryIds  Dozwolone id kategorii.
 * @param {'pl'|'en'} [locale]  Oczekiwany język pliku (wg katalogu, z którego czytamy).
 * @returns {string[]}
 */
export const validateFeature = (f, slug, categoryIds, locale = 'pl') => {
  /** @type {string[]} */
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const strArr = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim());

  need(f && typeof f === 'object', 'brak eksportu obiektu (export default {...})');
  if (!f || typeof f !== 'object') return errs;

  need(f.id === slug, `pole "id" (${f.id}) musi równać się nazwie pliku (${slug})`);
  need(typeof f.category === 'string' && categoryIds.has(f.category),
    `pole "category" (${f.category}) nie pasuje do żadnej kategorii z _categories.mjs`);
  need(f.locale === locale, `pole "locale" (${f.locale}) musi być "${locale}" (katalog, z którego czytany jest plik)`);
  need(typeof f.name === 'string' && f.name.trim(), 'brak "name"');
  need(typeof f.oneLiner === 'string' && f.oneLiner.trim(), 'brak "oneLiner"');
  need(f.flagship === undefined || typeof f.flagship === 'boolean', '"flagship" musi być boolean');
  need(f.order === undefined || (typeof f.order === 'number' && Number.isFinite(f.order)),
    '"order" (jeśli podane) musi być liczbą');
  need(strArr(f.idea), '"idea" musi być niepustą tablicą stringów');
  need(strArr(f.value), '"value" musi być niepustą tablicą stringów');

  need(f.fairplay && typeof f.fairplay === 'object', 'brak obiektu "fairplay"');
  if (f.fairplay && typeof f.fairplay === 'object') {
    need(strArr(f.fairplay.summary), '"fairplay.summary" musi być niepustą tablicą stringów');
    need(f.fairplay.borderline === undefined || typeof f.fairplay.borderline === 'boolean',
      '"fairplay.borderline" musi być boolean (ustawiane tylko dla budzika)');
  }

  if (f.details !== undefined) {
    need(strArr(f.details), '"details" (jeśli podane) musi być niepustą tablicą stringów');
  }
  need(Array.isArray(f.screenshots) && f.screenshots.length > 0, '"screenshots" musi mieć min. 1 pozycję');
  if (Array.isArray(f.screenshots)) {
    f.screenshots.forEach((s, i) => {
      need(s && typeof s.id === 'string' && s.id.trim(), `screenshots[${i}].id brak/pusty`);
      need(s && typeof s.caption === 'string' && s.caption.trim(), `screenshots[${i}].caption brak/pusty`);
    });
  }

  need(strArr(f.codeRefs), '"codeRefs" musi być niepustą tablicą ścieżek src/...');
  need(STATUSES.has(f.status), `"status" musi być todo|drafted|verified (jest: ${f.status})`);

  return errs;
};
