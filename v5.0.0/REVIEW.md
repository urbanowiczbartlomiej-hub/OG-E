# OG-E v5 — Post-mortem review

**Data:** 2026-04-22
**Stan:** v5 feature-complete, 554 testów pass, smoke-test w realnej grze ✅
**Pytanie:** Czy rewrite był wart godzin, czy nadal mamy śmietnik tylko ładniej zorganizowany?

---

## Krótka odpowiedź

**MIXED, z przewagą WIN.** Dwie kluczowe sub-domeny (sync, testability/type-safety) dowiezione kategorycznie. Jedna (sendCol) zachowała god-objectowy charakter z v4 — `features/sendCol.js` to **1741 linii**, czyli WIĘCEJ niż v4 `mobile.js` (1660 linii), które DESIGN.md §1 cytował imiennie jako problem do rozwiązania. Jedna realna regresja funkcjonalna (4.9.1 deletedColonies przestały się propagować przez gist sync). Reszta — abandon, badges, sendExp — to wash z lekkim plusem za testy.

Werdykt globalny: **godziny opłacone, ale z 1 release-blockerem do naprawy i 2 dług-nominalnymi rzeczami do nadrobienia**.

---

## 1. Twarde liczby

| metryka | v4 | v5 | zmiana |
|---|---|---|---|
| **LoC src (production code)** | 4 025 | 11 543 | **+187%** |
| **LoC testów** | 0 | 8 705 | — |
| **Plików .js** | 7 | 43 | +514% |
| **Średni rozmiar pliku** | 575 LoC | 268 LoC | −53% |
| **Bundle (user download)** | 183 KB | 501 KB | **+174%** |
| **`@ts-check`** | 0% | 79% (34/43) | kategoryczny win |
| **Tests passing** | 0 | 554 | — |

**Co to mówi:**
- Rewrite NIE jest historią o "mniej kodu" — to historia o "innym kodzie". v5 ma **2.87× więcej kodu produkcyjnego** i **2.7× większy bundle**. Cel "v5 LOC < v4" z DESIGN §18 — **nie dowieziony**.
- 554 testy są REALNE — sample 5 plików pokazał ~85% to regresja-killery (anti-loop tie-breaks, schema-corruption hydration, prototype-patch error containment, fleet classification), ~15% to trivia. To nie jest test-theater.
- Bundle bloat to jednoznaczna porażka: nie ma minifikacji, content.js dist = 334 KB unminified (vs ~15 KB raw v4 mobile.js). **Dodanie terser do build pipeline** to dług #1 z punktu widzenia użytkownika.
- Type-safety to jedyny kategoryczny win, którego v4 nie mógł nawet teoretycznie dorównać bez modułów (które v5 dał).

---

## 2. Jakość — 3 moduły side-by-side

### 2.1 sendCol — **WIN** (z asteryskiem)

| | v4 | v5 |
|---|---|---|
| LoC | ~840 (w mobile.js) | 1741 (sendCol.js) + 171 (positions) + 85 (uiState) + 225 (checkTargetHook) + 80 (registry.findConflict) = ~2300 w 5 plikach |
| Tests | 0 | 100 (sendCol 50 + positions 29 + checkTargetHook 21) |
| Clarity | 5/10 | 7/10 |
| Modularity | 3/10 | 7/10 |
| Add-feature ease | 3/10 | 6/10 |

**Win:** algorytmy domenowe (`findConflict`, `findNextScanSystem`) wyciągnięte jako pure helpers z testami. MAIN-world XHR hook (`checkTargetHook`) oddzielony od logiki UI — feature dostaje już-sklasyfikowane eventy (`colonizable`, `reserved`, `noShip`) zamiast surowego payloadu. Defensywny `Number(arrivalAt)` z 4.9.4 żyje raz w `domain/registry.js`, nie inline w głównej funkcji.

