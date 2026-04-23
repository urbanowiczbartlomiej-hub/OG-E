# sendCol — głęboka analiza (Faza A)

Celem jest zrozumieć, czy mamy do czynienia z *essential complexity* (funkcjonalność rzeczywiście jest taka skomplikowana) czy *incidental complexity* (dała się złożyć z prostszych kawałków, ale tego nie zrobiliśmy).

**Wniosek:** ~60% to incidental. Do zlikwidowania bez utraty funkcjonalności.

---

## 1. Stan ambientowy — inventarz

8 pól koordynujących zachowanie jednego przycisku:

| Pole | Gdzie | Typ | Po co |
|---|---|---|---|
| `scanBusy` | state.js `let` | bool | scanHalf zablokowany podczas in-page submit |
| `scanUnlockTimer` | state.js `let` | Handle | 10s safety-net gdyby `oge5:galaxyScanned` nigdy nie przyszło |
| `colWaitInterval` | state.js `let` | Handle | 1Hz countdown dla "Wait Ns" |
| `checkTargetWatchdog` | state.js `let` | Handle | 15s stuck-protection dla "Checking…" |
| `noShipBlocked` | state.js `let` | bool | lock po error 140035 |
| `pendingColVerify` | uiState | `{g,s,p}\|null` | "czekamy na checkTarget dla TYCH współrzędnych" |
| `staleRetryActive` | uiState | bool | "następny click Send nawiguje do galaxy view" |
| `staleTargetCoords` | uiState | `{g,s}\|null` | gdzie ta nawigacja idzie |
| ~~`pendingColLink`~~ | uiState | `string\|null` | **DEAD** — ustawiany/czyszczony, nigdy czytany |

Plus 6 środowiskowych na każdy tick:
- `location.search` matching (`component=overview\|fleetdispatch\|galaxy`, `mission=7`)
- `checkAbandonState(settings)` (DOM+settings)
- `readHomePlanet()` (DOM)
- `parseCurrentGalaxyView()` (DOM+URL)
- `parseFleetdispatchUrlCoords()` (URL)
- `#durationOneWay` text (DOM)

Plus 4 store'y: settings, scans, registry, uiState.

**Razem: 18 źródeł wejściowych koordynują UI jednego przycisku.**

## 2. Stan widoczny dla usera — 11 wariantów

Przycisk w dowolnym momencie jest w jednym z tych stanów:

| # | Kontekst | Send label | Scan label |
|---|---|---|---|
| A | Idle (inny page, kandydat w DB) | "Send Colony [g:s:p]" zielony | "Scan" niebieski |
| B | Idle (brak kandydatów) | "Send" zielony | "Scan" niebieski |
| C | Scan busy (in-page submit w toku) | bez zmian | 0.5 opacity |
| D | Abandon mode (overview+fresh+small) | "Too small! (N)" czerwony | "Abandon" ciemnoczerwony |
| E | Fleetdispatch checking | "Checking…/[g:s:p]" pomarańczowy | "Skip" |
| F | Fleetdispatch ready | "Ready!/[g:s:p]" zielony | "Skip" |
| G | Fleetdispatch stale | "Stale/[g:s:p]" pomarańczowy | "Skip" |
| H | Fleetdispatch reserved | "Reserved/[g:s:p]" pomarańczowy | "Skip" |
| I | Fleetdispatch no-ship | "No ship!/[g:s:p]" czerwony | "Skip" |
| J | Fleetdispatch wait-gap | "Wait Ns" amber | "Skip" |
| K | Fleetdispatch timeout (watchdog) | "Timeout/[g:s:p]" pomarańczowy | "Skip" |

**Kluczowa obserwacja:** te 11 stanów **nigdy nie jest zadeklarowane explicit**. Każdy handler re-deryvuje "w jakim jestem stanie" z kombinacji tych 18 wejść, w różnej kolejności, z nieco różnymi warunkami. To jest **pęknięta rura**: każda funkcja ma własne mini-rozpoznanie kontekstu.

## 3. Red flags (incidental complexity)

### 3.1 `state.js` jest smoking gun
Getterów/setterów piszemy tylko po to, żeby handlers+reactors+index mogły współdzielić 4 module-local `let`s. To oznacza że te 3 pliki **chcą być jednym**. Splittowanie było kosmetyczne.

### 3.2 Trzy safety timery kompensują "event może nie przyjść"
- `scanUnlockTimer` (10s) — gdyby `oge5:galaxyScanned` nie nadszedł
- `checkTargetWatchdog` (15s) — gdyby `oge5:checkTargetResult` nie nadszedł
- `setTimeout(..., 100)` (magic) — żeby gra zdążyła zrobić własny post-send redirect zanim my zrobimy nasz

Każdy timer to ryzyko desyncu. Timery są **kompensatą za brak modelu stanu** — zamiast mieć `lastScanSubmitAt: timestamp` i policzyć `isScanBusy = now - lastScanSubmitAt < 10s`, trzymamy `scanBusy: bool + scanUnlockTimer: Handle` które mogą się rozjechać.

