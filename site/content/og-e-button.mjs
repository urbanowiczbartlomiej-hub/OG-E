// @ts-check

// Discovery: src/features/shared/{unifiedFab,draggableButton,button,fabModules,
//   fabSettingsLifecycle}.js, src/features/settingsUi/sections/floatingButton.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'og-e-button',
  category: 'fab',
  locale: 'pl',

  name: 'Przycisk OG-E (FAB)',
  oneLiner:
    'Inteligentny pływający przycisk, który z łatwością tapniesz kciukiem, obsługując rutynowe akcje floty.',
  flagship: true,
  order: 1,

  idea: [
    'FAB (z ang. Floating Action Button) to jeden pływający przycisk, który ułatwia akcję floty takie jak Ekspedycje, Kolonizację, Odkrywanie Form Życia, Codzienne trasy, Zabezpieczenie Floty, Obserwacja Aktywności i Szpiegowanie. Każdy przycisk zostanie opisany w osobnej sekcji. Zawsze widzisz jeden aktywny przycisk w środku i kilka mniejszych „orbów" dookoła; tapnięcie orba przełącza aktywny przycisk, a tapnięcie środka wykonuje jego akcję na bieżącej stronie.',
    'Przycisk przeciągasz w dowolne miejsce (pozycja i wybór jest zapamiętywany), a każdy z nich sam wie na jakiej stronie jesteś i jakie masz możliwości.',
  ],

  value: [
    'Jest pomyślany **mobile-first**: na telefonie OGame skaluje stronę tak, że natywne przyciski robią się malutkie i trudno w nie trafić. FAB daje jeden **duży, wygodny cel pod kciukiem** i skupia rozrzucone akcje floty w jednym miejscu — na desktopie też działa, ale to telefon jest głównym scenariuszem.',
  ],

  details: [
    'Pasek przycisków — włącz/wyłącz, jeśli nie korzystasz z funkcji i nie chcesz jej widzieć na orbitach FAB.',
    'Rozmiar przycisku regulujesz suwakiem (zmiana na żywo).',
    'Pozycja i wybrany przycisk są zapamiętywane per urządzenie; po przeładowaniu FAB wraca w to samo miejsce (przycięty do widocznego ekranu).',
    'Long-press ma osobne znaczenie zależne od aktywnego przycisku (np. „pomiń tę planetę").',
    'Jeden z orbów to **Spyglass**: włączasz go i zarządzasz nim z zakładki `Spyglass` w Dashboardzie OG-E (lista obserwowanych, ustawienia skanów), a w grze proponuje kolejne spojrzenie na galaktykę albo wysyłkę sondy szpiegowskiej — patrz osobny rozdział „Spyglass — wywiad".',
  ],

  fairplay: {
    summary: [
      'FAB **nie wysyła do gry żadnych żądań**. Przekazuje Twoje kliknięcie do tego samego natywnego elementu interfejsu, który nacisnąłbyś sam — jeśli gra w reakcji łączy się z serwerem, robi to sama, po Twoim tapnięciu, dokładnie jak przy ręcznym kliknięciu.',
      'Działa tylko na tym, co i tak masz otwarte: odczytuje to, co gra już wyświetla, i nic nie robi w tle — nie odświeża strony, nie skanuje, nie śledzi gry.',
    ],
  },

  screenshots: [
    { id: 'orbits', caption: 'Pływający przycisk: jeden aktywny przycisk w środku, pozostałe jako orby dookoła.' },
    { id: 'module-bar', caption: 'Pasek przycisków w ustawieniach — kafelki włączają/wyłączają poszczególne przyciski.' },
  ],

  codeRefs: [
    'src/features/shared/unifiedFab.js',
    'src/features/shared/draggableButton.js',
    'src/features/shared/button.js',
    'src/features/shared/fabModules.js',
    'src/features/settingsUi/sections/floatingButton.js',
  ],

  status: 'drafted',
};
