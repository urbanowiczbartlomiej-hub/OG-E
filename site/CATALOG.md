# Katalog funkcji OG-E — tracker dokumentacji

Żywy dokument śledzący postęp (praca na wiele sesji). Jedna linia na
user-facing funkcję. Status:

- `todo` — jeszcze nieopisana (brak pliku w `content/`),
- `drafted` — opis napisany z kodu, czeka na weryfikację użytkownika,
- `verified` — użytkownik potwierdził zgodność z realną grą.

**Fair-play na stronie:** bez klasyfikacji 🟢/🟡/🔴 — zawsze interpretacja
pozytywna (argumenty za). Jedyny szczerze graniczny wyjątek: **budzik**
(`fairplay.borderline = true`). Wewnętrzna klasyfikacja zostaje w
`docs/fair-play.md` i nie trafia na stronę.

## Struktura (Faza 2, ustalona 2026-08-08)

Pięć rozdziałów, w tej kolejności (= kolejność sekcji na stronie i w
`_categories.mjs`):

1. **Przycisk OG-E** (`fab`) — flagowiec #1, hub akcji floty.
2. **Interfejs gry** (`game-ui`) — to, co widać wprost w grze i włącza się z
   panelu ustawień AGR (dawne `qol`, część pierwsza).
3. **Dashboard i analityka** (`dashboard`) — pełnostronicowy panel danych;
   wchłonął dawne osobne rozdziały **Budzik** (`alarms`) i **Sync** (`sync`) —
   obie żyją tu teraz jako zwykłe pozycje, nie osobne kategorie najwyższego
   poziomu.
4. **Spyglass — wywiad** (`spyglass`) — flagowiec #2, duży moduł wywiadu.
5. **Inne** (`other`) — kosmetyka i drobne usprawnienia (dawne `qol`, część
   druga).

> Poprzednia struktura (`fab, spyglass, alarms, dashboard, sync, qol`) jest
> zarchiwizowana w historii gita tego pliku; ta sekcja zastępuje całą starą
> „Do rozstrzygnięcia w Fazie 1" (patrz decyzje niżej, część z nich rozstrzyga
> te właśnie pytania).

---

## Przycisk OG-E — flagowy hub (`fab`)

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Przycisk OG-E (FAB) | `og-e-button` | ★ | **drafted** | features/shared/unifiedFab, draggableButton |
| Wyślij Ekspedycję | `send-expedition` | ★ | **drafted** | features/sendExpedition |
| Polowanie na kolonie (+ porzucanie małych) | `big-colony-hunting` | ★ | **drafted** | features/sendColony, abandon |
| Discovery lifeform | `discover-lifeforms` | ★ | **drafted** | features/sendLifeform |
| Daily run (codzienne trasy) | `daily-run` | ★ | **drafted** | features/dailyRun |
| Przypomnienie o flocie | `fleet-reminder` | | **drafted** | features/alarmClock (część in-tab) |

`og-e-button` teraz też wprost wspomina **Spyglass** jako jeden z orbów FAB
(włączany/zarządzany z zakładki Spyglass w Dashboardzie) i linkuje do
rozdziału `spyglass` — bez duplikowania jego treści.

## Interfejs gry (`game-ui`)

To, co gracz widzi wprost w grze i przełącza z panelu ustawień AGR (zakładka
OG-E). Rozdział zastępuje część dawnego `qol`.

| Funkcja | slug | status | źródło (src/) |
|---|---|---|---|
| Ustawienia OG-E w panelu AGR | `settings-ui` | **drafted** | features/settingsUi |
| Readability | `readability-boost` | **drafted** | features/readabilityBoost |
| Znaczniki na planetach | `planet-markers` | **drafted** | features/badges (klucz zapisu: `expeditionBadges`) |
| Event pulse | `event-menu-highlight` | **drafted** | features/eventMenuHighlight, features/rewardingWatcher |
| Trader pulse | `trader-menu-highlight` | **drafted** | features/traderMenuHighlight |
| Baner ataku | `attack-banner` | **drafted** | features/threatHighlight |
| Kto Cię szpieguje (wzmianka) | — | — | patrz `who-is-spying` w rozdziale `spyglass` — panel żyje na stronie wiadomości w grze, przełącznik w tej samej grupie Display co reszta tego rozdziału; **bez osobnej strony**, żeby nie duplikować opisu. |

