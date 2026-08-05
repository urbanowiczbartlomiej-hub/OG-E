// @ts-check

// Discovery: src/domain/homeWatch.js (systemy własne, diff sąsiadów, zasięg
//   gracza `rankHomeNeighbours`, koalicje sojuszu `findHomeCoalitions`,
//   wykluczenie swoich `friendlyNeighbourIds`), src/features/homeWatch/ (czytnik
//   in-game: scans → diff), src/state/homeWatch.js (baseline + log przybyć,
//   wygasanie flagi NEW), src/features/dashboard/homeWatch.js (karta).
// UWAGA: to jedyna funkcja Spyglassa patrząca DO WEWNĄTRZ ("kto może uderzyć w
//   MNIE"), nie na zewnątrz. Nie proponuje ataku i nie ma w sobie żadnej akcji.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-home',
  category: 'spyglass',
  locale: 'pl',

  name: 'Straż domowa (Home watch)',
  oneLiner:
    'Pilnuje systemów, w których mieszkasz: mówi, kto się właśnie wprowadził obok Ciebie i który sąsiad ma już flotę w kilku Twoich systemach naraz.',
  flagship: true,
  order: 6,

  idea: [
    'Każde Twoje własne spojrzenie na galaktykę jest porównywane z poprzednim — i jeśli w systemie, w którym trzymasz planetę albo księżyc, pojawił się ktoś nowy, dostajesz o tym jedną informację. Systemy własne wchodzą do planu „Look" przycisku Spy na **własnym tempie** (domyślnie raz na 24 h, `0` = wyłączone): sąsiad się nie „rusza", ktoś musi się dopiero skolonizować, więc sprawdzanie co godzinę nic nie przyśpiesza.',
    'Karta nie pokazuje adresów, tylko **aktorów**. Jeden wiersz na sąsiada: kolor = jego `Danger`, `×N` = w ilu Twoich systemach już siedzi. To ta druga liczba jest eskalacją, o której łatwo zapomnieć — konto z flotą w trzech Twoich systemach może samo wejść na księżyc w trzech miejscach, bez czasu lotu, który dałoby się zaplanować. Osobno wypisywane są **sojusze, których członkowie razem sięgają dalej niż każdy z nich osobno**: dwóch ludzi z jednego tagu w jednym Twoim systemie to nie eskalacja (zasięg ten sam co jednego), ale czterech Twoich systemów pokrytych wspólnie — już tak.',
  ],

  value: [
    'Sąsiedztwo to jedyna rzecz, której nie widzisz w highscore: hunter jeden system od Twojego księżyca nie ma żadnego czasu lotu i widzi Twoje ciała w galaktyce, ilekroć ją otworzy. Straż domowa zamienia to w jedno zdanie w odpowiednim momencie — „ten fleet-save, który latasz od miesięcy, przestał być bezpieczny" — zamiast w rzecz, o której dowiadujesz się z raportu po stracie floty.',
  ],

  fairplay: {
    summary: [
      'Obserwacja to **Twoje własne otwarcie widoku galaktyki** — nic nie jest inicjowane w tle, nie ma timera, nie ma odpytywania serwera. Cała funkcja to porównanie tego, co OG-E i tak zapisał z Twoich przeglądów: kto był w systemie wtedy, kto jest teraz. Nie ma tu żadnej akcji w grze i nigdy nie proponuje ataku — ta karta odpowiada wyłącznie na pytanie obronne.',
      'Nic nie „patrzy" za Ciebie: jeśli nie otworzysz gry, nie dowiesz się o niczym, i tak ma być. Nie ma powiadomienia na telefon, dźwięku ani odczytu wrogich flot poza kartą gry. Baseline (pamięć „kto tu był") jest **lokalny dla urządzenia** i nie jest wysyłany ani współdzielony.',
      'Twój sojusz i lista przyjaciół są **wykluczani z definicji** — to towarzystwo, nie ekspozycja. Flaga NEW gaśnie sama dobę po tym, jak ją przeczytasz; nie ma nic do klikania i nic do „potwierdzania".',
    ],
  },

  details: [
    'Pole `Home` w ustawieniach Spyglassa to godziny (`0` = wyłączone). Domyślnie 24 h — osobno od `Re-look`, który dotyczy obserwowanych graczy.',
    'Pierwsze spojrzenie na system **nie produkuje przybyć** — tylko zapisuje stan wyjściowy. Inaczej pierwszy dzień działania funkcji wysypałby kilkanaście „nowych" sąsiadów i nauczyłby Cię ignorować alert.',
    'Odejścia nie są raportowane: sąsiad, który się wyprowadził, to dobra wiadomość, a widok galaktyki nie odróżnia „porzucone" od „patrzyłem w złym momencie".',
    'Ten sam gracz w **kolejnym** Twoim systemie to nowa wiadomość (rośnie `×N`). Druga planeta w systemie, w którym już jest, nie — w środku już był.',
    'Przycisk Spy kieruje Cię do dashboardu **dopiero po domknięciu obejścia wszystkich własnych systemów** i tylko gdy jest co czytać. Jedno tapnięcie, potem sygnał sam znika.',
  ],

  screenshots: [
    { id: 'card', caption: 'Karta Straży domowej na zakładce Spyglass — nowe przybycie, wiersze per sąsiad i linia koalicji sojuszu.' },
  ],

  demo: {
    id: 'home-watch',
    caption: 'Prawdziwy komponent OG-E wyrenderowany na zmyślonych danych (nicki, tagi i koordynaty nie należą do nikogo). Kolor krawędzi wiersza = Danger, `×N` = w ilu Twoich systemach ten gracz siedzi, zapalony tag = sojusz, który razem sięga dalej niż każdy z jego członków osobno.',
  },

  codeRefs: [
    'src/domain/homeWatch.js',
    'src/features/homeWatch/index.js',
    'src/state/homeWatch.js',
    'src/features/dashboard/homeWatch.js',
  ],

  status: 'drafted',
};
