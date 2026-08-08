// @ts-check

// ŻYWY przycisk OG-E na stronie dokumentacji — prawdziwy FAB, nie makieta.
//
// Ten plik NIE implementuje przycisku. Implementacja mieszka w `src/` i jest
// stąd tylko URUCHAMIANA: powłoka FAB-a (`features/shared/unifiedFab.js`),
// budowa przycisku (`features/shared/button.js`), drag
// (`features/shared/draggableButton.js`), geometria orbit
// (`features/shared/unifiedFabPure.js`), tożsamości modułów
// (`features/shared/fabModules.js`), cykl życia sterowany ustawieniami
// (`features/shared/fabSettingsLifecycle.js`) i BLOK USTAWIEŃ z panelu
// rozszerzenia (`features/settingsUi/controls.js` + `sections/floatingButton.js`).
// Dzięki temu demo nie może się rozjechać z produktem — zmiana w `src/`
// natychmiast zmienia to, co widać na stronie.
//
// Dlaczego to działa w przeglądarce bez rozszerzenia: cały ten graf importów
// nie tyka `chrome.*` w czasie ładowania (`lib/storage.js` sięga po
// `browser ?? chrome` dopiero wewnątrz funkcji) ani DOM-u gry (`button.js` z
// założenia go nie czyta), a trwałość FAB-a — pozycja, rozmiar, aktywny moduł —
// idzie przez `safeLS`, czyli czysty `localStorage`. To dlatego generator może
// po prostu SKOPIOWAĆ dotknięte pliki `src/` do `dist/` (patrz site/build.mjs
// § graf modułów) i wpuścić je na stronę jako natywne ESM — bez bundlera,
// bez zależności, bez forka kodu.
//
// Czego demo NIE robi: nie wysyła żądań, nie dotyka gry, nie zna floty.
// Dotknięcie przycisku maluje etykietę scenariuszową (prawdziwym
// `labelLines`) i nic poza tym — to pokaz mechaniki (przesuwanie,
// przełączanie modułów, rozmiar), nie symulator rozgrywki.
//
// Klucze w `localStorage` domeny docs to te same nazwy `oge_*`, których używa
// rozszerzenie (nie forkujemy `safeLS`) — inne pochodzenie, więc z danymi gry
// nie mają kontaktu.

import { safeLS } from '../../src/lib/storage.js';
import {
  settingsStore,
  initSettingsStore,
  FAB_POS_KEY,
  SETTINGS_PREFIX,
} from '../../src/state/settings.js';
import { createButton, labelLines } from '../../src/features/shared/button.js';
import { FAB_MODULES } from '../../src/features/shared/fabModules.js';
import { installFabSettingsLifecycle } from '../../src/features/shared/fabSettingsLifecycle.js';
import {
  ABANDON_GLYPH,
  EYE_GLYPH,
  LIGHTHOUSE_GLYPH,
} from '../../src/features/shared/buttonGlyphs.js';
import { BG_SPY_IDLE } from '../../src/features/sendSpy/pure.js';
import { buildRow, syncInputsFromState } from '../../src/features/settingsUi/controls.js';
import { floatingButtonSection } from '../../src/features/settingsUi/sections/floatingButton.js';

/**
 * Tożsamości trzech modułów, które JEŻDŻĄ na FAB-ie, ale nie mają wpisu w
 * `fabModules.js`: ich widoczność nie jest sterowana module barem (własny
 * przełącznik / alert / kontekst), więc produkt trzyma ich meta inline w
 * plikach ficzerów — a te ciągną `state/` i `sync/`, czego w przeglądarce na
 * docs nie da się załadować. Glify są PRAWDZIWE (`buttonGlyphs.js`), kolor
 * Spyglassa też (`sendSpy/pure.js`); dwie wartości hex poniżej są jedyną
 * rzeczą powtórzoną z ficzerów — trzymaj je zgodne z
 * `alarmClock/guardian.js` (RIM) i `abandon/colonyFab.js` (ABANDON_COLOR).
 * @type {import('../../src/features/shared/unifiedFab.js').FabModuleMeta[]}
 */
const EXTRA_MODULES = [
  { id: 'spy', name: 'Spy', color: BG_SPY_IDLE, glyph: EYE_GLYPH },
  { id: 'guard', name: 'Fleet reminder', color: '#f5851a', glyph: LIGHTHOUSE_GLYPH },
  { id: 'colony', name: 'Abandon', color: '#fb7185', glyph: ABANDON_GLYPH },
];