### 3.3 `pendingColLink` jest martwy
Grep: ustawiany 3× do null, nigdy nie czytany. Memento dawnego flow ("scan → paint label → user klika Send → czyta pendingColLink → nawiguje"), który został zastąpiony auto-nav w `onGalaxyScanned`. Ale pole zostało w uiState i kilka miejsc ciągle je zeruje defensywnie.

### 3.4 `scanBusy` ma dwa źródła prawdy
- Pole `scanBusy: boolean` w state.js
- `opacity: 0.5` w DOM

Mutowane razem przez `lockScanHalf`/`unlockScanHalf` — ale jedna funkcja ustawia, druga czyta z DOM. Jak wywołamy `forceClearScanBusy` (dispose) to opacity nie wraca do 1, bo nie wołamy `unlockScanHalf`. Dlatego dispose woła obie. Podwójna księgowość.

### 3.5 Budowanie URL fleetdispatch w 2 miejscach
`targeting.js:findNextColonizeTarget` i `reactors.js:onGalaxyScanned` obie składają `?page=ingame&component=fleetdispatch&galaxy=X&system=Y&position=Z&type=1&mission=7&am208=1`. Zmiana = 2 miejsca synchronicznie.

### 3.6 `markPositionAbandoned` vs `markPositionReserved` — 18 linii duplikatu
Różnica: 1 obiekt statusu. Helper `markPosition(g, s, p, statusPayload)` byłby 6 linii.

### 3.7 `onCheckTargetResult` ma 4 gałęzie z overlapującymi update'ami uiState
Każda gałąź (ready/noShip/reserved/stale) robi podobny patch `pendingColVerify: null, staleRetryActive: ?, staleTargetCoords: ?`. Klasyczny smell dla discriminated union.

### 3.8 Coord-match boilerplate duplikuje się 2×
```js
if (verify.galaxy !== galaxy || verify.system !== system || verify.position !== position) return;
```
Identycznie w `onCheckTargetResult` i `armCheckTargetWatchdog`. Helper `matches(a, b)` byłby 1 linia.

### 3.9 Trzy źródła "gdzie user teraz jest"
`readHomePlanet()`, `parseCurrentGalaxyView()`, `parseFleetdispatchUrlCoords()`. Każda z innym fallbackiem (DOM→URL, inputs→URL, URL-only). Nie ma `getPageContext() → {kind, coords, activePlanet}`.

## 4. Proponowany nowy model

### 4.1 Jeden compute — `deriveButtonContext(env) → ButtonContext`

Dyskryminowana unia, nie state machine z flagami:

```ts
type Coords = { galaxy: number, system: number, position: number };

type ButtonContext =
  | { kind: 'abandon', max: number }
  | { kind: 'fleetdispatch', target: Coords, phase:
        | { tag: 'checking' }
        | { tag: 'ready' }
        | { tag: 'stale', reason: 'stale'|'reserved'|'timeout' }
        | { tag: 'noShip' }
        | { tag: 'waitGap', seconds: number }
        | { tag: 'plain' }  // mission != 7 lub brak coords
    }
  | { kind: 'galaxy', nextScan: {g,s}|null, candidate: Coords|null, scanPending: boolean }
  | { kind: 'other', candidate: Coords|null };
```

Pure function: `(location.search + DOM snapshot + stores + minimal persistent state) → ButtonContext`.

### 4.2 Pure render — `renderButton(ctx) → { send: Paint, scan: Paint }`

Nic nie wie o DOM. Dostaje kontekst, zwraca co ma być na labelu i jakim kolorze. Testowalne w izolacji 100%.

### 4.3 Click handlers dispatchują po kind — nie re-deryvują

```ts
function onSendClick() {
  const ctx = deriveButtonContext(currentEnv());
  switch (ctx.kind) {
    case 'abandon': return; // no-op
    case 'fleetdispatch':
      if (ctx.phase.tag === 'stale') return navigateToStale(ctx.target);
      if (ctx.phase.tag === 'noShip') return;
      if (ctx.phase.tag === 'waitGap' || ctx.phase.tag === 'ready') return dispatchEnter();
      // ...
  }
}
```

Żadne pole `isNoShipBlocked()` — kontekst mówi phase.tag === 'noShip', koniec.

### 4.4 Persistent state — redukcja z 8 do 1-2 pól

Po audycie:
- `pendingColVerify` — **musi zostać** (nie wyderivujemy czy to "nasz" checkTarget)
- `lastCheckTargetResult: {coords, verdict}` — zastępuje `noShipBlocked`, `staleRetryActive`, `staleTargetCoords` (wszystko derywowalne)
- `lastScanSubmitAt: timestamp` — zastępuje `scanBusy + scanUnlockTimer` (derywowalne: `isScanBusy = now - lastScanSubmitAt < 10s`)
- `pendingColLink` — **usunąć** (dead)
- Timery (watchdog, wait interval) — tylko UI layer, nie state

