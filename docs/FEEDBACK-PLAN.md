# Plan prac — feedback po wydaniu 1.17.0

> **Cel tego pliku.** To jest centralny rejestr zadań zebranych z feedbacku
> użytkownika po wydaniu 1.17.0. Służy do tego, by **żadne zadanie nie
> uciekło**, by pracę dało się prowadzić **przez wiele niezależnych sesji**, i
> by każda nowa sesja mogła **bez problemu kontynuować** od miejsca, w którym
> skończyła poprzednia. Czytaj go na początku każdej sesji i aktualizuj na
> bieżąco (statusy + dziennik postępu w każdym zadaniu).

---

## Jak pracujemy (konwencje tej serii zmian)

- **Branch roboczy:** `claude/project-setup-branch-hq8sgn`. Wszystkie zmiany tu,
  kolejnymi commitami. Każde zadanie (lub jego logiczny kawałek) = osobny commit
  w konwencji Conventional Commits (`fix:` / `feat:` / `refactor:` / …).
- **SKRÓT: bez testów.** Świadomie, dla oszczędności czasu, **nie uruchamiamy,
  nie poprawiamy ani nie dopisujemy testów** w tej serii. (To odstępstwo od
  reguły z `CLAUDE.md` — zaakceptowane przez użytkownika dla tego cyklu.)
  `npm run typecheck` warto uruchamiać, bo jest tani i łapie realne błędy.
- **Architektura nadrzędna:** trzymamy się warstw z `CLAUDE.md`
  (`lib ← domain ← state ← features/sync`, `bridges → lib`). Logika nietrywialna
  → `pure.js`. Selektory gry współdzielone przez ≥2 features → `lib/gameDom.js`.
- **Dane z gry (HTML / XHR):** użytkownik pracuje z telefonu i **chwilowo nie ma
  dostępu do DevTools** — nie może dostarczyć dumpów HTML ani podejrzeć
  odpowiedzi XHR. Zadania oznaczone **⛔ BLOKADA: dane** wymagają takich danych,
  zanim ruszymy implementację ich krytycznej części. Przy nich projektujemy „na
  sucho” i czekamy z kodem na dane, albo robimy tylko bezpieczną część.

### Legenda statusów

- `TODO` — nie zaczęte
- `ANALIZA` — w trakcie analizy / projektowania
- `W TOKU` — implementacja rozpoczęta
- `⛔ BLOKADA` — czeka na dane od użytkownika (HTML/XHR) lub decyzję
- `REVIEW` — zaimplementowane, czeka na weryfikację użytkownika w grze
- `DONE` — zweryfikowane / domknięte

---

## Tablica zadań (przegląd)

| ID | Zadanie | Trudność | Status |
|----|---------|----------|--------|
| T1  | Klawiatura wyskakuje na DAILY RUN przy przejściu na fleet2 | łatwe | TODO |
| T2  | Płynniejsze podświetlanie handlarza (jak Event) | łatwe | TODO |
| T3  | Tytuł sekcji „Currently queued” dla ekspedycji w Reminders | łatwe | TODO |
| T4  | Anulowanie remaindera FS na eventList (stan, 3 min, odznaczanie) | średnie | TODO |
| T5  | Własność przejścia fleet1→fleet2 po XHR checkTarget | trudne | TODO |
| T6  | Free Positions → mapa sąsiedztwa / regiony zasiedlenia | trudne | TODO |
| T7  | DAILY RUN: za mało statków → komunikat/blokada; Send All pusta planeta → redirect | średnie | TODO |
| T8  | Bug „Vlad”: na księżycu kolonizacja fałszuje brak wolnych pozycji | średnie | TODO |
| T9  | Redesign pozostałych komponentów w duchu 4 nowych przycisków | średnie | TODO |
| T10 | Lifeform: blokada Discovery po osiągnięciu 3600 (+ kiedy odblokować) | średnie | TODO |
| T11 | Obsługa „all fleets” dla każdego przycisku | średnie | TODO |
| T12 | Blask cieniutkiej krawędzi w przyciskach dwustrefowych | łatwe | TODO |

