# sendCol — projekt v2 (po game research)

**Cel**: przepisać `features/sendCol/` (6 plików, 1901 LoC, 8 pól state, 3 timery)
na **jeden plik ~450 LoC** z **3 polami state, 0 setInterval/setTimeout timerów**
(1 repaint ticker). Zachować 100% funkcjonalności + naprawić 1 bug (auto-redirect
przy scan).

**Status**: proposal. Do akceptacji **przed** implementacją.

---

## 1. Axiomy projektowe

Założenia przyjęte wspólnie z userem, nieruchome:

1. **Scan i Send są niezależne.** Przycisk Scan nigdy nie nawiguje na
   fleetdispatch. Przycisk Send nigdy nie robi galaxy submit. Dwa odrębne
   flow, jedna obudowa graficzna.
2. **`window.fleetDispatcher` to source of truth na fleetdispatch.**
   Gra go aktualizuje po każdym checkTarget. Czytamy wprost, nie
   duplikujemy w uiState.
3. **Abandon znika z sendCol.** Przenosi się do osobnego feature
   `abandonOverview` (patrz `ABANDON_OVERVIEW_DESIGN.md`). sendCol =
   czysta kolonizacja.
4. **State machine jawny.** Dyskryminowana unia `ButtonContext`
   wypracowana w `derive()`, nie rozmyta po 8 polach.
5. **Timery zastępowane timestamp'ami + 1 Hz repaint ticker.** Jedyny
   persistent `setInterval` to repaint — pure UI, nie state.
6. **Kontrakt TOS niezmieniony.** 1 user click → co najwyżej 1 origin'owane
   żądanie HTTP. Żadnych cyklicznych automatycznych wywołań.

---

## 2. ButtonContext — discriminated union

```ts
type Coords = { galaxy: number, system: number, position: number };

type ButtonContext =
  // Na stronie innej niż fleetdispatch / galaxy — pokazujemy kandydata
  // z DB, albo idle. Klik Send → nawigacja na fleetdispatch z kandydatem.
  | { kind: 'idle', candidate: Coords | null }

  // Na galaxy view. Kandydat z DB (jak istnieje) + info o kolejnym
  // systemie do scanu. Klik Scan → in-page submit / nawigacja.
  | { kind: 'galaxy', candidate: Coords | null, nextScan: {g,s} | null, scanCooldown: boolean }

  // Na fleetdispatch — tu fleetDispatcher nam wszystko mówi. Sub-phase
  // determined by orders[7] + ship inventory + last error code.
  | { kind: 'fleetdispatch', target: Coords | null, phase:
        | { tag: 'noTarget' }                       // user nie wybrał celu
        | { tag: 'ready' }                          // orders[7]=true, hasColonizer
        | { tag: 'noShip' }                         // orders[7]=false && !hasColonizer
        | { tag: 'reserved' }                       // last error 140016
        | { tag: 'stale' }                          // orders[7]=false, !noShip, !reserved
        | { tag: 'timeout' }                        // > 15s od nav, bez checkTarget response
        | { tag: 'waitGap', remaining: number }     // min-gap active, seconds left
    };
```

**Obserwacje:**
- `kind` rozstrzyga strona (location.search match)
- `phase` dla fleetdispatch wynika z fleetDispatcher + `lastCheckTargetError`
- Każdy `ButtonContext` jest self-contained — wiesz wszystko, czego
  potrzebuje render i click handler

---

## 3. Persistent state — trzy pola

Audyt wcześniej dał listę 8 pól. Po:
- usunięciu `pendingColLink` (dead)
- eliminacji `pendingColVerify` (czytamy `fleetDispatcher.targetPlanet` wprost)
- eliminacji `staleRetryActive` + `staleTargetCoords` (derive z current target + last error)
- eliminacji `scanBusy` + `scanUnlockTimer` (zastąpione `lastScanSubmitAt`)
- eliminacji `checkTargetWatchdog` (zastąpione `lastNavToFleetdispatchAt`)
- eliminacji `noShipBlocked` (derive z `fleetDispatcher.shipsOnPlanet[208]`)

