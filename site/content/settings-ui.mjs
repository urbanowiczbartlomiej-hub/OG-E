// @ts-check

// Discovery: src/features/settingsUi/index.js (zakładka wstrzykiwana do menu
//   opcji AGR — AntiGameReborn), sections/data.js (przycisk „Otwórz Dashboard"),
//   sections/floatingButton.js (pasek modułów FAB + suwak rozmiaru),
//   sections/preferences.js (grupy Expeditions / Display).

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'settings-ui',
  category: 'game-ui',
  locale: 'pl',

  name: 'Ustawienia OG-E w panelu AGR',
  oneLiner:
    'Wszystkie przełączniki OG-E siedzą jako jedna zakładka w istniejącym menu opcji AGR — jedno miejsce, bez osobnego panelu do szukania.',
  order: 1,

  idea: [
    'OG-E dokleja się do menu opcji **AntiGameReborn (AGR)** zamiast stawiać własny, pływający panel — to samo menu, co już jest dodane w grze, dostaje jedną dodatkową zakładkę. Na jej szczycie stoi przycisk **„Otwórz Dashboard"** (prowadzi do pełnostronicowego panelu OG-E), poniżej pasek modułów FAB — kafelki włączają/wyłączają poszczególne przyciski na orbitach (Ekspedycje, Kolonizacja, Discovery, Daily Run) — i suwak rozmiaru przycisku.',
    'Pod spodem siedzą opcje konfiguracji przycisku Ekspedycje oraz grupa **Display** — zmiany interfejsu w samej grze. Każdy kafelek ma podpis-słowo i dłuższy opis po najechaniu myszką; wszystkie zostaną opisane dalej.',
  ],

  value: [
    'Dwa osobne panele do ustawień to dwa miejsca do zapamiętania. Trzymając się jednego menu, którego AGR-owi użytkownicy i tak szukają, OG-E nie dokłada drugiego mentalnego modelu „gdzie to włączyć" — tym bardziej że OG-E i tak wymaga AGR do poprawnego działania.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **panel konfiguracji** — każdy przełącznik zapisuje wartość lokalnie i nic nie wysyła do gry ani na zewnątrz. Zmiana ustawienia nie jest akcją w grze.',
      'Integracja z AGR polega na dopisaniu zakładki do już istniejącego DOM-u menu (`#ago_menu_content`) — nic nie jest przy tym ukrywane ani podmieniane w interfejsie AGR.',
    ],
  },

  details: [
    'Wymaga zainstalowanego AGR — bez niego nie ma gdzie wstrzyknąć zakładki (ustawienia można edytować ręcznie w localStorage, ale to ścieżka niewspierana).',
  ],

  screenshots: [
    { id: 'tab', caption: 'Zakładka OG-E w menu opcji AGR: przycisk Dashboard, pasek modułów FAB, grupy Expeditions/Display.' },
  ],

  codeRefs: [
    'src/features/settingsUi/index.js',
    'src/features/settingsUi/sections/data.js',
    'src/features/settingsUi/sections/floatingButton.js',
    'src/features/settingsUi/sections/preferences.js',
  ],

  status: 'drafted',
};
