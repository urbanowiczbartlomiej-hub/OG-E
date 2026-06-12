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
| T1  | Klawiatura wyskakuje na DAILY RUN przy przejściu na fleet2 | łatwe | REVIEW |
| T2  | Płynniejsze podświetlanie handlarza (jak Event) | łatwe | REVIEW |
| T3  | Tytuł sekcji „Currently queued” dla ekspedycji w Reminders | łatwe | REVIEW |
| T4  | Anulowanie remaindera FS na eventList (stan, 3 min, odznaczanie) | średnie | REVIEW |
| T5  | Własność przejścia fleet1→fleet2 po XHR checkTarget | trudne | TODO |
| T6  | Free Positions → mapa sąsiedztwa / regiony zasiedlenia | trudne | REVIEW |
| T7  | DAILY RUN: za mało statków → komunikat/blokada; Send All pusta planeta → redirect | średnie | REVIEW |
| T8  | Bug „Vlad”: na księżycu kolonizacja fałszuje brak wolnych pozycji | średnie | REVIEW |
| T9  | Redesign pozostałych komponentów w duchu 4 nowych przycisków | średnie | TODO |
| T10 | Lifeform: blokada Discovery po osiągnięciu 3600 (+ kiedy odblokować) | średnie | TODO |
| T11 | Obsługa „all fleets” dla każdego przycisku | średnie | TODO |
| T12 | Blask cieniutkiej krawędzi w przyciskach dwustrefowych | łatwe | REVIEW |

### Sugerowana kolejność (stan po sesji 6)

T1–T4, T6–T8, T12 → REVIEW lub DONE. Pozostaje:
1. **Bez blokad, wizualne:** T9 (redesign) — dobry start nowej sesji.
2. **Częściowo zablokowane na dane:** T11 (all fleets) — dane z
   `window.fleetDispatcher` do potwierdzenia; T10 (lifeform 3600) — decyzja
   o warunku odblokowania.
3. **Mocno zablokowane:** T5 (własność fleet2) — potrzebne XHR `checkTarget`
   + `sendFleet`.

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
**Status:** REVIEW · **Trudność:** łatwe

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

**Dziennik:**
- 2026-06-11 (sesja 2): Fałszywa hipoteza zweryfikowana — fsCollect MA
  `installFocusPersist` z gardą coarse-pointer. Rzeczywista przyczyna:
  `fleetExecutor.js:fireInput()` wywołuje `input.focus()` na polach
  koordynatów AGR (fleet1), co na mobile otwiera klawiaturę. Fix: garda
  `!isTouchPrimary` przed `input.focus()` — zdarzenia KeyboardEvent
  działają bez rzeczywistego focusu. Commit `f889bb3`. Status: REVIEW.

---

### T2 — Płynniejsze podświetlanie handlarza (jak Event)
**Status:** REVIEW · **Trudność:** łatwe

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

**Dziennik:**
- 2026-06-11 (sesja 2): Zmieniono keyframe'y menu (`oge-trader-menu-*`)
  z symetrycznego 50% na asymetryczny 0%/70%/100% + 85% peak (jak Event),
  dodano `animation-timing-function: linear` dla `.oge-trader-menu.*`.
  Kolory i zachowanie hover/active niezmienione. Commit `880c2d1`. REVIEW.

---

### T3 — Tytuł sekcji „Currently queued” dla ekspedycji w Reminders
**Status:** REVIEW · **Trudność:** łatwe

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

**Dziennik:**
- 2026-06-11 (sesja 2): Dodano `h4` z tekstem „Currently queued" na
  początku `renderWavesInto` (po early-return), spójny stylem z h4 w
  sekcjach ad-hoc i fleet-save. Commit `5394664`. Status: REVIEW.

---

### T4 — Anulowanie remaindera FS na eventList (stan, 3 min, odznaczanie)
**Status:** REVIEW · **Trudność:** średnie

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

