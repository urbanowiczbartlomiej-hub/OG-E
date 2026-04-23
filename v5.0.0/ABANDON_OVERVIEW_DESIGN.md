# abandonOverview — projekt

**Cel**: wydzielić "porzucanie za małych kolonii" z `sendCol` jako samodzielny
feature `features/abandonOverview.js`. Pokazuje **big red overlay na
`#planet` div** na stronie overview, gdy colony jest fresh i za mały.

**Motywacja**:
1. Usuwa największy cross-cutting concern z sendCol (`checkAbandonState`
   wołane w 5 miejscach).
2. UX lepszy — abandon jest prominentny na overview, nie ukryty jako
   drugi stan scanHalf.
3. Separation of concerns — jeden feature = jedna odpowiedzialność.

**Status**: proposal, równolegle z `SENDCOL_DESIGN.md`. Do akceptacji
przed implementacją.

---

## 1. Precondition

Feature robi coś tylko wtedy gdy WSZYSTKIE:
- `location.search.includes('component=overview')`
- `checkAbandonState(settings)` truthy (istniejąca funkcja w `abandon.js`,
  bez zmian — overview + `usedFields===0` + `maxFields<colMinFields`)
- `#planet` div istnieje w DOM
- `settings.colonizeMode === true` (user włączył feature kolonizacji
  w ogóle — bez tego i tak nie ma `colMinFields` jako sensownej wartości)

Gdy którykolwiek warunek false → brak overlay, brak innych side effectów.

## 2. Co overlay robi wizualnie

Na stronie `component=overview` z fresh-small colony, na wierzchu `#planet`
div (który jest dużym kontenerem grafiki planety + podstawowych liczb),
pokazuje się:

```
┌─────────────────────────────────────┐
│                                     │
│         ⚠ ABANDON ⚠                 │
│                                     │
│       [g:s:p]  max: 145 pól        │
│                                     │
│    (click to start 3-click flow)    │
│                                     │
└─────────────────────────────────────┘
```

Styl: czerwony fill (`rgba(160, 0, 0, 0.85)`), biała czcionka 32px,
centered, border 3px white, border-radius 12px, semi-transparent żeby
planeta prześwitywała pod spodem (user widzi co usuwa).

**`position: absolute; inset: 0`** na `#planet` — ten sam trick co w
`abandon.js:makeInjectedButton`. Wymaga `parent.style.position = 'relative'`
na `#planet` div (tak jak robi `makeInjectedButtonHost`).

## 3. Interakcja

Klik na overlay → wywołuje istniejące `abandonPlanet()` z `abandon.js`:
1. Kliknęło w naszym overlay (click 1 z perspektywy usera)
2. `abandonPlanet()` robi pierwszy `safeClick(.openPlanetRenameGiveupBox)`
   → gra otwiera popup Giveup
3. `abandon.js` już ma pełny 3-click flow + 3 safety gates + overlay
   buttons WEWNĄTRZ popupów gry (4.9.3 pattern portowany, działa)
4. Flow kończy się `scansStore` update + `location.reload()`

**Nie dodajemy kolejnej warstwy confirm dialogu na nasz overlay** — abandon
flow ma 3 bezpieczniki w środku (`checkAbandonState` recheck, coord match
na popup, dialog text match). Dodatkowy confirm byłby redundantny i
irytujący.

## 4. Brak overlay — dlaczego

Gdy warunki nie zachodzą:
- `colMinFields` = 0 (user wyłączył abandon przez ustawienie 0) → nigdy
  nie triggeruje
- colony jest duża (`maxFields >= colMinFields`) → nic
- colony jest zabudowana (`usedFields > 0`) → nic
- nie jesteśmy na overview → nic

Overlay nie istnieje w DOM w tych przypadkach. Zero styling, zero event
listeners, zero koszt.

## 5. Lifecycle