zostaje:

```ts
const state = {
  // Timestamp ostatniej akcji "nawiguj na fleetdispatch z celem". Po
  // 15s bez matching checkTargetResult → phase: 'timeout'.
  lastNavToFleetdispatchAt: 0 as number,

  // Timestamp ostatniego in-page galaxy submit. Do cooldown (1s) żeby
  // spam-klik nie zakolejkował wielu żądań.
  lastScanSubmitAt: 0 as number,

  // Kod błędu z ostatniego checkTarget (lub null). Służy do rozróżnienia
  // reserved / noShip / generic stale. Nadpisywany na każdy event; nie
  // czyszczony przy nawigacji (stary błąd ze starego celu nie przeszkadza
  // bo `derive()` matching go do current fleetDispatcher.targetPlanet).
  lastCheckTargetError: null as number | null,

  // Timestamp startu wait-gap countdown. Używane gdy phase = 'waitGap'.
  // Ticker odczytuje (gapSeconds - (now - waitStartAt)/1000).
  waitStartAt: 0 as number,
  waitSeconds: 0 as number,
};
```

4 pola. Wszystkie in-memory (moduł-scope `let`). Nie persisted.

**Bez** `state.js` z getter/setter accessors — te 4 pola czyta i pisze
tylko jeden plik, więc prosty `let` wystarczy.

---

## 4. derive() — jedna funkcja, jeden compute

```ts
function derive(env: Env): ButtonContext {
  // 1. Abandon — out of scope (osobny feature).
  // 2. Fleetdispatch branch.
  if (env.search.includes('component=fleetdispatch') &&
      env.search.includes('mission=7')) {
    const fd = env.fleetDispatcher;
    if (!fd) return { kind: 'fleetdispatch', target: null, phase: { tag: 'noTarget' } };

    const target = fd.targetPlanet?.galaxy && fd.targetPlanet?.system && fd.targetPlanet?.position
      ? fd.targetPlanet : null;
    if (!target) return { kind: 'fleetdispatch', target: null, phase: { tag: 'noTarget' } };

    const hasColonizer = (fd.shipsOnPlanet || []).some(s => s.id === 208 && s.number > 0);
    const canColonize = fd.orders?.['7'] === true;
    const err = state.lastCheckTargetError;

    // Priority: timeout > (waitGap) > reserved > noShip > stale > ready
    if (env.now - state.lastNavToFleetdispatchAt > 15_000 && !canColonize && err === null) {
      return { kind: 'fleetdispatch', target, phase: { tag: 'timeout' } };
    }
    if (state.waitSeconds > 0) {
      const remaining = Math.max(0, state.waitSeconds - Math.floor((env.now - state.waitStartAt) / 1000));
      if (remaining > 0) return { kind: 'fleetdispatch', target, phase: { tag: 'waitGap', remaining } };
    }
    if (err === 140016) return { kind: 'fleetdispatch', target, phase: { tag: 'reserved' } };
    if (err === 140035 || !hasColonizer) return { kind: 'fleetdispatch', target, phase: { tag: 'noShip' } };
    if (!canColonize) return { kind: 'fleetdispatch', target, phase: { tag: 'stale' } };
    return { kind: 'fleetdispatch', target, phase: { tag: 'ready' } };
  }

  // 3. Galaxy branch.
  if (env.search.includes('component=galaxy')) {
    const home = readHomePlanet(env.dom);  // {galaxy, system} | null
    const view = parseCurrentGalaxyView(env);  // {galaxy, system} | null
    const scanCooldown = (env.now - state.lastScanSubmitAt) < 1000;

    // PRIORITY: gdy system, który user właśnie ogląda na galaxy view,
    // ma wolny target position — pokaż TEN coord na Send. User widzi
    // co znalazł i klik Send idzie tam, nie gdzie indziej z DB. Gdy
    // nie ma lokalnego trafienia → fallback na globalny picker.
    const candidate = (home && view
      ? pickCandidateInView(env.scans, env.registry, env.targets, view, env.now)
      : null
    ) ?? (home ? findNextColonizeTarget(env.scans, env.registry, home, env.targets, env.preferOther) : null);

    const nextScan = home ? findNextScanSystem(env.scans, home, view) : null;
    return { kind: 'galaxy', candidate, nextScan, scanCooldown };
  }

  // 4. Idle branch.
  const home = readHomePlanet(env.dom);
  const candidate = home ? findNextColonizeTarget(env.scans, env.registry, home, env.targets, env.preferOther) : null;
  return { kind: 'idle', candidate };
}
```

