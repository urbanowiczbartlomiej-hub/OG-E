// @ts-check

// Discovery: src/features/readabilityBoost.js — kontrast/czytelność dwóch
//   chronicznie ciasnych powierzchni AGR/OGame: boksu zdarzeń floty i linku
//   ruchu floty w nagłówku fleetdispatch.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'readability-boost',
  category: 'game-ui',
  locale: 'pl',

  name: 'Readability',
  oneLiner:
    'Odchudza gadatliwe etykiety w górnym pasku gry, żeby liczby, które naprawdę liczą się na małym ekranie, były większe i łatwiejsze do odczytania.',
  order: 2,

  idea: [
    'Boks zdarzeń floty domyślnie pokazuje trzy informacje (liczbę misji, typ + cel następnej, odliczanie), ale otacza je etykietami („Misje:", „Następna:", „Rodzaj:"), które zajmują więcej miejsca niż sama treść. Readability zwija te etykiety do zera, podciąga boks pod nagłówek AGR i stawia odliczanie po prawej w pełnym rozmiarze, a resztę w kolumnie po lewej z zarezerwowanym marginesem, żeby długa nazwa misji nigdy nie wjechała pod czas.',
    'Ten sam zabieg dostaje link ruchu floty w nagłówku fleetdispatch: kolor zieleni trafia tylko na sam link (nie na jego dzieci), więc natywny czerwony wskaźnik „limit ekspedycji osiągnięty" w środku dalej działa tak, jak powinien.',
  ],

  value: [
    'Na telefonie natywny układ AGR/OGame ściska te same informacje w miejsce zaprojektowane pod desktop — etykiety zjadają przestrzeń, którą powinny mieć liczby. Readability oddaje tę przestrzeń liczbom, więc odliczanie do następnej misji i stan slotów widać bez mrużenia oczu.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **CSS na już wyświetlonych elementach** — żadna liczba ani etykieta nie jest podmieniana na inną wartość, tylko inaczej wystylowana. Kolory motywu zostają grywe (AGR-owe), zmienia się jedynie układ i rozmiar.',
      'Domyślnie włączone, ale jeden przełącznik w Ustawieniach wyłącza wszystko naraz — bez migotania niestylowanej treści przy starcie strony.',
    ],
  },

  details: [
    'Obejmuje boks zdarzeń floty (`#eventboxFilled`) i link ruchu floty w nagłówku fleetdispatch.',
    'Ten sam przełącznik odsłania też panel nawigacji galaktyki (patrz „Przyciski nawigacji" w rozdziale „Inne").',
    'Włącza/wyłącza się w panelu Ustawień OG-E, kafelek „Readability".',
  ],

  screenshots: [
    { id: 'eventbox', caption: 'Boks zdarzeń floty przed i po odchudzeniu etykiet.' },
  ],

  codeRefs: [
    'src/features/readabilityBoost.js',
  ],

  status: 'drafted',
};
