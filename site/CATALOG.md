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

**Kolejność pisania:** od flagowców. Hero = **Przycisk OG-E (FAB)** z modułami,
potem Spyglass, budzik, Best Colony Spots, sync/społeczność; UI na końcu.

> **Faza 1 (osobna sesja):** ten spis to zalążek do domknięcia — część pozycji
> może się scalić lub rozejść (patrz „Do rozstrzygnięcia" na dole).

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

## Spyglass — wywiad (`spyglass`)

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Spyglass (podejrzyj, szpieguj, dossier, rutyna, danger, okna offline) | `spyglass` | ★ | todo | features/dashboard, features/sendSpy, domain/spyScan, dangerScore, threatModel, presence |
| Kto Cię szpieguje | `who-is-spying` | | **drafted** | features/whosSpyingPanel |

## Budzik i fleet-save (`alarms`)

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Budzik (alarm clock) — **graniczny, opisany uczciwie** | `alarm-clock` | ★ | todo | features/alarmClock, sync/ntfyReconciler |
| Ręczne oznaczenie fleet-save | `fleet-save-mark` | | todo | features/manualFsMark |

## Dashboard i analityka (`dashboard`)

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Najlepsze miejsca na kolonie | `best-colony-spots` | ★ | todo | domain/zoneScore, regions, positions |
| Patrol | `patrol` | | todo | features/dashboard/patrol |
| Trasy (routes) | `routes` | | todo | features/dashboard/routes |
| Free streak | `free-streak` | | todo | features/dashboard/freeStreak |
| Mapa galaktyki | `galaxy-map` | | todo | features/dashboard |
| Import / eksport / CSV | `data-io` | | todo | features/dashboard/autosave |

## Synchronizacja i społeczność (`sync`)

| Funkcja | slug | flagowa | status | źródło (src/) |
|---|---|:--:|---|---|
| Sync między urządzeniami | `device-sync` | ★ | todo | sync/* (gist) |
| Dzielenie i dołączanie aktywności | `share-join-activity` | ★ | todo | sync/*, state/activityObs |

## Usprawnienia UI — dodatki (`qol`)

| Funkcja | slug | status | źródło (src/) |
|---|---|---|---|
| Czytelność (readability boost) | `readability-boost` | todo | features/readabilityBoost |
| Anti-flicker tła | `anti-flicker-background` | todo | features/antiFlickerBackground |
| Logo AGR | `agr-logo` | todo | features/agrLogo |
| Baner „zainstaluj AGR" | `agr-guard` | todo | features/agrGuard |
| Watcher nagród | `rewarding-watcher` | todo | features/rewardingWatcher |
| Watcher sklepu z artefaktami | `artifact-shop-watcher` | todo | features/artifactShopWatcher |
| Panel ustawień OG-E | `settings-ui` | todo | features/settingsUi |
| Podświetlenie menu eventów | `event-menu-highlight` | todo | features/eventMenuHighlight |
| Podświetlenie menu kupca | `trader-menu-highlight` | todo | features/traderMenuHighlight |
| Panel nawigacji galaktyki | `galaxy-nav-panel` | todo | features/galaxyNavPanel |
| Przechwyt paska planet | `planet-bar-capture` | todo | features/planetBarCapture |
| Akcelerator ArrowRight | `fleetdispatch-shortcut` | todo | features/fleetdispatchShortcut |

---

### Warstwa infrastruktury — bez własnych stron

`apiContext`, `ownProfile`, `colonyRecorder`, `allianceClassIngest`, `targetsIngest`,
`badges` (danych) — to zaplecze. Skąd biorą się dane **wplatamy w funkcje, które
je konsumują** (sekcje „Jak działa" / „Fair-play"), nie robimy dla nich osobnych
stron.

### Do rozstrzygnięcia w Fazie 1

- **Spyglass** — potwierdzić, że opisujemy jako JEDNĄ dużą stronę (dossier /
  plan skanów / mapa / rutyna / danger / okna offline w środku), a `who-is-spying`
  zostaje osobno jako panel na stronie wiadomości.
- **„Okna offline"** — analiza okien offline wroga siedzi w Spyglass; „dzielenie i
  dołączanie aktywności" to sync/społeczność. Potwierdzić rozdział.
- **Best Colony Spots vs Big Colony Hunting** — osobna strona analityczna
  (dashboard) czy sekcja w polowaniu na kolonie? Wstępnie osobno.
