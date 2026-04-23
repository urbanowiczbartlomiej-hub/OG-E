# OG-E v5 — Dokument projektowy architektury

> Dokument do myślenia. Opisuje co budujemy, **dlaczego**, i skąd biorą
> się decyzje. Implementacja podąża za tym dokumentem — jeśli rzeczywistość
> nie zgadza się z jakąś sekcją, najpierw aktualizujemy dokument.

**Status:** szkic v0.3 (oczekuje na review)
**Punkt odniesienia:** OG-E 4.9.3 — **bardzo stabilna, używanie to czysta
przyjemność, zero znanych błędów**. Jest empirycznym punktem odniesienia:
wszystko, co 4.9.3 robi dobrze, v5 musi robić równie dobrze albo lepiej.
Przepisujemy NIE dlatego, że coś nie działa — tylko dlatego, że chcemy
architekturę, którą da się rozwijać kolejne dwa lata bez długu.
Nakładka zmian względem 4.9.0 obejmuje: `reserved` status +
navigate-to-stale-system UX (4.9.2), soft-delete dla colonyHistory (4.9.1),
overlay-buttons dla abandon popupów (4.9.3).

---

## 1. Cel

v5 to **pełne przepisanie** OG-E przy zachowaniu identycznego zestawu funkcji.
Celem nie są nowe możliwości — celem jest *"chcę czytać ten kod tak, jak
czyta się równania teorii względności"*. Konkretnie:

- **Czyste rozdzielenie odpowiedzialności.** Obecnie `mobile.js` ma 1700
  linii i jest workiem na niezwiązane ze sobą sprawy (Send Exp, Send Col,
  abandon, focus, drag, timer min-gap, algorytmy skanowania). W v5 jeden
  moduł = jedna koncepcja.
- **Zdeduplikowane helpery.** Dziś `safeLS` i `getExtStorage` są skopiowane
  do mobile.js i content.js. `waitFor`, `debounce`, `safeClick` mają
  niemal-identyczne implementacje w różnych miejscach. W v5 jeden
  `lib/` importowany wszędzie.
- **Jedno źródło prawdy dla stanu.** Dziś stan jest rozproszony w trzech
  systemach (chrome.storage, localStorage, zmienne w pamięci) z ad hoc
  kodem czytająco-zapisującym. W v5 będą nazwane store'y z propagacją
  przez subscribe — UI reaguje, persystencja jest automatyczna.
- **Brak ukrytej asynchroniczności.** Dziś "czy to jest sync czy async?"
  wymaga przeczytania 20 linii. W v5 nazwy są uczciwe (`getX` sync,
  `fetchX` async).
- **Sprawdzanie typów bez kosztu buildu.** JSDoc + `tsc --allowJs --noEmit`
  w CI. Runtime to czysty vanilla JS. IDE intellisense działa na prawdę.
- **Testowana pure logic.** Funkcje domenowe (merge, classify, parse) mają
  pokrycie testami vitest. Refactor odbywa się z pewnością siebie.

**Co NIE jest celem v5:**
- Nowe funkcje gry. Parzystość z 4.9.0 to cały zakres.
- Kompatybilność z przeglądarkami poza FF 140+ / Chrome aktualnym (MV3).
  Tak samo jak w 4.x.
- Jakakolwiek forma zautomatyzowanej interakcji z grą wykraczająca poza
  to, co robi 4.x. **Granice TOS są niezmienione i nienegocjowalne.**

---

## 2. Zasady przewodnie

1. **Czytanie wygrywa z pisaniem.** Optymalizuj każdą linię pod kątem
   następnego inżyniera, który będzie musiał ją zrozumieć za dwa lata.
2. **Małe moduły, jedna odpowiedzialność.** Plik powinien mieścić się
   w połowie ekranu albo uzasadniać swoją długość (nagłówki modułów,
   a nie rozwlekły kod).
3. **Pure ponad impure tam, gdzie się da.** Side effects są izolowane.
   Logika domenowa ma zero sprzężenia z DOM, storage, siecią.
4. **Deklaratywnie zamiast imperatywnie.** Opisuj kształt danych,
   subskrypcję, przepływ. Nie klej ręcznie imperatywnego kodu.
5. **Jawnie zamiast niejawnie.** Bez magicznych globali, bez importów
   wyłącznie dla side-effectów. Eksporty modułu są API surface.
6. **Kontrakty async są uczciwe.** `getX()` → sync. `fetchX()` → async.
   `onX` → subscribe/listener. Nazewnictwo to kontrakt.
7. **Minimum ceremonii.** Bez Redux, bez React, bez runtime TypeScript.
   Jeden bundler (rollup), jeden type checker (tsc w trybie check), jeden
   runner testów (vitest). Koniec.
8. **Kasuj bez strachu.** Martwy kod jest zabroniony. Jeśli coś nie jest
   używane przez dłużej niż jedną iterację — usuń. Wróci jeśli zajdzie
   potrzeba.

---

## 3. Granice etyczne (niezmienione z 4.x)

To są jasne granice. v5 dziedziczy je bez zmian. W razie wątpliwości PYTAJ
użytkownika — nigdy nie zakładaj, że "więcej automatyzacji = lepiej".

**DOZWOLONE:**
- Mapowanie przycisk-do-kliknięcia 1:1 (jedno kliknięcie użytkownika →
  jedno kliknięcie na element UI gry)
- Modyfikacje CSS / DOM, które nie wywołują żądań gry
- Pasywna obserwacja odpowiedzi XHR, które inicjuje sama gra
- Przechowywanie obserwowanych danych w lokalnym storage
- Wizualizacja przechowywanych danych na stronie histogramu
- Synchronizacja NASZYCH danych między urządzeniami przez prywatny
  GitHub Gist użytkownika
- Przepisywanie payloadów odpowiedzi po stronie klienta (np. `redirectUrl`
  po wysłaniu ekspedycji)
- Pojedyncza nawigacja strony wywołana pojedynczym, widocznym kliknięciem
  użytkownika

**ZABRONIONE:**
- Bezpośrednie `fetch()` / XHR do endpointów gry (bright line)
- Programowa modyfikacja pól formularza gry, która wywołuje żądanie gry,
  bez widocznego pojedynczego kliknięcia użytkownika
- Cykliczne / powtarzane zautomatyzowane żądania
- Obchodzenie CAPTCHA / rate limitów
- Praca w tle dotykająca gry, kiedy użytkownik nie jest aktywny w UI
- Łańcuchy wieloetapowej automatyzacji (jedno kliknięcie → wiele efektów
  na serwerze)

Reguła sprawdzająca: **"Czy człowiek obserwujący to zobaczyłby, że każda
interakcja z serwerem jest bezpośrednio powiązana z jego własnym
kliknięciem?"** Jeśli nie, to automatyzacja.

---

## 4. Architektura wysokiego poziomu

```
           ┌─────────────────────────────────────────────┐
           │  STRONA GRY (ogame.gameforge.com)           │
           │                                             │
           │  ┌──────────────────┐  ┌──────────────────┐ │
           │  │  Świat MAIN      │  │  Świat ISOLATED  │ │
           │  │  (wspólny z grą) │  │  (rozszerzenie)  │ │
           │  │                  │  │                  │ │
           │  │  page.js         │  │  content.js      │ │
           │  │                  │  │                  │ │
           │  │  • Hooki XHR     ├──┤  • Features      │ │
           │  │    (galaxy,      │  │  • Stany (store) │ │
           │  │    checkTarget,  │  │  • Sync          │ │
           │  │    sendFleet)    │  │  • DOM / UI      │ │
           │  │  • Pre-register  │  │                  │ │
           │  │    (sync do LS)  │  │                  │ │
           │  └────────┬─────────┘  └────┬─────────────┘ │
           │           │                 │               │
           │           │  DOM events     │               │
           │           │  między światami│               │
           │           └────────────────>│               │
           └─────────────────────────────┼───────────────┘
                                         │
                                         │ chrome.storage.local
                                         │ (duże dane, synchronizowalne)
                                         ▼
                              ┌─────────────────────┐
                              │  GitHub Gist        │
                              │  (prywatny u user)  │
                              │  gzip + base64      │
                              └─────────────────────┘
```

**Dwa bundle:**
- `content.js` — świat isolated, tutaj żyją wszystkie feature, stany, UI, sync
- `page.js` — świat MAIN, tylko minimum do obserwacji XHR + hooków

**Dwie warstwy storage:**
- `localStorage` — preferencje użytkownika, pozycje przycisków,
  **rejestr kolonizacji** (wymaga synchronicznych zapisów żeby pokonać race
  z nawigacją na mobile), transientne flagi
- `chrome.storage.local` — duże obserwowane dane (skany galaktyk, historia
  kolonii), synchronizowalne z Gistem

