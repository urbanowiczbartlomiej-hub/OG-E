# OG-E v5 — Dokument projektowy architektury

> Dokument do myślenia. Opisuje co budujemy, **dlaczego**, i skąd biorą
> się decyzje. Implementacja podąża za tym dokumentem — jeśli rzeczywistość
> nie zgadza się z jakąś sekcją, najpierw aktualizujemy dokument.

**Status:** szkic v0.2 (oczekuje na review)
**Punkt odniesienia:** OG-E 4.9.3 (dojrzała, produkcyjna, stabilna — służy
jako empiryczny punkt odniesienia, co działa / co boli). Nakładka zmian
względem 4.9.0 obejmuje: `reserved` status + navigate-to-stale-system UX
(4.9.2), soft-delete dla colonyHistory (4.9.1), overlay-buttons dla
abandon popupów (4.9.3).

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
├── manifest.json                    Chrome MV3
├── manifest.firefox.json            Firefox MV3 (nowy gecko.id)
├── DESIGN.md                        ten dokument
├── SCHEMAS.md                       generowane z JSDoc + ręcznie
├── src/
│   ├── content.js                   entry do bundla isolated
│   ├── page.js                      entry do bundla MAIN
│   ├── histogram.html               strona rozszerzenia
│   ├── histogram.js                 entry do bundla histogramu
│   │
│   ├── lib/                         pure helpery, zero wiedzy domenowej
│   │   ├── createStore.js           reaktywny store (~25 linii)
│   │   ├── storage.js               safeLS + chromeStore (ujednolicone)
│   │   ├── dom.js                   safeClick, waitFor, injectStyle
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
│   │   ├── settings.js              preferencje (localStorage per klucz)
│   │   └── uiState.js               transientny UI state (pendingLink,
│   │                                staleRetry itp.)
│   │
│   ├── features/
│   │   ├── sendExp.js               przycisk Send Exp + flow ekspedycji
│   │   ├── sendCol.js               przycisk Send Col + scan/send/stale-retry
│   │   ├── abandon.js               3-kliknięciowy abandon + injected buttons
│   │   ├── badges.js                kropki ekspedycji na planet list
│   │   ├── settingsUi.js            panel ustawień AGR
│   │   └── colonyRecorder.js        collectColonyData (overview → history)
│   │
│   ├── bridges/                     hooki XHR w świecie MAIN
│   │   ├── xhrObserver.js           generyczny `observeXHR({url, on, handler})`
│   │   ├── galaxyHook.js            fetchGalaxyContent → dispatch event
│   │   ├── checkTargetHook.js       checkTarget → dispatch result event
│   │   ├── sendFleetHook.js         sendFleet → pre-register + dispatch event
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
| `settingsStore` | `Settings` | localStorage per-klucz | 0 | per-klucz dla integracji z AGR |
| `uiStore` | `UIState` | nie persystowany | — | transientny: pendingColLink, staleRetryActive itp. |

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
najważniejszymi punktami statystycznymi). Dane usuwa się **wyłącznie**
przez tombstone (patrz niżej).

### `oge5_deletedColonies` (chrome.storage.local, syncowany przez gist)

Soft-delete tombstones dla `oge5_colonyHistory` — dodane w v4 4.9.1, by
rozwiązać problem multi-device merge'u (usunięcie lokalne było
przywracane przy kolejnym upload z drugiego urządzenia, bo `mergeHistory`
to union).

```ts
type DeletedColonies = number[];   // lista cp (planet ID)
```

**Cykl życia:**
- Zapis tylko przez explicit user action (DevTools snippet na stronie
  histogramu lub przycisk "Usuń wpis" jeśli zostanie dodany).
- `mergeDeleted(local, remote) = union` — append-only, tombstone'y
  propagują się stale.
- `mergeHistory(localHist, remoteHist, deletedSet)` filtruje z obu stron.
  To jest klucz: bez tego device B z wpisem w lokalnym history
  re-uploadowałby cp z powrotem do gista.