### Sugerowana kolejność

1. **Najpierw łatwe (szybkie zwycięstwa, niskie ryzyko):** T3 → T2 → T12 → T1.
2. **Potem średnie, niezależne:** T8 (bug funkcjonalny, wysoki priorytet) → T7 →
   T10 → T11 → T4 → T9.
3. **Na końcu trudne (wymagają projektu i/lub danych):** T5 → T6.

Zależności / powiązania:
- **T12 ⟷ T9** — poprawka krawędzi to część szerszego audytu wyglądu; T12 zrób
  jako pierwsze, ustalenia przenieś do T9.
- **T10 ⟷ T11** — oba dotykają logiki „disabled + etykieta” przycisków; warto
  ujednolicić wspólny mechanizm „zablokowany przycisk + powód” raz.
- **T5 ⟷ T7** — oba dotykają domknięcia stanu fleet2 / `fsCollect`; T5 może
  zmienić założenia T7, więc trzymaj je blisko siebie w czasie.

---

## Zadania (szczegóły, analiza, dekompozycja, dziennik)

> W każdym zadaniu: **Feedback** = wierne źródło (nie tracimy intencji),
> **Analiza/projekt** = co wiemy o kodzie, **Pliki** = punkty wejścia,
> **Podzadania** = dekompozycja, **Dane** = czego potrzeba od użytkownika,
> **Dziennik** = co zrobiono w której sesji.

---

### T1 — Klawiatura wyskakuje na DAILY RUN przy przejściu na fleet2
**Status:** TODO · **Trudność:** łatwe

**Feedback (wiernie):** „Klawiatura wyskakuje na przycisku DAILY RUN. W momencie
przechodzenia na fleet2. Pojawia się i od razu chowa.”

**Analiza/projekt:** Istnieją już wcześniejsze poprawki na pop-up klawiatury na
mobile: `tabIndex = -1` na przyciskach, `mousedown.preventDefault()` w warstwie
tap-wire, oraz `installFocusPersist` pomijający programowy `focus()` na
`pointer: coarse`. Najpewniej przycisk daily-run (`fsCollect`) nie korzysta z
tej samej ścieżki ochrony przy przejściu fleet1→fleet2 (re-render/nawigacja
przywraca focus). Hipoteza: dodać daily-run do tej samej ścieżki
`installFocusPersist` z gardą coarse-pointer, jak `sendExp`/`sendCol`.

**Pliki:**
- `src/features/shared/button.js:223,267` — `tabIndex=-1`
- `src/features/shared/draggableButton.js:233-250` — `installFocusPersist`, garda
  coarse pointer (`window.matchMedia('(pointer: coarse)')`, ~`:244-248`)
- `src/features/fsCollect/index.js` — orkiestracja daily-run

**Podzadania:**
1. Potwierdzić, czy fsCollect używa `installFocusPersist` / tej samej warstwy co
   sendExp/sendCol.
2. Jeśli nie — podpiąć analogicznie, z gardą coarse-pointer.
3. Sprawdzić moment przejścia na fleet2 (nawigacja `expeditionRedirect`/
   `deployRedirect`?) — czy to nie ono przywraca focus.

**Dane:** w większości analiza kodu wystarczy; ostateczna weryfikacja w grze
(REVIEW) na telefonie po stronie użytkownika.

**Dziennik:** —

---

### T2 — Płynniejsze podświetlanie handlarza (jak Event)
**Status:** TODO · **Trudność:** łatwe

**Feedback (wiernie):** „Do poprawy podświetlanie handlarza w menu. Obecne nie
jest płynne. Dużo lepiej zachowuje się na przycisku Event. Może najlepiej będzie
zastosować dokładnie to samo z takim samymi animacjami i prędkościami, ale inne
kolory. Zostawimy te co są.”

**Analiza/projekt:** `eventMenuHighlight` używa timingu 4s **linear** + zachowania
na hover/active (zatrzymanie pulsu → stały blask). `traderMenuHighlight` ma
animacje 4s **ease-in-out** (żółty/czerwony) i delikatniejsze keyframes dla menu.
Plan: przenieść timing/krzywą i zachowanie hover/active z Event do Tradera,
**zachowując obecne kolory** (żółty/czerwony).

