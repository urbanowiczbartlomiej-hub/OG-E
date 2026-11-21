// @ts-check

// Discovery: src/sync/gist.js, src/sync/scheduler.js, src/sync/merge.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'device-sync',
  category: 'dashboard',
  locale: 'pl',

  name: 'Sync między urządzeniami',
  oneLiner:
    'Komputer i telefon widzą te same dane OG-E — przez Twój własny, prywatny gist na GitHubie.',
  flagship: true,
  order: 5,

  idea: [
    'W zakładce **Sync** w Dashboardzie włączasz **Sync across devices** i wklejasz swój **token GitHub** (wystarczy uprawnienie `gist`). Od tej pory OG-E trzyma kopię danych w **Twoim prywatnym giście** i dogrywa ją na każdym urządzeniu.',
    'Synchronizuje się to, czego nie da się odtworzyć: historia kolonii, wywiad Spyglassa, lista obserwowanych, trasy Daily Run i ustawienia. Skany Galaktyki i lista graczy liczą się na każdym urządzeniu od nowa z publicznego API.',
    'Dane się **łączą**: listy (kolonie, raporty) uzupełniają się wzajemnie, a ustawienia i trasy bierze się w całości z nowszej wersji.',
  ],

  value: [
    'Grasz na komputerze i na telefonie? Bez syncu każde urządzenie wie co innego. Z nim — wszędzie widzisz to samo, bez ręcznego przenoszenia.',
  ],

  fairplay: {
    summary: [
      'Sync **nigdy nie łączy się z serwerem gry** — rozmawia tylko z GitHubem, z gistem, który należy do Ciebie.',
      'Jest **opcjonalny** i domyślnie wyłączony: bez Twojego tokena nic nie wychodzi z przeglądarki. Synchronizowane są wyłącznie Twoje własne dane zebrane w czasie gry.',
    ],
  },

  details: [
    '**Stored on this device** pokazuje, ile danych jest na tym urządzeniu dla każdego serwera i kiedy była ostatnia synchronizacja.',
    'Skończyłeś grę na serwerze? **Abandon** pobiera archiwum i usuwa dane z tego urządzenia (kopia w giście zostaje).',
    '**Alliance share (Spyglass)** to osobna, opcjonalna wymiana wywiadu z sojusznikami.',
  ],

  screenshots: [
    { id: 'settings', caption: 'Zakładka Sync: token GitHub, „Sync now" i podsumowanie danych serwera na tym urządzeniu.' },
  ],

  codeRefs: [
    'src/sync/gist.js',
    'src/sync/scheduler.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