**Dziennik:**
- 2026-06-11 (sesja 3): Zaimplementowano wymagania 1, 2, 4. Diagnoza wym. 1:
  stan „cancellable" i „passive" miały IDENTYCZNE klasy CSS (`fs`) — różniły
  się tylko tooltipem i kursorem, stąd „przycisk nie zmienia stanu" po
  kliknięciu. Dodano klasę `fs-cancel` (jaśniejszy badge + puls + ✕) oraz
  dokładny timer (`fsFlipTimer`) re-renderujący w momencie najbliższej
  tranzycji (otwarcie okna / odpalenie slotu) — wariant „timer od góry
  znany" zamiast 2 Hz. Okno: `FS_CANCEL_WINDOW_SEC` 120→180 s, hinty liczone
  z tej stałej. Wym. 2: nowy pure-helper `hasUpcomingFsSlot` — wyczerpana
  seria (wszystko anulowane/odpalone) zwalnia wiersz do trybu ad-hoc.
  **Wym. 3 (garda) ŚWIADOMIE POMINIĘTE** — dwa powody: (a) re-klasyfikacja
  jest już niemożliwa: `reconcileFleetSaves` trzyma anulowany wpis jako lock
  z pustą serią póki flota leci (udokumentowano to jako inwariant w
  docstringu); (b) dosłowna garda „blokuj gdy pozostały lot ≥ minFlightSec"
  przy domyślnej konfiguracji (slot -10 min, okno 3 min ⇒ pozostały lot
  600–780 s ≥ 600 s) blokowałaby anulowanie ZAWSZE, zabijając całą funkcję.
  Intencja gardy (brak re-detekcji po anulowaniu) jest spełniona przez lock.
  Do weryfikacji w grze: puls badge w oknie, anulowanie, powrót do ad-hoc.

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
**Status:** W TOKU (T6a + silnik regionów + zbieranie ranku → REVIEW;
mapa/strategie zaprojektowane, czekają na potwierdzenie danych) · **Trudność:** trudne

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

**Dane:** ⛔ ZDJĘTE — użytkownik dostarczył pełny response `fetchGalaxyContent`
(s163-pl, G1:S119). Potwierdzone: ranking = `player.highscorePositionPlayer`
(liczba, np. 749); UWAGA `player.rank` to OBIEKT tytułu („Bandyta") — usunięty
z kandydatów. Response ujawnił też, że trzy detekcje były MARTWE na
współczesnym payloadzie: księżyc = `planetType: 3` (brak `isMoon`/`luna`),
debris = wpis w `planets[]` z `planetType: 2` (brak `entry.debris`), sojusz =
`allianceId` (nie `allyId`). Naprawione + regresja: slot z samym debris
klasyfikował się jako `occupied`, teraz `empty` + `hasDebris`.

**Dziennik:**
- 2026-06-11 (sesja 3): **T6a zrobione** — zakładka „Free Positions" usunięta
  z paska (menu mieści się w jednej linii na mobile), treść jako pod-sekcja
  `.sub-section` w Galaxy Observations; zapamiętany tab `free` w localStorage
  bezpiecznie spada na default. **Silnik regionów** — nowy czysty
  `domain/regions.js` `findBestRegions(scans, { positions, status, maxGaps,
  galaxyMax })`: lista/zakres pozycji (gramatyka `parsePositions`, np.
  `12-15`; system pasuje gdy KAŻDY slot potwierdzony), tolerancja luk
  (region może mostkować ≤K niezgodnych/nieskanowanych systemów; zawsze
  zaczyna i kończy się na trafieniu), zawijanie 499→1 (podwojona lista
  trafień + two-pointer). Z defaultami (slot 15, 0 luk) wynik ≡ stare
  `findLongestStreaks` (moduł zostawiony — testy). UI: input pozycji +
  select tolerancji (perfect/1/2), tabela z kolumnami Free/Gaps; sanity
  ad-hoc w node potwierdził wrap/luki/AND/pełne koło. **Zbieranie ranku** —
  `Position.player.rank?` z payloadu galaktyki (best-effort, kandydaci jw.),
  klasyfikacja nietknięta gdy pola brak. Commity: `dashboard` + `scans`.
- 2026-06-11 (sesja 3, cd.): Użytkownik wkleił prawdziwy response skanu →
  model danych POTWIERDZONY i rozszerzony. Zbieramy teraz per pozycja:
  `player.rank` (highscore, potwierdzony numerycznie), `player.ally` (tag
  sojuszu), `flags.honorable` (`isHonorableTarget`), `moonSize` (trwała
  średnica księżyca — pod analizy zniszczenia księżyca/falangi) + naprawione
  martwe detekcje `hasMoon`/`hasDebris`/`inAlliance` (szczegóły w „Dane").
  Sanity na realnych pozycjach 1/2/4 + debris-only w node — OK. Etap 2
  ODBLOKOWANY (rank potwierdzony bez czekania na skany użytkownika).
- **Projekt T6b etap 2 (mapa sąsiedztwa + strategie)** — ODBLOKOWANY,
  do podjęcia w następnej sesji:
  1. *Scoring regionu:* funkcja czysta nad oknem systemów — gęstość
     zasiedlenia (udział `occupied`/`inactive`/…), rozkład ranków sąsiadów
     (mediana/min), liczba wolnych slotów docelowych w oknie.
  2. *Tryby strategii* (preset = parametry scoringu): „bezpieczny" (min
     zasiedlenie + niskie ranki), „agresywny" (max aktywnych/nieaktywnych
     celów), „paszcza lwa" (wysokie ranki sąsiadów), „metal-8" (gęste wolne
     ósemki = obecny silnik z positions=[8]).
  3. *UI — progressive disclosure:* domyślnie obecna prosta tabela; tryby
     i mapa w zwijanym `<details>` „Advanced", żeby nie przytłoczyć normal
     userów.
  4. *Mapa sąsiedztwa:* pasek pikselowy regionu (reuse stylu mapy galaktyk
     z `galaxy.js`/`palette.js`) — kolor statusu + intensywność wg ranku.