**Pliki:**
- `src/features/traderMenuHighlight.js:147-253` (animacje), `:180-193` (keyframes menu)
- `src/features/eventMenuHighlight.js:87-140` (4s linear, hover/active)

**Podzadania:**
1. Wyrównać `animation-timing-function` do `linear` i czas do wartości z Event.
2. Przenieść zachowanie hover/active (`animation-name: none` → stały blask).
3. Zostawić paletę kolorów Tradera bez zmian.

**Dane:** nie — czysto kod + weryfikacja wizualna (REVIEW).

**Dziennik:** —

---

### T3 — Tytuł sekcji „Currently queued” dla ekspedycji w Reminders
**Status:** TODO · **Trudność:** łatwe

**Feedback (wiernie):** „Dodać poprawny tytuł sekcji w dashboard w remainders dla
Currently queued dla ekspedycji. Sekcja FS jest dobrze nazwana i sekcja ad-hoc
również. Dla ekspedycji jest tylko nazwa serwera.”

**Analiza/projekt:** Sekcje ad-hoc i fleet-save mają własne nagłówki h4; sekcja
fal ekspedycji renderuje tylko nazwę uniwersum (h3) bez podtytułu. Dodać nagłówek
typu „Expedition waves” (do ustalenia dokładny tekst) przed renderowaniem fal.

**Pliki:**
- `src/features/dashboard/reminders.js:373` (h3 = nazwa serwera), `:374`
  (wywołanie `renderWavesInto`), wzorce nagłówków `:589` (ad-hoc), `:667` (FS)

**Podzadania:**
1. Dodać h4 z tytułem nad falami ekspedycji, spójny stylem z ad-hoc/FS.
2. Ustalić brzmienie tytułu (proponowane: „Expedition waves”).

**Dane:** nie.

**Dziennik:** —

---

### T4 — Anulowanie remaindera FS na eventList (stan, 3 min, odznaczanie)
**Status:** TODO · **Trudność:** średnie

**Feedback (wiernie):** „Poprawić anulowanie remainders dla FS na eventList.
Komunikat mówi że jak jest 2 minuty przed przypomnieniem to można je anulować,
ale po kliknięciu w przycisk nie zmienia on swojego stanu. Choć chyba faktycznie
przypomnienie się wycofuje. Można by zrobić że jeśli już jest ten czas kiedy
można anulować przypomnienie, przycisk, a już na pewno opis hinta, powinien się
zmieniać. Można ustalić tutaj 2 HZ dla sprawdzania i zmiany stanu, albo jakiś
timer od góry znany do jego zmiany. Po anulowaniu, i jeśli nie ma kolejnych
remainders większych niż 0 to możemy zlikwidować oznaczenie i pozwolić graczowi
zaznaczyć pozycję jak każdy inny slot czyli ad-hoc. Zachodzi jeszcze problem
minimalnego czasu do automatycznego oznaczania misji jako FS. Jeśli anulowany
remainder odnosi się do takiej misji (jej ID) który potencjalnie może być
automatycznie sklasyfikowany do oznaczenia to nie pozwalamy na jego anulowanie.
To chyba logiczne i jeśli chcę dopuszczać takie sytuacje to nie zmienia minimalny
czas dla automatycznej detekcji FS na większy. Należy też zmienić możliwość
anulowania remaindera dla FS z 2 na 3 minut.”

**Analiza/projekt:** Cztery wymagania:
1. **Reaktywny stan przycisku/hinta** gdy wejdziemy w okno anulowania — timer
   2 Hz albo policzony „od góry” moment przełączenia.
2. **Po anulowaniu i braku kolejnych remainders >0** → usunąć oznaczenie FS na
   nodze misji, pozwolić oznaczyć pozycję jak ad-hoc.
3. **Blokada anulowania**, jeśli misja (jej ID) mogłaby zostać automatycznie
   sklasyfikowana jako FS (próg minimalnego czasu lotu). Nie zwiększamy progu
   auto-detekcji, żeby obejść problem.