**Z 8 pól + 3 timerów → 2 pola + 1 timestamp.**

### 4.5 Jeden tick-ticker zamiast dwóch timerów

Zamiast osobny watchdog (15s) i wait interval (1Hz), jeden `requestAnimationFrame`/1Hz pętla która co sekundę:
1. `ctx = deriveButtonContext(env)`
2. `render(ctx)`

Stany "timeout" i "waitGap.seconds=N" są wtedy **derywowane z czasu**:
- `timeout` = `pendingColVerify != null && (now - pendingColVerify.at) > 15s`
- `waitGap.seconds = Math.max(0, gapDeadline - now)`

Bez osobnych setTimeout/setInterval. Bez ryzyka race. Koszt: 1 tick/s kiedy button mounted (nic w porównaniu do OGame baseline).

## 5. Hipotezy wymagające game research

Zanim piszę kod, muszę zweryfikować:

### H1 — Czy `#durationOneWay` to naprawdę jedyne źródło czasu lotu?
Gra ma prawdopodobnie `window.fleetDispatcher.currentFlight.duration` albo `window.fleetDispatchInstance.fleetData.time`. Czytanie JS state byłoby pewniejsze niż parsowanie tekstu "HH:MM:SS".

### H2 — Czy `canColonize` w galaxy response to naprawdę tylko "scanning planet has colonizer"?
Komentarz w reactors.js tak twierdzi. Ale może `canColonize` wymaga jeszcze czegoś? Może response ma inne pola (np. `cargoRequired`) które też wchodzą w decyzję?

### H3 — Czy galaxy response ma pola, których nie używamy?
`reservedPositions` wiemy że jest. Ale np. `inactive_users[]`, `debrisFields[]`, `planetMovements[]` — czy są? Te mogłyby uprościć klasyfikację.

### H4 — AGR i eventy
Czy AGR emituje `ago:routineReady`, `ago:fleetPanelLoaded`, `ago:galaxyScanComplete`? Jeśli tak, nasz polling + watchdog są nadmiarowe.

### H5 — Planet ID ze źródła gry
Czy jest `window.planetId` / `<body data-cp="...">` / inne? Obecne `#planetList .hightlightPlanet` działa ale wymaga specyficznego DOM.

### H6 — `checkTarget` response — pełne pola
Używamy: `status, targetOk, targetInhabited, targetPlayerId, targetPlayerName, orders, errors[]`. Co więcej tam jest? Może `resources`, `debrisField`, `moon`, `availableShips`?

### H7 — Game events DOM-side
OGame używa jQuery. Może emituje `planetChange`, `systemChange`, `fleetSent` na document? Moglibyśmy słuchać eventów zamiast XHR hooków?

### H8 — URL stability przy nawigacjach
- Po `location.href = '...galaxy...'` — czy URL jest pełny, z wszystkimi parametrami?
- Po naszym nav do fleetdispatch — czy gra nadpisuje URL, czy zostawia nasze parametry?
- AGR in-page galaxy submit — URL zostaje stary, ale inputs się zmieniają. Co jeszcze się zmienia?

## 6. Propozycja — co zrobić

### Krok 1 — user dostarcza dane (8 pytań wyżej)
Patrz "Co mogę zrobić żeby pomóc" w poprzedniej rozmowie:
- Network HAR z pełnego flow: galaxy scan → checkTarget → send
- DOM dump kluczowych stron (overview fresh colony, galaxy, fleetdispatch)
- Co jest na `window.*` i `document.body.dataset`
- Czy AGR emituje eventy — `monkeypatch`em dispatchEvent można wylistować wszystkie

### Krok 2 — ja weryfikuję hipotezy + zamykam pytania otwarte
Jak widzę game DOM/XHR, mogę ocenić które z H1-H8 dają realną redukcję kodu.

### Krok 3 — projekt nowej architektury (1 plik propozycji)
Konkretny projekt: nowy `src/features/sendCol/` (1-2 pliki, nie 6), z `deriveButtonContext` + `renderButton` + click dispatch. Może ~500-700 LoC zamiast obecnych 1900.

### Krok 4 — implementacja + ekwiwalencja 554 testów
Implementujemy. Testy z starej wersji (te które były regresja-killerami) muszą dalej przechodzić — weryfikują behawior, nie implementację.

### Krok 5 — usunięcie starego + dokumentacja
Kasacja `sendCol/{handlers,reactors,labels,state,targeting}.js`, aktualizacja DESIGN.md.

**Estymata:** jak H1/H4/H6/H7 potwierdzą się korzystnie → redukcja ~60% kodu sendCol + eliminacja wszystkich timerów + 1 pole persistent state zamiast 8. Jeśli nie potwierdzą się (gra nic sensownego nie eksponuje) → redukcja ~40% przez sam refactor strukturalny (`deriveButtonContext` + render).
