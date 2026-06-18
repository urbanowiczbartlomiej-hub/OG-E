# AUDIT.md — analiza długu technicznego

> **Dokument tymczasowy** (lifecycle wg `CLAUDE.md`: kasujemy po zamknięciu
> cyklu realizacji — git zachowa historię). To raport ustaleń z fazy
> *analizy*; nie zmieniono ani jednej linii kodu produkcyjnego przy jego
> tworzeniu. Stan: **2026-06-18**, baseline `v1.25.1`.

---

## Status realizacji

- **2026-06-18 — R1 + R2 + R3 + R4 + R6 — ZROBIONE i zweryfikowane**
  (build + lint + typecheck + **1631 testów** zielone):
  - **R1 config/DevOps:** D1 `globals` zadeklarowane; D2 Node ujednolicone na
    **22** (`engines` / `.nvmrc` / `REVIEWERS`); D3 `cross-env` usunięte (rollup
    `--environment`); D4 skrypt `package:source` usunięty.
  - **R1/R2 martwy kod:** obie bramki `when*Hydrated` + cała maszyneria hydracji
    (`hydratedPromise`/`resolveHydrated`/`onHydrate` + reset w dispose),
    `flushPlayersStore`, `_refreshForTest`.
  - **R3 martwy plik:** `domain/freeStreak.js` + test usunięte (−408 LOC).
  - **R4 konsolidacja:** `merge.js` (`mergeNewestConfigSlot`), `scheduler.js`
    (`mergeSyncSettings`), `reminders.js` (`buildReminderCard` + `appendFiresAtLine`).
  - **R6 DevOps:** klient AMO wydzielony do `scripts/amo.mjs` (D5; `release.mjs`
    −115 linii), wspólny zip do `scripts/zip.mjs` (D7).
  - **R2 redukcja powierzchni:** knip **41 → 7** nieużywanych eksportów. ~21
    de-eksportów (symbole używane tylko wewnętrznie) + usunięcie martwych
    (`POS_KEY`/`DRAG_THRESHOLD`/`DEFAULT_EDGE_OFFSET_PX` — pozostałości po
    zunifikowanym FAB, `maxLfScannedAt`, `paint`, re-eksporty
    `REWARDING_DONE_KEY`/`ARTIFACT_SHOP_DONE_KEY`/`derive,render`). Pozostałe 7
    eksportów świadomie zostawione (`TARGET_DEBRIS` + `CHECK_TARGET_TIMEOUT_MS`
    udokumentowane; `disposePlayersStore` + 4× `_reset*ForTest` = kontrakt/konwencja).
  - **Docs:** K1–K7 (dryf usuniętego UI, DRY komend, brama `lint`, kadencja
    testów, wiring builda, `.env.example`).
- **Pozostaje:** **R5 (`send*` reuse — wymaga weryfikacji w grze)**, reconcile
  testów na release. Uwaga: żywy upload HTTP do AMO (D5) testowalny dopiero przy
  realnym release — moduł ładuje się i jest wiernym wydzieleniem.

---

## 0. Werdykt

Repo jest **w nieprzeciętnie dobrym stanie**. Warstwy (`domain → state →
features/sync`, `bridges`, `lib`) są realnie egzekwowane przez ESLint, nie tylko
opisane. Mechanicznie potwierdzone: **0 cykli importów**, **1,5 % duplikacji**,
uprawnienia w manifeście zgodne z całą dokumentacją, baseline w pełni zielony
(build + lint + typecheck + 1645 testów).

To nie jest ratunek, tylko **dostrajanie**. Realny dług jest skupiony w czterech
miejscach, wszystkie o niskim ryzyku:
1. jeden **martwy plik** (+ jego test) — 408 LOC,
2. **~30 nadmiarowych eksportów** (powierzchnia API ponad potrzebę),
3. **rodzina `send*`** — jedyna istotna duplikacja strukturalna (FAB/courier),
4. **dryf dokumentacji** — README/CONTRIBUTING opisują UI usunięte 6 wydań temu.

Plus garść drobnych poprawek konfiguracji/DevOps (jeden z nich to realny
latentny błąd: niezadeklarowana zależność `globals`).