4. **Okno anulowania: 2 → 3 minuty.**

**Pliki:**
- `src/features/reminders/fsCancel.js:32-100` (logika okna/wygaśnięcia, dziś 2 min ~`:100`)
- `src/features/reminders/eventList.js:56,60,100-200` (import fsCancel, render badge)
- `src/features/reminders/producer.js:70` (`fsCancelOffsets`)
- `src/domain/fleetSave.js:35-40` (`minFlightSec`, próg auto-klasyfikacji FS)

**Podzadania:**
1. Zmienić okno anulowania 2→3 min (`fsCancel.js`).
2. Dodać reaktywne przełączanie stanu (2 Hz tick lub timer do momentu otwarcia
   okna) — przycisk + tekst hinta.
3. Po anulowaniu: jeśli brak kolejnych remainders >0 → zdjąć oznaczenie FS z nogi,
   przywrócić możliwość oznaczenia ad-hoc.
4. Dodać gardę: jeśli ID misji kwalifikuje się do auto-klasyfikacji FS (wg
   `minFlightSec`), zablokować anulowanie (z czytelnym hintem dlaczego).

**Dane:** raczej kod; ewentualnie potwierdzenie zachowania w grze (REVIEW).

**Dziennik:** —

---

### T5 — Własność przejścia fleet1→fleet2 po XHR checkTarget
**Status:** TODO · **Trudność:** trudne · ⛔ BLOKADA: dane (XHR)

**Feedback (wiernie):** „Być może da się śledzić XHR sprawdzania targetu misji i
na tej podstawie aktywować odpowiedni przycisk który mógł być potencjalnym
aktywatorem takiego typu XHRa. Obecnie każdy przycisk mimo że nie był aktywatorem
przejścia z fleet1 do fleet2 może wykryć że jest w stanie fleet2, mimo tego że
nie aktywował tego przejścia i może zakończyć (po przec click [prawdop. „pre /
przez click”]) stan fleet2 przez akceptację wysyłki misji za którą nie jest
odpowiedzialny. Być może da się to blokować i w takich przypadkach kierować
użytkownika na główną stronę fleetdispatcher. Najtrudniej będzie wykrywać to dla
misji ekspedycji które są klikane przez routine-7 od AGR i do końca nie wiemy
jakie statki zostały wyznaczone na fleet1, jednak wiemy że pozycja targetu to 16
a statki konieczne to albo mały/duży Transporter albo pionier — to statki z dużym
cargo i do tego powinien być przyjaźniej i najlepiej tylko jeden pionier i do tego
przynajmniej i najlepiej tylko jeden statek bojowy.”

**Analiza/projekt:** Problem własności: każdy przycisk widzi globalny stan fleet2
i może „dokończyć” cudzą wysyłkę. Cel: powiązać sesję fleet1→fleet2 z konkretnym
przyciskiem-inicjatorem (po XHR `checkTarget`), a pozostałym przyciskom blokować
domknięcie i kierować na główny `fleetdispatcher`. Najtrudniejszy przypadek:
ekspedycje odpalane przez AGR routine-7 — nie znamy z góry składu floty na fleet1.
Heurystyka rozpoznania ekspedycji: target pozycja **16**; statki o dużym cargo
(mały/duży Transporter lub Pionier/Pathfinder); preferencyjnie dokładnie jeden
Pionier i co najwyżej jeden statek bojowy.

**Pliki:**
- `src/bridges/checkTargetHook.js:1-209` (obserwuje `action=checkTarget`,
  dispatch `oge:checkTargetResult`)
- `src/bridges/sendFleetHook.js` (obserwuje `action=sendFleet`)
- `src/bridges/fleetDispatcherSnapshot.js` (snapshot `window.fleetDispatcher`)
- `src/features/shared/fleetCourier.js` (detekcja stanu fleet1/fleet2)
- `src/features/{sendExp,sendCol,fsCollect}/index.js` (domknięcie fleet2)

