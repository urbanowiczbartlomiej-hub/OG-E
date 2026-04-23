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

## 2. (placeholder — dodawać nowe tutaj)
