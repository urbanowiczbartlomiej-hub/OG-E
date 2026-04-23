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

## 2. AGR logo — poprawki wizualne

- `#ago_menubutton_logo` musi być KWADRATEM (`height:27px; width:27px`
  z `display:block`). Obecne aspect ratio pozwala się rozjeżdżać zgodnie
  z CSS AGR.
- Dodać hover state (np. `filter: brightness(1.2)` albo `opacity:1` z
  domyślnym `0.85`).
- PNG 500×500 (`icons/icon.png`) nie ma dobrego kształtu po przeskalowaniu
  do 27×27. Lepiej użyć pliku `.ico` z wieloma rozmiarami albo wygenerować
  dedykowany `icons/icon-27.png` / `icon-16.png`. Ewentualnie inline SVG.
- Pozostało: w `src/features/agrLogoRewire.js` popraw `background-size`
  + dodaj `background-position: center` (już jest). Dodać `:hover` rule
  przez style'owany `<style>` tag (inline style nie obsługuje pseudo-klas).

## 3. Readability boost — kolory + rozmiar

- Tekst w `#eventboxFilled` stracił oryginalne kolory po naszej regule
  `color: #fff !important`. Część tekstów powinna zachować kolor gry
  (np. zasoby) — reguła jest zbyt agresywna. Trzeba precyzyjniej:
  target na CONKRETNE tekstowe children, nie na wszystko z `*`.
- `a.ago_movement.tooltip.ago_color_lightgreen` — po zmianie koloru
  nadal za małe. Dodać `font-size: larger` / konkretny `font-size` +
  ewentualnie `font-weight: bold`.
- Plik: `src/features/readabilityBoost.js`. Zmienić reguły CSS +
  być może dodać oddzielną regułę `font-size` niezależną od koloru.

## 4. (placeholder — dodawać nowe tutaj)