- Nigdy nie jest pruned automatycznie. Lista rośnie monotonicznie — w
  praktyce kilkadziesiąt wpisów per konto (jedno na ręcznie usunięty
  błędny pomiar). Jeśli kiedykolwiek stanie się problemem rozmiaru, dodać
  UI "Reset listy usuniętych".

### Ustawienia (indywidualne klucze localStorage, prefiks `oge5_*`)

Mapowanie z listy preferencji v4; nazwy celowo niezmienione dla
kontynuacji konceptualnej. Pełna lista w `SCHEMAS.md` (generowane ze
źródła).

### Payload Gista

Ten sam format co w v4 4.9.3 (gzip + base64, schema w wersji 3). v5 tworzy
własny gist z **inną description**:
`"OG-E v5 sync data (compressed) — do not edit manually"`.
Nazwa pliku: `oge5-data.json.gz.b64`. Klucz localStorage: `oge5_gistId`.

Kształt zdekompresowanego payloadu:

```ts
type GistPayload = {
  version: 3;
  updatedAt: string;                       // ISO
  galaxyScans: GalaxyScans;
  colonyHistory: ColonyEntry[];
  deletedColonies?: number[];              // tombstone list (opcjonalne dla back-compat)
};
```

---

## 8. Komunikacja między światami

Jeden kierunek: **MAIN → isolated**. Świat isolated nigdy nie dispatchuje
do MAIN — nie musi (świat MAIN reaguje tylko na zdarzenia gry i je
przekazuje).

**Kontrakty zdarzeń** (`src/domain/events.js` definiuje je przez JSDoc
typedefs):

| Zdarzenie | Dispatchowane przez (MAIN) | Konsumowane przez (isolated) |
|---|---|---|
| `oge5:galaxyScanned` | `galaxyHook` | state `scans.js`, UI `sendCol.js` |
| `oge5:checkTargetResult` | `checkTargetHook` | `sendCol.js` — detekcja stale |
| `oge5:colonizeSent` | `sendFleetHook` | `scans.js` (update status → `empty_sent`) |
| `oge5:syncRequest` | `settingsUi.js` (user kliknął Sync) | `sync/scheduler.js` |

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

### 9.2 Wysłanie kolonizacji (pełny flow, ze stale-retry)

```
[user klika Send Col — nie na fleetdispatch]
  │
  ▼
sendCol.onClick():
  findNextCandidate(scansStore, registryStore, settings.positions)
    → { link, coords }
  uiStore.set({ pendingColLink: link })
  pokaż "Found! Go" na przycisku

[user klika Send Col — ma pending link]
  │
  ▼
  uiStore.set({ pendingColVerify: coords })
  location.href = link    (pojedyncze kliknięcie → pojedyncza nawigacja)
  │
  ▼
[strona fleetdispatch się ładuje]
  │
  ▼
checkTargetHook (MAIN) dispatchuje oge5:checkTargetResult
  (z errorCodes — patrz sekcja 8)
  │
  ▼
sendCol.onCheckTargetResult():
  jeśli pendingColVerify && coords się zgadzają:
    jeśli colonizable:
      pokaż "Ready! [coords]" (zielony) — bezpiecznie wysłać
      uiStore.set({ staleRetryActive: false, staleTargetCoords: null })
    w przeciwnym razie, rozróżnij:
      reserved (errorCodes zawiera 140016):
        scans[coords].status = 'reserved'
        pokaż "Reserved — click Send to check system" (fiolet)
      generic stale:
        scans[coords].status = 'abandoned'
        pokaż "Stale — click Send to check system" (pomarańcz)
      uiStore.set({ staleRetryActive: true, staleTargetCoords: coords })

[user klika Send na fleetdispatch z staleRetryActive]
  │
  ▼
sendCol.navigateToStaleSystem():
  { galaxy, system } = staleTargetCoords
  location.href = galaxy-view-url(galaxy, system)
  // ścisłe 1 kliknięcie → 1 nawigacja → 1 żądanie gry
  // gra sama wywoła fetchGalaxyContent → colonize.js observe →
  //   scansStore merge z nowymi danymi (w tym reservedPositions)
  // user ląduje na galaxy view i widzi rzeczywistość

[user klika Send na fleetdispatch, stan Ready]
  │
  ▼
sendCol.dispatch():
  wait = getMinGapWait(registryStore, getDuration())
  jeśli wait > 0:
    pokaż countdown "Wait Xs", nic nie rób
  w przeciwnym razie:
    symulacja Enter → gra wywołuje sendFleet XHR
  │
  ▼
sendFleetHook (MAIN, SYNC):
  parsuj duration, wylicz arrivalAt
  registryStore.update(dodaj wpis)  → sync zapis do localStorage
  addEventListener('load', () => dispatch oge5:colonizeSent)
  │
  ▼
[gra kontynuuje żądanie]
  │
  ▼
scans.onColonizeSent():                  (eventual, chrome.storage)
  scans[coords].status = 'empty_sent'
```