---

### T7 — DAILY RUN: za mało statków + Send All na pustej planecie
**Status:** REVIEW · **Trudność:** średnie

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

**Dziennik:**
- 2026-06-11 (sesja 3): Zaimplementowane oba przypadki, bez nowych dumpów —
  źródłem prawdy jest snapshot `fleetDispatcher` (`shipsOnPlanet`), który już
  zasila kuriera. Nowy read-only eksport `shipAvailability()` w
  `fleetCourier.js` (`null` = brak snapshotu, więc poza fleetdispatch nic
  się nie zmienia). (1) Micro za mało statków: trwała etykieta
  „No ships have/want" w `refresh()` (ticker 1 Hz) + twarda blokada w
  `buildOrder` zanim kurier cokolwiek dotknie. (2) Send All na pustej
  planecie: etykieta „Empty → next planet (tap to jump)", tap wykonuje skok
  do następnej planety wymagającej zbiórki (`findNextCollectPlanetCp`, ten
  sam mechanizm co redirect po wysyłce); gdy nic nie zostało — flash
  „All done". Detekcja przez `resolveSelection` z domain/fleetPlan (te same
  reguły co przy faktycznej selekcji). Status: REVIEW — do weryfikacji w
  grze: etykiety na planecie bez statków i z niepełną mikroflotą, skok.

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

**Dane:** dump HTML paska planet dostarczony przez użytkownika — ⛔ ZDJĘTE. Struktura
potwierdzona: na księżycu `.smallplanet` dostaje klasę `hightlightMoon` (nie
`hightlightPlanet`), a `.planet-koords` jest w tym samym wierszu.

**Dziennik:**
- 2026-06-11: Błędny fix (commit `91f666a`) oparty na starym, niepoprawnym
  komentarzu w kodzie — zakładał oddzielny wiersz księżyca bez `.planet-koords`.
- 2026-06-11: Dostarczono dump HTML z gry. Rzeczywista przyczyna: na stronach
  księżyca OGame ustawia `hightlightMoon` zamiast `hightlightPlanet` na elemencie
  `.smallplanet` — `GAME.ACTIVE_PLANET` zwracał `null`, stąd `home=null` w
  `derive()`. Fix: fallback `#planetList .hightlightMoon` w `readHomePlanet()`.
  Commit `3e289a8`. Status: **REVIEW** — wymaga weryfikacji w grze na księżycu.

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
**Status:** REVIEW · **Trudność:** łatwe

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

**Dziennik:**
- 2026-06-11 (sesja 2): Dodano reguły CSS `box-shadow` override dla
  `.oge-host.split` (idle: rim 72%, top-edge .12) i `.oge-host.split:hover`
  (rim 85%, top-edge .14). Commit `bf25ab6`.
- 2026-06-11 (sesja 2, cd.): Po analizie zidentyfikowano głębszą przyczynę —
  gradienty stref zabarwiają krawędź wewnętrzną, redukując kontrast nitki.
  Dodano ciemny inset-backing (`inset 0 0 0 3px rgba(0,0,0,.45)`) tuż za
  nitką, symulując ciemne tło jakie single-zone dostaje naturalnie.
  Commit `5409d43`. Status: REVIEW.

---

## Dziennik sesji (globalny)