/**
 * Jeden moduł demo: prawdziwa meta + parametry przycisku wzięte z ficzera,
 * plus etykieta spoczynkowa i ta po dotknięciu (fikcja scenariuszowa).
 *
 * @typedef {object} DemoModule
 * @property {import('../../src/features/shared/unifiedFab.js').FabModuleMeta} meta
 * @property {string} title      grawer na pierścieniu (jak w ficzerze).
 * @property {number} fontScale  jak w ficzerze.
 * @property {keyof import('../../src/state/settings.js').Settings} [settingKey]
 *   pole ustawień rządzące widocznością (moduły komendowe); brak = zawsze widoczny.
 * @property {{ main: string, sub?: string }} idle
 * @property {{ main: string, sub?: string }} tapped
 */

/**
 * Wszystkie moduły, jakie FAB potrafi hostować — cztery komendowe z
 * `FAB_MODULES` (rządzone module barem) plus trzy kontekstowe.
 * @type {DemoModule[]}
 */
const MODULES = [
  {
    meta: FAB_MODULES.exp,
    title: 'Expeditions',
    fontScale: 0.18,
    settingKey: FAB_MODULES.exp.settingKey,
    idle: { main: 'Send', sub: '3 free' },
    tapped: { main: 'Sent', sub: 'slot 1 of 3' },
  },
  {
    meta: FAB_MODULES.col,
    title: 'Colonization',
    fontScale: 0.18,
    settingKey: FAB_MODULES.col.settingKey,
    idle: { main: 'Colonize', sub: '4:207:9' },
    tapped: { main: 'On the way', sub: '12:40' },
  },
  {
    meta: FAB_MODULES.lf,
    title: 'Lifeforms',
    fontScale: 0.18,
    settingKey: FAB_MODULES.lf.settingKey,
    idle: { main: 'Discover', sub: '2 left' },
    tapped: { main: 'Sent', sub: '1 left' },
  },
  {
    meta: FAB_MODULES.fs,
    title: 'Daily Run',
    fontScale: 0.12,
    settingKey: FAB_MODULES.fs.settingKey,
    idle: { main: 'Daily Run', sub: '6 bodies' },
    tapped: { main: 'Zone 1', sub: '2 of 6' },
  },
  {
    meta: EXTRA_MODULES[0],
    title: 'Spyglass',
    fontScale: 0.18,
    idle: { main: 'Scan', sub: '9 systems' },
    tapped: { main: 'Scanning', sub: '3 of 9' },
  },
  {
    meta: EXTRA_MODULES[1],
    title: 'Fleet reminder',
    fontScale: 0.18,
    idle: { main: 'Fleet bare', sub: '2h 10m' },
    tapped: { main: 'Noted', sub: 'hold to dismiss' },
  },
  {
    meta: EXTRA_MODULES[2],
    title: 'Abandon colony',
    fontScale: 0.18,
    idle: { main: 'Abandon', sub: '4:207:9' },
    tapped: { main: 'Confirm?', sub: 'tap again' },
  },
];

/** Rozmiar FAB-a zasiewany przy PIERWSZEJ wizycie (produkt domyślnie ma 320 px,
 *  co na stronie dokumentacji przykrywa pół ekranu). */
const SEED_SIZE_PX = 120;
/** Odstęp od krawędzi dla zasiewanej pozycji startowej. */
const SEED_EDGE_PX = 20;
/** Jak długo przycisk trzyma etykietę „po dotknięciu”. */
const TAP_LABEL_MS = 1400;

/** Czy `initSettingsStore()` już poszedł (jest idempotentny, ale nie wołamy go w pętli). */
let settingsReady = false;

/** Odsubskrybowania cyklu życia modułów — trzymane do `disableFab()`. @type {(() => void)[]} */
let unsubs = [];

/** Czy FAB jest zmontowany. */
let live = false;

/**
 * Odpal store ustawień (write-through do `localStorage`) i przy pierwszej
 * wizycie zasiej rozmiar oraz pozycję: bez tego przycisk startuje z 320 px w
 * prawym dolnym rogu, czyli dokładnie pod mobilnym przełącznikiem spisu
 * funkcji. Zasiew dotyczy TYLKO braku zapisanej wartości — raz przesunięty
 * albo przeskalowany przycisk zostaje tam, gdzie go zostawiono.
 *
 * @returns {void}
 */
const ensureSettings = () => {
  if (settingsReady) return;
  settingsReady = true;
  const sizeStored = safeLS.get(SETTINGS_PREFIX + 'fabBtnSize') != null;
  initSettingsStore();
  if (!sizeStored) settingsStore.set({ ...settingsStore.get(), fabBtnSize: SEED_SIZE_PX });
  if (safeLS.json(FAB_POS_KEY) == null) {
    const size = settingsStore.get().fabBtnSize;
    safeLS.set(
      FAB_POS_KEY,
      JSON.stringify({
        x: SEED_EDGE_PX,
        y: Math.max(SEED_EDGE_PX, window.innerHeight - size - SEED_EDGE_PX),
      }),
    );
  }
};

