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
// Pola prozą (`how`, `purpose`, `advantage`, `fairplay.summary`) to TABLICE
// akapitów (string[]). W tekście wolno używać lekkiego formatowania:
//   **pogrubienie**  oraz  `kod`
// — generator zamienia je na <strong>/<code>, całą resztę escapuje.

/**
 * @typedef {'green'|'yellow'|'red'} FairPlayClass
 *   Klasyfikacja z kanonicznego `docs/fair-play.md`. NIE wymyślamy jej tutaj —
 *   przepisujemy werdykt z tamtego dokumentu (DRY: fair-play ma jeden dom).
 *   green  = jednoznacznie dozwolone (display/obliczenia/1-klik-1-akcja),
 *   yellow = zgodne, ale wymaga ujawnienia / drobnej zmiany / konsultacji,
 *   red    = literalne naruszenie reguły — decyzja/konsultacja przed publikacją.
 */

/**
 * @typedef {object} Shot
 * @property {string} id       Klucz zrzutu (plik: assets/shots/<slug>--<id>.png).
 * @property {string} caption  Podpis PL — co obrazek ma pokazywać.
 */

/**
 * @typedef {object} FairPlay
 * @property {FairPlayClass} classification  Werdykt z docs/fair-play.md.
 * @property {string[]} summary   User-facing wyjaśnienie: jaka jest przewaga
 *   i CZYM jest mitygowana (albo dlaczego jest po bezpiecznej stronie linii).
 *   Piszemy pod czytelnika publicznego — NIE kopiujemy wewnętrznej strategii
 *   compliance (taktyk konsultacji, "to najsłabsze do obrony" itp.).
 * @property {string} [ref]  Kotwica w docs/fair-play.md, np. '§Spyglass'.
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
 * @property {'pl'} locale        Język treści (na razie tylko 'pl').
 * @property {string} name        Nazwa jaką widzi użytkownik.
 * @property {string} oneLiner    Jedno zdanie "co to robi".
 * @property {string[]} where     Gdzie w OGame się pojawia / jak uruchomić.
 * @property {string[]} how       Dokładny opis działania (mechanika, triggery).
 * @property {string[]} purpose   Po co to jest, jaki problem gracza rozwiązuje.
 * @property {string[]} advantage Budowana przewaga — konkretnie co daje.
 * @property {FairPlay} fairplay  Klasyfikacja + mitygacja (z docs/fair-play.md).
 * @property {string[]} [settings] Powiązane opcje w panelu ustawień OG-E.
 * @property {Shot[]} screenshots  Lista zrzutów (min. 1; placeholder do czasu realnego).
 * @property {string[]} codeRefs   Pliki src/... (dla nas, do utrzymania).
 * @property {DocStatus} status    Stan dokumentacji tego feature'a.
 */

const CLASSES = new Set(['green', 'yellow', 'red']);
const STATUSES = new Set(['todo', 'drafted', 'verified']);

/**
 * Waliduje jeden obiekt feature'a. Zwraca listę błędów (pustą = OK).
 * @param {any} f          Wyeksportowany obiekt.
 * @param {string} slug    Slug wyprowadzony z nazwy pliku.
 * @param {Set<string>} categoryIds  Dozwolone id kategorii.
 * @returns {string[]}
 */
export const validateFeature = (f, slug, categoryIds) => {
  /** @type {string[]} */
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const strArr = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim());

  need(f && typeof f === 'object', 'brak eksportu obiektu (export default {...})');
  if (!f || typeof f !== 'object') return errs;

  need(f.id === slug, `pole "id" (${f.id}) musi równać się nazwie pliku (${slug})`);
  need(typeof f.category === 'string' && categoryIds.has(f.category),
    `pole "category" (${f.category}) nie pasuje do żadnej kategorii z _categories.mjs`);
  need(f.locale === 'pl', 'pole "locale" musi być "pl" (baza)');
  need(typeof f.name === 'string' && f.name.trim(), 'brak "name"');
  need(typeof f.oneLiner === 'string' && f.oneLiner.trim(), 'brak "oneLiner"');
  need(strArr(f.where), '"where" musi być niepustą tablicą stringów');
  need(strArr(f.how), '"how" musi być niepustą tablicą stringów');
  need(strArr(f.purpose), '"purpose" musi być niepustą tablicą stringów');
  need(strArr(f.advantage), '"advantage" musi być niepustą tablicą stringów');

  need(f.fairplay && typeof f.fairplay === 'object', 'brak obiektu "fairplay"');
  if (f.fairplay && typeof f.fairplay === 'object') {
    need(CLASSES.has(f.fairplay.classification),
      `"fairplay.classification" musi być green|yellow|red (jest: ${f.fairplay.classification})`);
    need(strArr(f.fairplay.summary), '"fairplay.summary" musi być niepustą tablicą stringów');
  }

  if (f.settings !== undefined) {
    need(strArr(f.settings), '"settings" (jeśli podane) musi być niepustą tablicą stringów');
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

/** Etykiety PL dla klasyfikacji fair-play (używane w szablonie). */
export const FAIRPLAY_LABEL = {
  green: 'Zielony — dozwolone',
  yellow: 'Żółty — wymaga ujawnienia / konsultacji',
  red: 'Czerwony — narusza regułę, decyzja wymagana',
};
