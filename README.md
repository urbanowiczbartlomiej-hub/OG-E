# OG-E

**A calm UI helper for OGame.** Floating buttons for the stuff you do most,
a local galaxy-scan database for the decisions that need data, and zero
automation. Your clicks stay your clicks — OG-E never talks to the game
server on your behalf.

> **Hard rule:** one user click → at most one HTTP request to the game.
> We observe XHRs the game already fires; we never originate traffic.
> Patrz `CONTRIBUTING.md` if you're poking at the code.

---

## What you get

- **Send Exp** / **Send Col** — pływające przyciski, draggowalne, przyjazne
  dla mobilki. Jeden tap wykonuje jedną intencję (wyślij ekspedycję,
  wyślij kolonizatora).
- **Smart colonize** — auto-target po twoich pozycjach, min-gap między
  flotami, dry-run `checkTarget` przed wysyłką, obsługa "slot zarezerwowany"
  i "brak statku" jako oddzielnych stanów zamiast wiecznej pętli.
- **Galaxy scan tracker** — lokalna baza skanów (systemy × pozycje ×
  timestamp), z polityką "odśwież po X" per-status. Przycisk Scan
  pokazuje licznik "ile systemów jeszcze do odświeżenia".
- **Fresh-planet banner** — świeżo skolonizowana planeta (zero pól)
  dostaje baner na środku ekranu. Klik → overview, tam decydujesz.
- **Abandon overlay** — jeśli kolonia jest za mała wg twojego progu,
  na overview paintujemy duży czerwony overlay "porzuć". 3-clickowy flow
  z wbudowanymi przyciskami wewnątrz popupu gry (działa też na mobilce).
- **Histogram + galaxy map** — strona rozszerzenia z wykresem rozmiarów
  twoich kolonii i piksel-mapą obserwacji galaktyk.
- **Cloud sync** — cross-device przez twój prywatny gist GitHuba.
  Payload gzipowany (~6× redukcja). 15 s debounce + anti-loop.
- **Readability boost** — CSS fix dla notorycznie nieczytelnego eventboxa
  i linka "Ruch floty" w nagłówku fleetdispatch. Żadnej magii, sam CSS.

Wymagana zależność: [AntiGameReborn](https://antigame.de/) — korzystamy
z jego panelu ustawień i reguł wizualnych. Bez AGR feature'y UI nadal
działają, ale panel ustawień się nie pojawi.

---

## Install

### Firefox
1. `npm install && npm run build:prod`
2. `about:debugging` → "This Firefox" → "Load Temporary Add-on…"
3. Wybierz `dist/manifest.json`

### Chrome / Edge
1. `npm install && npm run build:prod`
2. `chrome://extensions` → włącz "Developer mode"
3. "Load unpacked" → wskaż folder `dist/`

---

## Development

```bash
npm install
npm run dev           # rollup watch, rebuilds dist/ on save
npm run test          # vitest, 657 testów
npm run typecheck     # tsc --noEmit, JSDoc-as-types
npm run build:prod    # minified dist/ (terser, dropped console)
```

**Debug flags** (wpisz w DevTools console):
- `localStorage.oge_debugSendCol = 'true'` — log ctx na Send/Scan click
- `localStorage.oge_debugMinGap = 'true'` — log inputów min-gap

---

## Architektura w 5 minut

```
src/
├── content.js     isolated-world entry  (document_start)
├── page.js        MAIN-world entry      (XHR hooks)
├── histogram.js   extension page entry
│
├── lib/           pure helpery: store, storage, dom, gzip, debounce...
├── domain/        pure logic: scans, positions, registry, scheduling
├── state/         observable stores + persistence wiring
├── bridges/       MAIN-world XHR observers → DOM events
├── features/      UI modules: sendExp, sendCol, badges, abandon...
└── sync/          gist round-trip (gzip + debounce + anti-loop)
```

**Reguła przepływu:** bridges obserwują XHR-y gry → emitują DOM eventy
(`oge:galaxyScanned`, `oge:checkTargetResult`, …) → state stores
słuchają → feature'y re-renderują swoją warstwę DOM.

**Purity contract:** `lib/` i `domain/` są pure — zero DOM, zero
storage, zero `Date.now()` bez parametru. Test'owalne w node'owym
vitest bez mockowania.

---

## Contributing

Kilka twardych reguł w [CONTRIBUTING.md](CONTRIBUTING.md). Najważniejsze:
**compliance z ToS gry** jest nieruszalne — jeśli twoja zmiana wymaga
żądania do gry bez user-clicka, prawdopodobnie jest to automatyzacja,
co wyklucza PR.

## License

[MIT](LICENSE) — zrób z tym co chcesz, ale pamiętaj: ten kod działa
z cudzą grą, i to na ich warunkach. Nie jest oficjalnym produktem
GameForge.