**Komunikacja:**
- MAIN → isolated: `document.dispatchEvent(new CustomEvent('oge:X', ...))`
- isolated → MAIN: nie jest potrzebne (świat MAIN tylko reaguje na
  wydarzenia gry i je przekazuje)
- Wewnątrz świata isolated: subskrypcje store'ów + bezpośrednie importy

**Brak lokalnej szyny zdarzeń.** Zmiany stanu propagują się przez
`store.subscribe`. Imperatywne triggery (handlery kliknięcia, DOM events)
są podłączane bezpośrednio tam, gdzie się odpalają. Dodanie magistrali
zdarzeń byłoby ceremonią bez wartości.

---

## 5. Układ modułów

```
v5.0.0/
├── package.json                     rollup + vitest + tsc
├── rollup.config.mjs                dwa wyjścia: content.js, page.js
├── tsconfig.json                    allowJs + checkJs + noEmit
├── manifest.json                    MV3 (Chrome + Firefox; browser_specific_settings.gecko daje id i min-version dla FF, Chrome ignoruje)
├── DESIGN.md                        ten dokument (zawiera schematy danych — patrz §7)
├── src/
│   ├── content.js                   entry do bundla isolated
│   ├── page.js                      entry do bundla MAIN
│   ├── histogram.html               strona rozszerzenia
│   ├── histogram.js                 entry do bundla histogramu
│   │
│   ├── lib/                         pure helpery, zero wiedzy domenowej
│   │   ├── createStore.js           reaktywny store (~25 linii)
│   │   ├── persist.js               store ↔ storage wiring (hydrate + write)
│   │   ├── storage.js               safeLS + chromeStore (ujednolicone)
│   │   ├── dom.js                   safeClick, waitFor, injectStyle
│   │   ├── draggableButton.js       wspólne helpery drag + focus-persist
│   │   │                            (używane przez sendExp i sendCol)
│   │   ├── gzip.js                  encode/decode przez CompressionStream
│   │   ├── debounce.js              debounce + throttle
│   │   └── logger.js                opt-in ring buffer (sterowany z ustawień)
│   │
│   ├── domain/                      pure logic, zero side effects
│   │   ├── positions.js             parsePositions, sysDist, buildGalaxyOrder
│   │   ├── scans.js                 mergeScanResult, classifyPosition
│   │   ├── registry.js              pruneRegistry, findConflict, dedupeEntry
│   │   ├── scheduling.js            isSystemStale, tabela RESCAN_AFTER
│   │   └── rules.js                 stałe (COL_MAX_SYSTEM=499, itp.)
│   │
│   ├── state/                       obserwowalne store'y + persystencja
│   │   ├── scans.js                 oge5_galaxyScans (chrome.storage)
│   │   ├── registry.js              oge5_colonizationRegistry (localStorage)
│   │   ├── history.js               oge5_colonyHistory (chrome.storage)
│   │   ├── knownPlanets.js          oge5_knownPlanets (chrome.storage) — Set<cp>
│   │   │                            confirmed-as-permanent, czytany przez
│   │   │                            newPlanetDetector
│   │   ├── settings.js              preferencje (localStorage per klucz)
│   │   └── settingsMirror.js        mirror wybranych kluczy do chrome.storage
│   │                                (histogram extension origin czyta mirror)
│   │
│   ├── features/
│   │   ├── blackBg.js               czarne tło podczas ładowania (anty-flicker)
│   │   ├── readabilityBoost.js      wstrzyknięty CSS dla low-contrast elementów
│   │   ├── agrLogoRewire.js         zamienia logo AGR na ikonę OG-E; klik
│   │   │                            otwiera AGR menu i rozwija zakładkę OG-E
│   │   ├── newPlanetDetector.js     banner "new planet" po kolonizacji
│   │   │                            (diff #planetList vs knownPlanetsStore)
│   │   ├── sendExp.js               przycisk Send Exp + flow ekspedycji
│   │   ├── sendCol.js               przycisk Send Col — pojedynczy orchestrator
│   │   │                            (derive/render/click) ~1100 LoC. Pełna
│   │   │                            specyfikacja: `SENDCOL_DESIGN.md`. Transientny
│   │   │                            stan żyje jako module-local `let`-y w tym
│   │   │                            pliku (§3 SENDCOL_DESIGN), bez osobnego store'u.
│   │   ├── sendColLogic.js          pure helpery sendCol (targeting, URL build,
│   │   │                            parseCurrentGalaxyView, min-gap)
│   │   ├── abandon.js               3-kliknięciowy abandon + injected buttons
│   │   ├── abandonOverview.js       body-level czerwony overlay nad `#planet`
│   │   │                            na overview dla świeżych małych kolonii
│   │   ├── fleetdispatchShortcut.js keybinding ArrowRight → fleetdispatch
│   │   ├── badges.js                kropki ekspedycji na planet list
│   │   ├── settingsUi.js            panel ustawień AGR
│   │   └── colonyRecorder.js        collectColonyData (overview → history)
│   │
│   ├── bridges/                     hooki XHR / mosty MAIN→isolated
│   │   ├── xhrObserver.js           generyczny `observeXHR({url, on, handler})`
│   │   ├── galaxyHook.js            fetchGalaxyContent → dispatch event
│   │   ├── checkTargetHook.js       checkTarget → dispatch result event
│   │   ├── sendFleetHook.js         sendFleet → pre-register + dispatch event
│   │   ├── fleetDispatcherSnapshot.js
│   │   │                            MAIN-world most: publikuje snapshot
│   │   │                            `window.fleetDispatcher` przez
│   │   │                            `oge5:fleetDispatcher` (isolated content
│   │   │                            scripts nie czytają page globals
│   │   │                            bezpośrednio — cross-realm fix)
│   │   └── expeditionRedirect.js    przepisanie redirectUrl ekspedycji
│   │
│   └── sync/
│       ├── gist.js                  klient GitHub API + pipeline gzip
│       ├── merge.js                 mergeScans, mergeHistory
│       └── scheduler.js             debounce'owany upload + tombstones
│
├── test/
│   ├── domain/
│   │   ├── positions.test.js
│   │   ├── scans.test.js
│   │   ├── registry.test.js
│   │   └── scheduling.test.js
│   ├── sync/
│   │   └── merge.test.js
│   └── lib/
│       └── createStore.test.js
│
└── dist/                            wyjście rollupa (gitignored)
    ├── content.js
    ├── page.js
    ├── histogram.html (skopiowane)
    └── histogram.js
```

**Kierunek zależności modułów (ścisły):**

```
bridges (MAIN)            features (isolated)
     │                         │
     │ dispatch DOM events     │ subscribe do store, render UI
     ▼                         ▼
        granica między światami
                │
                │ 1-kierunkowa: MAIN → isolated
                ▼
            state stores  ◄───  domain (pure)
                │                   ▲
                │ persystencja       │ pure computation
                ▼                   │
              lib                   │
              (zero deps)  ─────────┘
