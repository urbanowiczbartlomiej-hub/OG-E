// @ts-check

// Discovery: src/features/sendSpy/{index,pure}.js (twarze przycisku, wysyłka),
//   src/domain/scanPriority.js (kolejność planu), src/domain/galaxyWatch.js
//   (plan zerknięć, sweep konta), src/domain/fleetLanding.js (moon strike),
//   src/domain/scanMode.js, src/state/watchList.js (ustawienia).
// UWAGA fair-play: wysyłka idzie natywnym dwuetapowym formularzem gry, jedno
//   ciało na raz; „Look" to zwykłe przejście do układu w widoku galaktyki.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-scan',
  category: 'spyglass',
  locale: 'pl',

  name: 'Skan: Look, Spy, Strike',
  oneLiner:
    'Przycisk Spyglass w grze podaje jedno następne działanie wywiadowcze: darmowe zerknięcie, sondę albo okazję na księżyc — zawsze dokładnie to jedno.',
  order: 3,

  idea: [
    'Przycisk pokazuje **jedną propozycję naraz**, wybraną z planu skanów dla obserwowanych graczy. `Look` to wejście do układu w widoku galaktyki — darmowe i niewykrywalne; w podpisie masz cel `[galaktyka:układ]` oraz `×N`, czyli ile obserwowanych ciał odświeży ta jedna wizyta. `Spy` to sonda na jedno ciało: pierwsze tapnięcie uzbraja i pokazuje, do kogo lecisz, drugie wysyła. `Strike` zapala się, gdy z samych zerknięć wynika, że na księżycu może stać zaparkowana flota. `N left` mówi, ile ciał w planie jeszcze czeka.',
    'Kolejność planu to **zagrożenie × przeterminowanie × dobry moment**: najpierw nigdy nieskanowane i te po terminie, a jeśli lokalna godzina wpada w zaobserwowane okno aktywności celu, propozycja awansuje. Terminy ustawiasz sam (`Re-scan`, `Re-look`), tak samo jak liczbę sond na skan, czy skanować planety, księżyce, czy jedno i drugie, oraz czy sondy startują z najbliższej planety, czy z tej, na której właśnie stoisz.',
  ],

  value: [
    'Prowadzenie wywiadu ręcznie to księgowość: kto był skanowany, co się przeterminowało, gdzie wystarczy zerknąć zamiast palić sondy, którą planetę pominąłeś. Przycisk trzyma tę księgowość za Ciebie i zostawia Ci jedną decyzję — tapnąć albo nie. Świetnie się to sprawdza na telefonie, gdzie przeklikiwanie galaktyki jest najbardziej męczące.',
  ],

  fairplay: {
    summary: [
      'Jedno tapnięcie to jedno działanie. OG-E **nie wysyła sondy samo**: wypełnia natywny, dwuetapowy formularz wysyłki floty i naciska przycisk gry — ten sam, który nacisnąłbyś ręcznie — i tylko dla **jednego** ciała. Nie istnieje „przeskanuj wszystko" ani żadna akcja wielocelowa. `Look` to po prostu przejście do układu w widoku galaktyki, dokładnie to, co robi gracz strzałkami.',
      'Plan skanów to **kolejka propozycji, nie kolejka zadań**: nie ma timerów, nie ma wysyłek w tle, nic nie startuje bez Twojego tapnięcia, a bez otwartej karty gry przycisk w ogóle nie istnieje. Cała wiedza, na której opiera się kolejność, to Twoje własne raporty i Twoje własne przeglądanie galaktyki.',
    ],
  },

  details: [
    '`galaxy` i `probes` na karcie obserwowanego to **dwa niezależne kanały** — możesz prowadzić gracza wyłącznie zerknięciami, wtedy cel nie widzi absolutnie nic.',
    'Zerknięcia zapisują się dla obserwowanych zawsze, gdy przeglądasz galaktykę; przełączniki wyciszają tylko *propozycje*, nie zapis.',
    '`Moon strike`: `off`, `lone` (świeci wyłącznie księżyc, resztę widać jako cichą), `newest` (na księżycu najświeższa interakcja konta), `any`. Przed uderzeniem przycisk każe najpierw domknąć podgląd całego konta.',
    '`↻` na karcie oznacza wszystkie ciała gracza jako „do ponownego skanu"; `never` znaczy „nigdy nieszpiegowany".',
    'Ciała wysłane w tej sesji wypadają z planu, a te w terminie w ogóle do niego nie wchodzą — nie da się przypadkiem zdublować sondy.',
    'Ustawiony promień patrolu dokłada do planu zerknięć sąsiedztwo Twoich kolonii (patrz „Patrol").',
  ],

  demo: {
    id: 'spy-fab-faces',
    caption: 'Trzy prawdziwe twarze przycisku Spy — napisy pochodzą z tego samego kodu, który maluje go w grze. Przycisk zawsze mówi, co zrobi NASTĘPNE tapnięcie, i nigdy nie twierdzi więcej, niż widać w sygnałach: „fresh landing?" to pytanie, nie werdykt.',
  },

  screenshots: [
    { id: 'spy', caption: 'Twarz „Spy" po uzbrojeniu: widzisz, do kogo lecisz — drugie tapnięcie wysyła sondę.' },
    { id: 'settings', caption: 'Ustawienia skanów: liczba sond, planety/księżyce, punkt startu, terminy odświeżania, tryb polowania na księżyce.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/sendSpy/pure.js',
    'src/domain/scanPriority.js',
    'src/domain/galaxyWatch.js',
    'src/domain/fleetLanding.js',
  ],

  status: 'drafted',
};
