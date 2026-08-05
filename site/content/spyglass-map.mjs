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
    'Wszystkie ciała obserwowanych graczy i Twoje własne na jednej siatce galaktyk — plus pierścienie wokół tych, którzy dolecą do Ciebie w mniej niż osiem godzin.',
  order: 6,

  idea: [
    'Siatka to serwer widziany z góry: wiersze to galaktyki, w poziomie idą układy, a pionowo wewnątrz wiersza — pozycja w układzie. Kropka to ciało; rośnie razem z zagrożeniem gracza, a kolor przypisujesz sam, żeby rozpoznawać swoich stałych klientów. Twoje planety są białe. Najechanie (na dotyku pierwsze tapnięcie) podaje nazwę, koordynaty i szacowany czas lotu do Twojej najbliższej planety.',
    'Chip `who can reach you` liczy dla każdego cudzego ciała najkrótszy dystans do **dowolnej** Twojej planety — z zawinięciem mapy zgodnie z zasadami serwera — i przelicza go na czas lotu **najwolniejszym możliwym atakującym**. Pierścień oznacza więc: ten gracz dosięga Cię w ciągu ośmiu godzin nawet swoją najcięższą, najwolniejszą flotą. Próg jest celowo pesymistyczny, bo szybsza flota przyleci wcześniej.',
  ],

  value: [
    '„Kto jest groźny" i „kto jest groźny **dla mnie**" to dwa różne pytania. Gracz z drugiego końca serwera z potworną flotą jest problemem teoretycznym; średniak trzy układy dalej jest problemem praktycznym. Mapa odpowiada na to geometrią, którą widać w sekundę — przydaje się i przy planowaniu fleet-save\'a, i przy wyborze celu, i przy decyzji, gdzie stawiać kolejną kolonię.',
  ],

  fairplay: {
    summary: [
      'Pozycje ciał pochodzą z **publicznej mapy serwera** — tego samego pliku, z którego korzystają narzędzia społeczności. Mapa jest więc kompletna od pierwszego uruchomienia i nie wymaga ani jednego skanu. Czasy lotu to arytmetyka na jawnych zasadach gry.',
      'Mapa **niczego nie wysyła i nikogo nie zaczepia** — to rysunek na danych, które i tak są publiczne, plus Twoje własne koordynaty z gry. Nie ma tu żadnej akcji w grze, nawet pośredniej.',
    ],
  },

  details: [
    'Na mapie są tylko Twoje ciała i gracze z listy obserwowanych — nie cały serwer, żeby rysunek pozostał czytelny.',
    'Oko przy chipie ukrywa gracza z mapy, nie przestając go obserwować; krzyżyk kończy obserwację całkowicie.',
    'Chip z kolorem to jedyne miejsce, w którym ustawiasz barwę gracza — ta sama trafia potem na karty listy obserwowanych.',
    'Na dotyku pierwsze tapnięcie opisuje ciało, drugie otwiera dossier właściciela.',
  ],

  demo: {
    id: 'positions-map',
    caption: 'Prawdziwa mapa pozycji na zmyślonym wszechświecie. Wiersz = galaktyka, kropka = ciało, rozmiar rośnie z zagrożeniem, Twoje planety są białe. Bursztynowy pierścień to „dosięgnie Cię" — Kestrel siedzi trzema ciałami w Twoim zasięgu, Boro tuczy się bezpiecznie daleko.',
  },

  screenshots: [
    { id: 'chips', caption: 'Chipy graczy pod mapą i przełącznik „kto Cię dosięgnie w ≤8 h" — kolor, ukrywanie, wejście do dossier.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/dashboard/mapPrimitives.js',
    'src/domain/geometry.js',
  ],

  status: 'drafted',
};