---

## 1. Linia bazowa (zmierzona)

| Metryka | Wartość |
|---|---|
| Kod `src/` | 36 877 LOC / 133 pliki |
| Testy `test/` | 25 979 LOC / 106 plików (ratio 0,70 — zdrowo) |
| Bundle prod (minified) | content **174 KB**, dashboard **82 KB**, page **17 KB** (Σ 274 KB) |
| Entry points | `content.js` (isolated), `page.js` (MAIN), `dashboard.js` |
| build / lint / typecheck | **0** (wszystko zielone) |
| testy | **1645 passed / 105 plików** |
| cykle importów (madge) | **0** |
| duplikacja (jscpd) | **1,51 %** (566 / 36 975 linii), 24 klony |

---

## 2. Wyniki mechaniczne

**madge** — `0` cykli. Sieroty (pliki nieimportowane przez nic): tylko 3 entry
pointy (oczekiwane) **+ `domain/freeStreak.js`** → patrz **C1**.

**jscpd** — 1,51 % to bardzo nisko. Klony skupione w: rodzinie `send*`
(cross-feature), `dashboard/reminders.js` (wewnątrz pliku), `sync/merge.js`,
`sync/scheduler.js`. Szczegóły w **C3**.

**knip** — 1 niezadeklarowana zależność (`globals`, → **D1**) + 41 nieużywanych
eksportów. Po włączeniu testów do grafu lista zawęża się do eksportów
nieużywanych **nigdzie** (ani w `src/`, ani w `test/`). Klasyfikacja → **C2**.

---

## 3. Ustalenia — kod

### C1 — Martwy plik: `domain/freeStreak.js` (+ jego test)  · ⭐ wysoki priorytet
- **Dowód:** madge raportuje `domain/freeStreak.js` jako sierotę; grep
  potwierdza — `regions.js:1` opisuje się jako *„the generalisation of
  `domain/freeStreak.js`"*, a wszystkie pozostałe odwołania to **komentarze**.
  `dashboard/index.js:51` importuje `./freeStreak.js` (wersję *feature*, nie
  domain). Eksportów `domain/freeStreak.js` nie zgłasza knip-z-testami, bo
  trzyma je przy życiu **wyłącznie** `test/domain/freeStreak.test.js`.
- **Skala:** 185 LOC (`src`) + 223 LOC (test) = **408 LOC** martwych na ścieżce
  produkcyjnej.
- **Rekomendacja:** usunąć plik i jego test — **po** potwierdzeniu, że
  `regions.js` w pełni pokrywa zachowanie (że test domeny nie sprawdza
  unikalnej własności, której `regions.test.js` nie ma). Ryzyko: **low**.
  Pewność: **high**.

### C2 — Nadmiarowa powierzchnia: 41 nieużywanych eksportów (knip)
Nie wszystkie są „martwe" — wymagają klasyfikacji. Trzy kubełki:

**(a) ZACHOWAĆ — intencjonalna, udokumentowana powierzchnia.**
`disposePlayersStore` jest nieużywane przez żaden test, ale `CLAUDE.md` wymaga,
by *każdy* store eksponował `dispose*Store()`. Inne `dispose*Store` są realnie
wołane przez testy (`disposeBodiesStore`, `disposeScansStore` — potwierdzone) →
to jednolity kontrakt teardownu, **nie** ruszać. (Sygnał poboczny: store
`players` nie ma testu resetującego — luka pokrycia, nie martwy kod.)

**(b) DO USUNIĘCIA/DE-EKSPORTU — ponad kontrakt lub realnie zbędne.** ~30 pozycji:
- **`flush*Store`** (`flushPlayersStore`, `flushGalaxyScanConfigStore`,
  `flushReminderConfigStore`) — `CLAUDE.md` mówi, że teardown to „`dispose*Store`
  … **i nic więcej**". `flush*Store` wykracza poza kontrakt i jest nieużywane →
  kandydat do usunięcia (zweryfikować, że nie ma go w realnym flow sync).