**Podzadania:**
1. Zaprojektować „sesję własności”: znacznik (np. id/timestamp) nadawany przez
   przycisk-inicjator w momencie wywołania, dopinany do `checkTarget`/`sendFleet`.
2. `fleetCourier`: domykać fleet2 tylko dla pasującej sesji; inaczej redirect na
   główny fleetdispatcher.
3. Heurystyka rozpoznania ekspedycji AGR (pozycja 16 + profil floty) — gdy nie ma
   jawnego inicjatora OG-E.
4. Spójne zachowanie dla sendExp/sendCol/fsCollect/lifeform.

**Dane:** ⛔ Potrzebne **payloady XHR** `checkTarget` i `sendFleet` (request +
response) — szczególnie: jakie pola identyfikują typ misji, target, skład floty;
oraz przykład przejścia odpalonego przez AGR routine-7. Bez tego projekt zostaje
teoretyczny.

**Dziennik:** —

---

### T6 — Free Positions → mapa sąsiedztwa / regiony zasiedlenia
**Status:** TODO · **Trudność:** trudne

**Feedback (wiernie):** „Na mobile lista menu na dashboard nie mieści się w jednej
linii. Prawdopodobnie jedną opcję można z niej usunąć, a mianowicie liczenia
najdłuższego ciągu wolnych lokalizacji dla wskazanej pozycji. To opcja bardzo
niszowa. Możliwe że najlepiej przenieść ją pod dane z skalowania galaktyk jako
kolejny akapit. Być może należy ją też rozbudować dla lepszego uogólnienia. Być
może nie tylko liczyć ciąg dla jednej wskazanej pozycji, ale może nieco szerzej
dla kilku pozycji, ale range pozycji, przystosować pod nie tylko czysty strike
wolnych pozycji ale też pod pewne uśrednianie. Dużo lepiej wskazać region z
pominięciem jednej minimalnej niezgodności, braku ciągłości, niż na siłę szukać
ideału. Być może podczas skanowania galaktyk powinniśmy też zbierać informacje
nt. rankingu gracza na danej pozycji. To razem pozwala na budowanie mapy
potencjalnego sąsiedztwa, jeśli zdecydujemy się zasiedlić dany region. Ten featue
powinien pozwalać na analizę danych, budowanie mapy graczy, i podpowiadanie gdzie
opłaca się zasiedlać swoje planety. Oczywiście potrzeby są różne. Ktoś może szukać
regionów o najmniejszym zasiedleniu i o najniższych rankingach (gra bezpieczna /
ofensywna budowa), inni wysokiego zasiedlenia (gra agresywna, wiele ofiar), inni
sąsiedztwa graczy o wysokim rankingu (w paszczy lwa najbezpieczniej), jeszcze inni
po prostu wielu pozycji nr 8 maksymalizujących wydobycie metalu blisko siebie. Tym
więcej da nam ten featue od ręki tym lepiej, ale tym bardziej skomplikowany i
zaawansowany — tym gorzej dla normal userów. Trzeba to dobrze zaplanować. Być może
zbierać jeszcze więcej danych których do tej pory nie zbieraliśmy. Być może
przygotować lepsze algorytmy pod potencjalne analizy.”

**Analiza/projekt:** Dwie warstwy:
- **Natychmiast (część T6a, łatwa, rozładowuje mobile menu):** usunąć/zwinąć
  zakładkę „Free Positions” do sekcji skalowania galaktyk jako akapit → menu
  mieści się w jednej linii na mobile.
- **Docelowo (część T6b, duży feature, do zaprojektowania):** uogólnić analizę
  wolnych pozycji: zakresy pozycji, uśrednianie (region z pominięciem 1 luki
  zamiast szukania ideału), zbieranie rankingu gracza per pozycja w skanach,
  budowa mapy sąsiedztwa + tryby strategii (niskie/wysokie zasiedlenie, wysoki
  ranking sąsiadów, gęste pozycje 8 pod metal). **Ryzyko:** przekombinowanie UX
  dla normal userów — trzeba etapować i ukrywać zaawansowane analizy.

