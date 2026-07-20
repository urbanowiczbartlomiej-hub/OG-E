// @ts-check

// Taksonomia user-facing, uporządkowana WEDŁUG WAGI PRODUKTOWEJ (nie wg
// katalogów kodu). Flagowiec to Przycisk OG-E (FAB) — hub, z którego odpalasz
// wszystkie akcje floty. Kolejne grupy to pozostali flagowcy, a UI/ustawienia
// są świadomie na końcu jako "dodatki". Kolejność tablicy = kolejność sekcji.
//
// `name` i `blurb` są per język (klucze jak w _strings.mjs) — id kategorii są
// wspólne dla wszystkich języków (są częścią kotwic #cat-<id>).

/**
 * @typedef {object} Category
 * @property {string} id     Id używane w `feature.category` (wspólne dla języków).
 * @property {Record<'pl'|'en', string>} name   Nagłówek sekcji per język.
 * @property {Record<'pl'|'en', string>} blurb  Jedno zdanie wprowadzające per język.
 */

/** @type {Category[]} */
export const CATEGORIES = [
  {
    id: 'fab',
    name: {
      pl: 'Przycisk OG-E',
      en: 'The OG-E Button',
    },
    blurb: {
      pl: 'Flagowy hub OG-E: jeden pływający przycisk, z którego odpalasz wszystkie akcje floty jednym tapnięciem — wyprawy, polowanie na kolonie, discovery, codzienne trasy, przypomnienia.',
      en: "OG-E's flagship hub: one floating button that fires every fleet action with a single tap — expeditions, colony hunting, discoveries, daily routes, reminders.",
    },
  },
  {
    id: 'spyglass',
    name: {
      pl: 'Spyglass — wywiad',
      en: 'Spyglass — intelligence',
    },
    blurb: {
      pl: 'Duży moduł wywiadu: podejrzyj i szpieguj, dossier przeciwnika, model zagrożenia, analiza rutyny wroga i okna offline oraz panel „kto Cię szpieguje". Wszystko z danych, które zebrałeś normalną grą.',
      en: 'A large intelligence module: peek and spy, opponent dossiers, a threat model, enemy-routine analysis with offline windows, and a "who is spying on you" panel. All built from data you gathered by playing normally.',
    },
  },
  {
    id: 'alarms',
    name: {
      pl: 'Budzik i fleet-save',
      en: 'Alarm clock & fleet-save',
    },
    blurb: {
      pl: 'Budzik na powrót floty, który sam ustawiasz. Jedyna świadomie graniczna funkcja — mówimy o tym wprost w sekcji fair-play.',
      en: 'A fleet-return alarm you set yourself. The only knowingly borderline feature — we say so openly in its fair-play section.',
    },
  },
  {
    id: 'dashboard',
    name: {
      pl: 'Dashboard i analityka',
      en: 'Dashboard & analytics',
    },
    blurb: {
      pl: 'Osobny panel OG-E: najlepsze miejsca na kolonie, patrol, trasy, statystyki i podgląd danych zebranych podczas normalnej gry.',
      en: "OG-E's own panel: best colony spots, patrol, routes, statistics and a view of the data collected during normal play.",
    },
  },
  {
    id: 'sync',
    name: {
      pl: 'Synchronizacja i społeczność',
      en: 'Sync & community',
    },
    blurb: {
      pl: 'Twoje dane na wielu urządzeniach oraz dzielenie się i dołączanie do wspólnej aktywności — bez śledzenia gry w tle.',
      en: 'Your data across devices, plus sharing and joining shared activity — with no background game tracking.',
    },
  },
  {
    id: 'qol',
    name: {
      pl: 'Usprawnienia UI (dodatki)',
      en: 'UI improvements (extras)',
    },
    blurb: {
      pl: 'Czytelność, spójność i drobne ułatwienia interfejsu — dodatki do flagowych funkcji. Nic, co dotyka reklam, menu premium czy stopki gry.',
      en: 'Readability, consistency and small interface conveniences — extras on top of the flagship features. Nothing that touches ads, premium menus or the game footer.',
    },
  },
];

/** Zbiór dozwolonych id — dla walidatora. */
export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