- **Bramki hydracji** `whenGalaxyScanConfigHydrated`, `whenReminderConfigHydrated`
  — 0 odwołań, dodane przez symetrię, nigdy niewpięte. Usunąć (+ `hydratedPromise`
  jeśli osieroci się). Pewność: **high**.
- **Stałe/klucze eksportowane „na zapas"** (tylko de-eksport — zerowe ryzyko):
  `TARGET_DEBRIS`, `abandonedCleanupDeadline`, `ARTIFACT_SHOP_DONE_KEY`,
  `REWARDING_DONE_KEY`, `LF_ARTIFACTS_KEY`, `OWN_PROFILE_KEY_BASE`,
  `PLAYERS_KEY_BASE`, `SYNC_REQUEST_KEY_BASE`, `RESET_GALAXY_KEY_BASE`,
  `SCHEMA_VERSION`, `DEFAULT_BACKOFF_MS`, `NTFY_MIN_DELAY_SEC`, `POS_KEY`,
  `DRAG_THRESHOLD`, `DEFAULT_EDGE_OFFSET_PX`, `CHECK_TARGET_TIMEOUT_MS`,
  `INPUT_ID_PREFIX`, `DISCOVER_BTN_ID`, `FAB_POS_KEY`, `expansionFactor`,
  `ONE_WAY_MISSIONS`, `maxLfScannedAt`, `countScansRemaining`, `parseCoordsText`.
- **Funkcje do sprawdzenia (eksport zbędny lub funkcja martwa):** `paint`
  (`sendColony/index.js:252`), `derive`/`render` (re-eksport
  `sendLifeform/index.js:67`), `ensureOrbitDefs` (`buttonChrome.js:518`, wołane
  z 1 miejsca w tym samym pliku → tylko de-eksport), `reconcileQueue`
  (`ntfyReconciler.js:495` — cała funkcja nieużywana?), `readReminderState`/
  `writeReminderState` (`sync/reminders.js:309,343`).

**(c) KONWENCJA vs luka — `_reset*ForTest` / `_refreshForTest`.**
Nieużywane: `_refreshForTest` (`dailyRun/index.js:841`), `_resetDashboardForTest`,
`_resetFleetdispatchShortcutForTest`, `_resetRemindersForTest`,
`_resetReminderProducerForTest`. `CLAUDE.md` mówi, że każdy feature *„ships a
`_reset*ForTest()` for the suite"* — więc nie są „martwe", tylko **nieużyte przez
żaden test**. Decyzja per-pozycja: albo dopisać test, który je woła (pokrycie),
albo zdjąć helper (jeśli feature świadomie nie ma testu resetu). `_refreshForTest`
to najpewniejszy do usunięcia (agent potwierdził: jedyny test dailyRun importuje
tylko `installDailyRun` + `_resetDailyRunForTest`).

- **Ryzyko całości C2:** low (de-eksport/usunięcie nieużywanego nie zmienia
  zachowania). **Efekt:** istotne zmniejszenie powierzchni publicznej API.

### C3 — Duplikacja strukturalna: rodzina `send*`  · ⭐ największa szansa reuse
- **Dowód (jscpd):** klony cross-feature `sendColony/index.js`↔`sendExpedition/
  index.js` (`966-1004` vs `543-580`, 39 linii; `1010-1023` vs `587-603`),
  `sendColony/index.js`↔`sendLifeform/index.js` (`999-1032` vs `460-491`, 34
  linie), `sendColony/index.js`↔`sendLifeform/domHelpers.js` (`625-644` vs
  `86-105`). Wzorce orkiestracji FAB/courier (montaż, drag, obsługa wyniku) są
  współdzielone między trzema feature'ami.
- **Ograniczenie:** „żaden feature nie importuje innego feature'a" → konsolidacja
  **musi** iść przez `features/shared/` (rodzina `button*`/`unifiedFab*` już tam
  jest — to naturalny dom dla wspólnego orchestratora send-flow).
- **Rekomendacja:** wydzielić wspólny helper send-flow do `features/shared/`.
  Skala: ~100–150 LOC. Ryzyko: **med** (dotyka najbardziej krytycznych dla
  użytkownika ścieżek — wymaga ręcznej weryfikacji w grze). Efekt: duży, bo to
  serce produktu. **Najpierw zweryfikować, że klony są naprawdę izomorficzne.**