**Pliki:**
- `src/features/dashboard/index.js:50-80` (zakładki), `freeStreak.js` (zakładka)
- `src/domain/freeStreak.js`, `src/domain/positions.js` (logika ciągów)
- `src/features/dashboard/galaxy.js`, `src/state/scans.js`, `src/domain/scans.js`
  (dane skanów — tu dojdą ranking gracza i nowe pola)

**Podzadania:**
1. **T6a:** przenieść Free Positions pod skalowanie galaktyk; odchudzić menu na
   mobile. *(można zrobić od ręki, niezależnie od T6b)*
2. **T6b-projekt:** zaprojektować model danych (jakie nowe pola w skanach:
   ranking, status zasiedlenia), zanim zaczniemy zbierać.
3. **T6b-algorytmy:** uogólnione wyszukiwanie regionów (zakresy + tolerancja 1
   luki + uśrednianie), tryby strategii.
4. **T6b-UI:** progresywne ujawnianie (prosty widok dla zwykłych, zaawansowany
   opcjonalny).

**Dane:** dla T6b warto **dump HTML widoku galaktyki** (gdzie widać ranking gracza
przy pozycji) — żeby wiedzieć, co da się zbierać podczas skanu. ⛔ częściowo.

**Dziennik:** —

---

### T7 — DAILY RUN: za mało statków + Send All na pustej planecie
**Status:** TODO · **Trudność:** średnie

**Feedback (wiernie):** „Co w chwili wysyłania DAILY RUN górna strefa, a statków
nie jest wystarczająca ilość? Powinien być jasny komunikat i zablokowanie
możliwości przejścia dalej. Ale dla Send All, gdzie wysyłamy wszystko, ale okazuje
się że nic na planecie nie ma to, wykrywamy to i proponujemy redirect do
następnej planety, jak po wysłanym Send All.”

**Analiza/projekt:** Dwie ścieżki w `fsCollect`:
- **Górna strefa, za mało statków:** wykryć przed wysyłką, pokazać jasny komunikat,
  zablokować przejście dalej.
- **Send All na pustej planecie:** wykryć „nic do zabrania”, zaproponować redirect
  do następnej planety — analogicznie do zachowania po udanym Send All
  (`findNextCollectPlanetCp`).

**Pliki:**
- `src/features/fsCollect/index.js:250-300` (strefa collect / „Send All”)
- `src/features/fsCollect/domHelpers.js:160-200` (`readDeployLegs`,
  `findNextCollectPlanetCp`)

**Podzadania:**
1. Detekcja niewystarczającej liczby statków w górnej strefie → komunikat + blok.
2. Detekcja pustej planety przy Send All → propozycja redirectu do następnej.

**Dane:** może wymagać potwierdzenia, jak wygląda DOM/snapshot przy „pustej
planecie” i „za mało statków”. ⛔ częściowo (do potwierdzenia w grze).

**Dziennik:** —

---

### T8 — Bug „Vlad”: na księżycu kolonizacja fałszuje brak wolnych pozycji
**Status:** TODO · **Trudność:** średnie · priorytet wysoki (bug funkcjonalny)

**Feedback (wiernie):** „Vlad: brak możliwości wysyłania i skanowania jeśli gracz
nie znajduje się na planecie a na księżycu. Przycisk Kolonizacji sygnalizuje brak
wolnych pozycji do skanowania i brak wolnych do kolonizowania, mimo że to nie jest
prawdą. Bardzo ciekawe dlaczego istnieje taka zależność. Po przełączeniu się w
grze na planetę funkcje wracają do łask i poprawnie wyświetlają i obsługują stany
na podstawie bazy danych. Nie powinna istnieć taka zależność.”

**Analiza/projekt:** Gdy gracz jest na **księżycu**, przycisk kolonizacji błędnie
raportuje brak wolnych pozycji do skanu i kolonizacji. Po przełączeniu na planetę
działa poprawnie. Hipoteza: `readCurrentBody`/`readHomePlanet` zwraca kontekst
księżyca i logika dostępności `colPositions`/skanu nie odróżnia planety od
księżyca. Fix: kontekst pozycji powinien bazować na bazie danych/koordynatach
niezależnie od tego, czy aktualnie stoimy na planecie czy księżycu (księżyc dzieli
koordynaty z planetą — pozycja w systemie jest ta sama).

