// @ts-check

// Taksonomia user-facing, uporządkowana WEDŁUG WAGI PRODUKTOWEJ (nie wg
// katalogów kodu). Flagowce to Przycisk OG-E (FAB) i Spyglass — dwa hub'y,
// z których gracz odpala większość akcji. Między nimi siedzi "Interfejs gry"
// (co widać wprost w grze) i "Dashboard" (pełnostronicowy panel danych);
// "Inne" na końcu to świadomie "dodatki". Kolejność tablicy = kolejność
// sekcji na stronie.
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
      pl: 'Flagowy hub OG-E: jeden pływający przycisk, z którego odpalasz wszystkie akcje floty jednym tapnięciem — ekspedycje, polowanie na kolonie, discovery, codzienne trasy, przypomnienia i wejście do Spyglassa.',
      en: "OG-E's flagship hub: one floating button that fires every fleet action with a single tap — expeditions, colony hunting, discoveries, daily routes, reminders, and the entry point into Spyglass.",
    },
  },
  {
    id: 'game-ui',
    name: {
      pl: 'Interfejs gry',
      en: 'Game interface',
    },
    blurb: {
      pl: 'To, co widzisz wprost w grze i włączasz z panelu ustawień AGR: czytelność interfejsu, znaczniki floty na planetach, pulsowanie menu wydarzeń i kupca oraz baner ataku. Nic, co dotyka reklam, menu premium czy stopki gry.',
      en: "What you see directly in the game and switch on from the AGR settings panel: interface readability, fleet-status planet markers, the event and trader menu pulses, and the attack banner. Nothing that touches ads, premium menus or the game footer.",
    },
  },
  {
    id: 'dashboard',
    name: {
      pl: 'Dashboard i analityka',
      en: 'Dashboard & analytics',
    },
    blurb: {
      pl: 'Osobny panel OG-E: najlepsze miejsca na kolonie, budzik na powrót floty, codzienne trasy, statystyki i synchronizacja między urządzeniami — zbudowane z danych zebranych podczas normalnej gry. Zakładka Spyglass żyje tu samodzielnie i ma własny rozdział niżej.',
      en: "OG-E's own panel: best colony spots, the fleet-return alarm clock, daily routes, statistics and cross-device sync — all built from data collected during normal play. The Spyglass tab lives here too, with its own chapter below.",
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
    id: 'other',
    name: {
      pl: 'Inne',
      en: 'Other',
    },
    blurb: {
      pl: 'Drobne usprawnienia i kosmetyka, dodatki do funkcji flagowych: przyciski nawigacji galaktyki, brak białego rozbłysku tła i inne detale interfejsu. Nic, co dotyka reklam, menu premium czy stopki gry.',
      en: 'Small conveniences and cosmetics on top of the flagship features: galaxy navigation buttons, no white background flash, and other interface details. Nothing that touches ads, premium menus or the game footer.',
    },
  },
];

/** Zbiór dozwolonych id — dla walidatora. */
export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