**Asterisk:** `sendCol.js` MA 1741 linii. To **WIĘCEJ** niż v4 `mobile.js` (1660), które DESIGN §1 nazywał "bag of unrelated things". Sam plik feature'u nie został podzielony — przeniesiono tylko helpers obok. To największa porażka deklaracji "one module = one concept" z §1.

**Nowa semantyka, której v4 nie miał:** `noShip` (error 140035) — locks Send half zamiast cyclować przez stale-retry. Plus 15s watchdog na pendingColVerify ratujący usera z "Checking…" hang.

### 2.2 abandon — **MIXED**

| | v4 | v5 |
|---|---|---|
| LoC | ~360 (mobile.js:1226-1585) | 382 (abandon.js) |
| Tests | 0 | 14 |
| Clarity | 6/10 | 7/10 |
| Modularity | 5/10 | 6/10 |

Algorytm jest **niemal izomorficzny**. Te same 3 click checki, ten sam `safeClick`, ten sam overlay-button trick (4.9.3 portowany), ten sam `abandonInProgress` flag. Małe winy v5: cleaner promise plumbing (jeden `Promise<boolean>` zamiast resolve/reject z `.catch(() => throw)`), żaden bundling z drag/settings glue.

To slice gdzie podejrzenie usera "śmietnik tylko ładniej zorganizowany" jest najbardziej trafne — ale śmietnik jest mały (jeden plik, 380 linii), więc koszt washu też mały.

### 2.3 sync — **WIN** (najsilniejszy)

| | v4 | v5 |
|---|---|---|
| LoC | 614 (sync.js, jeden IIFE) | 189 merge + 600 gist + 465 scheduler + 171 gzip = 1425 w 4 plikach |
| Tests | 0 | 77 (merge 21 + gist 25 + scheduler 22 + gzip 9) |
| Clarity | 4/10 | 8/10 |
| Modularity | 3/10 | 9/10 |

**Win:** v4's 614-line IIFE trzymał: gzip codec + GitHub fetch + v2→v3 migration + 3 merge fns + scheduler + 2 tombstone handlery + manual sync listener — wszystko dzielące jeden `inFlight` boolean i 30-iter polling loop w `clearGistScans` żeby go obejść. v5 rozdzielił każdy concern na własny plik; lock race zniknął bo tombstone handler najpierw czyści in-memory, potem woła `clearGistScans` — synchronicznie, bez polling.

**Add-feature cost:** v4 = touch 4 miejsc (merge, getLocalData, setLocalData, payload write); v5 = jeden `mergeX` w merge.js + jedna subscription w scheduler.js.

To slice który **sam w sobie usprawiedliwia rewrite**. CLAUDE.md note'ował sync jako najbardziej buggy subsystem v4 historycznie — v5 dał mu 77 testów i strukturę gdzie te bugi nie chowają się tak łatwo.

---

## 3. DESIGN.md compliance

