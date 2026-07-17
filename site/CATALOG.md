# Katalog funkcji OG-E — tracker dokumentacji

Żywy dokument śledzący postęp dokumentacji (praca na wiele sesji). Jedna linia
na user-facing funkcję. Status:

- `todo` — jeszcze nieopisana (brak pliku w `content/`),
- `drafted` — opis napisany z kodu, czeka na weryfikację użytkownika,
- `verified` — użytkownik potwierdził zgodność z realną grą.

Klasyfikacja fair-play (🟢/🟡/🔴) jest przepisywana z kanonicznego
`docs/fair-play.md` — NIE ustalamy jej tutaj.

> **Faza 1 (do zrobienia w osobnej sesji):** ten spis jest zalążkiem złożonym
> z `src/features/` + sekcji GREEN w `docs/fair-play.md`. Wymaga przeglądu:
> część pozycji to jedna funkcja, część (np. dashboard) rozpada się na kilka
> pod-paneli, które mogą chcieć osobnych stron. Zamykamy inwentaryzację, zanim
> ruszymy z masowym pisaniem.

---

## Automatyzacja floty (`fleet`)

| Funkcja | slug | fair-play | status | źródło (src/) |
|---|---|---|---|---|
| Wyślij wyprawę | `send-expedition` | 🟡 | todo | features/sendExpedition |
| Wyślij kolonizację | `send-colony` | 🟢 | todo | features/sendColony |
| Wyślij lifeform / discovery | `send-lifeform` | 🟢 | todo | features/sendLifeform |
| Spy FAB (szpieguj) | `send-spy` | 🟢 | todo | features/sendSpy |
| Daily run | `daily-run` | 🟢 | todo | features/dailyRun |
| Porzucenie kolonii | `abandon-colony` | 🟢 | todo | features/abandon |
| Akcelerator ArrowRight | `fleetdispatch-shortcut` | 🟢 | todo | features/fleetdispatchShortcut |

## Wywiad i zagrożenia (`intel`)

| Funkcja | slug | fair-play | status | źródło (src/) |
|---|---|---|---|---|
| Kto Cię szpieguje | `who-is-spying` | 🟢 | **drafted** | features/whosSpyingPanel |
| Podświetlenie zagrożeń | `threat-highlight` | 🟡 | todo | features/threatHighlight |
| Przechwytywanie raportów | `targets-ingest` | 🟢 | todo | features/targetsIngest |
| Odznaki (badges) | `badges` | 🟢 | todo | features/badges |
| Model zagrożenia | `danger-model` | 🟢 | todo | domain/dangerScore, threatModel |
| Sygnał świeżego fleet-save | `fleet-landing-strike` | 🟡 | todo | domain/fleetLanding |

## Dashboard i analityka (`dashboard`)

| Funkcja | slug | fair-play | status | źródło (src/) |
|---|---|---|---|---|
| Dashboard — przegląd | `dashboard-overview` | 🟢 | todo | features/dashboard |
| Spyglass — workbench wywiadu | `spyglass-tab` | 🟢/🟡 | todo | features/dashboard, domain/spyScan |
| Patrol | `patrol` | 🟢 | todo | features/dashboard/patrol |
| Trasy (routes) | `routes` | 🟢 | todo | features/dashboard/routes |
| Free streak | `free-streak` | 🟢 | todo | features/dashboard/freeStreak |
| Import / eksport / CSV | `data-io` | 🟢 | todo | features/dashboard/autosave |
| Mapa galaktyki | `galaxy-map` | 🟢 | todo | features/dashboard |

## Nawigacja i galaktyka (`galaxy`)

| Funkcja | slug | fair-play | status | źródło (src/) |
|---|---|---|---|---|
| Panel nawigacji galaktyki | `galaxy-nav-panel` | 🟢 | todo | features/galaxyNavPanel |
| Przechwyt paska planet | `planet-bar-capture` | 🟢 | todo | features/planetBarCapture |
| Podświetlenie menu eventów | `event-menu-highlight` | 🟢 | todo | features/eventMenuHighlight |
| Podświetlenie menu kupca | `trader-menu-highlight` | 🟢 | todo | features/traderMenuHighlight |

## Fleet-save i przypomnienia (`alarms`)

| Funkcja | slug | fair-play | status | źródło (src/) |
|---|---|---|---|---|
| Budzik (alarm clock) | `alarm-clock` | 🔴→✅ | todo | features/alarmClock |
| Ręczne oznaczenie fleet-save | `fleet-save-mark` | 🟢 | todo | features/manualFsMark |

## Jakość życia i UI (`qol`)

| Funkcja | slug | fair-play | status | źródło (src/) |
|---|---|---|---|---|
| Czytelność (readability boost) | `readability-boost` | 🟢 | todo | features/readabilityBoost |
| Anti-flicker tła | `anti-flicker-background` | 🟢 | todo | features/antiFlickerBackground |
| Logo AGR | `agr-logo` | 🟢 | todo | features/agrLogo |
| Baner „zainstaluj AGR" | `agr-guard` | 🟢 | todo | features/agrGuard |
| Watcher nagród | `rewarding-watcher` | 🟢 | todo | features/rewardingWatcher |
| Watcher sklepu z artefaktami | `artifact-shop-watcher` | 🟢 | todo | features/artifactShopWatcher |
| Panel ustawień OG-E | `settings-ui` | 🟢 | todo | features/settingsUi |
| Pływający przycisk (FAB) | `floating-button` | 🟢 | todo | features/shared/unifiedFab |

---

### Do rozstrzygnięcia w Fazie 1

- **Warstwa infrastruktury** (`apiContext`, `ownProfile`, `colonyRecorder`,
  `allianceClassIngest`) — to zaplecze danych, nie klasyczne „funkcje". Decyzja:
  osobna sekcja „Skąd OG-E bierze dane" czy pominięcie na stronie publicznej?
- **Dashboard** — czy `spyglass-tab` opisać jako jedną dużą stronę, czy rozbić
  na dossier / plan skanów / mapę / routine tracker (część 🟡-D)?
- Kolejność pisania: proponowana od najbardziej „flagowych" (fleet + Spyglass).