> Krótkie wpisy „co zrobiono w tej sesji”, żeby kolejna szybko złapała kontekst.

- **2026-06-11 (sesja 1):** Zmergowano `v1.17.0` do `main` (fast-forward),
  przebazowano branch roboczy na `main` (wersja 1.17.0). Zebrano i skatalogowano
  12 zadań z feedbacku do tego pliku.
- **2026-06-11 (sesja 1, cd.):** T8 — bug „Vlad" na księżycu. Pierwsze podejście
  błędne (zły model DOM). Po dostarczeniu zrzutu HTML z DevTools zidentyfikowano
  rzeczywistą przyczynę: `hightlightMoon` zamiast `hightlightPlanet`. Poprawiony
  fix w `src/features/sendCol/domHelpers.js`, commit `3e289a8`. T8 → REVIEW.
  Kolejne zadanie: zacząć od T3 (łatwe) w nowej sesji.
- **2026-06-11 (sesja 2):** T3 (tytuł sekcji ekspedycji w Reminders), T2
  (animacja handlarza), T12 (blask krawędzi split), T1 (klawiatura DAILY RUN)
  — wszystkie zaimplementowane i w REVIEW. T1: rzeczywistą przyczyną był
  `fireInput()` w `fleetExecutor.js` wywołujący `input.focus()` na mobile.
- **2026-06-11 (sesja 2, cd.):** Zmiany poza tablicą zadań (ad-hoc podczas
  przeglądu wizualnego): T12 wzmocnione dark-inset-backing (`5409d43`);
  etykieta ekspedycji `'Send'` → `'Explore'` (`f6302cd`); etykieta
  kolonizacji `'Send'` → `'Colonize'`, idle uproszczony do 1 linii,
  hold-to-skip przeniesiony do kroku 2 (`6014828`); glify DNA obrócony 45°
  (lewy-dół → prawy-góry) i oba glify (DNA + kometa) powiększone ×1.15
  (`1cb88ea`). Wszystkie zmiany na `claude/project-setup-branch-hq8sgn`.
  **Następna sesja: T7 lub T4** (średnie, bez blokad danych).
- **2026-06-11 (sesja 3):** Branch roboczy przeniesiony na
  `claude/project-setup-feedback-gv66h4` (fast-forward z poprzedniego, autorzy
  commitów znormalizowani do `Claude <noreply@anthropic.com>`). T4
  zaimplementowane → REVIEW (okno 3 min, widoczny stan cancellable z pulsem
  i ✕, dokładny timer tranzycji, zwolnienie wiersza do ad-hoc po wyczerpaniu
  serii; garda z wym. 3 świadomie zastąpiona lockiem — szczegóły w dzienniku
  T4). **Następna sesja: T7** (średnie, bez blokad danych).
- **2026-06-11 (sesja 3, cd.):** T7 → REVIEW. Oba przypadki rozwiązane
  snapshotem `fleetDispatcher` (nowy eksport `shipAvailability()` z kuriera):
  trwała etykieta + blokada przy niepełnej mikroflocie, „Empty → next planet"
  z tap-to-jump przy pustym Send All. Pozostałe bez blokad: T9 (redesign).
  Zablokowane na dane/decyzje: T5, T6b, T10, T11; T6a możliwe od ręki.
- **2026-06-11 (sesja 3, cd. 2):** T6 ruszone na całego. T6a zrobione
  (zakładka zwinięta do Galaxy Observations). T6b etap 1: uogólniony silnik
  regionów (`domain/regions.js` — zakres pozycji, tolerancja luk, wrap) +
  nowe UI + defensywne zbieranie ranku gracza ze skanów. Etap 2 (scoring,
  tryby strategii, mapa sąsiedztwa) zaprojektowany w dzienniku T6.
- **2026-06-12 (sesja 4):** T6b kontynuacja — `rankClass` zbierany ze skanów,
  neighbourhood scoring z bandit/honored tierami, pixel-strip, strategia engine z 5
  presetami + modyfikatory expansion/ally, custom weight sliders z dirty-flag i
  persystencją preferencji. Sekcja przemianowana na „Colony Scout — settlement area
  analysis". Commity: `643b322`…`8fea3c8`.
