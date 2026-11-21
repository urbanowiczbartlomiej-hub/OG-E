// @ts-check

// Discovery: src/features/dashboard/index.js (siatka, chipy graczy, pierścienie
//   zasięgu), src/features/dashboard/mapPrimitives.js (rysowanie, podpisy),
//   src/domain/geometry.js (dystans z zawinięciem mapy, czas lotu).
// Próg zasięgu liczony NAJWOLNIEJSZYM atakującym (RIP) — czyli ostrożnie.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-map',
  category: 'spyglass',
  locale: 'pl',

  name: 'Mapa pozycji i zasięg',
  oneLiner:
    'Planety obserwowanych graczy i Twoje na jednej mapie — z zaznaczeniem tych, z których da się do Ciebie dolecieć w mniej niż 8 godzin.',
  order: 6,

  idea: [
    'Karta **Positions map** to serwer z góry: wiersze to galaktyki, w poziomie układy. Kropka to planeta — im groźniejszy gracz, tym większa. Twoje planety są białe. Tapnięcie pokazuje nazwę i współrzędne, drugie otwiera dossier gracza.',
    'Przełącznik **who can reach you (≤8 h)** zaznacza planety, z których da się dolecieć do dowolnej Twojej planety w **8 godzin nawet najwolniejszą flotą**, i pokazuje czas lotu.',
  ],

  value: [
    'Groźny gracz na drugim końcu serwera to problem teoretyczny. Średniak trzy układy dalej — praktyczny. Mapa pokazuje to w sekundę: przy fleet-save, wyborze celu i nowej kolonii.',
  ],

  fairplay: {
    summary: [
      'Pozycje pochodzą z **publicznej mapy serwera**, a czasy lotu to arytmetyka na zasadach gry. Mapa niczego nie wysyła.',
    ],
  },

  details: [
    'Na mapie są tylko planety — Twoje i obserwowanych graczy (bez księżyców).',
    'Chip gracza: kolor, ukrycie z mapy (oko) albo koniec obserwacji (krzyżyk). Chip **You** ukrywa Twoje planety.',
  ],

  screenshots: [
    { id: 'positions', caption: 'Mapa pozycji: kropka na każdą planetę, rozmiar rośnie z zagrożeniem, Twoje planety na biało.' },
    { id: 'chips', caption: 'Chipy graczy i przełącznik „who can reach you (≤8 h)".' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/dashboard/mapPrimitives.js',
    'src/domain/geometry.js',
  ],

  status: 'drafted',
};
