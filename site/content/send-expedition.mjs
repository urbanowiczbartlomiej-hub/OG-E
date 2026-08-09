// @ts-check

// Discovery: src/features/sendExpedition/*, src/bridges/expeditionRedirect.js,
//   src/domain/fleetOwnership.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'send-expedition',
  category: 'fab',
  locale: 'pl',

  name: 'Wyślij Ekspedycję',
  oneLiner:
    'Codzienne wysyłasz setki ekspedycji z wielu planet? Teraz zrobisz to jednym dużym i wygodnym przyciskiem FAB, z automatycznym przeskokiem na następną planetę.',
  flagship: true,
  order: 2,

  idea: [
    'Przycisk **Ekspedycje** rozpozna, czy jesteś na stronie z flotą — jeśli nie, przekieruje Cię na nią. Kolejne kliknięcie wymaga konfiguracji ekspedycji w **AGR**. Sam skład floty, cel i typ misji ustala rutyna AGR — OG-E jedynie naciska we właściwej chwili właściwy natywny przycisk gry. Jeśli rutyna ekspedycji AGR nie pozwala wysłać ekspedycji, przycisk odpowiednio na to reaguje.',
    'Przycisk **sam przechodzi do następnej** planety z wolnym slotem, aż do wyczerpania limitów. Pomija te, z których już wysłał ekspedycję, i przeskakuje do następnej, jeśli flota nie jest wystarczająca.',
    'Przycisk można **przytrzymać**, żeby jawnie pominąć aktywną planetę i przeskoczyć do następnej.',
    'W praktyce cały obchód to rytm **dwóch tapnięć na jedną ekspedycję**: pierwsze otwiera stronę floty właściwej planety, drugie wysyła. 30 tapnięć = 15 wysłanych ekspedycji — i to bez celowania w malutkie natywne przyciski.',
  ],

  value: [
    'Bez tego wysyłka ekspedycji z kilkunastu planet to dziesiątki precyzyjnych kliknięć w malutki natywny przycisk. Tu cały obchód robisz kciukiem, nie pamiętając nawet, z których planet już poszło.',
  ],

  fairplay: {
    summary: [
      'OG-E **nie wysyła żądań do gry**: klika rutynę AGR i natywny przycisk „wyślij" — te same elementy, które nacisnąłbyś sam. Wysyłkę wykonuje gra, po Twoim tapnięciu. Skład i cel ekspedycji ustala AGR, nie OG-E.',
      'Automatyczny przeskok na kolejną planetę tylko podpowiada grze, którą stronę pokazać po wysyłce — nie generuje własnego ruchu do serwera.',
    ],
  },

  details: [
    'Auto next planet — automatyczne otwarcie następnej planety po wysyłce (możesz wyłączyć w ustawieniach).',
    'Max/planet — limit równoczesnych ekspedycji na planetę (1 lub 2).',
  ],

  screenshots: [
    { id: 'button', caption: 'Moduł „Ekspedycje" — etykieta zależna od strony (Exped / Send).' },
  ],

  codeRefs: [
    'src/features/sendExpedition/index.js',
    'src/bridges/expeditionRedirect.js',
    'src/domain/fleetOwnership.js',
  ],

  status: 'drafted',
};
