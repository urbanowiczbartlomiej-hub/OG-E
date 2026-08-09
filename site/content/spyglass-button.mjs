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
    'Orb Spyglassa na FAB-ie prowadzi Cię po galaktyce i podpowiada, kogo obejrzeć, a do kogo wysłać sondę.',
  order: 7,

  idea: [
    'Spyglass to jeden z orbów przycisku OG-E. Sam nic nie wymyśla na miejscu — **działa dokładnie wg ustawień z zakładki Spyglass w Dashboardzie**: to tam trzymasz listę obserwowanych graczy, terminy ponownego skanu i to, czy interesują Cię planety, księżyce, czy jedno i drugie.',
    'W grze przycisk sprowadza to do jednego tapnięcia: pomaga **obserwować galaktykę** (podsuwa kolejny system, który warto obejrzeć) i **wysyłać sondy szpiegowskie** tam, gdzie dane się zestarzały. Kolejne tapnięcie prowadzi do następnego celu z listy.',
  ],

  value: [
    'Bez tego wywiad to ręczne przeklikiwanie galaktyki i pamiętanie, kogo i kiedy się już oglądało. Przycisk zamienia to w rytm tapnięć, a całą decyzję „co dalej" podejmuje na podstawie ustawień, które raz sobie zdefiniowałeś.',
  ],

  details: [
    'Każda z funkcji wywiadu — ranking zagrożenia, dossier, rutyna, mapa, patrol — ma własny opis w rozdziale „Spyglass — wywiad".',
    'Orb włączasz i wyłączasz jak każdy inny: kafelkiem na pasku przycisków w Ustawieniach OG-E.',
  ],

  fairplay: {
    summary: [
      'Przycisk **nie wysyła żadnych żądań do gry** — klika natywne elementy widoku galaktyki i natywną wysyłkę sondy, dokładnie te, które nacisnąłbyś sam. Tempo wyznaczasz Ty: nie ma tu żadnej pętli działającej w tle ani bez Twojego tapnięcia.',
      'Wszystko, co przycisk wie, pochodzi z ekranów, które i tak otworzyłeś, oraz z ustawień, które sam zapisałeś w Dashboardzie.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'Orb Spyglassa na przycisku OG-E — podpowiada kolejne spojrzenie na galaktykę albo wysyłkę sondy.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/dashboard/index.js',
  ],

  status: 'drafted',
};
