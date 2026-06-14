# NAMING-REFACTOR — wyrównanie nazw kodu do funkcji biznesowych

> **Status:** plan do decyzji. Dokument *efemeryczny* (zgodnie z CLAUDE.md
> § Documentation hygiene — plan docs mają cykl życia; usunąć po zamknięciu).
> **Cel:** zbliżyć nazwy plików / katalogów / funkcji / zmiennych do języka,
> którym posługuje się UI (etykiety widziane przez użytkownika), bez psucia
> trwałego stanu i synchronizacji.

---

## 1. Rekomendacja (TL;DR)

To **NIE jest jeden prosty rename na jedną sesję** — ale i **nie jest** w całości
ryzykowne. Rozbieżności dzielą się na dwie zupełnie różne kategorie ryzyka,
i to rozdzielenie jest osią całego planu:

| Kategoria | Co to | Ryzyko | Migracja? |
|---|---|---|---|
| **A — identyfikatory wewnętrzne** | nazwy plików, katalogów, funkcji, zmiennych, pól typu `Settings` (JS) | **niskie** | **nie** |
| **B — stringi trwałe** | klucze localStorage / chrome.storage, nazwy pól w payloadzie gist, stringi `oge:*` zdarzeń | **wysokie** | **tak (+ bump schematu)** |

**Dźwignia, która to umożliwia:** w OG-E nazwa *identyfikatora JS* jest już
**oddzielona** od *stringa trwałego*. W `state/settings.js` schemat ma osobne
pole `key` (np. `reminderSchedule` → klucz LS `oge_reminderWaveOffsets`,
`fsOffsets` → `oge_fsReminderOffsets`). Czyli **można przemianować pole JS
zostawiając string klucza nietknięty → zero migracji.** To samo dotyczy nazw
zmiennych odnoszących się do kluczy w `lib/storageKeys.js` oraz nazw stałych
zdarzeń w `lib/ogeEvents.js` (stała JS ≠ string `oge:*` na drucie).

**Moja propozycja podziału:**

- **Faza 1 (Kategoria A, internal-only)** — jedna sesja, niskie ryzyko, największy
  zysk czytelności. Mechaniczny rename + aktualizacja importów i testów.