```js
export const installAbandonOverview = () => {
  if (installed) return installed.dispose;

  const mount = () => { /* idempotent */ };
  const unmount = () => { /* clean */ };

  const refresh = () => {
    const settings = settingsStore.get();
    const info = checkAbandonState(settings);
    if (info && location.search.includes('component=overview')) {
      mount(info);  // idempotent — no-op if already mounted
    } else {
      unmount();
    }
  };

  refresh();  // initial

  // React do settings (colMinFields, colonizeMode change)
  const unsubSettings = settingsStore.subscribe(refresh);

  // MutationObserver na document.body — overview może być AJAX-swapped
  // (OGame robi to przy zmianie planety przez planetList). Obserwer
  // odpala refresh() przy każdym childList change na body.
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true });

  installed = {
    dispose: () => {
      unmount();
      unsubSettings();
      observer.disconnect();
      installed = null;
    },
  };
  return installed.dispose;
};
```

**MutationObserver na body** — analogicznie do `badges.js` po
Phase-10 polish. Konieczny bo user może przechodzić między overview
różnych planet bez full page reload (AGR / OGame quirks).

## 6. Integracja z sendCol

**Brak integracji.** To jest cały sens.

- `sendCol.js` już nie woła `checkAbandonState`
- `sendCol.js` już nie zna overlay styles
- `sendCol.js` już nie ma brancha "abandon mode"
- `abandonOverview.js` nie wie o istnieniu sendCol

Oba features importują z `abandon.js`:
- sendCol: **nic** (zero imports z abandon.js)
- abandonOverview: `checkAbandonState`, `abandonPlanet`

## 7. `content.js` wire-up

```js
import { installAbandonOverview } from './features/abandonOverview.js';

const installDomFeatures = () => {
  installColonyRecorder();
  installBadges();
  installSendExp();
  installSendCol();
  installAbandonOverview();  // NEW
  installFleetdispatchShortcut();
  installSettingsUi();
};
```

Jedna nowa linia plus import. Order nie matter (cross-feature niezależne).

## 8. Testy

Nowy plik `test/features/abandonOverview.test.js`:

- render overlay gdy pełne preconditions (mock settings + DOM z
  `#diameterContentField (0/145)` + location.search `component=overview`)
- brak overlay gdy `usedFields !== 0`
- brak overlay gdy `maxFields >= colMinFields`
- brak overlay na innej stronie
- click overlay → `abandonPlanet()` called (mock)
- settings subscribe: zmiana `colMinFields` odświeża stan
- dispose: usuwa overlay + unsubscribe + disconnect observer

Estymata: ~10 testów, ~150 LoC testu.

## 9. Interakcja z `badges.js` / innymi observers

Badges obserwuje `#planetList` + `#eventContent`. Nie koliduje z `#planet`.
Brak konfliktu.

## 10. Rozmiar

- `src/features/abandonOverview.js`: ~200 LoC (install/dispose, refresh,
  mount, unmount, styles, click wiring)
- `test/features/abandonOverview.test.js`: ~150 LoC

Razem: ~350 LoC nowego kodu.

Plus **po stronie sendCol**: usunięcie ~40 LoC związanych z abandon mode
(`BG_SCAN_ABANDON`, "Too small!" label, "Abandon" label, `checkAbandonState`
wołania w 5 miejscach, delegacja w `handleScanClick`). Netto: +310 LoC,
ale rozdzielone w czysty sposób.

---

## 11. Decyzje (zatwierdzone)

1. **Kolor + copy**: czerwony semi-transparent, "⚠ ABANDON ⚠" + coords +
   max fields + "click to start". ✅
2. **Preconditions**: tylko minimalne (overview + fresh + small). Bez
   guardów na fleet in-flight. ✅
3. **Target**: `#planet` div — potwierdzone przez usera. ✅
4. **Anti-misclick**: `pointer-events: none` na 500ms po mount, potem
   `auto`. ✅

Ruszamy razem z sendCol.