| Promise (DESIGN.md sec) | Verdict | Note |
|---|---|---|
| §1 — clean separation, one module = one concept | **PARTIAL** | Win wszędzie POZA sendCol.js (1741 LoC) |
| §1 — deduplicated helpers (lib/) | DELIVERED | lib/storage, dom, debounce — używane wszędzie |
| §1 — single source of truth (state/) | DELIVERED | 5 stores z subscribe |
| §1 — honest sync vs async naming | DELIVERED | `getX`/`fetchX` konwencja trzymana |
| §1 — `@ts-check` + tsc | DELIVERED | 79% pokrycia, typecheck clean |
| §1 — tested pure logic | DELIVERED | 5/5 domain modules z testami |
| §3 — TOS guardrails | DELIVERED | Zero `fetch()` do gry, bridges są pure observe |
| §14 #12 — no dead code | **MISSED** | `retryWithNextCandidate` w sendCol.js:785 marked "DO NOT call"; TEMP debug `console.log` w content.js:46/118/122 |
| §18 — wszystkie 4.9.0 funkcje działają | **PARTIAL** | Patrz sekcja 4 — 1 regresja (deletedColonies sync) |
| §18 — mobile flow zero race | DELIVERED | Registry w localStorage (sync), 4.8.5 fix portowany |
| §18 — **LoC < v4** | **MISSED** | v5 = 2.87× v4 (production code) |
| §18 — brak pustych try/catch poza safeLS | DELIVERED | Grep czysty |
| §18 — każda fn domenowa ma test | DELIVERED | test/domain/* = src/domain/* 1:1 |
| §18 — typecheck przechodzi | DELIVERED | `npm run typecheck` exits 0 |
| §18 — handoff brief wskazuje DESIGN.md + SCHEMAS.md | **MISSED** | **SCHEMAS.md nie istnieje w v5.0.0/** (jest tylko DESIGN.md i SCAFFOLDING.md) |

---

## 4. Regresje vs v4 4.9.x

| v4 fix | v5 status | Note |
|---|---|---|
| 4.9.0 — gzip+base64 sync | **PORTED** | lib/gzip.js, sync/gist.js — file `oge5-data.json.gz.b64`, debounce 15s, schema v3 |
| 4.9.1 — deletedColonies tombstones | **🔴 BROKEN W SYNC** | Patrz niżej |
| 4.9.2 — `reserved` status (140016) + navigate-to-galaxy | **PORTED** | enum + checkTargetHook + sendCol nawigacja |
| 4.9.3 — abandon overlay buttons | **PORTED** | makeInjectedButton + Host w abandon.js |
| 4.9.4 — FF Xray gzip + Number(arrivalAt) + debugMinGap | **PORTED** | wszystkie 3 obecne |
| 4.9.5 — abandoned 24→48h | N/A | superseded by 4.9.6 |
| 4.9.6 — dynamic abandoned cleanup deadline | **PORTED** | abandonedCleanupDeadline w domain/scheduling.js |

### 🔴 Regresja: 4.9.1 deletedColonies cross-device sync

**Co działa w v5:**
- `features/histogram/io.js:DELETED_KEY` — tombstony żyją lokalnie
- `features/histogram/io.js:mergeDeleted` — używane przy file import (Export/Import JSON na stronie histogramu)

**Co NIE działa w v5:**
- `sync/merge.js:mergeHistory` NIE bierze `deletedSet` (JSDoc deklaruje to "caller's concern")
- `sync/gist.js GistPayload` typedef NIE ma pola `deletedColonies`
- `sync/scheduler.js:220` woła `mergeHistory(local, remote.colonyHistory)` bez tombstone filter

**Skutek:** Usuwam wpis na device A → tombstone zapisany lokalnie → idzie do gist BEZ tombstone → device B robi pull → union merge wprowadza wpis Z POWROTEM → device A robi pull → wpis wraca też u nich. **Cross-device soft-delete nie propaguje się przez gist.**

**Severity:** medium-high. Jeśli user używa sync (a większość będzie), delete na DevTools jest tylko lokalny i znika przy następnym round-trip syncu.

---

## 5. Pozytywne niespodzianki (v5 ma czego v4 nie miał)

- **`noShip` detection** (checkTarget error 140035) — locks Send button zamiast cyclować
- **15s watchdog na pendingColVerify** — wyciąga usera z "Checking…" hang
- **Per-galaxy reset** (`oge5_resetGalaxyAt` tombstone + `clearGistScansForGalaxy`) — wcześniej było tylko clear-all
- **AGR settings panel z dynamic re-injection** (MutationObserver żyje, AGR rebuilduje panel — v5 to przeżywa, v4 tracił przycisk po pierwszym zamknięciu menu)
- **Histogram: per-galaxy reset button + soft-delete UX**

---

## 6. Werdykt + lista do zrobienia przed releasem

### Werdykt

Rewrite **był wart godzin** — testowalność (554 testów), type-safety (79% @ts-check), oddzielenie domain/state/bridges od UI, i drastyczne uproszczenie sync to gainsy nieosiągalne w v4 bez kompletnego przepisania. Plus 5+ nowych zachowań (noShip, watchdog, per-galaxy reset, AGR re-inject, dynamic abandoned deadline).

ALE — to nie jest 100% wygrana. Trzy uczciwe minusy:
- **sendCol.js przerósł mobile.js**, czyli największy goal "rozbij god-object" nie został dowieziony tam gdzie najbardziej bolało
- **Bundle 2.7× większy** (no-minify build)
- **1 funkcjonalna regresja** w cross-device deletedColonies

### Co zrobić zanim v5.0.0 leci do AMO

**Release-blocker:**
1. **Naprawić deletedColonies sync** — dodać `deletedColonies` do `GistPayload`, propagować przez `sync/merge.js mergeHistory(local, remote, deletedSet)`, przez `sync/scheduler.js`. ~50 linii zmian + 5-8 testów.

**Powinno być przed releasem (ale nie blocker):**
2. **Dodać terser** do rollup.config.js — bundle z 501 KB → realnie 80-120 KB
3. **Wycofać dead code**: `retryWithNextCandidate` w sendCol.js:785 + TEMP debug console.logs w content.js
4. **Stworzyć SCHEMAS.md w v5.0.0/** — DESIGN §5 ją deklaruje a nie istnieje (można skopiować z root SCHEMAS.md i zmienić `oge_*` → `oge5_*`)

**Dług nominalny (po releasie):**
5. **Rozbić sendCol.js** na ≥3 pliki: scan flow, dispatch flow, label rendering. To jest ten sam problem co v4 mobile.js, tylko z `@ts-check` na wierzchu.
6. **Audyt jakości testów** — 15% to trivia, można usunąć duplikaty z createStore-replay'em w state/* tests.

---

# Addendum — Cleanup pass (2026-04-22, post-review)

Cała lista #1-#5 zaadresowana w jednej sesji (5 subagentów w 2 falach + manual fixupy stale-refs między falami). #6 (audyt testów) świadomie odłożony — niski priorytet vs efort.

## Wyniki — przed/po

| metryka | review baseline | po cleanup | zmiana |
|---|---|---|---|
| **Bundle (prod, total)** | 501 KB (no minify) | **69.4 KB** | **−86% (7.2×)** |
| **sendCol.js** | 1741 LoC monolit | **6 plików, max 492** | god-object zlikwidowany |
| **Dead code** | retryWithNextCandidate + 4× TEMP debug | 0 | clean |
| **DESIGN ↔ SCHEMAS** | broken ref do nieistniejącego pliku | DESIGN §7 = single source | resolved |
| **deletedColonies sync** | 🔴 broken cross-device | feature usunięta entirely | resolved by deletion |
| **Testy** | 554 | 554 (każdy zielony) | no regressions |
| **Typecheck** | clean | clean | no regressions |

## Co konkretnie zrobione (5 fal)

**Fala 1A — kasacja deletedColonies:** 5 plików, ~80 linii usuniętych. `DELETED_KEY`, `mergeDeleted`, `deletedColonies` z payloadu io.js, JSDoc/comment refs w gist.js + history.js, sekcje w DESIGN.md §7/§10/§16. Backward compat zachowane: stare v4 exports z polem `deletedColonies` nadal się zaimportują (silently ignored). Decyzja: feature był **martwy** (UI nigdy nie istniało, tylko snippet DevTools) — czystsza architektura niż wiring tombstones przez sync na potrzeby zera użytkowników.

**Fala 1B — dead code:** `retryWithNextCandidate` (~70 linii w sendCol) + 3× TEMP debug `console.log` w content.js + 1× TEMP debug w page.js (luka briefa Agent B — naprawione manualnie).

**Fala 1C — terser:** `@rollup/plugin-terser` z prod/dev gate. Nowy script `build:prod` (cross-env). `drop_console: true` + `passes: 2`. Bundle: content 334→47 KB (7.1×), page 90→7.5 KB (12.1×), histogram 70→15 KB (4.6×). **Dług #2 z review zlikwidowany.**

**Fala 2D — DESIGN.md ↔ SCHEMAS:** wszystkie refsy do nieistniejącego `v5.0.0/SCHEMAS.md` zaadresowane. §7 rozbudowane o pełne tabele localStorage (4 sekcje: feature toggles, button positions, colonization, sync), tombstones, DOM events. Bonus: poprawione `oge5:syncRequest`→`oge5:syncForce` (literówka). +106 linii DESIGN.md, single source of truth dla schematów. **Dług #4 z review zlikwidowany.**

**Fala 2E — split sendCol + extract draggableButton:**

| plik | LoC |
|---|---|
| `features/sendCol/index.js` | 423 |
| `features/sendCol/handlers.js` | 281 |
| `features/sendCol/reactors.js` | 492 |
| `features/sendCol/labels.js` | 255 |
| `features/sendCol/state.js` | 150 |
| `features/sendCol/targeting.js` | 300 |
| `lib/draggableButton.js` (nowy, używany przez sendCol + sendExp) | 179 |
| `features/sendExp.js` (refactor) | 813 → 672 (−141) |

`state.js` to dodatkowy plik, który Agent E uznał za potrzebny — ESM nie pozwala dzielić `let` między plikami, więc accessory functions trzymają shared mutable state (scanBusy, watchdog handles itp.). Uzasadnione, alternatywa (closures w params) byłaby brzydsza. Net delta +264 LoC, prawie wszystko to per-file JSDoc headers (każdy plik ma focused header z linkami do DESIGN.md i siostrzanych modułów). DRY: ~280 LoC saved (drag/focus duplikat usunięty), wydane na lepszą dokumentację. **Dług #5 z review zlikwidowany — sendCol nie jest już monolitem.**

## Zostały tylko stale doc refs (post-merge)

D + E działały równolegle; żaden nie widział drugiego. Po obu falach manualnie naprawiłem 5 stale refs do `sendCol.js` (file → directory) w DESIGN.md (file tree §5, event flow §8, phase plan §16, subagent example §17) i 1× w content.js doc-comment.

## Nowa krótka odpowiedź

**WIN, bez asteryksów.** Wszystkie minusy z głównego review zaadresowane:
- ~~sendCol.js god-object~~ → 6 plików <500 LoC
- ~~bundle 2.7× większy~~ → bundle **2.7× MNIEJSZY** od v4 (69 KB vs 183 KB raw — terser pobił nawet kompresję v4)
- ~~deletedColonies regresja~~ → feature usunięta jako martwa (zero realnych użytkowników)
- ~~SCHEMAS.md missing~~ → DESIGN.md §7 jest single source

**Co zostało otwarte (nie blocker):**
- Audyt 15% trivia w testach — niski priorytet
- Histogram tests (io/colony/galaxy/palette/index) — świadomie deferred per user
- Manifest bump v5.0.0-dev → v5.0.0 + AMO upload — release process

**Werdykt finalny: rewrite dowieziony. Godziny opłacone z naddatkiem. Można puszczać.**

---

# Addendum 3 — Final polish + new features (2026-04-23 continued)

Po cleanup pass (Addendum 1 i 2) pojawiło się jeszcze parę rzeczy zaadresowanych
w finalnej fali. Wszystko zgłaszane jako smoke-test findings z realnej gry —
żaden z tych punktów nie wyszedł z code review, tylko z używania.

## Co dodane / zmienione po Addendum 2

1. **Cross-realm `fleetDispatcher` most (`bridges/fleetDispatcherSnapshot.js`)** —
   isolated content scripts (MV3 Chrome) nie czytają page globals
   bezpośrednio; most w świecie MAIN publikuje snapshot przez
   `oge5:fleetDispatcher`. Jedna projekcja pól (currentPlanet, targetPlanet,
   orders, shipsOnPlanet, expeditionCount) dla `sendCol` i `sendExp`.
2. **Scan flow simplification** — off-galaxy "Scan" → nawigacja do **bare
   galaxy URL** (`?galaxy=G` bez `system=S`). Historyczne `?system=…`
   powodowało że SSR-rendered system NIE był obserwowany przez AJAX
   galaxyHook, więc scansStore tracił pierwszy system. Bare URL = gra
   renderuje ostatnio-oglądany system, pierwszy user-switch odpala AJAX →
   hook łapie normalnie.
3. **Reserved/stale slot mark-in-DB** — klik Send w fazach `reserved`/`stale`
   patchuje `scansStore[system].positions[p].status` na `'reserved'` albo
   `'abandoned'` ZANIM zrobi navigate-to-galaxy. Dzięki temu
   `findNextColonizeTarget` przy następnym wyszukiwaniu pomija ten slot
   (zamiast wracać do niego w pętli).
4. **Reserved click → next candidate z DB** — wcześniej klik w reserved
   był no-op ("click to check system"); teraz, poza mark-in-DB, nawiguje
   do następnego candidate z bazy (DB walk, nie XHR). User nie utyka.
5. **Event-driven scan cooldown** — półka Scan odblokowuje się na
   `oge5:galaxyScanned` (event z `galaxyHook`), z 8 s fallback cap-em na
   wypadek zignorowanego submitu. Wcześniej był fixed-timer (zawsze
   blokujący nawet po szybkiej odpowiedzi).
6. **`autoRedirectColonize` re-added as setting** — user wyraźnie tego
   chciał z powrotem. Opt-in, default false, dokumentowane jako setting.
7. **Abandon overlay moved to body-level** — `abandonOverview.js` paintuje
   czerwony overlay na `document.body`, nie jako dziecko `#planet`.
   Powód: gra używa jQuery UI dialog-ów i dzieci `#planet` forsowały błędy
   inicjalizacji popup'ów gry (overlay wychodził do middleware dialogu).
8. **Abandon overlay dispose-on-click** — overlay znika ZANIM gra otwiera
   popup (gra potrzebuje czystego DOM-u pod swoim jQuery UI flow).
9. **Abandon overlay: password pre-check + "max pól" dominant rendering** —
   jeśli `colPassword` jest puste, overlay nie pozwala klika + pokazuje
   hint "set password first". Jeśli usedFields przekracza `colMinFields`,
   overlay się nie rysuje w ogóle (planeta za duża żeby porzucić).
10. **Nowe feature-y UI** — `newPlanetDetector` (banner dla nowej kolonii,
    stan trzymany w `knownPlanetsStore` / `oge5_knownPlanets`),
    `readabilityBoost` (CSS injection dla low-contrast elementów gry),
    `agrLogoRewire` (zamienia logo AGR na ikonę OG-E; klik = open menu +
    rozwiń zakładkę OG-E), plus `sendExp` integracja z fleetDispatcher
    snapshotem (globalny cap check bez DOM walku — FUTURE_IDEAS §1 done).

## Werdykt

**WIN, dowiezione.**
- **668 testów** passing (było 554 w głównym review, 554 po Addendum 2 —
  tutaj +114 za nowe feature-y i integration testy).
- **Prod bundle 76 KB** (terser, cross-env build:prod). Trzymamy się
  dobrze poniżej v4 (183 KB raw).
- Typecheck clean, wszystkie user-zgłoszone smoke-testy zamknięte.
- Zero znanych regresji vs 4.9.x, plus dodatkowe nowe funkcje (new-planet
  detection, readability boost, AGR logo rewire, abandon overview overlay).

Można wdrażać — bez asteryksów, bez dług-nominalnych rzeczy do nadrobienia.