```

- **lib/** nie zależy od niczego (poza API przeglądarki).
- **domain/** nie zależy od niczego (pure functions; importuje tylko z lib/).
- **state/** importuje z lib/ i domain/; eksportuje store'y.
- **features/** i **bridges/** importują wszystko co jest pod nimi.
- **sync/** importuje z state/ i lib/.

**Brak cyklicznych zależności.** Lint w CI to wymusza.

---

## 6. Model stanu

**Store** to trywialny observable (pseudokod):

```js
/** @template T */
export const createStore = (initial) => {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set: (next) => { state = next; subs.forEach(fn => fn(state)); },
    update: (fn) => set(fn(state)),
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
};
```

~25 linii. Zero zależności. Testowalny w izolacji.

**Persystencja** to cienka wrapperka:

```js
/** Podłącza store do storage, zapisuje przy każdej zmianie. */
export const persist = ({ store, key, storage, debounceMs = 0 }) => {
  // Hydratacja — wczytanie wartości na start
  storage.get(key).then(v => { if (v !== undefined) store.set(v); });
  // Zapis (debounce'owany jeśli trzeba)
  const write = debounce(() => storage.set(key, store.get()), debounceMs);
  store.subscribe(write);
};
```

**Stany które będziemy mieli:**

| Store | Typ | Persystowany do | Debounce | Powód |
|---|---|---|---|---|
| `scansStore` | `GalaxyScans` | chrome.storage.local | 200ms | duży, dużo zapisów podczas skanu |
| `registryStore` | `ColonizationEntry[]` | **localStorage (sync!)** | 0 | race nawigacji na mobile wymaga natychmiastowego zapisu |
| `historyStore` | `ColonyEntry[]` | chrome.storage.local | 0 | rzadkie zapisy (wizyty na kolonii) |
| `knownPlanetsStore` | `Set<number>` | chrome.storage.local (as array) | 0 | rzadkie zapisy (seed/mark/prune), codec Set↔array na granicy |
| `settingsStore` | `Settings` | localStorage per-klucz | 0 | per-klucz dla integracji z AGR |

**Brak globalnego transient-store'u dla UI.** Transientny stan UI
(pendingLink, staleRetry, countdowny, cooldowny) żyje jako **module-local
`let`-y** w tych feature-ach, które ich używają — głównie
`features/sendCol.js` (patrz §3 `SENDCOL_DESIGN.md`: `lastCheckTargetError`,
`lastNavToFleetdispatchAt`, `lastScanSubmitAt`, `lastScanEventAt`,
`waitStartAt`, `waitSeconds`). Każdy reader i writer tych pól żyje w tym
samym pliku, więc wyciąganie ich do osobnego store'u byłoby indirection
taxem bez wartości.

**Dlaczego `registryStore` w localStorage**: race nawigacji na mobile
(udokumentowany fix w 4.8.5). localStorage jest synchroniczny — zapisy
przeżywają następującą nawigację. Główna ochrona przed "double-send"
żyje tutaj.

**Dlaczego `settingsStore` per-klucz**: kompatybilność z AGR. Panel
ustawień w AGR oczekuje jeden klucz = jedna preferencja. Zachowanie tej
kompatybilności pozwala reużyć dokładnie ten sam wzorzec UI bez mostów.

---

## 7. Schematy danych

**Uwaga:** wszystkie klucze storage używają prefiksu `oge5_`, żeby uniknąć
kolizji z kluczami `oge_*` z v4, gdy oba rozszerzenia są zainstalowane
równolegle w okresie dev/test.

### `oge5_galaxyScans`

Ten sam kształt co w v4 (to już dobry kształt — nie kwestionujemy):

```ts
type GalaxyScans = Record<SystemKey, SystemScan>;
type SystemKey = `${number}:${number}`;
type SystemScan = {
  scannedAt: number;                      // ms
  positions: Record<1..15, Position>;
};
type Position = {
  status: PositionStatus;
  player?: { id: number; name: string };
  flags?: { hasAbandonedPlanet?, hasMoon?, hasDebris?, inAlliance? };
};
type PositionStatus =
  'empty' | 'empty_sent' | 'mine' | 'occupied' |
  'inactive' | 'long_inactive' | 'vacation' | 'banned' | 'admin' |
  'abandoned' |
  'reserved';   // inny gracz zarezerwował slot pod planet-move (DM-paid)
                // checkTarget error 140016; rescan 24h (cooldown ~22h)
```

**Polityka re-skanu** (rozszerzona względem v4 4.9.0):

| status | re-scan after | uwagi |
|---|---|---|
| `empty`, `mine`, `admin` | never | stabilne |
| `empty_sent` | 4h | nasza flota powinna dolecieć |
| `abandoned` | **dynamic (25-47h)** | patrz formuła poniżej |
| `reserved` | 24h | 4.9.2: cooldown planet-move ~22h |
| `inactive` / `long_inactive` | 5 dni | flaga może się zmienić |
| `occupied` / `vacation` / `banned` | 30 dni | rzadkie zmiany |

**Dynamiczna deadline dla `abandoned`** (4.9.6): gra zamiata "Porzuconą
planetę" o **3 AM serwera** każdego dnia, usuwając planety które przekroczyły
24h grace period. Deadline = pierwsze 3 AM **po** `scannedAt + 24h`. Wait
zmienia się od 25h (obserwacja tuż przed 3 AM) do 47h (tuż po 3 AM), średnio
~36h — zawsze tyle ile trzeba, ani więcej ani mniej. Jeden rescan cycle
zamiast potencjalnie dwóch (stary 24h) lub zawsze-za-dużo (48h). Założenie:
browser TZ = server TZ (spełnione dla PL usera na PL serwerze).

### `oge5_colonizationRegistry` (localStorage)

```ts
type Registry = RegistryEntry[];
type RegistryEntry = {
  coords: `${number}:${number}:${number}`;  // "g:s:p"
  sentAt: number;                            // ms
  arrivalAt: number;                         // ms
};
```

### `oge5_colonyHistory`

```ts
type History = ColonyEntry[];
type ColonyEntry = {
  cp: number;
  fields: number;      // max — stałe per planeta
  coords: string;      // "[g:s:p]"
  position: number;    // 1..15
  timestamp: number;   // ms (pierwsza obserwacja)
};
```

History **zachowuje wszystkie obserwacje**, włącznie z planetami
porzuconymi potem (lekcja z 4.8.3 — małe porzucone planety są
najważniejszymi punktami statystycznymi). Store jest strict append-only:
brak ścieżki usuwania. V4 miało `deletedColonies` tombstones; v5 tę funkcję
porzuciło — nie było UI, sync nigdy ich nie propagował, zostało jako dead
code i usunięte.

### `oge5_knownPlanets` (chrome.storage.local)

```ts
type KnownPlanetsOnDisk = number[];          // CPs, array shape na dysku
type KnownPlanetsInMemory = Set<number>;     // Set w RAM dla O(1) membership
```

Zbiór CP (IDs planet), które użytkownik "potwierdził" jako stałe. Codec
Set↔array na granicy hydrate/save — `chrome.storage.local` nie round-tripuje
Set konsystentnie między przeglądarkami (Firefox serializuje Set jako `{}`),
więc na dysku trzymamy array.

**Reguły przejścia:**
- **seed przy pierwszym uruchomieniu** (pusty Set): wszystkie obecne CP
  z `#planetList` dodane jednym zapisem, żeby świeża instalacja nie
  generowała banneru na każdą istniejącą planetę.
- **confirmed** (CP wchodzi do Set-u): user otworzył overview planety z
  `usedFields > 0`, albo był to seed.
- **unconfirmed/new** (CP jest w `#planetList`, ale nie w Set-cie):
  `newPlanetDetector` paintuje banner zachęcający do obejrzenia planety.
- **abandoned** (CP znikł z `#planetList`): usunięty z Set-u przez
  `pruneAbandoned`.

### Ustawienia (indywidualne klucze localStorage, prefiks `oge5_*`)

Mapowanie z listy preferencji v4; nazwy celowo niezmienione (z prefiksem
`oge5_`) dla kontynuacji konceptualnej i zgodności z wzorcem AGR (jeden
klucz = jedna preferencja). Wszystkie wartości to stringi
(localStorage konwencja); helpery z `lib/storage.js` `safeLS` robią typed
get/set z try/catch w środku.

**Feature toggles:**

| klucz | typ | default | znaczenie |
|---|---|---|---|
| `oge5_mobileMode` | bool | false | floating Send Exp button |
| `oge5_colonizeMode` | bool | false | floating Send Col button + scan-and-send flow |
| `oge5_expeditionBadges` | bool | true | kropki ekspedycji w locie na planet list |
| `oge5_autoRedirectExpedition` | bool | true | przepisanie `redirectUrl` po wysłaniu ekspedycji |
| `oge5_cloudSync` | bool | false | sync z prywatnym Gistem |

**Rozmiary i pozycje przycisków:**

| klucz | typ | default | znaczenie |
|---|---|---|---|
| `oge5_enterBtnSize` | int (px) | 560 | średnica Send Exp |
| `oge5_colBtnSize` | int (px) | 336 | średnica Send Col |
| `oge5_enterBtnPos` | JSON `{x,y}` | brak | drag-saved pozycja |
| `oge5_colBtnPos` | JSON `{x,y}` | brak | drag-saved pozycja |
| `oge5_focusedBtn` | string | brak | id ostatnio sfokusowanego przycisku |

**Konfiguracja kolonizacji:**

| klucz | typ | default | znaczenie |
|---|---|---|---|
| `oge5_colPositions` | string | "8" | wymagane pozycje (np. "8,9,7" lub "1,3-5") |
| `oge5_colPreferOtherGalaxies` | bool | false | deprioritize home galaxy w `findNextCandidate` |
| `oge5_colMinGap` | int (sec) | 20 | min gap między arrivals |
| `oge5_colMinFields` | int | 200 | abandon threshold dla małych kolonii |
| `oge5_colPassword` | string | "" | hasło OGame (autofill w abandon) |
| `oge5_maxExpPerPlanet` | int | 1 | limit ekspedycji per planeta |
| `oge5_autoRedirectColonize` | bool | false | auto-nav po udanej kolonizacji (opt-in) |

**Konfiguracja synca:**

