# Changelog

All notable changes to this project will be documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

## [1.0.0] — 2026-04-24

Pierwsze oficjalne wydanie.

### Dodane

- **Send Exp** + **Send Col** floating buttons — draggable, mobile-first,
  jeden tap = jedna intencja gry.
- **Smart colonize flow** — auto-target z `colPositions` + `colMinGap` +
  pre-send `checkTarget` dry-run. Stany `ready` / `reserved` / `noShip` /
  `stale` / `timeout` / `waitGap` explicit w discriminated union.
- **Galaxy scan tracker** — baza lokalna (chrome.storage.local) z polityką
  rescan per status (`empty_sent` 4h, `occupied` 30d, `abandoned` → 3 AM
  server time po 24h, …). Scan button pokazuje licznik pozostałych
  systemów.
- **Fresh-planet banner** — banner na planety z `usedFields === 0`,
  klik → overview. Stateless: czyta tooltip `#planetList`, żadnego DB.
- **Abandon overlay** — 3-clickowy flow z przyciskami wstrzykniętymi
  wewnątrz popupów gry (mobile-safe). Overlay drawuje się na overview
  gdy `usedFields < colMinFields` i hasło konta jest ustawione.
- **Histogram + galaxy map** — strona rozszerzenia z local data view,
  per-galaxy reset, export/import JSON.
- **Cloud sync via GitHub Gist** — prywatny gist usera, gzip + base64
  payload (~6× mniejszy), 15 s debounce, anti-loop przez `changed` flag
  z merge'ów, inFlight lock dla concurrent upload/download.
- **Readability boost** — CSS fix dla `#eventboxFilled` (gradient tło,
  flex-column layout, duży countdown chip) i `a.ago_movement` (stack
  vertical, preserved `ago_color_palered` na maxie ekspedycji).
- **AGR integration** — panel ustawień wewnątrz AGR menu, rewire AGR
  logo → OG-E icon z hover state, fleetdispatch ArrowRight shortcut.
- **657 jednostkowych testów** (vitest + happy-dom), pełny `@ts-check`
  z JSDoc jako typedef, minimalny build pipeline (rollup + terser).

### Architektoniczne decyzje

- Vanilla JS, zero runtime deps. Typy via JSDoc + `tsc --noEmit`.
- `lib/` + `domain/` czyste, bez DOM / storage / side-effectów.
- XHR observer (MAIN world) → DOM event → isolated-world listener.
  Nigdy nie originujemy żądań do gry.
- Storage dwupoziomowy: localStorage dla sync-write (registry wyścigów),
  chrome.storage.local dla większych zasobów (scans, history).

### Compliance

OG-E jest modyfikacją UI. Każde kliknięcie usera powoduje co najwyżej
jedno żądanie do gry. Nie ma tła, nie ma cykli, nie ma bypass-CAPTCHA.
Patrz [CONTRIBUTING.md](CONTRIBUTING.md) §Compliance.