**Pure** — wszystkie wejścia są w `env` (location.search, DOM snapshot
wrappers, fleetDispatcher reference, stores snapshots, now). Testowalne
w izolacji, deterministyczne.

`findNextColonizeTarget` i `findNextScanSystem` zostają jak są —
istniejące pure algorithms w `targeting.js`. Do nowego pliku je
inlineujemy lub zostawiamy w targeting.js (jako kilkanaście pure helpers
dobrze jest trzymać osobno — decyzja poniżej).

---

## 5. render() — ctx → paint instructions

```ts
type Paint = { text: string, bg: string, subtext?: string };
type RenderResult = { send: Paint, scan: Paint };

function render(ctx: ButtonContext): RenderResult {
  switch (ctx.kind) {
    case 'idle':
      return {
        send: ctx.candidate
          ? { text: `[${ctx.candidate.galaxy}:${ctx.candidate.system}:${ctx.candidate.position}]`,
              subtext: 'Send Colony', bg: BG_SEND_READY }
          : { text: 'Send', bg: BG_SEND_IDLE },
        scan: { text: 'Scan', bg: BG_SCAN_IDLE },
      };

    case 'galaxy':
      return {
        send: /* same as idle */,
        scan: ctx.nextScan
          ? { text: 'Scan', bg: BG_SCAN_IDLE }  // dimmed if scanCooldown
          : { text: 'All scanned!', bg: BG_SCAN_IDLE },
      };

    case 'fleetdispatch':
      return {
        send: renderFleetdispatchSend(ctx.target, ctx.phase),
        scan: { text: 'Skip', bg: BG_SCAN_IDLE },
      };
  }
}

function renderFleetdispatchSend(target, phase): Paint {
  const coords = target ? `[${target.galaxy}:${target.system}:${target.position}]` : '';
  switch (phase.tag) {
    case 'noTarget': return { text: 'Send', bg: BG_SEND_IDLE };
    case 'ready':    return { text: coords, subtext: 'Dispatch!', bg: BG_SEND_READY };
    case 'noShip':   return { text: coords, subtext: 'No ship!',  bg: BG_SEND_ERROR };
    case 'reserved': return { text: coords, subtext: 'Reserved',  bg: BG_SEND_STALE };
    case 'stale':    return { text: coords, subtext: 'Stale',     bg: BG_SEND_STALE };
    case 'timeout':  return { text: coords, subtext: 'Timeout',   bg: BG_SEND_STALE };
    case 'waitGap':  return { text: `Wait ${phase.remaining}s`,   bg: BG_SEND_WAIT };
  }
}
```

**Pure** — ctx in, RenderResult out. Żadnego DOM, żadnego window.

Osobny `paint()` step aplikuje RenderResult do DOM. Testowalny zwykłymi
string comparisons, nie jsdom mockingiem.

---

## 6. Click handlers — switch po kind

