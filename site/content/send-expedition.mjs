// @ts-check

// Discovery: src/features/sendExpedition/*, src/bridges/expeditionRedirect.js,
//   src/domain/fleetOwnership.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'send-expedition',
  category: 'fab',
  locale: 'pl',

  name: 'Wyślij wyprawę',
  oneLiner:
    'Codzienne wyprawy z wielu planet jako seria tapnięć w jeden duży przycisk, z automatycznym przeskokiem na następną planetę.',
  flagship: true,
  order: 2,

  idea: [
    'Moduł **Wyprawy** zamienia codzienne rozsyłanie wypraw w serię tapnięć w jeden duży przycisk. Sam skład floty, cel i typ misji ustala rutyna **AGR**, którą i tak uruchamiasz — OG-E jedynie naciska we właściwej chwili właściwy natywny przycisk gry.',
    'Gdy z jednej planety wysłałeś już tyle wypraw, ile chcesz, przycisk **sam przechodzi do następnej** planety z wolnym slotem — aż do wyczerpania limitów.',
  ],

  value: [
    'Bez tego wysyłka wypraw z kilkunastu planet to dziesiątki precyzyjnych kliknięć w malutki natywny przycisk. Tu cały obchód robisz kciukiem, nie pamiętając nawet, z których planet już poszło.',
  ],

  fairplay: {
    summary: [
      'OG-E **nie wysyła żądań do gry**: klika rutynę AGR i natywny przycisk „wyślij" — te same elementy, które nacisnąłbyś sam. Wysyłkę wykonuje gra, po Twoim tapnięciu. Skład i cel wyprawy ustala AGR, nie OG-E.',
      'Automatyczny przeskok na kolejną planetę tylko podpowiada grze, którą stronę pokazać po wysyłce — nie generuje własnego ruchu do serwera. Cudzej ani ręcznie uzbrojonej floty przycisk nie rusza.',
    ],
  },

  settings: [
    'Auto next planet — automatyczne otwarcie następnej planety po wysyłce (opcja opt-out).',
    'Max/planet — limit równoczesnych wypraw na planetę (1 lub 2).',
  ],

  screenshots: [
    { id: 'button', caption: 'Moduł „Wyprawy" — etykieta zależna od strony (Exped / Send).' },
    { id: 'auto-next', caption: 'Automatyczny przeskok na następną planetę z wolnym slotem po wysyłce.' },
  ],

  codeRefs: [
    'src/features/sendExpedition/index.js',
    'src/bridges/expeditionRedirect.js',
    'src/domain/fleetOwnership.js',
  ],

  status: 'drafted',
};