| klucz | typ | default | znaczenie |
|---|---|---|---|
| `oge5_gistToken` | string | "" | GitHub PAT (gist scope) |
| `oge5_gistId` | string | "" | id auto-discovered/created gista |
| `oge5_lastSyncAt` | ISO string | "" | timestamp ostatniego upload |
| `oge5_lastDownAt` | ISO string | "" | timestamp ostatniego download |
| `oge5_lastSyncErr` | string | "" | komunikat błędu (czyszczony przy success) |

**Stan transientny / migracje:**

| klucz | typ | znaczenie |
|---|---|---|
| `oge5_scansSchemaVersion` | int | znacznik migracji. Mismatch przy boot → wipe `oge5_galaxyScans` + tombstone `oge5_clearRemoteAt`. |
| `oge5_expandedGalaxies` | JSON array | stan accordionu na histogramie |
| `oge5_debugMinGap` | bool | gdy `'true'`, log diagnostyczny min-gap przez `console.debug('[OG-E v5 min-gap]', ...)` przy każdym kliknięciu Send. Ustawiane z DevTools console do diagnostyki "czemu min-gap nie zablokował?". |

**Uwaga o stanie transientnym sendCol.** v5 nie persystuje żadnego
"pending link" ani "pending verify" klucza w localStorage. Transientny
stan przycisku Send Col (ostatni `errorCode` z checkTarget, czasy
nawigacji/scanu, min-gap countdown start) żyje jako **module-local
`let`-y w `features/sendCol.js`** — patrz §3 `SENDCOL_DESIGN.md`. Nic
z tego nie jest persystowane między przeładowaniami strony, ponieważ
każde przeładowanie resetuje `fleetDispatcher` i i tak musielibyśmy
derive'ować kontekst od zera.

### `oge5_colPositions` (mirror w chrome.storage.local)

Mirror robione przez `state/settings.js`, bo histogram (extension origin)
nie czyta `ogame.gameforge.com` localStorage. Surowy string (taki sam
format jak w localStorage), parsowany przez `domain/positions.js`
`parsePositions` na deduped listę intów 1..15.

### Tombstones (chrome.storage.local)

Cross-context one-shot triggery — zapisywane w jednym execution context,
obserwowane przez `chrome.storage.onChanged` w innym, po skonsumowaniu
porównywane z last-handled.

```ts
type Tombstone = number;     // ms timestamp
```

| klucz | piszący | konsumujący | znaczenie |
|---|---|---|---|
| `oge5_clearRemoteAt` | histogram (Clear scan data), state/scans.js (migracja schematu) | sync/scheduler.js → `clearGistScans` | wipe gist scans (merge sam nie odróżnia "user wyczyścił" od "device tego nie widział") |
| `oge5_syncRequestAt` | histogram (Refresh), settingsUi.js (Sync now) | sync/scheduler.js → `downloadAndMerge` + `upload` | force pełny bidirectional sync |
| `oge5_resetGalaxyAt` | histogram (per-galaxy reset) | sync/scheduler.js → `clearGistScans` (wybiórczo dla galaxy) | wipe scans dla konkretnej galaktyki + propagacja do gista |

### Payload Gista

Ten sam format co w v4 4.9.3 (gzip + base64, schema w wersji 3). v5 tworzy
własny gist z **inną description**:
`"OG-E v5 sync data (compressed) — do not edit manually"`.
Nazwa pliku: `oge5-data.json.gz.b64`. Klucz localStorage: `oge5_gistId`.

**Pipeline:** `payload → JSON.stringify → gzip (CompressionStream) → base64 → gist file`

Kształt zdekompresowanego payloadu:

```ts
type GistPayload = {
  version: 3;                              // SCHEMA_VERSION; mismatch → ignore remote
  updatedAt: string;                       // ISO
  galaxyScans: GalaxyScans;
  colonyHistory: ColonyEntry[];
};
```

**Dlaczego skompresowany**: surowy JSON dla pełno-zeskanowanego konta to
~2 MB, dominują powtarzające się klucze. Gzip dedupuje to do ~250 KB
(po base64 +33% — net ~330 KB). Na wolnym mobile to różnica między
płynnym sync a widocznie throttled'owanym, który konkuruje z ruchem gry
podczas aktywnego skanowania.

**Cross-device merge logic** (szczegóły w `sync/merge.js`):

- `mergeScans`: per-system merge by max `scannedAt` (whole-system replace,
  fresh scan i tak by zastąpił stale per-position).
- `mergeHistory`: dedup by `cp` (planet ID); first-seen wins.
- `colonizationRegistry`: **NIE syncowane** — local-only per device,
  regenerowany naturalnie przy wysyłaniu misji.

**Anti-loop**: oba `mergeScans` i `mergeHistory` zwracają `{merged, changed}`.
Lokalne zapisy tylko gdy `changed === true` — bez tego każdy sync write
triggerowałby `storage.onChanged` → `scheduleUpload` → infinite loop
hammering quoty GitHuba.

**Debounce**: 15s. Na mobile aktywne-skan bursty są coalescowane w jeden
upload. Trade-off: świeża obserwacja na device A jest co najwyżej
~15s "stale" przy następnym sync na device B.

**Rate limit**: 403/429 odpowiedzi armują `backoffUntil` z `Retry-After` →
`X-RateLimit-Reset` → default 5 min. Wszystkie `gh()` calle przed tym
czasem rzucają natychmiast bez sieci.

---

## 8. Komunikacja między światami

Jeden kierunek: **MAIN → isolated**. Świat isolated nigdy nie dispatchuje
do MAIN — nie musi (świat MAIN reaguje tylko na zdarzenia gry i je
przekazuje).

**Kontrakty zdarzeń** (`src/domain/events.js` definiuje je przez JSDoc
typedefs):

| Zdarzenie | Dispatchowane przez (MAIN) | Konsumowane przez (isolated) |
|---|---|---|
| `oge5:galaxyScanned` | `galaxyHook` | state `scans.js`, UI `features/sendCol.js` (event-driven scan cooldown unlock, patrz §9.2) |
| `oge5:checkTargetResult` | `checkTargetHook` | `features/sendCol.js` — detekcja stale / reserved / noShip |
| `oge5:colonizeSent` | `sendFleetHook` | `scans.js` (update status → `empty_sent`) |
| `oge5:fleetDispatcher` | `bridges/fleetDispatcherSnapshot.js` | `features/sendCol.js`, `features/sendExp.js` — snapshot `window.fleetDispatcher` (cross-realm: isolated content scripts nie czytają page globals bezpośrednio) |
| `oge5:syncForce` | `settingsUi.js` (user kliknął Sync now) | `sync/scheduler.js` |

**Detail `oge5:fleetDispatcher`** (projekcja pól, nie surowy obiekt gry):

```ts
type FleetDispatcherSnapshot = {
  currentPlanet: { galaxy, system, position } | null;
  targetPlanet:  { galaxy, system, position } | null;
  orders: Record<string, boolean> | null;      // orders['7'] === true ⇒ colonize OK
  shipsOnPlanet: Array<{ id: number, number: number }>;
  expeditionCount: number;
  maxExpeditionCount: number;
};
```

Publikowany przy `DOMContentLoaded` i po każdym `action=checkTarget` XHR
(jedna mikrotaska opóźnienia, żeby gra zdążyła zaktualizować
`fleetDispatcher` przed naszym read-em).

**Kształty detail** dziedziczą z v4 z drobnymi porządkami (typowane przez
JSDoc typedefs, jedna deklaracja importowana tam, gdzie potrzebna).

**Ważne — `oge5:checkTargetResult`** (stan po 4.9.2):

```ts
type CheckTargetResultDetail = {
  galaxy: number;
  system: number;
  position: number;
  success: boolean;                   // data.status === 'success'
  targetOk: boolean;
  targetInhabited: boolean;
  targetPlayerId: number;
  targetPlayerName: string;
  orders: Record<string, boolean>;
  errorCodes: number[];               // np. [140016] dla "reserved for planet-move"
};
```

Fire'uje się dla OBU success i failure responses — failure niosą
`errorCodes` których UI używa do rozróżnienia "reserved" (140016) od
"generic stale" (dowolny inny błąd / `targetOk: false`).

**Przestrzeń nazw**: wszystkie nazwy zdarzeń zaczynają się od `oge5:`,
tak żeby v4 i v5 nie kolidowały podczas równoległej instalacji.

---

## 9. Kluczowe przepływy

### 9.1 Wysłanie ekspedycji (uproszczone — już solidne w v4)

```
[user klika Send Exp (przycisk floating)]
  │
  ▼
sendExp.onClick():
  jeśli jest na fleetdispatch && mission=15:
    symulacja Enter → gra wywołuje sendFleet XHR
  w przeciwnym razie:
    location.href = fleetdispatch z mission=15
  │
  ▼
[gra wysyła XHR sendFleet]
  │
  ▼
expeditionRedirect (świat MAIN):
  hook responseText; jeśli success && redirectUrl:
    findNextPlanetWithoutExpedition() → przepisuje redirectUrl
  [navigacja idzie do przepisanego URL]
```