/**
 * Zbuduj jeden moduł i podłącz go pod PRAWDZIWY cykl życia sterowany
 * ustawieniami (mount / unmount na przełączniku module bara, live-resize na
 * suwaku rozmiaru) — ten sam `installFabSettingsLifecycle`, którego używa
 * każdy send*-ficzer.
 *
 * @param {DemoModule} mod
 * @returns {() => void} odsubskrybowanie + rozmontowanie modułu.
 */
const installModule = (mod) => {
  const id = `oge-demo-${mod.meta.id}`;
  /** @type {ReturnType<typeof createButton>} */
  let ctl = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let revert = null;
  let installed = true;

  const paint = (/** @type {{ main: string, sub?: string }} */ parts) =>
    ctl?.paintLines('z', labelLines(parts));

  const mount = () => {
    if (ctl) return;
    ctl = createButton({
      id,
      title: mod.title,
      ringId: `${id}-ring`,
      size: settingsStore.get().fabBtnSize,
      fontScale: mod.fontScale,
      module: mod.meta,
      zones: [
        {
          key: 'z',
          id: `${id}-z`,
          ariaLabel: mod.title,
          bg: mod.meta.color,
          glyph: mod.meta.glyph,
          onTap: () => {
            paint(mod.tapped);
            if (revert) clearTimeout(revert);
            revert = setTimeout(() => paint(mod.idle), TAP_LABEL_MS);
          },
        },
      ],
    });
    paint(mod.idle);
  };

  const removeButton = () => {
    if (revert) clearTimeout(revert);
    revert = null;
    ctl?.dispose();
    ctl = null;
  };

  const unsub = installFabSettingsLifecycle({
    settingsStore,
    enabled: (s) => (mod.settingKey ? Boolean(s[mod.settingKey]) : true),
    mount,
    removeButton,
    updateButtonSize: (size) => ctl?.resize(size),
    isInstalled: () => installed,
  });

  return () => {
    installed = false;
    unsub();
    removeButton();
  };
};

/**
 * Pokaż FAB na stronie. Idempotentne.
 * @returns {void}
 */
export const enableFab = () => {
  if (live) return;
  live = true;
  ensureSettings();
  unsubs = MODULES.map(installModule);
};

/**
 * Zdejmij FAB ze strony (powłoka znika sama z ostatnim modułem — patrz
 * `maybeTeardown` w unifiedFab.js). Idempotentne.
 * @returns {void}
 */
export const disableFab = () => {
  if (!live) return;
  live = false;
  for (const off of unsubs) off();
  unsubs = [];
};

/**
 * Zbuduj blok ustawień FAB-a — PRAWDZIWY pierwszy blok panelu rozszerzenia:
 * module bar (kafelek = orb 1:1) plus suwak `fabBtnSize`, oba podpięte pod
 * `settingsStore`. `buildRow` zwraca `<tr>` (panel w grze to tabela), więc
 * opakowujemy go w minimalną tabelę.
 *
 * Jedyna zmiana wobec produktu: zdejmujemy `topSlot`, czyli przycisk „Open
 * Dashboard” — na stronie dokumentacji nie ma strony rozszerzenia, do której
 * mógłby prowadzić, a martwy przycisk to gorsze kłamstwo niż jego brak.
 *
 * @returns {HTMLElement}
 */
export const buildSettingsBlock = () => {
  ensureSettings();
  const opt = { ...floatingButtonSection.options[0], topSlot: undefined };
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;';
  const tbody = document.createElement('tbody');
  tbody.appendChild(buildRow(opt));
  table.appendChild(tbody);
  // Zapisy z INNEGO źródła niż ten blok (np. zasiew rozmiaru) muszą go
  // przemalować — dokładnie to robi settingsUi/index.js w rozszerzeniu.
  settingsStore.subscribe(() => syncInputsFromState());
  return table;
};

/**
 * Skasuj zapamiętaną pozycję i rozmiar, potem przemontuj — wyjście awaryjne,
 * gdy ktoś zostawi przycisk 560 px na środku ekranu.
 * @returns {void}
 */
export const resetFab = () => {
  const wasLive = live;
  disableFab();
  safeLS.remove(FAB_POS_KEY);
  settingsStore.set({ ...settingsStore.get(), fabBtnSize: SEED_SIZE_PX });
  settingsReady = false;
  if (wasLive) enableFab();
};