```ts
function onSendClick() {
  const ctx = derive(captureEnv());
  switch (ctx.kind) {
    case 'idle': case 'galaxy':
      if (ctx.candidate) {
        state.lastNavToFleetdispatchAt = Date.now();
        state.lastCheckTargetError = null;
        state.waitSeconds = 0;
        location.href = buildFleetdispatchUrl(ctx.candidate);
      } else {
        paint(render({ kind: 'idle', candidate: null }));
        // label flashes "None available" for 2s
      }
      return;

    case 'fleetdispatch':
      switch (ctx.phase.tag) {
        case 'noShip': case 'reserved': case 'noTarget':
          return;  // no-op

        case 'stale': case 'timeout':
          // DESIGN.md §9.2 stale retry — nawigacja na galaxy view celu
          if (ctx.target) {
            location.href = buildGalaxyUrl(ctx.target);
          }
          return;

        case 'ready': case 'waitGap':
          // Min-gap gate. If remaining > 0, repaint already shows countdown;
          // user click is no-op until it reaches 0.
          if (ctx.phase.tag === 'waitGap') return;
          const wait = getColonizeWaitTime();
          if (wait > 0) {
            state.waitStartAt = Date.now();
            state.waitSeconds = wait;
            refresh();  // repaint immediately
            return;
          }
          dispatchEnter();
          return;
      }
  }
}

function onScanClick() {
  const ctx = derive(captureEnv());
  if (ctx.kind !== 'galaxy' && ctx.kind !== 'idle') return;

  const home = readHomePlanet();
  if (!home) return;

  const view = parseCurrentGalaxyView();  // null poza galaxy
  const next = findNextScanSystem(scansStore.get(), home, view);
  if (!next) { /* paint "All scanned!" */ return; }

  // Cooldown
  if ((Date.now() - state.lastScanSubmitAt) < 1000) return;
  state.lastScanSubmitAt = Date.now();

  if (view) {
    // In-page submit (już na galaxy view)
    if (navigateGalaxyInPage(next.galaxy, next.system)) return;
  }
  // Fallback: full nav
  location.href = buildGalaxyUrl(next);
}
```

**Brak** `checkAbandonState` w sendCol. Kompletnie gone.

---

## 7. Tick policy

### Event-driven refresh
Wywoływane wprost, gdy coś się zmienia:
- `oge5:checkTargetResult` → aktualizuje `state.lastCheckTargetError`, refresh()
- `oge5:galaxyScanned` → scansStore się zmienił (przez state/scans listener), refresh()
- `oge5:colonizeSent` → autoRedirectColonize? → ewentualnie nav, refresh()
- `settingsStore.subscribe` → refresh()
- `scansStore.subscribe` → refresh()  (gdy scan zmienił DB)
- `registryStore.subscribe` → refresh()

### Time-driven (1 Hz ticker)
Jeden `setInterval(refresh, 1000)` przy mount. Clearowany przy dispose.

Ticker potrzebny do:
- waitGap countdown (co sekundę refresh → `remaining` się zmniejsza)
- timeout detection (derive() patrzy na `now - lastNavToFleetdispatchAt`)

Koszt: 1 DOM repaint/s kiedy button mounted. Pomijalny.

### Zero innych timerów
- Brak `setTimeout` dla scanUnlock (cooldown jest porównaniem timestamp)
- Brak `setTimeout` dla checkTargetWatchdog (timeout to derive z lastNavToFleetdispatchAt)
- Brak `setInterval` dla waitGap countdown (ten sam 1Hz ticker co timeout)
- Brak `setTimeout(..., 100)` magic dla post-send nav (jeśli zostaje autoRedirectColonize, zostaje ten jeden — patrz niżej)

---

## 8. `autoRedirectColonize` — USUNIĘTE

Setting + cała logika auto-redirect po wysłaniu → **do usunięcia całkiem**
(decyzja usera). Argumenty:

- Axiom #1 (scan i send niezależne) zabrania auto-chain'ingu
- User: "zwykle gracz sobie najpierw naskanuje, a później tylko wysyła"
- Po wysłaniu `empty_sent` marker w scansStore zostaje (tę logikę w
  `oge5:colonizeSent` listener zachowujemy), więc next click Send
  i tak nie re-pick'nie tego samego slotu — user kontroluje tempo
- Usuwa `setTimeout(..., 100)` magic z reactor'a → zero setTimeout w feature

**Zniknąć:**
- `settings.autoRedirectColonize` w `state/settings.js` (usunąć z
  SETTINGS_SCHEMA, settingsUi, defaults)