### 9.2 Wysłanie kolonizacji (architektura derive/render/click)

**Źródło prawdy specyfikacji: `SENDCOL_DESIGN.md`** (§1–§9). Skrót tutaj.

Przycisk Send Col to JEDEN plik (`features/sendCol.js`) napędzany
trójkątem:

1. **`derive(env) → ButtonContext`** — pure function. `env` zbiera
   wszystko z world-state (URL, `fleetDispatcher` snapshot, scansStore,
   registryStore, settings, `lastCheckTargetError`, czasy).
   `ButtonContext` to discriminated union:
   - `{ kind: 'idle' }` — nie jesteśmy na galaxy/fleetdispatch
   - `{ kind: 'galaxy', candidate?, scanNext? }` — widok galaktyki
   - `{ kind: 'fleetdispatch', phase: 'verifying' | 'ready' | 'stale' |
     'reserved' | 'noShip' | 'timeout' | 'waitGap', ... }` — fleetdispatch
2. **`render(ctx) → { send, scan }`** — paint instructions per klawisz
   (label, kolor, enabled). Zero side-effectów.
3. **`onSendClick()` / `onScanClick()`** — switch na `ctx.kind + phase`
   i palić akcję dopasowaną do fazy.

**Module-local `let`-y (§3 SENDCOL_DESIGN)** zastępują dawny transient store:

- `lastCheckTargetError` — ostatni errorCode (null / 140016 / 140035 / inny)
- `lastNavToFleetdispatchAt` — kiedy nawigowaliśmy do fleetdispatch; po
  15 s bez pasującego `checkTargetResult` `derive()` daje phase `timeout`
- `lastScanSubmitAt` — anti-spam cooldown 1 s dla półka Scan
- `lastScanEventAt` — znacznik wywołania `oge5:galaxyScanned` (patrz niżej)
- `waitStartAt`, `waitSeconds` — start + czas trwania min-gap countdown-u;
  jeden 1 Hz tick repaintuje.

**Event-driven scan cooldown.** Półka Scan po submit'cie blokuje się do
czasu, aż przyjdzie zdarzenie `oge5:galaxyScanned`, z bezpiecznikiem 8 s.
W praktyce scansStore refresh odblokowuje przycisk od razu, a 8 s cap
ratuje nas kiedy gra zignorowała submit (błąd sieci, rate limit).

**Flow (user side):**

```
[user klika Send Col — nie na fleetdispatch, nie na galaxy]
  │
  ▼
onSendClick() widzi ctx.kind='idle' + znaleziony candidate w scansStore:
  buildFleetdispatchUrl(candidate) → location.href = url
  zapisz lastNavToFleetdispatchAt = now()
  // ścisłe 1 klik → 1 nawigacja
  │
  ▼
[strona fleetdispatch się ładuje — gra wywołuje checkTarget XHR]
  │
  ▼
oge5:fleetDispatcher  (fleetDispatcherSnapshot publikuje snapshot)
oge5:checkTargetResult (checkTargetHook publikuje wynik + errorCode)
  sendCol zapisuje lastCheckTargetError
  scheduleRepaint()
  │
  ▼
derive(env): kind='fleetdispatch', phase = ?
  colonizable (errorCode null, orders['7']===true):       phase='ready'
  errorCode 140016 (planet-move reserved):                 phase='reserved'
  errorCode 140035 (no ship):                              phase='noShip'
  any other error / targetOk=false:                        phase='stale'
  brak checkTargetResult w 15 s od lastNav…At:             phase='timeout'
  min-gap wait > 0 (getColonizeWaitTime):                  phase='waitGap'

render(ctx) maluje Send:
  ready    → zielony "Ready! [coords]"
  reserved → fiolet "Reserved — Send → check system"
  stale    → pomarańcz "Stale — Send → check system"
  noShip   → czerwony "No ship"           (przycisk disabled)
  timeout  → szary    "Timed out"         (przycisk disabled)
  waitGap  → szary    "Wait Xs"           (tick co 1 s)

[user klika Send w fazie 'stale' lub 'reserved' — stale-retry]
  │
  ▼
onSendClick() (switch po phase):
  // mark-in-DB, żeby findNextColonizeTarget przestał rzucać
  // userowi ten sam slot. scansStore patch:
  scansStore[key].positions[p].status = phase==='reserved'
                                         ? 'reserved' : 'abandoned'
  // navigate do BAREGO galaxy view (bez ?system=…) — patrz Uwaga poniżej
  location.href = buildGalaxyUrl(galaxy)   // samo galaxy, gra wczyta
                                           // ostatni zapamiętany system
  // gra → fetchGalaxyContent → galaxyHook → scansStore refresh
  // user ląduje w galaxy view z aktualnym obrazem, findNextColonizeTarget
  //   pomija 'reserved'/'abandoned' slot, wskaże następny candidate

[user klika Send w fazie 'ready']
  │
  ▼
onSendClick() symuluje Enter w natywnym formularzu — gra wywołuje sendFleet
  │
  ▼
sendFleetHook (MAIN, SYNC):
  parsuj duration, wylicz arrivalAt
  registryStore.update(+wpis)  → SYNC zapis do localStorage
  addEventListener('load', → dispatch oge5:colonizeSent)
  │
  ▼
scans.onColonizeSent(): scans[coords].status = 'empty_sent'
```

**Krytyczny niezmiennik #1 (registry sync write):** zapis do `registryStore`
jest synchroniczny, przed nativeSend. To cały powód, dla którego
`registryStore` persystuje do localStorage, a nie chrome.storage.

**Krytyczny niezmiennik #2 (navigation-based stale-retry):** stale-retry
nie wykonuje automatycznego swap'u pól formularza. Ten wzorzec
(`retryWithNextCandidate` w v4 4.7.11–4.9.1) był TOS-wątpliwy i
nieprzejrzysty dla usera. Nowy wzorzec: 1 klik → mark-in-DB + 1 nawigacja
do bare galaxy view. Pojedyncze żądanie gry, pełna widoczność, pozwala
`findNextColonizeTarget` pominąć martwy slot przy następnym wyszukiwaniu.

**Uwaga (bare galaxy URL).** Historycznie nawigowaliśmy do
`?galaxy=G&system=S` — ale system renderowany przez SSR nie był
obserwowany przez AJAX hook, więc scansStore nie dostawał świeżych danych
dla tego pierwszego systemu. Poprawka: nawigować do **samego galaxy**
(`galaxy=G` bez system), gra renderuje ostatnio-oglądany system i fire'uje
AJAX przy pierwszej zmianie — co `galaxyHook` łapie normalnie.

### 9.3 Abandon (3 kliknięcia, ścisłe 1:1)

```
[user wchodzi na overview nowej, małej kolonii]
  │
  ▼
przycisk Abandon staje się widoczny (checkAbandonState())
  │
  ▼
[user kliknięcie 1 — floating Abandon]
  │
  ▼
abandon.start():
  safeClick(openGiveupLink)        → GRA: GET /planetlayer
  [czekaj na popup, zweryfikuj coords]
  safeClick(#block)                → pokaż formularz hasła
  wypełnij hasło programowo
  nałóż OVERLAY "SUBMIT PASSWORD" na content popupu
    (position:absolute; inset:0; flex center; tło pomarańczowe)
  parent popupu dostaje position:relative + minHeight:200px

[user kliknięcie 2 — overlay Submit pokrywa content]
  │
  ▼
  safeClick(nativeSubmit)          → GRA: POST /confirmPlanetGiveup
  [czekaj na dialog potwierdzenia]
  nałóż OVERLAY "⚠ CONFIRM DELETE ⚠" na content dialogu
    (tło czerwone, taki sam wzorzec inset:0)

[user kliknięcie 3 — overlay Confirm pokrywa content]
  │
  ▼
  safeClick(yesBtn)                → GRA: POST /planetGiveup
  oznacz pozycję jako 'abandoned' w scansStore
  reload strony
```

**Uwaga 4.9.3 — overlay zamiast append-below**: wcześniejsze wersje
dołączały duże przyciski pod content popup'a i forsowały szerokość
`.ui-dialog` przez `expandEnclosingDialog()`. v5 idzie za 4.9.3: przycisk
`position: absolute; inset: 0` pokrywa content area, user widzi TYLKO nasz
action button. Natywne pole password / tekst gry są w DOM-ie popup'a ale
niewidoczne pod overlay. `safeClick()` klika natywny element
programowo — jego widoczność nie jest wymagana do kliku. Zero forsowania
wymiarów dialoga, simpler.

