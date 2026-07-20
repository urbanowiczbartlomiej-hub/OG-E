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
    'Jeden przycisk sam znajduje najbliższy nieodkryty system i pozwala go odkryć jednym tapnięciem — po artefakty form życia.',
  flagship: true,
  order: 4,

  idea: [
    'Moduł **Lifeforms** prowadzi Cię po odkrywaniu systemów: sam wskazuje **najbliższy nieodkryty** system, przenosi tam widok i pozwala go odkryć jednym tapnięciem. Systemy odkryte niedawno pomija, żeby nie marnować akcji.',
    'Dodatkowo, przy Twojej wizycie na stronie badań form życia, pokazuje, ile artefaktów już uzbierałeś — sygnał, kiedy warto je spożytkować.',
  ],

  value: [
    'Odkrywanie systemów daje **artefakty form życia** do badań. Ręcznie to żmudny obchód mapy w poszukiwaniu, co jeszcze nieodkryte — przycisk zdejmuje z Ciebie tę nawigację i pilnuje, żebyś nie klikał w systemy na cooldownie.',
  ],

  fairplay: {
    summary: [
      'OG-E **nie inicjuje odkrycia samo** — klika natywny przycisk „odkryj system", a flotę wysyła gra, dokładnie jak przy Twoim ręcznym kliknięciu.',
      'Licznik artefaktów odczytuje **wyłącznie z tego, co gra już wyświetla**, przy Twojej naturalnej wizycie na stronie badań — bez żadnych zapytań w tle.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Moduł „Lifeforms" w widoku galaktyki — gotowy odkryć bieżący system.' },
    { id: 'artifact-cap', caption: 'Sygnał uzbieranych artefaktów — czas zajrzeć na badania form życia.' },
  ],

  codeRefs: [
    'src/features/sendLifeform/index.js',
    'src/bridges/systemDiscoveryObserver.js',
    'src/state/lifeformArtifacts.js',
  ],

  status: 'drafted',
};