- Cały block auto-redirect w `onColonizeSent` reactor — zostaje tylko
  update scansStore (`empty_sent` marker)

**Nice-to-have zastępujący funkcjonalnie**: po wysłaniu user naturalnie
zostaje na fleetdispatch (po game redirect); kolejny cel pojawi się w
label Send'a gdy user wróci na overview / galaxy. Zero automatyki, pełna
kontrola.

---

## 9. Bridge simplification (opcjonalnie, w pakiecie)

Obecny `checkTargetHook` computuje `colonizable`, `reserved`, `noShip` w bridge.
Grep: jedyny konsument to sendCol. W nowym sendCol czytamy `fleetDispatcher`
wprost — `colonizable`/`noShip` derivujemy na miejscu, potrzebujemy tylko
`errorCodes[]` dla `reserved`/`noShip` fallback.

Uproszczenie bridge event detail:
```ts
// Przed:
type CheckTargetResultDetail = {
  galaxy, system, position, success, targetOk, targetInhabited,
  targetPlayerId, targetPlayerName, orders, errorCodes,
  colonizable, reserved, noShip,
};
// Po:
type CheckTargetResultDetail = {
  galaxy, system, position,
  errorCode: number | null,  // pierwszy z errors[].error lub null
};
```

Oszczędność ~30 LoC w bridge + łatwiejszy test (3 pola zamiast 13).

**Decyzja**: robimy w pakiecie rewrite'u sendCol. Zero external breakage
(jeden konsument).

---

## 10. Struktura plików — decyzja

Opcje:
- **(A)** Jeden plik `src/features/sendCol.js` (~450 LoC)
- **(B)** Dwa pliki: `src/features/sendCol.js` (orchestration, ~300) +
  `src/features/sendColTargeting.js` (pure algorithms przeniesione z
  starego `targeting.js`, ~200)

Argument za (A): nic nie jest współdzielone z innym feature, drag/focus
już w `lib/draggableButton.js`. Jeden plik = zero cross-file boilerplate.

Argument za (B): pure algorithms (`findNextScanSystem`, `findNextColonizeTarget`,
`getColonizeWaitTime`) mają już 3 pliki testowe (~100 testów). Łatwiej
utrzymać jako osobny moduł z własnym test suite.

**Rekomendacja: (B) but smaller**. Jeden pomocniczy plik `sendColLogic.js`
(nie katalog!) trzyma pure helpers. Main `sendCol.js` orchestracja.

```
src/features/
  sendCol.js          ~300 LoC — install/dispose, derive, render, paint, clicks, ticker
  sendColLogic.js     ~220 LoC — pure: findNextScanSystem, findNextColonizeTarget,
                                 pickCandidateInView, getColonizeWaitTime,
                                 readHomePlanet, parseCurrentGalaxyView,
                                 buildFleetdispatchUrl, buildGalaxyUrl
```

vs obecne 6 plików w `sendCol/` dir + `state.js` + 1901 LoC.

**Nowa pure funkcja `pickCandidateInView`** — część current-view priority
logiki z sekcji 4. Sygnatura:

```ts
pickCandidateInView(
  scans: GalaxyScans,
  registry: RegistryEntry[],
  targets: number[],       // user's colPositions
  view: { galaxy, system }, // current galaxy-view coords
  now: number
): Coords | null
```

Zwraca pierwszy target position w `view.galaxy:view.system` który ma
status='empty' i nie jest inFlight. `null` gdy view nie ma trafienia
(caller wtedy falluje na global `findNextColonizeTarget`). Pure,
testowalne.

---

## 11. Test migration

Obecne testy (50 w `sendCol.test.js`, 29 w `positions.test.js`, 21 w
`checkTargetHook.test.js`, plus tyle co użyte z tych dla registry/scheduling):

**Zostają bez zmian** (pure algorithms nadal istnieją):
- positions.test.js — buildGalaxyOrder, sysDist, parsePositions
- domain/scans.test.js — mergeScanResult
- domain/registry.test.js — findConflict, pruneRegistry
- domain/scheduling.test.js — isSystemStale, abandonedCleanupDeadline