### C4 — Klony wewnątrz plików (łatwe, lokalne)
- `dashboard/reminders.js` — `renderWavesInto`/`renderAdhocInto`/
  `renderFleetSavesInto` (`744-780` vs `841-866`, 37 linii) i `cancel*` (`711-721`
  vs `801-811`). Konsolidacja w obrębie pliku. Ryzyko: **low**.
- `sync/merge.js` (`406-441` vs `441-478`, 36 linii) — powtórzony merge per
  kolekcja. Ryzyko: **low-med**.
- `sync/scheduler.js` (`529-544` vs `655-671`) — symetria download/upload slot.
  Ryzyko: **low**.

### C5 — `parseCurrentGalaxyView` (duplikat sankcjonowany)  · NEEDS_HUMAN
Bajt-w-bajt kopia w `sendColony/domHelpers.js:125-165` i
`sendLifeform/domHelpers.js:42-75` (41 linii). Jest **świadomą** decyzją
udokumentowaną w `sendLifeform/domHelpers.js:8-13` (reguła „kontraktem są
selektory, nie funkcje"; selektory już w `gameDom.js`). Technicznie hoistable do
`lib/gameDom.js` (~18 LOC), ale właściciel ma pisemną decyzję, by ją tolerować.
**Nie ruszać bez Twojej zgody.**

### C6 — Drobne centralizacje
- `'.originFleet'` inline w `badges.js:190`, gdy plik już ciągnie inne selektory
  z `gameDom.js` → dodać `ORIGIN_FLEET` (jeśli używane też przez inny feature;
  inaczej zostaje lokalnie wg reguły). Ryzyko: low. Pewność: med.
- Wzorzec „planet-list wrap-walk" (`sendExpedition/domHelpers.js:96-119`,
  `dailyRun/domHelpers.js:155-177`) — możliwy wspólny `findNextPlanetInList(pred)`
  w `features/shared/`. **Zweryfikować izomorfizm ciał przed konsolidacją.**

### Pliki >800 LOC — werdykt: architektonicznie OK
`scheduler.js` (1118), `sendColony/index.js` (1095), `dashboard/index.js` (903),
`settingsUi/controls.js` (872), `dailyRun/index.js` (841) — duże z powodu
nieusuwalnej orkiestracji I/O/DOM; każdy, który potrzebował pure-core, już go ma
(`pure.js`). **Jedyny łagodny kandydat:** `dashboard/reminders.js` (953) ma 2-3
czyste helpery (`collectOurMessageIds`, `isFleetSaveTooFarOut`, `coerceMirror`)
zaszyte w pliku DOM-owym → opcjonalny `reminders.pure.js`. Niski priorytet.

---

## 4. Ustalenia — konfiguracja i DevOps

| # | Obszar | Lokalizacja | Typ | Rekomendacja | Ryzyko |
|---|---|---|---|---|---|
| **D1** ⭐ | dep | `eslint.config.mjs:19` + `package.json` | latentny błąd | `globals` jest importowany, ale **niezadeklarowany** w devDeps (działa tylko jako tranzytywny). Dodać `"globals"` do devDependencies. Potwierdzone przez knip i agenta. **1 linia.** | low (realny) |
| **D2** | Node | `.nvmrc`(22) vs `engines`(>=20) | niespójność | Wyrównać `engines` do `>=22` (lub udokumentować różnicę). 1 linia. | low |
| **D3** | build | `package.json:13` | uprość | `build:prod` używa `cross-env` dla jednej zmiennej → zastąpić `rollup --environment NODE_ENV:production` i usunąć devDep `cross-env`. | low |
| **D4** | scripts | `package.json:21` | zbędny | `package:source` jako osobny skrypt nie ma konsumenta (jest wołany wprost wewnątrz `package`). Usunąć lub świadomie zostawić jako escape-hatch. | low |
| **D5** | release | `scripts/release.mjs` (351 LOC, ~7 odpowiedzialności) | przeinżynierowanie | Wydzielić klienta AMO (JWT+upload+poll, linie ~219-307) do `scripts/amo.mjs` — to najgęstszy fragment i najczystszy szew. Zostawia orchestratorowi jego właściwą rolę. | med |
| **D6** | release dual-mode | `release.mjs` + `release.yml` | osąd | Auto-detekcja „jedna komenda, dwie ścieżki" to **zarobiona** złożoność (pozwala maszynie bez creds ciąć tagi dla CI). **Nie rozcinać** bez przeglądu — uproszczenie mogłoby zduplikować logikę do workflow. Zostawić, ale to główne obciążenie poznawcze. | — |
| **D7** | scripts | `package.mjs` + `package-source.mjs` | drobny dedup | wspólna gałąź win32/POSIX tar (~4 linie) → `scripts/zip.mjs`. Opcjonalne. | low |

