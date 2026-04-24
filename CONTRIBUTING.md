# Contributing

Cześć. Projekt jest mały i celowo trzymany minimalnie. Sześć reguł,
potem reszta wypływa z kodu sama.

## 1. Compliance pierwsza

**Jedno kliknięcie usera → co najwyżej jedno żądanie do gry.** Nigdy
nie originuj ruchu sieciowego do serwera gry. Obserwujemy XHR-y które
gra sama wywołuje (`src/bridges/`), rozpakowujemy je na DOM-eventy, i
tyle. Nigdy `fetch('/game/…')`, nigdy synthetic XHR w tle.

Żadnych cyklicznych akcji w tle. Żadnego "w jednym clicku wyślij 5
flot". Żadnego obchodzenia CAPTCH-a ani rate-limitów gry.

Żądania do naszych serwisów (np. `api.github.com` dla sync) są OK.
Nawigacja typu `location.href = url` po single clicku jest OK.

Jak masz wątpliwości — otwórz issue zamiast PR-a.

## 2. Pure gdzie się da

`src/lib/` i `src/domain/` mają **zero** DOM, storage, `Date.now()`
bez parametru. Jak twoja funkcja tego potrzebuje, nie należy tam —
przenieś do `src/state/` (dla storage) albo `src/features/` (dla DOM).

Tak trzymamy 60% kodu testowalnym w node'owym vitest bez żadnych mocków.

## 3. JSDoc + `@ts-check`

Vanilla JS, ale każdy plik otwiera się od `// @ts-check` i każda
publiczna funkcja ma `@param` / `@returns`. `npm run typecheck` musi
exitować 0 przed każdym commitem.

TypeScript nie jest wymagany, ale typy są — przez JSDoc.

## 4. Testy tam gdzie to uzasadnione

- `domain/` i `lib/` — każdy helper ma testy w `test/` (często
  pokrywają 10+ edge case'ów każdy).
- `features/` — integracyjne smoke testy w happy-dom, głównie wiring.
- `bridges/` — happy-dom XHR shim, sprawdzamy że handler lądują z
  dobrym payloadem.

Nie gonimy 100% coverage. Gonimy regression-killerom i contract-lockom.

## 5. Commit format

`fix:` / `feat:` / `chore:` / `docs:` / `refactor:` / `test:` + krótki
imperatyw. Body tłumaczy "dlaczego", nie "co" (diff pokazuje "co").

```
feat: lock Send Exp button on Sent!

Previously the button remained clickable after firing the dispatch,
letting a fast double-tap trigger two nav attempts. Now we lock +
safety-unlock after 3 s (by which time the page has reloaded or the
game returned an error).
```

## 6. Żadnych runtime dependencies

Vanilla JS + browser API. Jeśli naprawdę potrzebujesz libki — otwórz
issue z uzasadnieniem trade-offu (rozmiar bundla, tree-shake'owalność,
maintenance burden, jakieś nietrywialne rzeczy których sami nie chcemy
ogarniać).

Dev deps (rollup, vitest, typescript) oczywiście OK.

---

## Workflow

```bash
npm install
npm run dev           # rollup watch
npm run test          # vitest
npm run typecheck     # must exit 0
npm run build:prod    # check bundle size
```

Commit-ready = wszystkie trzy powyższe zielone.

## Test ride

Załaduj `dist/manifest.json` jako temporary add-on (Firefox) albo
unpacked extension (Chrome). OGame otwarte → sprawdź że twoja zmiana
nie zepsuła pływających przycisków, AGR menu, ani żadnej z istniejących
ścieżek.

## Kontakt

Otwórz issue. Nie pisz mailami.
