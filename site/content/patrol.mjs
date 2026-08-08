// @ts-check

// Discovery: src/features/dashboard/patrol.js, src/domain/patrol.js.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'patrol',
  category: 'spyglass',
  locale: 'pl',

  name: 'Patrol',
  oneLiner:
    'Karta na zakładce Szpieguj pilnująca Twojego rewiru: co jest teraz w zasięgu do uderzenia i czy pokrycie obserwacją jest zdrowe.',
  order: 7,

  idea: [
    'Patrol traktuje Twoje kolonie jak **kratę pokrycia** i patrzy na wszystkie układy w promieniu ±kilku systemów od Twoich ciał (w tej samej galaktyce, z zawinięciem mapy). Karta odpowiada na dwa pytania: **co jest teraz do złapania** w rewirze (lista uderzeń — te same sygnały, które oznacza szpiegowski Przycisk OG-E) oraz **czy pokrycie jest zdrowe** (ile układów ma świeży, przeterminowany albo żaden podgląd).',
    'Sąsiada z listy uderzeń jednym tapnięciem awansujesz na listę obserwowanych (patrol → gwiazdka → snajperka). Kartę widać tylko, gdy promień patrolu jest ustawiony — przy zerze nie ma żadnego UI.',
  ],

  value: [
    'Lista obserwowanych to narzędzie snajpera — jeden gracz, rozpracowany. Patrol jest narzędziem drapieżnika terytorialnego: łupem jest ktokolwiek w pobliżu, kto się zagapi (wracający fleet-save na księżycu zapominalskiego sąsiada), a nie nazwisko tropione miesiącami. Karta pokazuje, czy rewir jest realnie obchodzony.',
  ],

  fairplay: {
    summary: [
      'Wszystko zostaje **pasywne i tylko-proponujące**. Podglądy patrolu to Twoje własne przeglądanie galaktyki (niewykrywalne), a uderzenie to wciąż jedno świadome tapnięcie na sondę — OG-E nic nie wysyła samo, inicjuje natywne kliknięcie w widoku galaktyki gry.',
      'Karta liczy się **z danych, które OG-E już ma** — z Twoich skanów i publicznego API czytanego przy otwartej karcie gry. Rewir to skończony zbiór układów, więc zapis jest z natury ograniczony. Karta niczego nie wysyła; sama pokazuje intel i nie ma przycisku „wyślij wszystko".',
    ],
  },

  details: [
    'Promień patrolu (w systemach) to jedno pokrętło, ustawiane na zakładce Szpieguj; 0 = patrol wyłączony.',
    'Filtry szumu odsiewają siebie, urlop/ban/admina, buddy, własny sojusz i graczy pod ochroną nowicjusza.',
  ],

  screenshots: [
    { id: 'card', caption: 'Karta Patrol na zakładce Szpieguj z listą uderzeń i podsumowaniem pokrycia.' },
    { id: 'watch', caption: 'Awans sąsiada na listę obserwowanych jednym tapnięciem „gwiazdka".' },
  ],

  codeRefs: [
    'src/features/dashboard/patrol.js',
    'src/domain/patrol.js',
  ],

  status: 'drafted',
};