**Czyste (nie ruszać):** `tsconfig`, `vitest.config` (wzorcowo minimalny),
`rollup.config`, `eslint.config` (strefy importów = load-bearing, nie ceremonia),
`manifest`, `.gitignore`, `.gitattributes`, `.env.example`. 9 devDeps — wszystkie
używane (poza odwrotnym problemem D1). 4 skrypty build (`clean`/`copy-static`/
`package`/`package-source`) **zarabiają na siebie** — kodują wiedzę o walidatorze
AMO (forward-slash w zipie), plugin by ją zgubił.

**Test 5 minut (DevOps):** zdaje, z jednym wyjątkiem — `release.mjs` to jedyny
plik, który wymaga wysiłku, by go ogarnąć (stąd D5).

---

## 5. Ustalenia — dokumentacja

| # | Obszar | Lokalizacja | Typ | Rekomendacja | Ryzyko |
|---|---|---|---|---|---|
| **K1** ⭐ | drift | `README.md:53-56` | dryf | Opisuje 2 osobne, **usunięte** funkcje (banner „fresh planet" + overlay abandon) jako żywe. Zlikwidowane w 1.20.0 — `abandon/colonyFab.js:3-4` mówi wprost „folds the OLD … into ONE button". Zwinąć do opisu jednego przycisku Abandon na FAB. ~4 linie. | wysoki dla zaufania/onboardingu |
| **K2** | stale | `CONTRIBUTING.md:98-104` | stale | Ten sam usunięty UI w checklliście „test-in-game" + osobne FAB-y Send Exp/Col (zunifikowane w 1.19.0). Przepisać pod aktualny model jednego FAB z orbami. | med |
| **K3** | DRY | `README.md:134-139` + `CONTRIBUTING.md:81-86` + `REVIEWERS.md:15-18` | dry-violation | Blok komend `npm install/dev/test/typecheck` powtórzony 3×. Kanon = `REVIEWERS.md`, reszta linkuje (reguła, którą repo samo egzekwuje). | low |
| **K4** | onboarding | `CONTRIBUTING.md:§3` | luka | §3 wymienia tylko `typecheck` jako bramkę pre-commit, pomija **`lint`** — a to lint egzekwuje warstwy. Dopisać `lint`. | med |
| **K5** | tension | `CONTRIBUTING.md:§4` vs `CLAUDE.md` | dryf | Filozofia testów opisana dwiema niespójnymi narracjami (ciągłe pokrycie vs reconcile-at-release). Dodać 1 zdanie o kadencji release-time (lub link). | med |
| **K6** | onboarding | `README` arch-map | luka | Mapa „Architecture in five minutes" jest dobra i aktualna, ale opisuje runtime data-flow, **nie** wiring builda. Dopisać 1 linię: „te 3 pliki to entry pointy rollup; `content.js` woła `install*()` każdego feature'a". | low |
| **K7** | stale | `.env.example` | trivial | Przykład używa `--env-file=` + wersji rok wstecz; kanon to `npm run release <ver>`. | trivial |

**Czyste:** uprawnienia/hosty — **zgodne w 100 %** między `manifest`, `PRIVACY`,
`REVIEWERS`, `amo-reviewer-notes`, `README` (luka ntfy z pamięci projektu —
zamknięta). Brak porzuconych plików-planów. Podział `CHANGELOG` /
`docs/CHANGELOG-archive.md` — **zostawić** (release czyta tylko bieżącą sekcję;
podział bezpieczny i opisany).

**Najwyższa wartość dla onboardingu:** K1 — nowy człowiek czyta README z góry i
trafia na 2 pewnie opisane funkcje, których kod nie ma od 6 wydań → traci
zaufanie do reszty, łącznie z (poprawną) mapą architektury tuż poniżej.

---

## 6. Co jest czyste / NIE ruszać (intencjonalne wzorce)

Spis, by realizacja nie „naprawiła" inwariantów:
- **9 par `domain/state` o tej samej nazwie** — wszystkie to czysty podział
  (pure logic vs persisted store), zero duplikacji. Potwierdzone per-para.
- **`disposePlayersStore`** i spółka — kontrakt teardownu z `CLAUDE.md`.
- **`autoRedirectExpedition`** czytany z `localStorage` w `bridges/` zamiast ze
  `state/` — sankcjonowany wzorzec (bridge w MAIN-world nie może importować `state`).
- **`parseCurrentGalaxyView`** (C5) — udokumentowany świadomy duplikat.
- **Selektory single-feature** trzymane lokalnie — zgodne z regułą `gameDom.js`.
- **Rodzina `features/shared/button*`** — kompozycja warstwowa, nie nakładanie się.
- **Duże pliki** — orkiestracja I/O/DOM, nie uwięziona logika.

---

## 7. Scorecard

| Wymiar | Teraz | Po realizacji (szac.) |
|---|---|---|
| Martwy kod (LOC) | 408 (freeStreak) + rozproszone | ~0 |
| Nieużywane eksporty | 41 | ~10 (tylko intencjonalna powierzchnia) |
| Duplikacja (jscpd) | 1,51 % | ~0,8 % (po konsolidacji `send*` + intra-file) |
| Poprawki config/DevOps | 7 (1 latentny błąd) | 0 |
| Dryf/DRY w docs | 7 | 0 |
| Cykle / naruszenia warstw | 0 / 0 | 0 / 0 (utrzymać) |

---

## 8. Proponowane fazowanie realizacji (do osobnego planu)

Kolejność: najpierw zero-ryzykowne i wysokowartościowe, krytyczne ścieżki na końcu.

- **R1 — Sprzątanie zerowego ryzyka:** D1 (globals), D2, D4, K1, K3, K4, K6, K7;
  usunięcie bramek hydracji i `_refreshForTest`. (Build + lint + typecheck jako
  bramka; testy zielone — bo to tylko usunięcia/de-eksporty.)
- **R2 — Redukcja powierzchni:** de-eksport stałych z C2(b), decyzja per
  `_reset*ForTest` (C2c), `flush*Store`. Weryfikacja `reconcileQueue`/`readReminderState`.
- **R3 — Martwy plik:** C1 (`domain/freeStreak.js` + test) — po potwierdzeniu
  pokrycia przez `regions.js`.
- **R4 — Konsolidacja lokalna:** C4 (reminders/merge/scheduler), C6, opcjonalnie
  `reminders.pure.js`.
- **R5 — Reuse `send*` (większy):** C3 — wspólny orchestrator w `features/shared/`.
  Wymaga weryfikacji w grze (build-first). Osobno, ostrożnie.
- **R6 — DevOps refactor (opcjonalny):** D3 (cross-env→rollup env), D5
  (wydzielić `scripts/amo.mjs`), D7. D6 — tylko przegląd, prawdopodobnie zostaje.
- **R7 — Docs domknięcie:** K2, K5 + ewentualne dociągnięcia po zmianach kodu.
- **Release:** reconcile testów (m.in. dla freeStreak i zmian send*), `npm run
  release` wg `CLAUDE.md`.

> Uwaga metodyczna: cała realizacja wg workflow repo — **build-first + ręczna
> weryfikacja w grze**, testy pojednane raz, na release. Każda faza powinna
> kończyć się zielonym `build`+`lint`+`typecheck`.
