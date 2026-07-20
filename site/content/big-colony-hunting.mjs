// @ts-check

// Discovery: src/features/sendColony/*, src/features/abandon/*,
//   src/domain/apiOccupancy.js, src/domain/galaxyScanConfig.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'big-colony-hunting',
  category: 'fab',
  locale: 'pl',

  name: 'Polowanie na kolonie (+ porzucanie małych)',
  oneLiner:
    'Jeden przycisk wskazuje kolejny najlepszy wolny slot z całego serwera i wysyła kolonizatora — a drugi pomaga porzucić za małe kolonie.',
  flagship: true,
  order: 3,

  idea: [
    'Moduł **Kolonizacja** sam wskazuje **kolejny najlepszy wolny slot** w całym uniwersum (wg Twoich preferencji co do pozycji i galaktyk) i wysyła tam kolonizatora — pomijając miejsca, które gra właśnie oznaczyła jako zajęte. Licznik „N free" pokazuje na żywo, ile wybranych pozycji jest jeszcze wolnych.',
    'Towarzyszy mu moduł **Porzuć kolonię**: wyłapuje świeżo skolonizowaną, **za małą** planetę i prowadzi przez jej porzucenie, żebyś mógł spróbować gdzie indziej. Raz porzucony slot nie wróci już jako propozycja na żadnym Twoim urządzeniu.',
  ],

  value: [
    'Polowanie na duże kolonie to inaczej ręczne przeczesywanie galaktyk, pilnowanie odstępów między lądowaniami i porzucanie nietrafionych planet. Ten duet prowadzi cały cykl: znajdź wolne miejsce → wyślij → jeśli za małe, porzuć i próbuj dalej.',
  ],

  details: [
    'Wolne miejsca biorą się z **publicznego API OGame** (mapa zajętych planet serwera) — to dane kandydackie, potwierdzane żywym widokiem galaktyki, zanim kolonizator poleci.',
    'Przycisk pilnuje minimalnego odstępu między lądowaniami — jeśli kolejne wypadłoby za blisko, pokazuje „Wait Ns".',
    'Odliczanie lądowania chodzi na zegarze serwera i sam proponuje odświeżenie, gdy nowa kolonia już jest.',
  ],

  fairplay: {
    summary: [
      'OG-E **nie wysyła żądań do gry** — klika natywne elementy wysyłki i porzucenia, dokładnie te, które nacisnąłbyś sam. Rozmiar planety do decyzji o porzuceniu odczytuje z **już wyświetlonego** przeglądu, bez dodatkowego zapytania.',
      'Dane o wolnych miejscach pochodzą z **publicznego, statystycznego API** (tego samego, z którego korzystają narzędzia społeczności) — czyli mapy zajętości serwera, a nie z jakiegokolwiek masowego skanowania w tle. Bez tych danych przycisk działa tylko na tym, co sam przeskanowałeś normalną grą.',
    ],
  },

  settings: [
    'Docelowe pozycje, preferencja obcych galaktyk, minimalny odstęp lądowań, próg „za mała kolonia" (konfiguracja per-universe w Dashboardzie).',
    'Hasło do porzucania kolonii (wymagane przez moduł Porzuć).',
  ],

  screenshots: [
    { id: 'n-free', caption: 'Moduł „Kolonizacja" z licznikiem „N free" — ile wybranych pozycji wciąż wolnych.' },
    { id: 'abandon', caption: 'Moduł „Porzuć kolonię" na przeglądzie za małej, świeżej kolonii.' },
  ],

  codeRefs: [
    'src/features/sendColony/index.js',
    'src/features/abandon/index.js',
    'src/domain/apiOccupancy.js',
    'src/domain/galaxyScanConfig.js',
  ],

  status: 'drafted',
};
