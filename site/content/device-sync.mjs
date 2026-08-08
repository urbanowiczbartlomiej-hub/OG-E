// @ts-check

// Discovery: src/sync/gist.js, src/sync/scheduler.js, src/sync/merge.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'device-sync',
  category: 'dashboard',
  locale: 'pl',

  name: 'Sync między urządzeniami',
  oneLiner:
    'Twoje zebrane dane (skany galaktyki, historia kolonii) wędrują między komputerem a telefonem przez Twój własny prywatny GitHub gist.',
  flagship: true,
  order: 5,

  idea: [
    'Podłączasz w Ustawieniach **własny token GitHub** (klasyczny PAT z jednym uprawnieniem `gist`), a OG-E trzyma Twoje lokalnie zebrane dane w **prywatnym giście, który należy do Ciebie**. Każde urządzenie wysyła i pobiera przez `api.github.com` — nigdzie indziej.',
    'Łączenie stron jest **przyrostowe i lokalne-najpierw**: przy pobraniu zdalne wpisy są dokładane do lokalnych (nowszy skan wygrywa), nic nie jest hurtowo nadpisywane. Wysyłka jest zdławiona 15-sekundowym oknem, żeby seria skanów przy przewijaniu galaktyki złożyła się w jeden upload zamiast kilkunastu.',
  ],

  value: [
    'Grasz na kilku urządzeniach, a wiedza zebrana normalną grą — klasyfikacje skanów, obserwacje kolonii — rozjeżdża się między nimi. Sync sprawia, że każde urządzenie po starcie widzi ten sam, scalony, aktualny obraz, bez ręcznego przenoszenia.',
  ],

  fairplay: {
    summary: [
      'Sync **nigdy nie kontaktuje się z serwerem gry**. Cały ruch idzie do usługi, którą kontrolujesz (Twój gist na GitHubie), poza pasmem gry. To pozycja OG-E w regulaminie: czytamy tylko strony gry wyrenderowane w Twojej przeglądarce, a Twoje dane synchronizują się osobnym kanałem.',
      'Jest **całkowicie opt-in**: bez wklejonego przez Ciebie tokena nic nie wychodzi na zewnątrz. Token ma najmniejsze możliwe uprawnienie (`gist`) i mieszka lokalnie. Synchronizowane są tylko Twoje własne dane zebrane grą — nie ma śledzenia gry w tle.',
    ],
  },

  details: [
    'Sekrety (token GitHub, token ntfy) nigdy nie trafiają do synchronizowanego pliku ani eksportu.',
    'Przy błędach limitu GitHuba (403/429) moduł wchodzi w backoff i nie bije bez sensu w API — mieści się w budżecie 5000 żądań/h.',
  ],

  screenshots: [
    { id: 'settings', caption: 'Pole tokena GitHub w Ustawieniach OG-E — sync jest opt-in.' },
    { id: 'merge', caption: 'Dwa urządzenia po scaleniu widzą ten sam, aktualny obraz danych.' },
  ],

  codeRefs: [
    'src/sync/gist.js',
    'src/sync/scheduler.js',
    'src/sync/merge.js',
  ],

  status: 'drafted',
};
