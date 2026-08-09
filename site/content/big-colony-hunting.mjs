// @ts-check

// Discovery: src/features/sendColony/*, src/features/abandon/*,
//   src/domain/apiOccupancy.js, src/domain/galaxyScanConfig.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'big-colony-hunting',
  category: 'fab',
  locale: 'pl',

  name: 'Kolonizacja (polowanie na duże kolonie)',
  oneLiner:
    'Jeden przycisk wskazuje kolejny najlepszy wolny slot z całego serwera i wysyła kolonizatora — a drugi pomaga porzucić za małe kolonie.',
  flagship: true,
  order: 3,

  idea: [
    'Moduł **Kolonizacja** sam wskazuje kolejny najlepszy wolny slot w całym uniwersum (wg Twoich preferencji co do pozycji i galaktyk) i wysyła tam kolonizatora. Wykrywa, kiedy pozycja jest już zajęta, i umożliwia ustawienie kolejnych koordynat. Dzięki licznikowi „N free" pokazuje na żywo, ile wybranych pozycji jest jeszcze wolnych. Dzięki licznikowi minimalnego odstępu między czasem lądowania, można wysłać dziesiątki misji jedna po drugiej, zachowując czas niezbędny do tego, żeby porzucić zbyt małą kolonię.',
    'Rytm jest prosty: **dwa tapnięcia to jedna wysłana misja kolonizacji** — 40 tapnięć = 20 misji lecących jedna po drugiej. **Trzy tapnięcia** wystarczą, żeby porzucić kolonię, która okazała się za mała.',
    'Przyciskowi towarzyszy przycisk **Porzuć kolonię**. Wykrywa zbliżające się misje lądowania kolonizacji i proponuje przejście do nowej kolonii. Sprawdza jej wielkość i przeprowadza proces jej porzucenia, jeśli jest zbyt mała. Dzięki temu kolejna misja kolonizacji może lądować już za kilka sekund. Raz porzucony slot wróci do kandydatów kolonizacji dopiero po minimum 24h (w nocy, zgodnie z zasadami gry).',
  ],

  value: [
    'Znalezienie dużej kolonii wymusza wiele prób kolonizacji (nawet setki). Wymusza to przeglądanie galaktyki i poszukiwanie wolnych slotów, a dane te można mieć z darmowego API. Żeby wysłać całą falę wielu misji, niezbędne jest pilnowanie odstępów między lądowaniami i porzucanie nietrafionych planet, tak szybko jak to możliwe. Ten duet przycisków robi to za Ciebie i prowadzi cały cykl, pilnując, żeby Tobie było wygodnie. Ty tylko klikasz.',
  ],

  fairplay: {
    summary: [
      'OG-E **nie wysyła żądań do gry** — klika natywne elementy wysyłki i porzucenia, dokładnie te, które nacisnąłbyś sam.',
      'Dane o wolnych miejscach pochodzą z **publicznego, statystycznego API** (tego samego, z którego korzystają narzędzia społeczności) — czyli mapy zajętości serwera. Dane te łączymy z własnymi danymi o porzuceniach i odświeżamy raz na tydzień.',
    ],
  },

  details: [
    'Wolne miejsca biorą się z **publicznego API OGame** (mapa zajętych planet serwera) — to dane kandydackie, potwierdzane żywym widokiem galaktyki, zanim kolonizator poleci.',
    'Przycisk pilnuje minimalnego odstępu między lądowaniami — jeśli kolejne wypadłoby za blisko, pokazuje „Wait Ns".',
    'Odliczanie lądowania chodzi na zegarze serwera i sam proponuje odświeżenie, gdy nowa kolonia już jest.',
    'Docelowe pozycje, preferencja obcych galaktyk, minimalny odstęp lądowań, próg „za mała kolonia" (konfiguracja per-universe w Dashboardzie).',
    'Hasło do porzucania kolonii (wymagane przez moduł Porzuć).',
  ],

  screenshots: [
    { id: 'n-free', caption: 'Moduł „Kolonizacja" z licznikiem „N free" — ile wybranych pozycji wciąż wolnych.' },
    { id: 'wait', caption: 'Moduł „Kolonizacja" z licznikiem „N" sekund, które odlicza odstęp pomiędzy wysłaniem kolejnych kolonizatorów.' },
    { id: 'landing-soon', caption: 'Moduł „Porzuć kolonię" kiedy za kilka sekund musisz odświeżyć stronę, żeby sprawdzić czy nowa kolonia jest duża.' },
    { id: 'landed', caption: 'Moduł „Porzuć kolonię" kiedy statek kolonizacyjny wylądował i trzeba odświeżyć stronę.' },
    { id: 'abandon', caption: 'Moduł „Porzuć kolonię" ułatwia porzucenie zbyt małej nowej kolonii.' },
    { id: 'delete-confirm', caption: 'Moduł „Porzuć kolonię" kiedy chcesz potwierdzić porzucenie kolonii na zawsze.' },
    { id: 'settings', caption: 'Moduł „Kolonizacja" — ustawienia jakie planety kolonizować i kiedy porzucać.' },
  ],

  codeRefs: [
    'src/features/sendColony/index.js',
    'src/features/abandon/index.js',
    'src/domain/apiOccupancy.js',
    'src/domain/galaxyScanConfig.js',
  ],

  status: 'drafted',
};
