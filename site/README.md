# site/ — dokumentacja funkcji OG-E

Statyczna strona opisująca każdą funkcję OG-E: co robi, jak działa, jaką buduje
przewagę i jak trzyma się zasad fair-play OGame. Bazowy język: **PL** (struktura
gotowa pod tłumaczenia). Docelowo hostowana na stronie autora i podlinkowana z
rozszerzenia.

## Model

**Treść = dane, nie ręczny HTML.** Każda funkcja to jeden plik
`content/<slug>.mjs` eksportujący obiekt zgodny z kontraktem w
`content/_schema.mjs`. Generator (`build.mjs`) waliduje i renderuje **jedną
długą, wycentrowaną stronę** `dist/index.html` — wszystkie funkcje jedna pod
drugą (pogrupowane w kategorie), z bocznym spisem treści (scroll-spy,
przyklejony na desktopie, chowany pod przyciskiem na mobile). Strona ma
**dwa motywy** (ciemny domyślny + jasny; tokeny na `html[data-theme]`,
przełącznik w nagłówku, wybór zapamiętywany, start wg preferencji systemu).
Dzięki modelowi danych każdy blok ma ten sam zestaw sekcji, a tłumaczenie
sprowadza się do podmiany stringów, nie layoutu — stringi CHROME szablonu
(nagłówki sekcji, hero, przyciski, stopka) żyją w `content/_strings.mjs`
per język.

**Idea, nie implementacja.** Opisujemy IDEĘ działania — krótko (dwie zwięzłe
sekcje prozą: `idea` = „Jak to działa", `value` = „Po co to"), tak by dało się
to przeczytać w kilka sekund. Nie opisujemy każdego stanu przycisku ani
najdrobniejszej mechaniki — to dezaktualizuje dokument z każdym commitem.
Konkretne, zmienne detale (tylko gdy pomagają) idą do opcjonalnego `details`
(punkty). Każda sekcja renderuje się w osobnej karcie z etykietą; fair-play ma
mocniejszą, akcentową identyfikację. Pełny kontrakt pól — w `_schema.mjs`.

```
site/
  build.mjs              generator (czysty Node ≥22, zero zależności)
  serve.mjs              podgląd lokalny dist/ (statyczny serwer, zero zależności)
  CATALOG.md             tracker postępu (wszystkie funkcje + status)
  content/
    _schema.mjs          kontrakt pól + walidacja (== test spójności)
    _categories.mjs      taksonomia user-facing (6 grup)
    _strings.mjs         stringi szablonu per język (warstwa i18n chrome'u)
    _categories.mjs      → nazwy/blurby kategorii są per język (pl/en)
    <slug>.mjs           treść PL (baza) — wzorzec: who-is-spying.mjs
    en/<slug>.mjs        treść EN (lustro 1:1 — build wymusza komplet slugów)
  assets/
    style.css            arkusz (mobile-first, motyw ciemny + jasny na tokenach)
    shots/               zrzuty ekranu: <slug>--<shotId>.png (WSPÓLNE dla języków)
  dist/                  wygenerowany output (gitignore — buduje go CI)
    index.html           PL (baza, w korzeniu)
    en/index.html        EN
    .nojekyll            wyłącza Jekylla na GitHub Pages
```

## Build i podgląd

```
npm run site:build       # → site/dist/
npm run site:preview     # build + http://localhost:4173/  (EN: /en/)
```

Build **przerywa (exit 1)** przy brakującym/niepoprawnym polu w dowolnym pliku
treści (oraz przy niekompletnym lustrze EN) — to nasz test spójności, a na CI
jednocześnie bramka publikacji. Podgląd wymaga serwera statycznego —
przeglądarka nie ładuje tego layoutu z `file://`; `site:preview` odpala
minimalny serwer z `serve.mjs`.

## Żywe demo (`demos/`)

Zamiast zrzutu funkcja może pokazać **prawdziwy komponent OG-E** wyrenderowany
z `src/` w headless DOM (`site/demos/<id>.mjs`, wskazane przez `demo: {id,
caption}` w treści). Dane są zawsze ZMYŚLONE — dokumentacja nie publikuje
pozycji żadnego realnego gracza.

Renderowanie potrzebuje `happy-dom`, czyli **devDependency**, a CI Pages
celowo nie robi `npm ci` (generator jest zero-dependency). Dlatego markup jest
**pre-renderowany i commitowany**:

- lokalny build (masz `node_modules`) renderuje na żywo i zapisuje wynik do
  `site/demos/_generated/<id>.html`;
- CI (bez `happy-dom`) render pomija i **wkleja ten zacommitowany plik** — to on
  ląduje na opublikowanej stronie;