- **2026-06-12 (sesja 5):** Gruntowne review całej funkcjonalności Colony Scout →
  zidentyfikowane fundamentalne wady (1 region per galaxy = scoring na 9 wierszach,
  vacation=farma, multiplikacja count×maxLevel, ally bonus zbyt słaby). Refaktor
  fazy 1+2: multi-region per galaxy (do 5 niezachodzących, prawdziwy global TOP 20),
  precompute mines, vacation oddzielone, Σ tier, ally bonus min(1, n/3). Commit
  `f9d51a6`. T6 → **REVIEW**. **Następna sesja: T9** (redesign komponentów, bez
  blokad danych) lub T11/T10 (dane do potwierdzenia). T6b całkowicie zrealizowane — szczegóły poniżej.
  **Zbieranie `rankClass`:** `player.rank.rankClass` (np. `rank_bandit2`,
  `rank_starlord3`) zbierany w `domain/scans.js::classifyPosition` — oddany
  tylko gdy `hasRank === true && typeof rankClass === 'string'`. Commit `643b322`.
  **Neighbourhood scoring:** `RegionScore` z polami occupied/inactive/ranks/
  bandits+banditMaxLevel/honored+honoredMaxLevel/allianceCount/allyNearby/mineMinDist.
  `scoreRegion` de-duplikuje graczy po id; `banditMaxLevel` / `honoredMaxLevel`
  różnicują przypadkowego bandit1 od top-10-serwera bandit3. `mineMinDist` =
  minimalna kołowa odległość do własnej kolonii w galaktyce (cały skan,
  nie tylko wnętrze regionu). Pixel-strip sąsiedztwa z `systemColor` mapping.
  Commity: `58eecf9`, `57d7e7c`.
  **Silnik strategii:** 5 presetów (longest/peaceful/farmer/honor_pvp/aggressive)
  + 2 ortogonalne modyfikatory: expansion (±2, „spread" = bonus za dist≥100 sys
  od własnej kolonii, „cluster" = odwrotnie) i allyBonus (auto-włączone gdy ally
  tag podany w UI). `expansionFactor`: 0 przy dist<50, liniowo do 1 przy dist≥200.
  Commit `a005ceb`, `4ad85b0`.
  **Custom weight sliders:** 5 suwaków (-3..3, step 0.1) w `<details>` panelu,
  live-update bez opóźnienia, reset do presetu, persystencja preferencji
  (strategy/expansion/allyTag) w `oge_colonyScoutPrefs` localStorage, dirty-flag
  odróżniający „gracz wyzerował ręcznie" od „preset jeszcze nie tknięty".
  Commit `8fea3c8`.
  **Gruntowne review + refaktor Fazy 1+2 (commit `f9d51a6`):**
  - *Generacja kandydatów:* zamiast 1 regionu per galaktyka → do 5 niezachodzących
    (helper `findGalaxyRegions` — po znalezieniu best window usuwa użyte dopasowania
    i ponawia); TOP_N=20 staje się realnym globalnym rankingiem.
  - *Precompute mines:* jeden przebieg po skanach buduje jednocześnie
    `matchesByGalaxy` i `minesByGalaxy`; `scoreRegion` przyjmuje
    `mineSystemsInGalaxy` w opts — eliminuje O(N×M) hotspot.
  - *Vacation ≠ farma:* gracze w trybie urlopowym (gra chroni ich przed atakiem)
    otrzymali osobne pole `vacation` w `RegionScore`; nie trafiają już do `inactive`.
  - *Tier sum:* scoring używa `banditTierSum` / `honoredTierSum` (Σ tier_i) zamiast
    `count×maxLevel` — monotonicznie rośnie z każdym kolejnym bandytą LUB wyższym
    tierem, bez retro-amplifikacji.
  - *Ally bonus skalibrowany:* `Math.min(1, allyNearby/3)` zamiast
    `allyNearby/scanned`; teraz 1 sojusznik = realny ~0.75 bonus (nie ~0.05).
  Status: **REVIEW** — do weryfikacji w grze przy pełnych danych ze skanów.
  **Znane ograniczenia do potencjalnego T6c:**
  - `ranks` (pozycje w rankingu) zbierane ale nieużywane w scoring — dane są,
    wagi do dodania gdy pojawi się potrzeba.
  - `mineMinDist` widzi tylko przeskanowane kolonie; historia kolonizacji dałaby
    lepsze pokrycie (do rozważenia w przyszłości).
  - Opcje `<select>` strategii w HTML są hardcoded zamiast generowane z `STRATEGIES`
    (hinty w typedef są ale nie trafiają do UI).