**Trzy niezależne bramki bezpieczeństwa** (niezmienione z 4.x):
1. `checkAbandonState()` daje OK
2. `#giveupCoordinates` zgadza się z coords planety
3. Tekst dialogu potwierdzenia zawiera nasze coords

### 9.4 Skan → merge do storage (chronione przed nadpisaniem)

```
[user nawiguje galaktykę w grze]
  │
  ▼
[gra wywołuje XHR fetchGalaxyContent]
  │
  ▼
galaxyHook (MAIN):
  parsuj response.galaxyContent (15 pozycji)
  dispatch oge5:galaxyScanned { galaxy, system, positions, canColonize }
  │
  ▼
scans.onGalaxyScanned():
  pending = registryStore.get().filter(r => r.arrivalAt > now)
  dla każdej pozycji p:
    jeśli existing[p].status === 'empty_sent'
       && fresh[p].status === 'empty'
       && pending zawiera g:s:p:
      merged[p] = existing[p]            // zachowaj — nasza flota w locie
    w przeciwnym razie:
      merged[p] = fresh[p]               // świeże wygrywa
  scansStore.set({ ..., [key]: { scannedAt, positions: merged } })
```

### 9.5 Sync (gist z gzipem)

```
zmiana w storage → scheduler.scheduleUpload() [debounce 15s]
  │
  ▼ (po 15s ciszy)
upload():
  local = { galaxyScans, colonyHistory } ze store'ów
  remote = fetchGistData()                          [dekoduj gzip]
  merged = { scans: merge(local.scans, remote.scans),
             history: merge(local.history, remote.history) }
  jeśli merged coś zmienił:
    aktualizacja lokalnych store'ów (anti-loop: tylko jeśli changed)
  jeśli remote !== merged:
    writeGistData(merged)                           [enkoduj gzip]
```

### 9.6 Czarne tło podczas ładowania (anti-flicker)

**Problem**: OGame przeładowuje całą stronę przy praktycznie każdej akcji
(klik na planetę, klik na zakładkę, powrót z fleetdispatch, auto-refresh
po misji itd.). Domyślnie większość przeglądarek między wyładowaniem
starej strony a wyrenderowaniem nowej pokazuje białe tło. Dla OGame
(ciemny motyw graficzny) daje to efekt migania białym — w trybie nocnym
to nie jest irytacja, to jest horror.

**Rozwiązanie** (dziedziczone z 4.x, tam działa świetnie — musi być
zachowane identycznie):

```
content script (ISOLATED, run_at: document_start)
  │
  ▼ (pierwsza linia po entry)
blackBg.install():
  style = <style id="oge5-black-bg">
            html, body { background: #000 !important; }
          </style>
  appendChild do (document.head || document.documentElement)
  │
  ▼ (tym momencie strona jest czarna od samego początku)
window.addEventListener('load', () => {
  setTimeout(() => style.remove(), 300)
  // 300ms żeby rzeczywiście zdążyć zobaczyć renderowane assety
  // zamiast tylko przeładować na biało — w praktyce bezpieczny bufor
})
```

Kluczowe warunki poprawności:
- `run_at: document_start` w manifeście dla content scripta (isolated
  world), tak żeby `<style>` był wstrzyknięty **zanim** HTML zacznie się
  renderować. `document_idle` byłby za późno.
- `!important` w CSS — OGame ma własne style na html/body.
- Cleanup po `window.load + 300ms` — zbyt szybki cleanup pokazuje biel
  w trakcie renderowania assetów, zbyt późny daje widoczny ciemny flash
  po załadowaniu.

**Lokalizacja w v5**: `features/blackBg.js`, importowany jako **pierwsza**
linia w `src/content.js` (przed czymkolwiek innym). Nie ma zależności
— nie potrzebuje lib/ ani domain/, więc jeśli cokolwiek innego rzuci
błędem podczas importu, czarne tło i tak zadziała.

### 9.7 Wykrywanie nowej planety (`features/newPlanetDetector.js`)

Feature orthogonalny do Send Col — paintuje centralny banner zapraszający
usera do obejrzenia świeżo skolonizowanej planety. Stan prawdy:
`knownPlanetsStore` (`oge5_knownPlanets`, Set CP).

```
[content script mount]
  │
  ▼
hydrate knownPlanetsStore z chrome.storage.local
  │
  ▼
read #planetList → current = Set<CP>

  jeśli knownPlanets JEST PUSTE (first-run):
    knownPlanets := current    (seed — brak banneru)
    STOP

  new = current \ knownPlanets
  gone = knownPlanets \ current

  jeśli gone !== ∅:  knownPlanets := knownPlanets \ gone   (planeta
                                                           porzucona —
                                                           prune)

  jeśli new !== ∅:
    wybierz pierwszy CP z new
    paint "New planet detected — click to inspect" banner

[user wchodzi na overview nowej planety]
  │
  ▼
  jeśli usedFields > 0:
    knownPlanets.add(cp)       (potwierdzenie: user buduje na niej)
```

Invariant: banner pokazuje się co najwyżej raz per fresh planeta; znika
gdy user ją potwierdzi (zbudował coś) lub ją porzuci (zniknęła z
`#planetList`). First-run seed jest kluczowy — inaczej świeża instalacja
rozszerzenia dla usera z 8 planetami wyświetliłaby banner 8 razy.

---

## 10. Strategia storage

Dwa poziomy, jasne odpowiedzialności.

**localStorage** (sync, origin-scoped, małe dane):
- `oge5_<setting>` — preferencje użytkownika (jeden klucz = jedna preferencja,
  zgodne z AGR)
- `oge5_colonizationRegistry` — floty w locie (synchroniczny write-through)
- `oge5_gistId` — cachowane id gista
- `oge5_scansSchemaVersion` — znacznik migracji
- `oge5_*Migrated*` — jednorazowe znaczniki migracji (wg potrzeby)

> Transientny stan Send Col nie jest w localStorage — żyje jako module-local
> `let`-y w `features/sendCol.js` (patrz §3 `SENDCOL_DESIGN.md`).

**chrome.storage.local** (async, widoczne cross-origin, duże dane,
synchronizowalne):
- `oge5_galaxyScans` — ten duży
- `oge5_colonyHistory` — dane do histogramu
- `oge5_knownPlanets` — zbiór CP, który `newPlanetDetector` uznał za
  potwierdzone (array na dysku, Set w RAM)
- Tombstone'y dla cross-kontekstowych triggerów (clear, sync request)

**Anti-wzorce, których unikamy:**
- Żadnego mieszania storage "primary + cache" tych samych danych (jedno
  źródło prawdy).
- Żadnych odczytów z chrome.storage w sync'owych ścieżkach kodu (zawsze
  przez store.get w pamięci).
- Żadnych zapisów z wielu miejsc do tego samego klucza (store są jedynymi
  writerami).

---

## 11. Toolchain buildu

Minimalny. Trzy komendy: `build`, `dev`, `test`.

```
package.json
├── devDependencies:
│   ├── rollup              bundler
│   ├── @rollup/plugin-node-resolve  (tylko jeśli kiedyś potrzeba)
│   ├── typescript          type check (bez emit)
│   └── vitest              testy
├── scripts:
│   ├── build:    rollup -c + skopiuj manifest + skopiuj histogram.html
│   ├── dev:      rollup -c -w
│   ├── typecheck: tsc --noEmit
│   ├── test:     vitest run
│   └── package:  build + spakuj dist/ do dist/oge5.zip
```

**Rollup config:**
- Dwa/trzy entry pointy: `src/content.js`, `src/page.js`, `src/histogram.js`
- Wyjście: `dist/content.js`, `dist/page.js`, `dist/histogram.js` —
  pojedyncze pliki IIFE
- Bez sourcemap w buildzie produkcyjnym (review AMO ich nie potrzebuje;
  debugujemy ze źródeł)
