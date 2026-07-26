// @ts-check

// Discovery: src/features/sendLifeform/*, src/bridges/systemDiscoveryObserver.js,
//   src/state/lifeformArtifacts.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'discover-lifeforms',
  category: 'fab',
  locale: 'pl',

  name: 'Discovery lifeform',
  oneLiner:
    'Jeden przycisk, który wie, gdzie jest najbliższy nieodkryty system, i pozwala go odkryć jednym tapnięciem, by łatwo zdobyć artefakty form życia.',
  flagship: true,
  order: 4,

  idea: [
    'Przycisk **Lifeforms** prowadzi Cię po odkrywaniu systemów: sam wskazuje **najbliższy nieodkryty** system, przenosi tam widok i pozwala go odkryć jednym tapnięciem. Systemy odkryte niedawno pomija, żeby nie marnować akcji — wraca do nich, kiedy znów będą dostępne.',
    'Dodatkowo, przy Twojej wizycie na stronie badań form życia, odczytuje, ile masz obecnie artefaktów, a jeśli dawno tam nie zaglądałeś — zaproponuje przejście na tę stronę. Wszystko po to, żeby przypomnieć, że masz ich już 3600 lub więcej.',
  ],

  value: [
    'Ręcznie to żmudny obchód galaktyki w poszukiwaniu tego, co jeszcze nieodkryte — przycisk zdejmuje z Ciebie tę nawigację i pilnuje, żebyś nie klikał w systemy już odkryte. Dodatkowo jest wygodny na mobile.',
  ],

  fairplay: {
    summary: [
      'OG-E **nie inicjuje odkrycia samo** — klika natywny przycisk „odkryj system", i to tylko wtedy, kiedy Ty klikniesz, a flotę wysyła gra, dokładnie jak przy Twoim ręcznym kliknięciu.',
      'Licznik artefaktów odczytuje **wyłącznie z tego, co gra już wyświetla**, przy Twojej naturalnej wizycie na stronie badań — bez żadnych zapytań w tle.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Przycisk „Lifeforms" w widoku galaktyki — gotowy odkryć bieżący system.' },
    { id: 'sent-count', caption: 'Sygnał wysłania 8 misji odkrywania.' },
  ],

  codeRefs: [
    'src/features/sendLifeform/index.js',
    'src/bridges/systemDiscoveryObserver.js',
    'src/state/lifeformArtifacts.js',
  ],

  status: 'drafted',
};
