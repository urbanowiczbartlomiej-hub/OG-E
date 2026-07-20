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
    'Jeden pływający przycisk pod kciukiem, z którego odpalasz wszystkie akcje floty — pomyślany przede wszystkim pod telefon.',
  flagship: true,
  order: 1,

  idea: [
    'FAB to **jeden pływający przycisk**, który hostuje moduły akcji floty — wyprawy, kolonizację, discovery, codzienne trasy, przypomnienia. Zawsze widzisz jeden aktywny moduł w środku i kilka mniejszych „orbów" dookoła; tapnięcie orba **przełącza** aktywny moduł, a tapnięcie środka wykonuje jego akcję na bieżącej stronie.',
    'Przycisk **przeciągasz** w dowolne miejsce (pozycja jest zapamiętywana), a każdy moduł sam wie, na której stronie gry ma sens.',
  ],

  value: [
    'Jest pomyślany **mobile-first**: na telefonie OGame skaluje stronę tak, że natywne przyciski robią się malutkie i trudno w nie trafić. FAB daje jeden **duży, wygodny cel pod kciukiem** i skupia rozrzucone akcje floty w jednym miejscu — na desktopie też działa, ale to telefon jest głównym scenariuszem.',
  ],

  details: [
    'Moduły włączasz i wyłączasz kafelkami w ustawieniach; rozmiar przycisku regulujesz suwakiem (zmiana na żywo).',
    'Pozycja i wybrany moduł są zapamiętywane per urządzenie; po przeładowaniu przycisk wraca w to samo miejsce (przycięty do widocznego ekranu).',
    'Long-press ma osobne znaczenie zależne od modułu (np. „pomiń tę planetę").',
  ],

  fairplay: {
    summary: [
      'FAB **nie wysyła do gry żadnych żądań**. Klika za Ciebie ten sam natywny element interfejsu, który nacisnąłbyś sam — jeśli gra w reakcji łączy się z serwerem, robi to sama, po Twoim tapnięciu, dokładnie jak przy ręcznym kliknięciu.',
      'Działa tylko na tym, co i tak masz otwarte: odczytuje to, co gra już wyświetla, i nic nie robi w tle — nie odświeża strony, nie skanuje, nie śledzi gry.',
    ],
  },

  settings: [
    'Pasek modułów — włącz/wyłącz poszczególne komendy (brak master-switcha; wszystkie wyłączone = brak przycisku).',
    'Suwak rozmiaru przycisku (na żywo).',
  ],

  screenshots: [
    { id: 'orbits', caption: 'Pływający przycisk: jeden aktywny moduł w środku, pozostałe jako orby dookoła.' },
    { id: 'dragging', caption: 'Przeciąganie przycisku pod kciuk — pozycja zapamiętywana per urządzenie.' },
    { id: 'module-bar', caption: 'Pasek modułów w ustawieniach — kafelki włączają/wyłączają komendy.' },
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