- Build dev z sourcemapami + watch

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "target": "ES2022",
    "moduleResolution": "bundler"
  },
  "include": ["src/**/*.js", "test/**/*.js"]
}
```

Odpalane przez `npm run typecheck` — pre-commit hook (opcjonalnie) lub
ręcznie.

**Testy:**
- vitest, zero-config (natywny dla ESM)
- Testy żyją obok koncepcji: `test/domain/positions.test.js` itp.
- Cel pokrycia: **wszystkie pure functions w `domain/` i `lib/`**.
  Feature'y i bridges są testowane ręcznie (UI). ~40-60 testów łącznie.

**Id w manifeście** (kluczowe dla równoległej instalacji z v4):
- `manifest.json` → `browser_specific_settings.gecko.id = "oge5@ogame-extensions"` (Chrome ignoruje to pole)
- `manifest.json`: nazwa `"OG-E v5 (dev)"` w trakcie developmentu,
  `"OG-E v5"` do release'u

---

## 12. Migracja z v4

**Zasada kluczowa: kod v5 nigdy nie zna schemy v4.** Żadnego
`oge_*` w źródłach v5. Żadnych ścieżek importu, konwersji, adapterów
"tylko na wszelki wypadek". v5 startuje pusty, żyje we własnych kluczach
`oge5_*` i własnym giście. Koniec.

**Dlaczego takie rygorystyczne stanowisko**: dodawanie w v5 kodu który
rozumie v4 natychmiast generuje dług. Każda przyszła zmiana schematu v5
będzie wymagała weryfikacji, czy import z v4 dalej działa. Użytkownik
wyraźnie powiedział: "nie zaśmiecać kodu v5 importami z v4". Trzymamy
się tego.

**Czyja odpowiedzialność to więc jest?** **Dodajemy do 4.x funkcję
eksportu** — ostatni prezent dla odchodzącej wersji:

```
OG-E 4.9.x (nowa minor, np. 4.10.0):
  ustawienia → sekcja "Eksport do v5"
  przycisk "Pobierz dane jako plik do v5"
  │
  ▼ onClick:
    zbierz { galaxyScans, colonyHistory } z chrome.storage v4
    zapisz do pliku `oge-v4-export-YYYY-MM-DD.json`
    (bez kompresji — to jednorazowa akcja, czytelność wygrywa)
```

Wtedy w v5 jest osobny, pojedynczy przycisk **"Importuj z pliku"**:

```
OG-E v5:
  ustawienia → Diagnostyka → "Wczytaj dane z pliku"
  <input type="file" accept=".json">
  │
  ▼ onChange:
    parse, waliduj kształt (schema v4 znaną wersją)
    jeśli OK: do store'ów v5
    feedback: "Wczytano X skanów, Y kolonii."