**Pliki:**
- `src/features/sendCol/index.js:1-150` (orkiestracja)
- `src/features/sendCol/domHelpers.js:1-100` (`readHomePlanet`, `readCurrentBody`)
- `src/features/sendCol/pure.js:195-220` (wyszukiwanie targetu)

**Podzadania:**
1. Zlokalizować, gdzie typ ciała (planeta vs księżyc) wpływa na liczenie wolnych
   pozycji / dostępność skanu.
2. Uniezależnić logikę od „stania na księżycu” (użyć koordynatów systemu, nie typu
   ciała).
3. Sprawdzić, czy ten sam problem nie dotyczy skanowania (przycisk skanu).

**Dane:** pomocny byłby **dump HTML, gdy gracz stoi na księżycu** (planet bar /
koordynaty / lista ciał) — żeby potwierdzić, co odczytujemy. ⛔ częściowo.

**Dziennik:** —

---

### T9 — Redesign pozostałych komponentów w duchu 4 nowych przycisków
**Status:** TODO · **Trudność:** średnie

**Feedback (wiernie):** „Inspirując się wyglądem czterech bardzo nowoczesnych i
profesjonalnie wyglądających przycisków pasujących do stylu OGame (kolonizacja,
DAILY RUN, ekspedycje, lifeform). Należy przemyśleć czy inne komponenty OG-E nie
wymagają drobnego redesignu. Highlights, overlay, buttons.”

**Analiza/projekt:** Audyt spójności wizualnej: czy podświetlenia (trader/event),
nakładka „abandon”, banner „fresh planet” i pozostałe przyciski pasują do nowego
stylu 4 głównych przycisków (cień, rim, glify, glow). Ujednolicić odstępy, cienie,
szerokości obwódek; rozważyć modernizację dialogu nakładki i palety banera.

**Pliki:**
- `src/features/shared/buttonChrome.js:47-164` (`BUTTON_CHROME_CSS`, ring/glow/edge)
- `src/features/shared/button.js`, `src/features/shared/buttonGlyphs.js`
- `src/features/abandon/overview.js` (overlay), `src/features/freshPlanetDetector.js` (banner)
- highlighty: `traderMenuHighlight.js`, `eventMenuHighlight.js`

**Podzadania:**
1. Spisać „design tokens” z 4 przycisków (kolory rim, glow, promienie, cienie).
2. Audyt komponent po komponencie: co odstaje.
3. Zastosować drobne, spójne poprawki (bez przebudowy logiki).

**Dane:** nie (wizualne, REVIEW). Powiązane z **T12**.

**Dziennik:** —

---

### T10 — Lifeform: blokada Discovery po 3600 (+ kiedy odblokować)
**Status:** TODO · **Trudność:** średnie · ⛔ BLOKADA: decyzja (warunek odblokowania)

**Feedback (wiernie):** „Kiedy dla form życia osiągniemy max 3600, można
zablokować wysyłania kolejnych misji Discovery. Tylko kiedy odblokować?”

**Analiza/projekt:** Po osiągnięciu sumarycznego limitu 3600 (form życia /
artefaktów?) zablokować przycisk lifeform (Discovery). Otwarte pytanie:
**warunek odblokowania** — opcje: (a) reset dzienny gry, (b) ręczne wyczyszczenie,
(c) wykrycie spadku poniżej 3600 z kolejnego XHR/DOM. Trzeba ustalić, skąd czytamy
bieżącą wartość 3600 (snapshot fleetDispatcher? osobny XHR? DOM lifeform?).

**Pliki:**
- `src/features/sendLifeform/index.js` (orkiestracja, etykieta/disabled)
- `src/bridges/discoveryHook.js:29-100` (`sendSystemDiscoveryFleet`, wynik)
- `src/state/scans.js` (per-position; ewentualnie nowe pole na sumę)

