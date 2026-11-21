// @ts-check

// Discovery: src/features/sendSpy/* (moduł FAB), src/features/dashboard/
//   (zakładka Spyglass — lista obserwowanych i ustawienia skanów, które ten
//   przycisk czyta). Strona-towarzysz do rozdziału „Spyglass — wywiad": tu
//   jest sam PRZYCISK, tam cała analityka za nim.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-button',
  category: 'fab',
  locale: 'pl',

  name: 'Spyglass (przycisk)',
  oneLiner:
    'Złoty przycisk z okiem: podpowiada, który układ obejrzeć, a gdzie wysłać sondę — i pojawia się tylko wtedy, gdy jest coś do zrobienia.',
  order: 7,

  idea: [
    'Przycisk **Spyglass** pojawia się sam, gdy masz obserwowanych graczy, włączone **Neighbours** (domyślnie tak, raz na dobę) albo ustawiony **Patrol** — i znika, gdy nie ma nic do zrobienia. Nie włączasz go kafelkiem jak pozostałych.',
    'Etykieta mówi, co dalej: **Look** — obejrzyj ten układ w Galaktyce, **Spy** — sonda na jedno ciało (drugie tapnięcie, **Send**, wysyła ją), **Strike** — okazja na księżycu. **neighbours** i **patrol (N)** to obchód okolicy, **Reports** — czekają nowe raporty szpiegowskie, **Home** — nowi sąsiedzi do przejrzenia w Dashboardzie.',
    'Co i jak często sprawdzać, ustawiasz raz w zakładce **Spyglass** w Dashboardzie.',
  ],

  value: [
    'Zamiast pamiętać, kogo i kiedy ostatnio oglądałeś, po prostu tapiesz. Przycisk sam układa kolejkę układów i sond z Twoich ustawień.',
  ],

  details: [
    'Szczegóły analizy — ranking zagrożenia, dossier, rutyna, mapa, patrol — opisuje rozdział „Spyglass — wywiad".',
    'Przytrzymanie przycisku przez 2 s gasi podpowiedź **Home**.',
  ],

  fairplay: {
    summary: [
      '**Look** to zwykłe przejście do układu w Galaktyce. Sonda to dwa tapnięcia: pierwsze wypełnia natywny formularz floty (statek, cel, misja **Szpieguj**), drugie naciska przycisk wysyłki gry. Zawsze jedno ciało, nic w tle.',
      'Przycisk korzysta z tego, co widziałeś w grze, z publicznego API OGame i z Twoich ustawień.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Spyglass na przycisku OG-E: „Look" — obejrzyj układ [1:116], zostało jeszcze 79 celów.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