Krytyczny niezmiennik:
**zapis do rejestru jest synchroniczny, przed nativeSend.** To jest cały
powód, dla którego `registryStore` persystuje do localStorage, nie do
chrome.storage.

**Drugi krytyczny niezmiennik — pivot z 4.9.2**: stale-retry nie wykonuje
automatycznego swap'u pól formularza. Wcześniejsza implementacja
(`retryWithNextCandidate` w v4 4.7.11-4.9.1) modyfikowała pola
fleetdispatch na następnego kandydata; gra sama fire'owała checkTarget.
Działało, ale:
1. UX niewidzialny — user widział tylko zmianę label bez kontekstu.
2. Klasa bugów "Checking..." stuck gdy swap nie wymusił zmiany (ten sam
   candidate z różnym id) albo gdy kolejny candidate też był stale.
3. Nie ujawniał stanu "reserved" — user nie wiedział czemu się nie wysyła.

Navigation-to-galaxy wycofuje ten wzorzec i daje user'owi widoczny
kontekst. Pojedyncza nawigacja = pojedyncze żądanie gry. TOS-clean.

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

---

## 10. Strategia storage

Dwa poziomy, jasne odpowiedzialności.

**localStorage** (sync, origin-scoped, małe dane):
- `oge5_<setting>` — preferencje użytkownika (jeden klucz = jedna preferencja,
  zgodne z AGR)
- `oge5_colonizationRegistry` — floty w locie (synchroniczny write-through)
- `oge5_pendingColVerify` — transientny stan Send Col
- `oge5_gistId` — cachowane id gista
- `oge5_scansSchemaVersion` — znacznik migracji
- `oge5_*Migrated*` — jednorazowe znaczniki migracji (wg potrzeby)

**chrome.storage.local** (async, widoczne cross-origin, duże dane,
synchronizowalne):
- `oge5_galaxyScans` — ten duży
- `oge5_colonyHistory` — dane do histogramu
- `oge5_deletedColonies` — tombstone'y cp dla soft-delete historii
  (union-merged, patrz sekcja 7)
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
- `manifest.firefox.json`: `gecko.id = "oge5@ogame-extensions"`
- `manifest.json`: nazwa `"OG-E v5 (dev)"` w trakcie developmentu,
  `"OG-E v5"` do release'u

---

## 12. Migracja z v4

**Zasada: v5 jest niezależne.** Nie czyta storage'u v4 bezpośrednio. User
sam wywołuje jednorazowy import, kiedy jest gotowy.

**Fresh install**: v5 startuje pusty. Ustawienia mają wartości domyślne.
Pusty histogram.

**Import z v4**: nowy przycisk w ustawieniach v5:
*"Importuj dane z OG-E 4.x (przez Gist)"*

Flow po kliknięciu:
1. v5 czyta `oge_gistToken` z localStorage (ta sama origin → ten sam
   localStorage → token jest widoczny). To JEDYNY odczyt klucza v4
   wykonywany przez v5.
2. v5 używa tokenu, żeby pobrać gist v4 (match po description).
3. Dekompresja (format v3 z v4).
4. Kopiuj do store'ów v5 (przekształcenie kształtu w razie potrzeby —
   zachowamy identyczny, więc przekształcenie nie jest potrzebne).
5. Pokaż userowi liczby: "Zaimportowano X skanów, Y kolonii."