```

**Zalety tego podejścia:**
- **v5 nie ma nigdzie stringa `oge_*`**. Nie wie, że v4 istniało.
- **v5 czyta tylko dane w swoim własnym formacie (który akurat jest taki
  sam jak v4).** Adapter formatu to po prostu walidacja pliku JSON — tak
  samo jak obsługa każdego innego importu.
- **Odpowiedzialność za eksport spoczywa na stronie, która ma dane**
  (v4). v5 tylko je konsumuje.
- **Gdy v4 zostanie wycofane**, razem z nim znika kod eksportu. Zero
  rezydualnego długu po stronie v5.
- **User decyduje kiedy**. Brak automatyki, brak cichych importów.

**Ważne**: funkcja eksportu w v4 to dodanie do zamkniętej, stabilnej
wersji. Minimalistyczny wpis — tylko zbierz dane, wyrzuć do pliku.
Zero zależności, zero refactoru 4.x.

**Jeśli user chce porzucić v4 całkowicie**: po zweryfikowaniu, że v5
działa, usuwa v4 w about:addons. Opcjonalnie usuwa gisty v2/v3 w UI
GitHuba. v5 żyje z własnym gistem, własnymi danymi.

---

## 13. Strategia testowania

**Testy jednostkowe** (vitest, `test/`):
- `domain/positions.js`: przypadki parsePositions, edge case'y sysDist
  (wrap), symetria buildGalaxyOrder
- `domain/scans.js`: classifyPosition dla każdej gałęzi statusu, logika
  merge z/bez pending registry
- `domain/registry.js`: prune, dedup, findConflict
- `domain/scheduling.js`: isSystemStale per polityka
- `sync/merge.js`: mergeScans, mergeHistory — flaga `changed` anti-loop
- `lib/createStore.js`: subscribe/unsubscribe, get/set/update

**Ręczne testy integracyjne** (w trakcie developmentu):
- Send Exp na fleetdispatch
- Pełny flow Send Col (scan → send → stale → retry → success)
- Abandon 3 kliknięcia
- Upload/download synca
- Migracja z v4

Bez automatyzacji e2e w przeglądarce. Overkill dla tego zakresu.

---

## 14. Anti-wzorce (explicite)

Rzeczy, które zobowiązujemy się NIE robić:

1. **Żadnego bezpośredniego `fetch()` / XHR do gry.** Bright line.
2. **Żadnych cichych retry.** Każda akcja dotykająca serwera odwołuje się
   do dokładnie jednego kliknięcia użytkownika (wzorzec `tryLockRecovery`
   z v4.6 jest zabroniony).
3. **Żadnej modyfikacji pola formularza bez widocznego kliknięcia
   użytkownika.** Stale-retry w v5 (zgodnie z 4.9.2) to NAWIGACJA do
   galaxy view, nie swap pól. Historycznie swap był dopuszczalny
   (ścisłe 1 click → 1 swap), ale praktyka pokazała że navigation jest
   TOS-cleaner + lepszy UX + eliminuje klasę bugów "Checking... stuck".
   **Nigdy nie wracać do wzorca form-field swap dla stale-retry.**
4. **Żadnego `eval`, `new Function`, ani `innerHTML` z niezaufanym
   contentem.** CSP nas szanuje.
5. **Żadnego `setInterval` dotykającego gry.** Timery tylko dla UI (np.
   etykieta countdown "Wait").
6. **Żadnych default exports.** Tylko named exports — grep-friendly.
7. **Żadnych globalnych zmiennych** poza tym, co już zanieczyszcza gra.
8. **Żadnych cross-modułowych side effects w czasie importu.** Moduły
   eksportują funkcje/store'y/stałe. Inicjalizacja dzieje się w plikach
   entry (`content.js`, `page.js`).
9. **Żadnych warunkowych importów.** Tylko statyczne — bundler tego
   potrzebuje.
10. **Żadnych plików-śmietników typu "utility".** Jeśli `utils.js` przekracza
    3 niepowiązane helpery — podziel według koncepcji.
11. **Żadnego JSDoc który kłamie.** Jeśli zachowanie się zmieni, doc zmienia
    się w tym samym commicie.
12. **Żadnego martwego kodu.** CI może to wymuszać przez eslint
    unused-exports (opcjonalnie).

---

## 15. Pytania otwarte (rozstrzygnięte w v0.3)

- [x] **P1**: CompressionStream w content script na FF Android 140 —
      działa. v4 4.9.0 uruchomił to w produkcji, oba desktop i mobile
      syncują bez problemu. Bezpiecznie polegać — bez fallbacku do
      zewnętrznej biblioteki.
- [x] **P2**: Zestaw pluginów rollupa — tylko `@rollup/plugin-replace`
      do wstrzykiwania stałych z buildu (np. wersji z manifestu).
      Poza tym zero-config.
- [x] **P3**: Integracja UI ustawień z AGR — trzymamy ten sam selektor
      injection co w v4 (`.ago_menu_content`). **OG-E działa wyłącznie
      razem z AGR** (AntiGameReborn) — to hard dependency, nie opcja.
      Sensowne założenie: AGR musi być obecny, inaczej OG-E się nie
      uruchamia (albo gracefully pomija injection ustawień).
- [x] **P4**: Osobny plik `SCHEMAS.md` w `v5.0.0/` — **NIE robimy**.
      Schematy są inline w §7 tego dokumentu (jedyne źródło prawdy dla
      v5). W v4 osobny `SCHEMAS.md` żył w roocie repo i się sprawdził,
      ale dla v5 — z rygorystycznym `oge5_` prefixem i mniejszą liczbą
      kluczy — utrzymywanie dwóch plików byłoby ceremonią. Root-level
      `SCHEMAS.md` zostaje jako frozen v4 docs (nie ruszać).
- [x] **P5**: Przycisk paniki / zrzut store'ów — **NIE ROBIMY**.
      Na histogramie mamy już Export/Import pełnych danych (JSON) + CSV
      histogramu. Te opcje MUSZĄ być zachowane w v5. Użytkownik
      raportujący bug eksportuje JSON i załącza.
- [x] **P6**: Logger — **in-memory only** (ring buffer ~500 ostatnich
      wpisów). User kopiuje z DevTools. Bezpieczniejsze dla prywatności,
      prostsze w implementacji.
- [x] **P7**: Testy dla `bridges/*` — **nie warto**. To cienkie adaptery,
      testowane ręcznie podczas manualnej weryfikacji flow'ów.
- [x] **P8**: Reset do fabryki — **NIE ROBIMY**. Eksport + manualne
      usunięcie rozszerzenia + reinstall = czysty start. Przycisk reset
      w UI = niebezpieczny (pomyłka = utrata danych).

---

## 16. Fazy implementacji

- [x] **1. Scaffolding** — package.json, rollup, tsconfig, jeden wspólny
      manifest.json dla Chrome + FF (merged w Fazie 10 polish — FF zawsze
      ładuje `manifest.json`, osobny `manifest.firefox.json` był ignorowany),
      entry files, smoke-test czarnego tła.
- [x] **2. features/blackBg.js** — anti-flicker style injection at
      document_start.
- [x] **3. lib/** — 6 modułów (createStore, storage, dom, gzip, debounce,
      logger). 97 testów.
- [x] **4. domain/** — 5 modułów (rules, positions, scans, registry,
      scheduling). +93 testów.
- [x] **5. state/** — 4 persisted stores + uiState + lib/persist. +80 testów.
      (uiState zostało później usunięte w post-review cleanup — transientny
      stan Send Col przeniesiony do module-local `let`-ów w `sendCol.js`,
      patrz §3 `SENDCOL_DESIGN.md`. `knownPlanets` store dołączony w
      ostatnim polish'u pod feature `newPlanetDetector`.)
- [x] **6. bridges/** — 5 MAIN-world XHR hooków. +89 testów.
- [x] **7. features/sendExp.js** — floating Send Exp + Phase 0/1/2 flow
      (v4 port), per-planet count, context-aware label, ArrowRight shortcut.
- [x] **8. features/sendCol/** — pełny flow rozbity na 6 plików
      (index/targeting/handlers/reactors/labels/state), navigation-to-galaxy
      stale-retry (DESIGN.md §9.2), reserved/no-ship detection,
      stuck-protection watchdog, auto-redirect po colonize.
      (Splitting został później scofnięty — 6 plików scalonych z powrotem
      w 2 pliki: `features/sendCol.js` jako orchestrator + `sendColLogic.js`
      jako pure helpery. Architektura derive/render/click wokół
      fleetDispatcher snapshot — pełna specyfikacja w `SENDCOL_DESIGN.md`.)
- [x] **9. features/abandon.js** — 3 kliknięcia + overlay injected buttons
      (4.9.3 port; overlay pokrywa cały content popup'u, nie tylko
      append-below).
- [x] **10. features/badges.js** + **colonyRecorder.js** — pasywne dane,
      badges z safety-net poll 3s (dla AJAX eventContent refresh).
- [x] **11. sync/** — merge + gist (z gzip FF Xray fix 4.9.4) + scheduler
      (z tombstone listener `oge5_syncRequestAt`/`_clearRemoteAt`/
      `_resetGalaxyAt`).
- [x] **12. features/settingsUi.js** — panel ustawień w AGR
      (`#ago_menu_content` ID, MutationObserver re-injection gdy AGR
      przebudowuje panel, złota etykieta "OG-E v5 Settings",
      accordion toggle + akcja closing-others, sekcja "Data"
      z przyciskiem "Open histogram").
- [x] **13. features/histogram** — strona histogramu (Colony Size + Galaxy
      Observations + Export/Import JSON + CSV + per-galaxy reset).
- [x] **Wire-up (Faza 10 poprzedniej rozpiski)** — `src/content.js` +
      `src/page.js` — init stores, install features, installSync
      (top-frame only), installScansListener, installSettingsMirror,
      installFleetdispatchShortcut. DOM features deferred do
      DOMContentLoaded.
- [x] **4.9.6 parity** — dynamic abandoned deadline
      (`abandonedCleanupDeadline(scannedAt)` — pierwsze 3 AM po
      scannedAt+24h). `abandoned` usunięty z `RESCAN_AFTER`.
- [x] **4.9.4 parity** — gzip manual reader + TextDecoder (FF Xray fix),
      defensive `Number(arrivalAt)` w findConflict, debug flag
      `oge5_debugMinGap` dla diagnostyki min-gap.
- [ ] **14. Patch v4.10.0: eksport do pliku .json** — osobny commit w głównym
      repo (poza `v5.0.0/`). Przycisk w v4 settings panel zapisuje
      `oge_galaxyScans` + `oge_colonyHistory` jako zwykły JSON.
      Schema v4 `{version:1, exportedAt, colonyHistory, galaxyScans}` —
      v5 `features/histogram/io.js` `importAllData` już to rozumie
      (ewentualne stare pole `deletedColonies?` jest po cichu ignorowane).
- [ ] **15. v5: import z pliku .json** w ustawieniach → Diagnostyka. Większość
      logiki już jest (`importAllData`), wymaga tylko UI button w settingsUi.
- [ ] **16. Polish / known open items:**
      - **Abandon floating button** — `features/abandon.js` eksportuje
        `checkAbandonState()` i `abandonPlanet()`, ale nie ma
        `installAbandonButton`. Floating UI pokazujące button gdy
        warunki spełnione trzeba dopisać (overlay-style injected
        buttons dla flow samego już działają).
- [ ] **17. Release** — package.zip, bump wersji, submit do AMO.

Każda faza kończy się review userowym + sign-off przed kolejną. Żadnego
big-bang dropa.

---

## 17. Podejście do pracy (orkiestracja agentów)

Rewrite tej skali wymaga dyscypliny — żaden agent (ani główna sesja, ani
subagent) nie pamięta wszystkiego. Dlatego:

**Główna sesja** (ta, która rozmawia z użytkownikiem) jest dyrygentem.
Jej rola:
- Decyzje architektoniczne i trade-offy (konsultuje z userem)
- Pisanie briefów dla subagentów
- Review wyniku każdego subagenta (trust-but-verify — sprawdzić pliki,
  nie tylko czytać podsumowanie)
- Koordynacja między fazami
- Integracja — łączenie modułów w działający bundle
- Komunikacja z userem po polsku

**Subagenci** (Agent tool) są pracownikami wykonawczymi. Każdy dostaje
ZAMKNIĘTY BRIEF — self-contained, zero założeń o kontekście rozmowy:
- Ścieżki plików (absolutne)
- Link do tego DESIGN.md (z numerem wersji, np. v0.3) i relevantnymi
  sekcjami (schematy danych są w §7)
- Konkretne zadanie (co napisać / co zweryfikować / co przetestować)
- Kontrakt wyniku (co powinno powstać, jaki kształt)
- Lista plików do NIE ruszania (żeby się nie rozleźli poza swój scope)

**Typowe zastosowania subagentów:**
- **general-purpose**: pisanie jednego modułu zgodnie z briefem (np.
  "zaimplementuj `lib/createStore.js` i jego testy w `test/lib/`,
  zgodnie z typedef w DESIGN.md §6, bez dotykania innych plików").
- **general-purpose** (w trybie review): "przeczytaj `src/features/sendCol.js`
  i zwaliduj, czy spełnia wymagania TOS z DESIGN.md §3 — zwróć listę
  naruszeń lub potwierdzenie".
- **Explore**: szybkie odpowiedzi na pytania typu "gdzie w 4.x jest
  zaimplementowana obsługa X" — odpowiedź wraca jako brief dla głównej
  sesji, która decyduje jak przenieść do v5.

**Nie używamy subagentów do:**
- Interakcji z userem (użytkownik rozmawia z główną sesją, kropka)
- Decyzji architektonicznych (to jest dyrygentura)
- Drobnych edytów (ceremonia nie warta overhead'u)

**Po każdej fazie** — review user'owy.
**Po każdym subagencie** — trust-but-verify: główna sesja otwiera pliki
które subagent rzekomo zmienił, i patrzy na nie oczami user'a.

---

## 18. Kryteria sukcesu

v5 jest gotowe do produkcji, gdy:

- [ ] Wszystkie funkcje z 4.9.0 działają identycznie.
- [ ] Flow kolonizacji na mobile jest nieodróżnialny od desktopu (zero
      race'ów).
- [ ] Całkowita liczba linii kodu jest **mniejsza** niż w 4.9.0 przy tym
      samym zestawie funkcji.
- [ ] Brak `try {} catch {}` z cichym połykaniem błędów poza `safeLS`.
- [ ] Każda funkcja domenowa ma test.
- [ ] `npm run typecheck` przechodzi z zero błędów.
- [ ] Nowy czytelnik może odpowiedzieć na "gdzie dzieje się X?" w ciągu
      60 sekund.
- [ ] Handoff brief dla przyszłej sesji LLM wskazuje na ten dokument
      (DESIGN.md zawiera architekturę, flow'y i schematy danych w §7) i
      nic więcej nie jest potrzebne.

---

*Koniec DESIGN.md v0.4.*
*Status: Fazy 1-13 + wire-up + extensive polish zakończone. 554 testy, typecheck clean, build OK.*
*Następny krok: Faza 14 (patch v4.10.0 eksport do pliku) → Faza 15 (v5 import UI) → Faza 16 (polish: abandon button, etc.) → Faza 17 (release).*
