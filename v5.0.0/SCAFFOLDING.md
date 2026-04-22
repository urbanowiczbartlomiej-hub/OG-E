# OG-E v5 — Setup i workflow deweloperski

Ten plik tłumaczy jak zbudować i uruchomić v5 lokalnie. Podczas całej fazy
developmentu v5 żyje obok produkcyjnej v4.9.x — mają różne gecko.id,
różne prefiksy storage i różne gisty, więc są na siebie nieczułe.

---

## Wymagania

- **Node.js 20+** (lub 22+; rollup i vitest wspierają obie linie)
- **Firefox Nightly** (albo Developer Edition) — jedyna przeglądarka do
  testów runtime podczas developmentu
- Opcjonalnie Chrome / Chromium do weryfikacji MV3 Chrome

---

## Pierwsze uruchomienie

```powershell
cd C:\Users\urban\Desktop\OG\OGame_extensions\OG-E\v5.0.0
npm install
npm run build
```

Po buildzie folder `dist/` zawiera wszystko, co trzeba — oba manifesty,
bundle'owane skrypty i statyczne pliki strony histogramu.

---

## Ładowanie do Firefoksa (temporary add-on)

1. Otwórz `about:debugging#/runtime/this-firefox`
2. Kliknij **"Wczytaj tymczasowy dodatek..."** (Load Temporary Add-on)
3. Wskaż plik `dist/manifest.json`
4. Rozszerzenie instaluje się obok v4 (osobny gecko.id: `oge5@ogame-extensions`)

Przy każdym `npm run build` trzeba ponownie kliknąć **"Przeładuj"**
w `about:debugging` (FF ma cache dla temporary add-onów).

Dla szybszej iteracji: `npm run dev` (watch mode) + tryb "auto-reload"
wtyczki `web-ext` (opcjonalnie — nie jest wymagane).

---

## Weryfikacja smoke-test po scaffoldingu

Po załadowaniu rozszerzenia wejdź na dowolny widok OGame. Powinieneś
zauważyć:

- **Brak białego mignięcia** podczas przeładowań (np. przełączenie
  zakładki, dispatch misji). Zamiast bieli — krótka czarna klatka.
  To `features/blackBg.js` robi swoje.
- W DevTools w zakładce **Konsola** dla strony histogramu (jeśli
  otworzysz `moz-extension://<id>/histogram.html`) widzisz:
  `[OG-E v5] histogram page loaded (placeholder)`.
- W DevTools w zakładce **Źródła** widać `content.js` jako załadowany
  skrypt dla strony gry.

To wszystko, co Faza 1 dostarcza. Reszta (Send Exp, Send Col, abandon,
sync, itd.) przychodzi w kolejnych fazach — każda weryfikowana osobno.

---

## Komendy npm

| Komenda | Opis |
|---|---|
| `npm run build` | Build jednorazowy — IIFE bundles do `dist/` + copy manifestów i histogramu |
| `npm run dev` | Watch-mode rollupa (re-bundling przy zmianie pliku źródłowego). Manifesty trzeba skopiować ręcznie (`node scripts/copy-static.mjs`) jeśli się zmienią |
| `npm run typecheck` | `tsc --noEmit` — walidacja JSDoc types. Zero emisji, tylko sprawdzanie |
| `npm run test` | Testy jednostkowe vitest (pure functions z `domain/` i `lib/`) |
| `npm run test:watch` | Vitest w trybie watch |

---

## Struktura folderów

```
v5.0.0/
├── DESIGN.md              architektura i motywacja (PL)
├── SCAFFOLDING.md         ten plik
├── package.json           deps + scripts
├── rollup.config.mjs      config buildu (3 bundles)
├── tsconfig.json          JSDoc type-check config
├── .gitignore
├── manifest.json          MV3 (one file for Chrome + Firefox; gecko.id: oge5@ogame-extensions)
├── scripts/
│   └── copy-static.mjs    post-build: manifesty + histogram.html → dist/
├── src/                   ŹRÓDŁA
│   ├── content.js         entry isolated world
│   ├── page.js            entry MAIN world (placeholder)
│   ├── histogram.js       entry strony histogramu (placeholder)
│   ├── histogram.html     DOM strony histogramu (placeholder)
│   └── features/
│       └── blackBg.js     anti-flicker (Faza 1)
│
├── test/                  TESTY (puste w Fazie 1)
├── icons/                 ikony (do dodania przed release)
└── dist/                  OUTPUT buildu (gitignored)
    ├── content.js
    ├── page.js
    ├── histogram.js
    ├── histogram.html
    └── manifest.json
```

---

## Gdzie szukać informacji

- **Architektura i decyzje projektowe**: `DESIGN.md`
- **Schematy danych**: `SCHEMAS.md` (pojawi się w Fazie 3 razem z `domain/`)
- **Historia wersji 4.x**: `../` (katalog główny repo)

---

## Następna faza

Po pomyślnym smoke-teście (czarne tło działa) przechodzimy do:

- **Faza 2**: pełne `features/blackBg.js` jest już napisane —
  Faza 2 jest efektywnie zakończona scaffoldingiem.
- **Faza 3**: `lib/` — pure helpers (createStore, storage, dom, gzip,
  debounce, logger) + ich testy vitest.

Każda kolejna faza zaczyna się od briefu dla subagenta (opisanego
w DESIGN.md §17) i kończy review przez użytkownika przed merge.
