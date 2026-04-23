# OG-E v5 — Pomysły na przyszłość

Miejsce na notatki o usprawnieniach pojawiających się w toku analiz/prac.
Nie zobowiązujące. Dodawać swobodnie, oceniać kiedy aktualnie dowieźliśmy
główny cel.

---

## 1. `sendExp`: użyj `fleetDispatcher.expeditionCount` zamiast DOM counting — DONE

Zaimplementowane jako warstwa WSPÓŁISTNIEJĄCA z istniejącym DOM counting:
per-planet DOM count nadal rządzi (potrzebny do `maxExpPerPlanet` —
ustawienia per-planeta), ale GLOBALNY cap-check czyta snapshot
`fleetDispatcherSnapshot` (`expeditionCount` / `maxExpeditionCount`).

Co dodano w `src/features/sendExp.js`:
- Typedef `FleetDispatcherSnapshot` + module-local `fleetDispatcherSnapshot`
  cache (mirror pattern z `features/sendCol.js`).
- Bootstrap read `window.fleetDispatcher` na install (Firefox Xray /
  testy) + listener `oge5:fleetDispatcher` aktualizujący cache.
- Pre-click gate: `isGlobalExpeditionCapReached()` — gdy snapshot
  reportuje 14/14, od razu paint "All maxed!", bez żadnego DOM walku.
- Post-send guard: `isGlobalExpeditionCapReachedAfterNextSend()` —
  w gałęzi "current planet maxed", zanim zawołamy `findPlanetWithExpSlot(true)`,
  sprawdzamy czy snapshot mówi 13/14 (czyli ten send nas zepcha do maxa).
  Jeśli tak, nie szukamy innej planety — paint "All maxed!" i stop.
- Dispose zdejmuje listener. Backward-compat: gdy snapshot jest `null`
  (non-fleetdispatch page, testy które nie dispatchują eventu) —
  zachowanie identyczne jak wcześniej.

Test hook `_resetFleetDispatcherSnapshotForSendExpTest` w `sendExp.js`;
3 nowe testy w `test/features/sendExp.test.js` (14/14, 5/14, 13/14).

Nie wycinano DOM countingu per-planet — jest dalej potrzebny do
ustawienia `maxExpPerPlanet` (ile ekspedycji per planeta może wisieć),
które ma inną semantykę niż globalny cap gry.

---

## 2. AGR logo — poprawki wizualne — DONE

Zmiany w `src/features/agrLogoRewire.js`:

- Kwadrat wymuszony inline stylem `width:27px; height:27px; display:block`
  z `!important` — klik-target już się nie rozjeżdża niezależnie od
  aktywnej klasy AGR.
- Źródło obrazu przełączone z `icons/icon.png` (500×500, rozmyty po
  skalowaniu do 27) na `icons/icon48.png` — ostre krawędzie przy
  downscale 48→27. `.ico` nie był potrzebny skoro mamy dedykowany
  PNG w rozmiarze bliskim docelowemu.
- Hover state przez osobny `<style id="oge5-agr-logo-hover">`
  (idempotentny, dispose usuwa) — inline style nie obsługuje
  pseudo-klas. Reguła: `opacity 0.85 → 1` + `filter: brightness(1.2)`
  z transition 120 ms.
- Dispose restore'uje inline style verbatim + zdejmuje `<style>`.

Testy: 3 nowe w `test/features/agrLogoRewire.test.js` (square, hover
CSS, dispose cleanup). STUB_ICON_URL zaktualizowany na `icon48.png`.

## 3. Readability boost — kolory + rozmiar — DONE

Zmiany w `src/features/readabilityBoost.js`:

- `#eventboxFilled`: rozdzielone reguły — `color: #fff !important`
  tylko na ROOT (elementy bez własnego koloru dziedziczą biały; spany
  z grą-narzuconym kolorem jak `ago_color_*` zachowują tint). Bold
  nadal na `*` (additywne, bez kolizji).
- `a.ago_movement.tooltip.ago_color_lightgreen`: `color` na
  root + `*` (subtree), ale `font-size: larger !important` i
  `font-weight: bold !important` tylko na ROOT — `larger` jest
  relatywne, pushowanie go przez `*` kompoundowałoby rozmiar na
  każdym poziomie zagnieżdżenia.

Testy: 1 nowy w `test/features/readabilityBoost.test.js` —
regression guard regexem na `#eventboxFilled *` rule block (nie może
zawierać `color:`). Plus sprawdzenie obecności `font-size: larger`.

## 4. (placeholder — dodawać nowe tutaj)
