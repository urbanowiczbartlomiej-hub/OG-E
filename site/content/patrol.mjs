// @ts-check

// Discovery: src/features/dashboard/patrol.js, src/domain/patrol.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'patrol',
  category: 'spyglass',
  locale: 'pl',

  name: 'Patrol',
  oneLiner:
    'Pilnuje okolicy Twoich planet: pokazuje, kogo w pobliżu warto teraz sprawdzić, i jak dawno ją oglądałeś.',
  order: 7,

  idea: [
    'Ustawiasz promień, np. **± 3 układy** od Twoich planet (w tej samej galaktyce). Karta **Patrol** w Spyglassie pokazuje wtedy dwie rzeczy: **okazje na księżycach** w okolicy (wg ustawienia **Moon strike**) i ile zamieszkanych układów ma **świeży, stary albo żaden** podgląd.',
    'Przycisk Spyglass prowadzi Cię po tej okolicy (etykieta **patrol (N)**). Ciekawego sąsiada jednym tapnięciem dodajesz do obserwowanych (**+ watch**).',
  ],

  value: [
    'Lista obserwowanych to polowanie na konkretnego gracza. Patrol to pilnowanie własnego terenu — łupem jest każdy w pobliżu, kto się zagapi.',
  ],

  fairplay: {
    summary: [
      'Patrol **tylko podpowiada**. Podglądy to Twoje własne przeglądanie Galaktyki, a sonda leci dopiero po Twoim tapnięciu — natywnym formularzem floty.',
      'Karta korzysta wyłącznie z danych, które OG-E już ma: z Twoich podglądów i z publicznego API OGame. Nie ma przycisku „wyślij do wszystkich".',
    ],
  },

  details: [
    'Promień ustawiasz w ustawieniach Spyglassa (**Patrol ± N sys**); `0` = wyłączony (domyślnie).',
    'Podgląd uznaje się za świeży wg ustawienia **Re-look**.',
    'Pomijani są: gracze w trybie urlopowym, zbanowani, administratorzy, pod ochroną nowicjusza, Twój sojusz i przyjaciele.',
  ],

  screenshots: [
    { id: 'card', caption: 'Karta Patrol: okazje w okolicy i stan podglądów (świeże / stare / brak).' },
  ],

  codeRefs: [
    'src/features/dashboard/patrol.js',
    'src/domain/patrol.js',
  ],

  status: 'drafted',
};