## Dashboard i analityka (`dashboard`)

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Big Colony Hunting — histogram i ustawienia | `colony-hunting-dashboard` | ★ | **drafted** | domain/histogram, galaxyScanConfig; features/dashboard/scanConfig |
| Best Colony Spots — najlepsze miejsca na kolonie | `best-colony-spots` | ★ | **drafted** | domain/zoneScore, regions, heatField |
| Budzik (alarm clock) — **graniczny, opisany uczciwie** | `alarm-clock` | ★ | **drafted** | features/alarmClock, sync/ntfyReconciler |
| Trasy (routes) — edytor Daily Run | `routes` | | **drafted** | features/dashboard/routes |
| Import / eksport / CSV | `data-io` | | **drafted** | features/dashboard/autosave |
| Sync między urządzeniami | `device-sync` | ★ | **drafted** | sync/* (gist) |
| Dzielenie i dołączanie aktywności | `share-join-activity` | ★ | todo | sync/*, state/activityObs |
| Free streak | `free-streak` | | todo | features/dashboard/freeStreak |
| Mapa galaktyki | `galaxy-map` | | todo | features/dashboard |
| Ręczne oznaczenie fleet-save | `fleet-save-mark` | | todo | features/manualFsMark |

**„Big Colony Hunting" i „Best Colony Spots" to dwie osobne pozycje** — nazwy
marketingowe/UI, nie techniczne nazwy z kodu (kod podpisuje tę drugą sekcję
„Colony Scout"; strona świadomie tego nie używa). `colony-hunting-dashboard`
to towarzysz do `big-colony-hunting` (kategoria `fab`): tam jest sam
przycisk, tu histogram rozmiarów i ustawienia, które ten przycisk czyta —
dwie strony, wzajemnie linkujące, bez powtarzania tej samej treści dwa razy.

Zakładka **Spyglass** żyje na Dashboardzie fizycznie, ale ma **własny
rozdział niżej** — tu tylko wzmianka, zero duplikacji treści. `patrol`
też fizycznie żyje na zakładce Szpieguj/Spyglass, więc — inaczej niż wcześniej
ustalono w Fazie 1 — **przeniesiony do rozdziału `spyglass`** (patrz niżej).

## Spyglass — wywiad (`spyglass`)

Rozdział rozbity na **sześć pytań + obrona + backbone**, w tej kolejności
(jedna strona = jedno pytanie gracza). Strona `spyglass` jest wstępem: model
myślowy (dwa kanały + lista obserwowanych) i spis pytań — szczegóły
algorytmów tylko na stronach szczegółowych, żeby żadna nie przytłaczała.

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Spyglass — wywiad (wstęp rozdziału) | `spyglass` | ★ | **drafted** | features/dashboard, features/sendSpy, domain/spyScan, state/watchList |
| Ranking zagrożenia (Danger) + lista obserwowanych | `spyglass-danger` | ★ | **drafted** | domain/dangerScore, dangerJoin, players; features/dashboard/targets |
| Skan: Look, Spy, Strike (+ ustawienia skanów) | `spyglass-scan` | | **drafted** | features/sendSpy; domain/scanPriority, galaxyWatch, fleetLanding |
| Dossier gracza | `spyglass-dossier` | | **drafted** | features/dashboard/dossier; domain/raidVerdict, threatModel, civilBaseline, lootRhythm |
| Rutyna i okna offline | `spyglass-routine` | ★ | **drafted** | domain/routine, presence, presenceLedger, shiftPattern; state/activityObs |
| Mapa pozycji i zasięg | `spyglass-map` | | **drafted** | features/dashboard/mapPrimitives; domain/geometry |
| Twoi sąsiedzi (Straż domowa / Home watch) | `spyglass-home` | ★ | **drafted** | domain/homeWatch; features/homeWatch, features/dashboard/homeWatch; state/homeWatch |
| Kto Cię szpieguje | `who-is-spying` | | **drafted** | features/whosSpyingPanel |
| Patrol | `patrol` | | **drafted** | features/dashboard/patrol, domain/patrol |

**Rozstrzygnięte 2026-08-08:**

- **`patrol` przenosi się do `spyglass`** (było `dashboard`) — karta żyje na
  zakładce Szpieguj i pcha graczy na listę obserwowanych, więc to treściowo
  Spyglass, nie ogólny Dashboard. Odwraca wcześniejszą decyzję z tej samej
  sesji (Faza 1 uznawała to za zamknięte w drugą stronę).

**Bez nowych stron (uzasadnienie DRY):**

- **„Spyglass — ustawienia"** nie dostaje osobnej strony — ustawienia skanów
  (terminy re-scan, liczba sond, planety/księżyce, punkt startu, tryb
  `Moon strike`) są już w pełni opisane w `spyglass-scan` (`details` + zrzut
  `settings`). Osobna strona tylko powtórzyłaby tę treść.
- **„Spyglass — Watch list"** nie dostaje osobnej strony — mechanika (gwiazdka
  `+ watch` / `+ watch all`, per-gracz `scanMode`/`galaxyMode`, sync
  między urządzeniami) jest opisana w `spyglass` (wstęp, backbone) i
  `spyglass-danger` (jak się dodaje). Osobna strona duplikowałaby obie.
- **„Twoi sąsiedzi"** to nazwa użytkownika dla już istniejącej strony
  `spyglass-home` (Straż domowa / Home watch) — zmieniona tylko nazwa w tym
  katalogu, treść strony bez zmian.

## Inne (`other`)

Kosmetyka i drobne usprawnienia — dodatki do funkcji flagowych. Dawne `qol`,
część druga (patrz `game-ui` dla pierwszej połowy: to, co ma własny
przełącznik w grupie Display panelu ustawień).

| Funkcja | slug | status | źródło (src/) |
|---|---|---|---|
| Przyciski nawigacji galaktyki | `galaxy-nav-panel` | **drafted** | features/galaxyNavPanel |
| Bez białego rozbłysku (FF mobile i inne) | `anti-flicker-background` | **drafted** | features/antiFlickerBackground |
| Logo AGR jako skrót do ustawień | `agr-logo` | **drafted** | features/agrLogo |
| Baner „zainstaluj AGR" | `agr-guard` | todo | features/agrGuard |
| Watcher nagród | `rewarding-watcher` | todo | features/rewardingWatcher (patrz też `event-menu-highlight`) |
| Watcher sklepu z artefaktami | `artifact-shop-watcher` | todo | features/artifactShopWatcher |
| Podświetlenie menu eventów | *(przeniesione)* | — | patrz `event-menu-highlight` w rozdziale `game-ui` |
| Podświetlenie menu kupca | *(przeniesione)* | — | patrz `trader-menu-highlight` w rozdziale `game-ui` |
| Panel nawigacji galaktyki | *(przeniesione)* | — | patrz `galaxy-nav-panel` wyżej |
| Przechwyt paska planet | `planet-bar-capture` | todo | features/planetBarCapture (infrastruktura pod edytor tras) |
| Akcelerator ArrowRight | `fleetdispatch-shortcut` | todo | features/fleetdispatchShortcut |

Pięć pozycji ze statusem `todo` (`agr-guard`, `rewarding-watcher`,
`artifact-shop-watcher`, `planet-bar-capture`, `fleetdispatch-shortcut`) to
świadomy „catch-all" — każda dostanie własną stronę w kolejnej sesji, ale
żadna nie jest na tyle flagowa, żeby blokować resztę restrukturyzacji.

---

### Warstwa infrastruktury — bez własnych stron

`apiContext`, `ownProfile`, `colonyRecorder`, `allianceClassIngest`,
`targetsIngest`, `badges` (dane, nie UI) — to zaplecze. Skąd biorą się dane
**wplatamy w funkcje, które je konsumują** (sekcje „Jak działa" /
„Fair-play"), nie robimy dla nich osobnych stron.