**Adaptujemy** do nowego sendCol:
- sendCol.test.js — behawioralne: "after checkTargetResult z noShip → label = 'No ship!'".
  Zapis assertingu się zmieni (read context → assert render result zamiast ręcznej DOM inspection),
  liczba testów podobna.
- checkTargetHook.test.js — upraszcza się bo bridge upraszcza się (3 pola zamiast 13).
  Z 21 testów → ~15.

**Nowe** testy (pure derive/render):
- `derive()` — tabela input → ButtonContext. ~20 przypadków, jeden plik.
- `render()` — tabela ButtonContext → RenderResult. ~15 przypadków.

**Target**: 554 pass → **550+** pass (może paru usuwamy jeśli były artefaktami
starego 8-pol-stanu). Baseline nie spadnie.

---

## 12. Migration plan — krok po kroku

1. **Branch** (worktree) — żeby nie blokować innych prac.
2. **Stwórz `sendColLogic.js`** — przeniesienie pure helpers z obecnego
   `sendCol/targeting.js` + drobne sygnaturowe zmiany (pure: no store reads,
   tylko args). Testy.
3. **Stwórz nowy `sendCol.js`** — implementacja `derive` + `render` +
   `paint` + `onSendClick` + `onScanClick` + install/dispose + ticker +
   event hooks. Testy.
4. **Uprość bridge `checkTargetHook.js`** — zwraca `{coords, errorCode}`.
   Testy adapt.
5. **Usuń stare**: `src/features/sendCol/` (cały dir), `state.js`,
   `uiState.js` pola `pendingColLink` / `pendingColVerify` / `staleRetryActive`
   / `staleTargetCoords` (cała uiState prawdopodobnie się upraszcza).
6. **Update `content.js`** import path (`./features/sendCol/index.js` →
   `./features/sendCol.js`).
7. **Run testy** — 550+ zielonych. Build prod. Smoke test (user).

Estymata czasu: 3-5 godzin skoncentrowanej pracy.

---

## 13. Risks + rollback

**Risks**:
- `window.fleetDispatcher` może być mutowany inaczej niż zakładam.
  Fallback: stary sposób (URL parse) jako safety net w `derive()`.
- `autoRedirectColonize` default flip może dezorientować userów. Mitigation:
  docs note + settings label explicit.
- Ticker 1Hz może być widoczny (flicker). Mitigation: render idempotentny,
  nie repaint'ujemy gdy paint output identical do previous.

**Rollback**:
- Branch w worktree, jeśli smoke test nie działa → revert jednym
  `git reset --hard HEAD~N`.
- Stary kod zostaje w historii git — zawsze można wyciągnąć.

---

## 14. Decyzje (zatwierdzone)

1. **Struktura**: (B) — `sendCol.js` (~300 LoC) + `sendColLogic.js` (~220 LoC). ✅
2. **Bridge simplification** `checkTargetResult` → `{coords, errorCode}`: w pakiecie. ✅
3. **`autoRedirectColonize`**: **usunięte całkiem**. Setting znika, reactor robi
   tylko `empty_sent` marker w scansStore. ✅
4. **Nice-to-have**: Send label priorytetuje current-view candidate nad globalnym
   picker (nowa pure `pickCandidateInView`). ✅
5. **`uiState.pendingColVerify/Link/staleRetry*`**: usunięte. ✅
6. **`navigateGalaxyInPage`**: zostaje. ✅

**Kompletny scope rewrite'u:**
- Nowe: `features/sendCol.js`, `features/sendColLogic.js` (+ ich testy)
- Usuniete: `features/sendCol/` (cały katalog, 6 plików)
- Zmodyfikowane: `bridges/checkTargetHook.js` (uproszczenie detail shape),
  `state/uiState.js` (usunięcie 4 pól), `state/settings.js` (usunięcie
  `autoRedirectColonize`), `features/settingsUi.js` (usunięcie odpowiedniej
  opcji), `content.js` (import path update)

Ruszamy implementację.