**Podzadania:**
1. Ustalić źródło bieżącej wartości limitu 3600 (skąd ją czytamy).
2. Zablokować przycisk po osiągnięciu (disabled + etykieta — wspólny mechanizm z T11).
3. Zdecydować i zaimplementować warunek odblokowania.

**Dane:** ⛔ Potrzeba potwierdzić **skąd odczytać 3600** (XHR discovery response /
DOM lifeform). Oraz decyzja użytkownika o warunku odblokowania.

**Dziennik:** —

---

### T11 — Obsługa „all fleets” dla każdego przycisku
**Status:** TODO · **Trudność:** średnie

**Feedback (wiernie):** „Dodać obsługę all fleets! Dla każdego przycisku... Dla
lifeform nieco inaczej tj przez niedostępny przycisk do wysyłania a dla tych z
fleet1 po etykiecie.”

**Analiza/projekt:** Wykrywać stan „wszystkie sloty flot zajęte”:
- **Przyciski z fleet1** (exp/col/daily): sygnalizacja **po etykiecie**
  („All fleets used” lub podobnie).
- **Lifeform:** inaczej — przez **niedostępny (disabled) przycisk** wysyłki.
`fleetDispatcherSnapshot` już niesie część danych (`expeditionCount`/
`maxExpeditionCount`); dla pozostałych dodać liczbę zajętych/maks slotów.

**Pliki:**
- `src/bridges/fleetDispatcherSnapshot.js:56-100` (`expeditionCount`/`maxExpeditionCount`)
- `src/features/sendExp/pure.js:95-98` (`isGlobalExpeditionCapReached…`)
- `src/features/{sendExp,sendCol,fsCollect,sendLifeform}/index.js` (etykiety/disabled)

**Podzadania:**
1. Rozszerzyć snapshot o ogólną liczbę slotów flot (used/max), jeśli brak.
2. Wspólny helper „disabled + powód” (współdzielony z T10).
3. Etykieta dla exp/col/daily; disabled dla lifeform.

**Dane:** potwierdzić w `window.fleetDispatcher`, jakie pole daje used/max slotów
flot (nie tylko ekspedycji). ⛔ częściowo (do potwierdzenia).

**Dziennik:** —

---

### T12 — Blask cieniutkiej krawędzi w przyciskach dwustrefowych
**Status:** TODO · **Trudność:** łatwe

**Feedback (wiernie):** „Poza ring w przyciskach wystaje jeszcze cieniutka nitka
nadająca błyszczącą krawędź. W przyciskach mających dwie strefy krawędź ta nie
jest wystarczająco rozjaśniona i przez to nie daje efektu blasku jak jest to w
przyciskach z 1 zone.”

**Analiza/projekt:** Cienka jasna obwódka (edge thread) jest dobrze widoczna w
przyciskach jednostrefowych, ale w dwustrefowych (split) jest za mało rozjaśniona
— gradienty stref i divider „przygaszają” postrzeganą krawędź. Fix: dla klasy
split podbić jasność/`--glow` krawędzi lub dodać ostrzejszy highlight na granicy
stref, by efekt blasku był jak w 1-zone.

**Pliki:**
- `src/features/shared/buttonChrome.js:59-62` (box-shadow: rim + outer glow),
  `:72-73` (split layout), `:80-88` (gradienty stref + divider), `:144-151` (hover)

**Podzadania:**
1. Porównać wartości blur/glow między single a split.
2. Podbić jasność krawędzi dla split (np. mocniejszy `--rim`/`--glow` lub dodatkowy
   inset highlight).

**Dane:** nie (wizualne, REVIEW). Ustalenia przenieść do **T9**.

**Dziennik:** —

---

## Dziennik sesji (globalny)

> Krótkie wpisy „co zrobiono w tej sesji”, żeby kolejna szybko złapała kontekst.

- **2026-06-11 (sesja startowa):** Zmergowano `v1.17.0` do `main` (fast-forward),
  przebazowano branch roboczy na `main` (wersja 1.17.0). Zebrano i skatalogowano
  12 zadań z feedbacku do tego pliku. Nie zaczęto jeszcze implementacji.