- gdy nie ma ani jednego, ani drugiego, figura po prostu nie powstaje (fail-soft).

Praktyczny wniosek: **po zmianie komponentu zbuduj stronę i zacommituj to, co
zmieni się w `_generated/`** — inaczej opublikowane demo zostanie na starej
wersji. Build mówi o tym wprost (`↻ demo "…" odświeżone`).

## Publikacja (GitHub Pages)

Strona jest hostowana na GitHub Pages pod
<https://urbanowiczbartlomiej-hub.github.io/OG-E/> i **budowana przez CI, nie
commitowana**: `.github/workflows/pages.yml` na każdy push do `main`, który
dotknie `site/**`, uruchamia `node site/build.mjs` i wdraża `site/dist/` jako
artefakt Pages (`workflow_dispatch` = „opublikuj teraz" ręcznie).

Konsekwencje, o których warto pamiętać:

- **`site/dist/` zostaje w `.gitignore`.** Opublikowany HTML jest zawsze tym,
  co generator robi z treści na `main` — nie da się wypchnąć nieświeżego
  outputu ani konfliktować na pliku generowanym.
- **Ścieżki są względne**, więc strona działa pod podkatalogiem (`/OG-E/`) bez
  żadnej konfiguracji `base`. Nie wprowadzaj linków od korzenia (`/assets/…`).
- **Publikacja strony jest niezależna od wydania rozszerzenia** (`release.yml`)
  — poprawka treści nie wymaga podbicia wersji ani wysyłki na AMO/CWS.

## Dodanie nowej funkcji

1. Skopiuj `content/who-is-spying.mjs` na `content/<slug>.mjs`.
2. Wypełnij pola (discovery z kodu — patrz nagłówek wzorca). `idea`/`value`
   trzymaj krótko; `details` dodawaj oszczędnie.
3. `fairplay.summary` pisz jako **argumenty ZA** (interpretacja pozytywna).
   `fairplay.borderline = true` ustaw **tylko** dla budzika. NIE pisz „1 tap =
   1 żądanie" — OG-E nie wysyła żądań, tylko **inicjuje kliknięcie natywnego
   elementu gry** (to gra ewentualnie łączy się z serwerem, jak przy ręcznym
   kliknięciu). Patrz reguła w `_schema.mjs`.
4. Zdefiniuj listę zrzutów; realne pliki wrzuć do `assets/shots/` później —
   do tego czasu generator pokazuje placeholder.
5. **Dorób lustro EN**: `content/en/<slug>.mjs` z `locale: 'en'` i tym samym
   `id` (build wymaga kompletu slugów w każdym języku, inaczej `exit 1`).
6. Zaktualizuj `CATALOG.md` (status `drafted`), zbuduj, oddaj do weryfikacji.

## Fair-play — polityka strony

Strona **nie stosuje** klasyfikacji zielony/żółty/czerwony (to zostaje
wewnętrzne, w `docs/fair-play.md`). Publicznie zawsze dajemy **interpretację
pozytywną** — argumenty za tym, że funkcja jest fair, w tym pochodzenie danych
(„z raportów, które sam otworzyłeś" itp.). Jedyny wyjątek, gdzie uczciwie
przyznajemy graniczność, to **budzik** (`borderline: true`) — generator dokłada
tam szczery komentarz.

## Tłumaczenia (EN/PL — działają)

Strona jest **dwujęzyczna**: PL to baza (`dist/index.html`), EN to lustro
(`dist/en/index.html`). Przełącznik PL/EN siedzi w nagłówku i przenosi na tę
**samą sekcję** drugiej wersji — kotwice-slugi są wspólne, skrypt dokleja
bieżący `#hash`.

Trzy warstwy języka:

1. **Stringi szablonu** (nagłówki sekcji, hero, przyciski, stopka, liczebniki)
   — `content/_strings.mjs`, klucz per język (`pl`, `en`).
2. **Kategorie** — `content/_categories.mjs`: `name`/`blurb` to obiekty
   `{ pl, en }`; `id` jest wspólne (część kotwicy `#cat-<id>`).
3. **Treść funkcji** — PL w `content/<slug>.mjs`, EN w `content/en/<slug>.mjs`
   (`locale: 'en'`). Zrzuty są wspólne; tłumaczą się tylko podpisy.

Build **wymusza komplet**: zbiór slugów EN musi być 1:1 z PL, inaczej `exit 1`
(brakujące ↔ osierocone tłumaczenie). Dodanie języka = nowy klucz w
`_strings.mjs`, klucze w `_categories.mjs`, katalog `content/<lang>/` i wpis
w stałej `LOCALES` w `build.mjs`. Nowa funkcja = plik PL **i** jego lustro EN.
