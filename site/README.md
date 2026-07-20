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
drugą (pogrupowane w kategorie), z pływającym menu-kotwicą (scroll-spy,
przyklejone na desktopie, chowane pod przyciskiem na mobile). Dzięki modelowi
danych każdy blok ma ten sam zestaw sekcji, a tłumaczenie sprowadza się do
podmiany stringów, nie layoutu.

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
  CATALOG.md             tracker postępu (wszystkie funkcje + status)
  content/
    _schema.mjs          kontrakt pól + walidacja (== test spójności)
    _categories.mjs      taksonomia user-facing (6 grup)
    <slug>.mjs           jedna funkcja = jeden plik (wzorzec: who-is-spying.mjs)
  assets/
    style.css            arkusz (mobile-first, ciemny motyw)
    shots/               zrzuty ekranu: <slug>--<shotId>.png (opcjonalne)
  dist/                  wygenerowany output (gitignore)
```

## Build

```
node site/build.mjs      # → site/dist/
```

Build **przerywa (exit 1)** przy brakującym/niepoprawnym polu w dowolnym pliku
treści — to nasz test spójności. Podgląd lokalny: dowolny statyczny serwer nad
`site/dist/` (przeglądarka nie ładuje `file://` z tego layoutu).

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
5. Zaktualizuj `CATALOG.md` (status `drafted`), zbuduj, oddaj do weryfikacji.

## Fair-play — polityka strony

Strona **nie stosuje** klasyfikacji zielony/żółty/czerwony (to zostaje
wewnętrzne, w `docs/fair-play.md`). Publicznie zawsze dajemy **interpretację
pozytywną** — argumenty za tym, że funkcja jest fair, w tym pochodzenie danych
(„z raportów, które sam otworzyłeś" itp.). Jedyny wyjątek, gdzie uczciwie
przyznajemy graniczność, to **budzik** (`borderline: true`) — generator dokłada
tam szczery komentarz.

## Tłumaczenia (później)

Baza to PL (`locale: 'pl'`). Ścieżka i18n: docelowo `content/<lang>/<slug>.mjs`
i parametr języka w `build.mjs`; szablon i taksonomia bez zmian. Na razie nie
budujemy tej warstwy — dopiero gdy treść PL się ustabilizuje.
