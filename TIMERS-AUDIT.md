# TIMERS-AUDIT — unifikacja niekończących się timerów

> **Status:** Etap 1 + Etap 2 ZAIMPLEMENTOWANE (typecheck/lint/build zielone; testy
> odłożone do release). `attackAlarm` — carve-out, nietknięty.
> **Lifecycle:** dokument transientowy — kasujemy po zamknięciu cyklu (git trzyma
> historię). Konwencja jak `SYNC-AUDIT.md`.

## 1. Cel

Zlokalizować wszystkie „interwałowe sprawdzanie bez końca" i zastąpić rozproszone,
niezależne timery **jednym, wspólnie zarządzanym, świadomym widoczności karty**
mechanizmem. Cel: mniej długu (koniec z 5× kopiowanym boilerplate'em), lepszy
performance/UX (zero wybudzeń, gdy karta jest w tle) i testowalność.

## 2. Inwentarz (11× `setInterval` + 1× `rAF`)

**Rodzina A — „safety poll" (fallback dla `MutationObserver`):**

| Site | Interwał | Tick | Powód | Charakter |
|---|---|---|---|---|
| `artifactShopWatcher.js:198` | 3 s | `checkCompletion()` | miss observera | czysty strażnik |
| `rewardingWatcher.js:132` | 3 s | `checkCompletion()` | miss observera | czysty strażnik |
| `eventMenuHighlight.js:255` | 3 s | `applyHighlights()` | miss observera | czysty strażnik |
| `badges/index.js:576` | 3 s | `renderGuarded()` O(#planet) | OGame omija scoped observery | strażnik (obronny) |
| `reminders/eventList.js:592` | 3 s | `refreshSnapshot()`+`render()` | zgubiony storage-event | strażnik UI (zweryfikowane: tylko DOM, push żyje w `sync/`) |
| `traderMenuHighlight.js:704` | 60 s | pełny skan Trader | **północ / granica okna / snooze** | **sterowany czasem** |
| `attackAlarm/index.js:384` | 25 s | rebind MO + `checkAttack()` | re-bind po AJAX + fallback | rebind + fallback (**bezpieczeństwo**) |

**Rodzina B — „1 Hz repaint ticker":**

| Site | Interwał | Tick | Uwaga |
|---|---|---|---|
| `sendColony/index.js:990` | 1 s | repaint odliczań | zawsze włączony |
| `sendLifeform/index.js:472` | 1 s | repaint odliczań | zawsze włączony |
| `dailyRun/index.js:820` | 1 s | repaint „N left" | zawsze włączony |
| `attackAlarm/index.js:245` | 1 s | blink favicona/tytułu | **ograniczony** show/hide ✅ |

## 3. Werdykt — czy jest problem?

**Tak, umiarkowany i czysto naprawialny dług + marnotrawstwo — nie bug.**

- **Zero świadomości widoczności.** Brak `visibilitychange`/`document.hidden`/
  `requestIdleCallback` w całym `src/`. 10 zawsze-włączonych interwałów tyka pełną
  parą, gdy karta jest w tle — a OGame trzyma się w tle godzinami. Najem. ~5
  wybudzeń/s w pesymistycznym przypadku, część rusza DOM.
- **5× zduplikowany boilerplate** safety-poll (`setInterval(()=>installed&&x(),3000)`).
- **Poll tradera = ręczny scheduler** (≈1440 skanów/dobę dla kilku znanych z góry granic).

**Uczciwa kalibracja:** Chrome i tak dławi `setInterval` w głębokim tle do ≥1/min,
więc surowy zysk CPU częściowo się pokrywa. Większe wygrane to **(a) konsolidacja
+ testowalność**, **(b) deterministyczne zero-wybudzeń + snap-to-truth po powrocie**,
**(c) usunięcie długu**. Nie przesadzamy z narracją „oszczędzamy baterię".

## 4. Co NIE jest problemem (zostaje)

- `shared/button.js:397` — `requestAnimationFrame` samokończący się (`if (pct<1)`).
- `lib/dom.js` `waitFor` — poll z twardym `timeoutMs`.
- Same `MutationObserver`y — „szybka ścieżka"; obserwery nie są dławione widocznością,
  więc po migracji to one trzymają poprawność, gdy karta jest widoczna.
- **Brak wycieków** — wszystkie 12 timerów są `clearInterval`-owane przy dispose.

## 5. Design — `lib/clock.js` (fundament, zero zależności)

Jeden tick-bus dla całego rozszerzenia, w idiomie `debounce.js`/`waitFor`
(minimalny, wstrzykiwalny `now` → testowalny bez happy-dom). Miejsce: `lib/`
(reguła warstw: importuje nic; dotyka tylko `document.visibilityState`, jak
`dom.js` dotyka DOM).

```js
// lib/clock.js
// Jeden, ogólnorozszerzeniowy, visibility-aware tick-bus. Backed JEDNYM
// setInterval(BASE_MS). Pauzuje się, gdy document.hidden; jeśli nie ma
// subskrybenta whileHidden — ZATRZYMUJE bazowy interwał całkowicie
// (zero wybudzeń w tle). Na powrocie do widoczności odpala każdego
// subskrybenta raz natychmiast (snap-to-truth), potem wznawia.

const BASE_MS = 1000;

/**
 * @param {() => void} cb
 * @param {{ everyMs?: number, whileHidden?: boolean }} [opts]
 *   everyMs      — kadencja; zaokrąglana w GÓRĘ do wielokrotności BASE_MS. Domyślnie 1000.
 *   whileHidden  — jeśli true, tyka też przy ukrytej karcie. Domyślnie false (pauza).
 * @returns {() => void} unsubscribe (idempotentny)
 */
export const subscribe = (cb, opts) => { /* ... */ };

// Dla testów jednostkowych samego zegara — fabryka z wstrzykniętymi zależnościami:
export const createClock = ({ now, setInterval, clearInterval, doc }) => ({ subscribe, _dispose });
// Moduł eksportuje też domyślny singleton wpięty w realne globale; featury importują singleton.
```

**Semantyka (kontrakt):**
- `eligible(sub) = sub.whileHidden || !doc.hidden`.
- Bazowy interwał działa **wtw.** `subscribers.some(eligible)`; po każdej zmianie
  (subscribe / unsubscribe / visibilitychange) `ensureRunning()` start/stop.
- Na ticku: każdy `eligible` sub, dla którego minęło `>= everyMs` od ostatniego
  odpalenia (na siatce BASE_MS), jest wołany.
- `visibilitychange → widoczna`: każdy sub odpalany raz natychmiast + reset
  „ostatniego odpalenia"; potem `ensureRunning()`. (Snap dla pauzowanych; nieszkodliwe
  ponowienie dla `whileHidden` — calle są idempotentne.)
- `visibilitychange → ukryta`: `ensureRunning()` (zatrzyma interwał, jeśli nie ma
  `whileHidden`).
- Leniwy: interwał + listener `visibilitychange` istnieją tylko gdy ≥1 subskrybent.

## 6. Etap 1 — migracja (8 interwałów → 1 zegar)

Pauza-przy-ukryciu jest tu **poprawnością**, nie regresją: nikt nie patrzy → nie ma
po co malować; po powrocie snap. `whileHidden` **nie** jest potrzebny dla żadnego z
tych 8 (zweryfikowane — same UI, bez efektów w tle).

| Site | Było | Będzie |
|---|---|---|
| `sendColony:990` | `setInterval(refresh, 1000)` | `subscribe(refresh, { everyMs: 1000 })` |
| `sendLifeform:472` | `setInterval(refresh, 1000)` | `subscribe(refresh, { everyMs: 1000 })` |
| `dailyRun:820` | `setInterval(refresh, 1000)` | `subscribe(refresh, { everyMs: 1000 })` |
| `artifactShopWatcher:198` | `setInterval(…,3000)` | `subscribe(…, { everyMs: 5000 })` |
| `rewardingWatcher:132` | `setInterval(…,3000)` | `subscribe(…, { everyMs: 5000 })` |
| `eventMenuHighlight:255` | `setInterval(…,3000)` | `subscribe(…, { everyMs: 5000 })` |
| `badges:576` | `setInterval(…,3000)` | `subscribe(…, { everyMs: 5000 })` (5 s nadal ≪ 30 s OGame) |
| `reminders/eventList:592` | `setInterval(refresh,3000)` | `subscribe(refresh, { everyMs: 5000 })` |

W każdym `dispose`: `clearInterval(handle)` → `unsubscribe()`. `install*()` pozostaje
idempotentny; `unsubscribe` trzymany w `installed` (re-install po dispose czyściutko
re-subskrybuje).

**Decyzja (podjęta):** wszystkie 5 strażników na 5 s — to backstopy dla missów
observera/storage-eventu (precyzja nieistotna; observer łapie wspólny przypadek,
a powrót do karty robi natychmiastowy snap). `badges` i `reminders` dzielą tę samą
powierzchnię flake'u (`#eventContent`), więc mają tę samą kadencję co reszta.

## 7. Etap 2 — `scheduleAt` dla tradera (ZAIMPLEMENTOWANE)

`clock.scheduleAt(getNextWakeTs, cb)` → `{ reschedule, dispose }`: arm JEDNEGO
`setTimeout` na następną granicę; po odpaleniu woła `cb` (NIE auto-rearmuje — re-arm
przez `reschedule()`). Nie pauzowany widocznością (granice absolutne; tani timeout).

Pure `nextTraderBoundary(now, state)` (obok `traderGlows`, eksportowane do testów)
zwraca min z przyszłych granic: kolejne 6/14/23 + północ (reużyty `nextDailyOccurrence`
z `traderClock.js`), `auctionBidAt+BID_SNOOZE_MS`, `auctionQuietUntil`, `importNextAt`.
cb = `applyHighlight` (lekki re-compute z magazynu + nowy `now`; bez re-skanu — zmiany
DOM łapie observer). `applyHighlight` woła `boundary?.reschedule()` na końcu, więc każdy
re-paint (scan/refresh, bid, import, fire granicy) re-armuje z aktualnego stanu.
≈1440 polli/dobę → kilka timeoutów/dobę.

## 8. Carve-out — `attackAlarm` zostaje nietknięty

Feature bezpieczeństwa: detekcja ataku **musi** działać w tle, a blink tytułu w pasku
kart jest wtedy pożądany. Detekcja i tak jest głównie observer-driven; 25 s poll to
fallback. Nie ryzykujemy dla marginalnego zysku. (Ewentualnie później: sam blink na
zegarze z `whileHidden:true` — poza tym cyklem.)

## 9. Ryzyka i mitygacje

- **R1 — strażniki nie re-aplikują dekoracji, gdy karta ukryta.** Nieszkodliwe: user
  nie widzi, a `MutationObserver` (nie-pauzowany) i tak łapie mutacje, gdy karta jest
  widoczna; clock robi snap na powrocie. ✅
- **R2 — reminders: zgubiony storage-event w tle.** `render`/`refreshSnapshot` to
  wyłącznie UI (zweryfikowane: `stamp()` + odczyt mirror); push żyje w `sync/`, na
  storage-evencie (`onMirror`, linia 553), nie na tym pollu. Snap na powrocie. ✅
- **R3 — badges: OGame omija scoped observery.** Poprawność dla widocznej karty
  zachowana (observer + snap). Zostawiamy `everyMs:3000`. ✅
- **R4 — narracja perf.** Patrz §3: nie przeceniamy CPU; główne wygrane to dług +
  determinizm + UX.
- **R5 — testy.** `lib/clock.js` dostaje testy jednostkowe; testy featurów oparte na
  `setInterval` mogą wymagać przepięcia na fake-timery/sterowanie zegarem. Zgodnie z
  CLAUDE.md — reconcyliacja przy release, nie w pętli build-and-verify.

## 10. Plan testów (release-time)

- `clock`: kadencja na siatce BASE_MS; leniwy start/stop (0↔≥1 sub); pauza przy
  `hidden`, brak wybudzeń bez `whileHidden`; snap + wznowienie na powrocie;
  idempotencja `unsubscribe`; `whileHidden:true` tyka w tle. Przez `createClock(fakes)`.
- `scheduleAt` (jeśli Etap 2): pojedynczy timeout do `min` granicy; reschedule po fire;
  `getNextWakeTs===null` → uśpienie.
- Featury: przepiąć asercje czasowe na zegar/fake-timery.

## 11. Otwarte decyzje (dla Ciebie)

1. **Zakres:** ROZSTRZYGNIĘTE — Etap 1 + Etap 2; `attackAlarm` pozostaje carve-out.
2. **Kadencja strażników:** ROZSTRZYGNIĘTE — wszystkie 5 strażników na 5 s.
3. **API:** ROZSTRZYGNIĘTE — `clock.subscribe(cb, {everyMs, whileHidden})` +
   `clock.scheduleAt(getNextWakeTs, cb)`, singleton, `lib/clock.js`.

## 12. Kolejność prac / definicja ukończenia

1. `lib/clock.js` + (Etap 2) `scheduleAt`.
2. Migracja 8 sitów (§6), zamiana dispose.
3. `npm run typecheck` + `npm run lint` = 0 (gate per-commit).
4. Build + manualna weryfikacja przez użytkownika (odliczania, podświetlenia, badge'y
   działają; po powrocie z tła snap natychmiastowy).
5. Testy + zielony suite — przy release (§10).
6. Skasować ten dokument po wdrożeniu.