**Nigdy się nie dzieje automatycznie.** Żadnego skanowania danych v4
w tle, żadnego cichego importu. User jest właścicielem decyzji.

**Jeśli user chce porzucić v4**: po zweryfikowaniu, że v5 działa, usuwa
v4 w about:addons. Opcjonalnie usuwa gisty v2/v3 w UI GitHuba. v5 żyje
z własnym gistem.

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

## 15. Pytania otwarte (do rozstrzygnięcia przed/podczas scaffoldingu)

- [x] **P1**: CompressionStream w content script na FF Android 140 —
      **ROZSTRZYGNIĘTE**: działa. v4 4.9.0 uruchomił to w produkcji, oba
      desktop i mobile syncują bez problemu. Bezpiecznie polegać — bez
      fallbacku do zewnętrznej biblioteki.
- [ ] **P2**: Zestaw pluginów rollupa — czy potrzebujemy czegoś poza
      zero-config? Prawdopodobnie tylko `@rollup/plugin-replace` do
      wstrzykiwania stałych z buildu (np. wersja). Zweryfikować podczas
      scaffoldingu.
- [ ] **P3**: Integracja UI ustawień z AGR — czy trzymamy ten sam selektor
      injection (`.ago_menu_content`)? Tak, chyba że AGR się zmieni.
- [ ] **P4**: Generowanie `SCHEMAS.md` z JSDoc — ręcznie (copy/paste
      z typedefs) czy automatycznie (tsc + typedoc lub jsdoc-to-markdown)?
      Zacznij ręcznie, automatyzuj tylko jeśli zacznie się rozjeżdżać.
- [ ] **P5**: Czy chcemy "przycisk paniki", który zrzuca pełne store'y do
      schowka dla raportowania bugów? Mogłoby pomóc w debugowaniu. Koszt:
      ~10 linii. Na razie odkładamy.
- [ ] **P6**: Logger — persystować do localStorage czy tylko in-memory?
      In-memory jest prostsze + bezpieczniejsze dla prywatności; user może
      skopiować z DevTools.
- [ ] **P7**: Testy dla `bridges/*` — mockować XHR przez happy-dom?
      Prawdopodobnie nie warto — to cienkie adaptery.
- [ ] **P8**: Czy oferujemy przycisk "zresetuj v5 do fabryki"? Tak, pod
      ustawienia → Diagnostyka. Jedno kliknięcie usuwa wszystkie klucze
      `oge5_*` + wpisy chrome.storage.

---

## 16. Fazy implementacji

1. **Scaffolding** (1 posiedzenie) — package.json, rollup config, tsconfig,
   manifest.json + manifest.firefox.json, puste entry files, pierwszy
   smoke-test import działający w FF (ładuje się, nic nie robi).
2. **lib/** — wszystkie pure helpery, w pełni przetestowane.
3. **domain/** — cała pure logic, w pełni przetestowana.
4. **state/** — store'y + persystencja + jednorazowa hydratacja.
5. **bridges/** — XHR hooki w świecie MAIN, dispatchujące eventy (jeszcze
   bez feature'ów).
6. **features/sendExp.js** — pierwszy widoczny feature, end-to-end.
7. **features/sendCol.js** — pełny flow włącznie ze stale-retry.
8. **features/abandon.js** — pełne 3 kliknięcia.
9. **features/badges.js** + **features/colonyRecorder.js** — pasywne dane.
10. **sync/** — pipeline gista.
11. **features/settingsUi.js** — panel ustawień w AGR.
12. **features/histogram** — strona histogramu.
13. **Narzędzie migracji** — import z v4.
14. **Polish** — edge case'y, ręczne testy integracyjne, finalny review.
15. **Release** — package.zip, bump wersji, submit do AMO.

Każda faza kończy się review userowym + sign-off przed kolejną. Żadnego
big-bang dropa.

---

## 17. Kryteria sukcesu

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
- [ ] Handoff brief dla przyszłej sesji LLM wskazuje na ten dokument +
      SCHEMAS.md i nic więcej nie jest potrzebne.

---

*Koniec DESIGN.md v0.1.*
*Następny krok: review userowy → iteracja → scaffolding.*