- **Faza 2 („Daily Run" / disambiguacja `fs`)** — osobna sesja, średnie ryzyko.
  Dotyka katalogu feature, store'a i DSL, ale stringi LS/gist da się **zamrozić**.
- **Faza 3 (Kategoria B, stringi trwałe)** — osobna sesja (lub **świadomie
  pominąć**). Wymaga kodu migracji i bumpa schematu. Najmniejszy zysk dla
  użytkownika (te stringi są niewidoczne), największy koszt/ryzyko.

> **Sugestia:** zrób Fazę 1 i 2. Fazę 3 odłóż lub pomiń — przemianowanie
> niewidocznych stringów trwałych kupuje tylko wewnętrzną spójność kosztem
> realnego ryzyka migracji. Jeśli i tak chcesz B, rób ją per-klucz, nigdy hurtem.

---

## 1a. Dziennik postępu (aktualizowany co sesję)

**Sesja 1 — Faza 1 (częściowa) — ZROBIONE:**
- ✅ **poz. 5** `blackBg.js` → `antiFlickerBackground.js` (+ `installBlackBackground`
  → `installAntiFlickerBackground`, `STYLE_ID` `oge-black-bg` → `oge-anti-flicker-bg`).
- ✅ **poz. 4** `reminders/fsScan.js` → `fleetSaveScan.js` (`fsLabelFor` →
  `fleetSaveLabelFor`); `reminders/fsCancel.js` → `fleetSaveCancel.js` (eksporty
  `*FsCancel*`/`fsCancelOffsets` → `*FleetSaveCancel*`/`fleetSaveCancelOffsets`).
  Klucz LS `oge_fsCancel_` **zamrożony** (komentarz „historyczny" w pliku).
- Bramki zielone: typecheck + lint + 1443 testy. Bez zmian zachowania.

**Korekty planu wykryte podczas Sesji 1 (ważne dla kolejnych sesji):**
- ⚠️ **poz. 11/12 PRZENIESIONE do Fazy 3 (Kategoria B).** Założenie planu, że
  pole `Settings` jest odłączone od trwałego stringa, jest prawdziwe **tylko**
  dla klucza LS (`SETTINGS_SCHEMA.key`). `sync/settingsSync.js` używa
  **nazwy pola jako klucza na drucie gista** (`UNIVERSE_SCOPED_SETTINGS` =
  `Set(['colMinGap','colPassword',…])`; `pickSyncedValues` iteruje
  `Object.keys(settings)`; mapy ts są kluczowane nazwą pola). Rename pola
  synchronizowanego = breaking change cross-device → wymaga shimu pole↔wire
  lub migracji. Dotyczy wszystkich pól poza `EXCLUDED_SETTINGS`.
- ⏭️ **poz. 6 `freeStreak` POMINIĘTE — już zgodne z UI.** Dashboard używa słowa
  „streak" wprost (`perfect streak`, `Longest streak`, sekcja „Colony Scout —
  settlement area analysis`), a domenowa funkcja to już `findLongestStreaks`.
  Rename oddaliłby kod od języka UI.
- ⏭️ **poz. 7 `rewardingWatcher` POMINIĘTE — żargon gry trzymany dosłownie.**
  Śledzi własną stronę OGame „rewarding"; brak etykiety UI w OG-E do wyrównania.
  Per CLAUDE.md (carve-out) wiedza o grze zostaje verbatim. Klucz
  `REWARDING_DONE_KEY='oge-rewarding-done-day'` i tak jest trwały.

**Pozostało w Fazie 1:** nic bezpiecznego (Kat. A) ponad powyższe.

**Sesja 2 — Faza 2 (disambiguacja „Daily Run" / `fs`) — ZROBIONE:**
- ✅ **poz. 1** `features/fsCollect/` → `features/dailyRun/` (`index.js`,
  `domHelpers.js`, `pure.js`); `installFsCollect` → `installDailyRun`,
  `_resetFsCollectForTest` → `_resetDailyRunForTest`, `fsCollectMode` →
  `dailyRunMode`.
- ✅ **poz. 2** `domain/fsRoutes.js` → `domain/dailyRunRoutes.js`,
  `state/fsRoutes.js` → `state/dailyRunRoutes.js`. Symbole JS przemianowane:
  `fsRoutesStore`→`dailyRunRoutesStore`, `initFsRoutesStore`→
  `initDailyRunRoutesStore`, `migrateFsRoutes`→`migrateDailyRunRoutes`,
  `mergeFsRoutes`→`mergeDailyRunRoutes`, `FsRoutes` (typedef)→`DailyRunRoutes`,
  `FsRoutesSlot`→`DailyRunRoutesSlot`, oraz wszystkie pochodne
  (`fsRoutesKeyFor`, `fsRoutesTsKeyFor`, `flushFsRoutesStore`,
  `disposeFsRoutesStore`, `stampFsRoutesChanged`, `whenFsRoutesHydrated`,
  `currentFsRoutesKey`, `FS_ROUTES_KEY_BASE`, `FS_ROUTES_TS_BASE`).
- ✅ **poz. 3** `domain/fleetSave.js` — **zostawione** (zgodne z UI
  „Fleet-save reminders", to inny feature niż „Daily Run").
- ✅ `FS_REDIRECT_KEY` → `DAILY_RUN_REDIRECT_KEY` w `lib/storageKeys.js`
  (MAIN-world bridge `deployRedirect.js` importuje stałą — działa, bo string
  zamrożony).
- 🔒 **Stringi trwałe ZAMROŻONE** (wartości literalne nietknięte, komentarz
  „historical name — do not change without migration"): `oge_fsRoutes`,
  `oge_fsRoutesTs`, `oge_fsRedirect`, `<universeId>:oge_fsRoutes`. Zero migracji.
- Bramki zielone: typecheck + lint + 1443 testy. Bez zmian zachowania.

**Status:** Fazy 1 i 2 zamknięte. Pozostaje tylko **Faza 3** (Kat. B, stringi
trwałe) — rekomendacja CLAUDE.md/§1: **pominąć** (zerowy zysk dla użytkownika,
wysokie ryzyko migracji cross-device). Ten dokument można usunąć po decyzji
o Fazie 3 (plan docs mają cykl życia — patrz CLAUDE.md § Documentation hygiene).

---

## 2. Metodyka researchu

Zestawiono **słownik biznesowy** (dokładne etykiety UI: panel ustawień, zakładki
dashboardu, etykiety przycisków, teksty przypomnień, overlay) ze **słownikiem
technicznym** (nazwy plików/katalogów/funkcji/zmiennych/kluczy). Rozbieżność =
etykieta UI mówi co innego niż identyfikator obsługujący ją w kodzie. Dla każdej
pozycji ustalono też, czy nazwa jest **trwała** (a więc ryzykowna).

Granice warstw są egzekwowane przez ESLint (`eslint.config.mjs`). **Dobra
wiadomość:** strefy cross-feature są wyliczane dynamicznie z
`fs.readdirSync('src/features')` — **zmiana nazwy katalogu feature NIE psuje
configu lint**, strefy same się przeliczą.

---

## 3. Skala zjawiska — czy mamy tego dużo?

**Umiarkowanie, ale są wyraźne ogniska.** Większość kodu jest nazwana dobrze
(`dashboard`, `reminders`, `galaxy`, `colony`, `settingsUi`, zdarzenia w
`ogeEvents.js`). Problemy skupiają się w kilku miejscach:

1. **Przeciążony skrót `fs`** — oznacza DWIE różne rzeczy biznesowe:
   - „Fleet-save reminders" (powiadomienia): `domain/fleetSave.js`,
     `reminders/fsScan.js`, `reminders/fsCancel.js`, `fsEnabled/fsThreshold/
     fsOffsets/fsMinFlightSec`. UI: **„Fleet-save reminders"** → tylko skrócone.
   - **„Daily Run"** (workflow micro-flot): `features/fsCollect/`,
     `domain/fsRoutes.js`, `state/fsRoutes.js`. UI: **„Daily Run"** → **silna
     rozbieżność** (kod mówi „fleet-save collect", użytkownik widzi „Daily Run").
2. **Skróty abbreviacyjne**: `col` (colonize), `exp` (expedition) — domenowy
   żargon; zrozumiałe, ale niespójne z pełnymi etykietami UI.
3. **Nazwy nieoczywiste / żargon wewnętrzny**: `blackBg`, `freeStreak`,
   `rewardingWatcher`, `planetBarCapture`, hooki `*Hook`.
4. **Nazwy w pełni OK (nie ruszać):** `adhoc`, `waves`, `ntfy`, `gist`, `AGR`,
   `fab`, `traderCountdown`, oraz wszystkie stałe w `ogeEvents.js`.

---

## 4. Tabela rozbieżności (kandydaci do renamingu)

Legenda kolumny **Trwałe?**: `nie` = czysto wewnętrzne (Kat. A, bez migracji);
`STRING` = nazwa jest też stringiem trwałym (Kat. B, migracja); `mieszane` =
identyfikator wewnętrzny, ale w pobliżu są klucze trwałe do zamrożenia.

| # | Teraz | Etykieta UI / znaczenie | Propozycja (do decyzji) | Trwałe? | Faza |
|---|---|---|---|---|---|
| 1 | `features/fsCollect/` (dir) | **„Daily Run"** | `features/dailyRun/` | mieszane¹ | 2 |
| 2 | `domain/fsRoutes.js`, `state/fsRoutes.js` | trasy „Daily Run" | `dailyRunRoutes.js` | mieszane¹ | 2 |
| 3 | `domain/fleetSave.js` | „Fleet-save reminders" | `fleetSave.js` (zostaw — zgodne) lub pełne `fleetSaveReminder` | nie | 2 |
| 4 | `reminders/fsScan.js`, `reminders/fsCancel.js` | skan/anulowanie fleet-save | `fleetSaveScan.js`, `fleetSaveCancel.js` | nie | 1 |
| 5 | `features/blackBg.js` | anti-flicker tła (UX) | `antiFlickerBackground.js` | nie | 1 |
| 6 | `domain/freeStreak.js`, `features/dashboard/freeStreak.js` | „Free Positions"/najdłuższe puste serie | ⏭️ **POMINIĘTE** — UI używa „streak", już zgodne | nie | — |
| 7 | `features/rewardingWatcher.js` | detekcja ukończenia zadań dziennych | ⏭️ **POMINIĘTE** — żargon gry („rewarding" page) verbatim | nie | — |
| 8 | `bridges/eventBoxHook.js` | obserwator XHR listy zdarzeń | `eventBoxObserver.js`² | nie | 1 |
| 9 | `bridges/discoveryHook.js` | obserwator XHR odkryć systemów | `systemDiscoveryObserver.js`² | nie | 1 |
| 10 | `bridges/checkTargetHook.js` | obserwator XHR walidacji celu | `checkTargetObserver.js`² | nie | 1 |
| 11 | pola `Settings`: `colMinGap`, `colMinFields`, `colPassword` | Kolonizacja | `colonyMinGap`, `colonyMinFields`, `colonyPassword` | **STRING³** | **3** |
| 12 | pola `Settings`: `expeditionBadges`, `maxExpPerPlanet` | Ekspedycje | `maxExpeditionsPerPlanet` | **STRING³** | **3** |
| 13 | `sendCol/`, `sendExp/`, `sendLifeform/` (dir) | „Colonize"/„Explore"/„Discover" | opcjonalnie `sendColony/`… (niski zysk) | nie | 1 (opc.) |
| 14 | klucze LS `oge_col*`, `oge_exp*`, `oge_fs*` | — | **NIE ruszać bez migracji** | **STRING** | 3 |
| 15 | pola gist: `galaxyScans`, `colonyHistory`, `waves`, `adhocReminders`, `fleetSaveReminders`, `notifyState` | — | **NIE ruszać bez bumpa schematu** | **STRING** | 3 |

¹ Klucz LS `oge_fsRoutes`/`<universeId>:oge_fsRoutes` i `oge_fsRedirect`
(`lib/storageKeys.js`) zostają jako stringi — przemianowujemy tylko symbole JS.
² Konwencja repo to dziś sufiks `*Hook` dla obserwatorów MAIN-world — jeśli
chcesz ją zachować jako celowy żargon architektoniczny, **pomiń poz. 8–10**
(to świadoma decyzja, nie dług). Sufiks jest spójny wewnętrznie.
³ **KOREKTA (Sesja 1):** NIE jest bezpieczne. Rozdział pole↔`key` dotyczy tylko
klucza localStorage. `sync/settingsSync.js` używa **nazwy pola jako klucza w
payloadzie gista** (`UNIVERSE_SCOPED_SETTINGS`, `pickSyncedValues`, mapy ts),
więc rename pola synchronizowanego łamie sync cross-device → Kategoria B
(shim pole↔wire lub migracja). Przeniesione do Fazy 3.

---

## 5. Plan fazowy

### Faza 0 — przygotowanie (mała, w ramach Fazy 1)
- Potwierdź baseline: `npm run test`, `npm run typecheck`, `npm run lint` zielone.
- Zdecyduj o kwestiach spornych (patrz § 6): czy ruszamy `*Hook`, `sendCol/` itd.
- Zasada nadrzędna: **żaden string trwały nie zmienia wartości w Fazach 1–2.**
  Klucze w `storageKeys.js`, `key` w `SETTINGS_SCHEMA`, stringi `oge:*` i pola
  gist pozostają literalnie identyczne.

### Faza 1 — rename czysto wewnętrzny (Kategoria A) — **1 sesja, niskie ryzyko**
Zakres pierwotny: poz. 4–12. **Zrealizowano poz. 4 + 5** (patrz §1a); poz. 6/7
pominięte (już zgodne / żargon gry); poz. 11/12 przeniesione do Fazy 3 po
odkryciu, że nazwa pola jest kluczem na drucie gista. Faza 1 zamknięta.
- Mechaniczny rename plików + aktualizacja `import`/`export` i `content.js`.
- Rename funkcji/zmiennych + ich użyć (w tym `_reset*ForTest`, nazwy `install*`).
- Rename pól `Settings` **z zamrożeniem `key`** (zero migracji LS).
- Aktualizacja testów odnoszących się do nazw (importy, nazwy describe).
- **Bramki:** `test` + `typecheck` + `lint` zielone (lint sam przeliczy strefy).
- Commit(y) `refactor:` per logiczna grupa; bez zmian zachowania.
- Rozmiar: szeroki, ale płytki (find/replace + importy). Wykonalne w jednej sesji.

### Faza 2 — disambiguacja „Daily Run" / `fs` — **ZROBIONE (Sesja 2)**
Zakres: poz. 1–3 (patrz dziennik §1a).
- `features/fsCollect/` → `features/dailyRun/`; `*Routes` → `dailyRun*Routes`.
- **Krytyczne:** w `lib/storageKeys.js`/`state/fsRoutes.js` zostaw stringi
  `oge_fsRoutes`, `oge_fsRedirect`, `<universeId>:oge_fsRoutes` **niezmienione**
  (komentarz: „nazwa historyczna, świadomie zamrożona"). Renaming dotyka tylko
  symboli JS i ścieżek importu.
- Sprawdź MAIN-world: `bridges/deployRedirect.js` czyta `FS_REDIRECT_KEY` przez
  `lib/storageKeys.js` — póki string stały, bridge działa bez zmian.
- **Bramki + behawioralne testy** I/O dashboardu i DSL tras (zgodnie z CLAUDE.md
  „Testing bar"). Sprawdzić, że trasy się ładują (round-trip przez fake storage).
- Średnie ryzyko, bo dotyka warstwy `state` + DSL współdzielony z dashboardem.

### Faza 3 — stringi trwałe (Kategoria B) — **osobna sesja / opcjonalna / POMIŃ**
Zakres: poz. 11, 12 (pola `Settings` synchronizowane przez gist), 14, 15.
- Wymaga: kod migracji w `state/migrate.js` + `state/settings.js` (wzorzec
  `migrateLegacyButtonSettings`), bump wersji schematu payloadu gist, ścieżka
  kompatybilności wstecznej przy odczycie zdalnego gista, testy fresh-install
  **oraz** upgrade.
- **Zysk dla użytkownika: zerowy** (stringi niewidoczne). **Koszt/ryzyko: wysokie**
  (cross-device, dane historyczne). Rekomendacja: **nie robić**, chyba że pojawia
  się inny powód (np. i tak planowany bump schematu).
- Jeśli mimo to — rób per-klucz, każdy z własnym testem migracji, nigdy hurtem.

---

## 6. Pytania do decyzji (przed startem)

1. **Czy ruszamy hooki `*Hook` (poz. 8–10)?** To spójna konwencja
   architektoniczna, nie dług. Domyślnie: **zostawić**.
2. **Czy ruszamy `sendCol/sendExp/sendLifeform` (poz. 13)?** Niski zysk, szeroki
   zasięg. Domyślnie: **zostawić** (skróty są domenowo czytelne).
3. **Czy w ogóle wchodzimy w Fazę 3?** Domyślnie: **nie**.
4. **Język symboli** — całość pozostaje po angielsku (jak reszta repo).

---

## 7. Zasady bezpieczeństwa renamingu (każda faza)

- Jeden rename = jeden mechaniczny krok; po każdej grupie `test`+`typecheck`+`lint`.
- **Nigdy** nie zmieniaj wartości stringa trwałego w Fazach 1–2 (tylko nazwę
  symbolu JS, który ten string trzyma).
- Każdy zamrożony historyczny string dostaje komentarz „nazwa historyczna —
  nie zmieniać bez migracji" (chroni przyszłe sesje).
- Commity wyłącznie `refactor:`, bez zmian zachowania; CHANGELOG nie wymaga
  wpisu (brak zmian user-visible) — chyba że Faza 3 (wtedy minor/major bump).
- Trzymać granice warstw (domain ← state ← features/sync; bridges → lib+domain).
