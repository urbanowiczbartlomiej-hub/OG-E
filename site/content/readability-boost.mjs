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
    'Odchudza gadatliwe etykiety w górnym pasku gry i daje duże przyciski nawigacji w galaktyce — żeby to, co naprawdę liczy się na małym ekranie, było większe i łatwiejsze do trafienia.',
  order: 2,

  idea: [
    'Boks zdarzeń floty domyślnie pokazuje trzy informacje (liczbę misji, typ + cel następnej, odliczanie), ale otacza je etykietami („Misje:", „Następna:", „Rodzaj:"), które zajmują więcej miejsca niż sama treść. Readability zwija te etykiety do zera i stawia odliczanie po prawej w pełnym rozmiarze, a resztę w kolumnie po lewej z zarezerwowanym marginesem, żeby długa nazwa misji nigdy nie wjechała pod czas.',
    'Ten sam zabieg dostaje link ruchu floty w nagłówku fleetdispatch: kolor zieleni trafia tylko na sam link (nie na jego dzieci), więc natywny czerwony wskaźnik „limit ekspedycji osiągnięty" w środku dalej działa tak, jak powinien.',
    'Ten sam przełącznik odsłania też **duże przyciski nawigacji w widoku galaktyki**: skok o galaktykę i o system w lewo/prawo, „Start" oraz Phalanx / Spy / Discovery w celach wygodnych dla kciuka. Dzięki temu przejście systemu po systemie — np. przy falandze całego regionu — to spokojne tapnięcia zamiast celowania kursorem w kilkunastopikselowe strzałki. Na desktopie działa dokładnie tak samo.',
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
    { id: 'eventbox-before', caption: 'Przed: boks zdarzeń floty z pełnymi etykietami — treść tonie w podpisach.' },
    { id: 'eventbox-after', caption: 'Po: etykiety zwinięte, odliczanie i stan slotów w pełnym rozmiarze.' },
    { id: 'galaxy', caption: 'Widok galaktyki: duże przyciski skoku o galaktykę i system oraz Start / Phalanx / Spy / Discovery.' },
  ],

  codeRefs: [
    'src/features/readabilityBoost.js',
  ],

  status: 'drafted',
};
