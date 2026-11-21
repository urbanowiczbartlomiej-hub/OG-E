// @ts-check

// Discovery: src/features/sendSpy/{index,pure}.js (twarze przycisku, wysyłka),
//   src/domain/scanPriority.js (kolejność planu), src/domain/galaxyWatch.js
//   (plan zerknięć, sweep konta), src/domain/fleetLanding.js (moon strike),
//   src/domain/scanMode.js, src/state/watchList.js (ustawienia).
// UWAGA fair-play: wysyłka idzie natywnym dwuetapowym formularzem gry, jedno
//   ciało na raz; „Look" to zwykłe przejście do układu w widoku galaktyki.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-scan',
  category: 'spyglass',
  locale: 'pl',

  name: 'Skan: Look, Spy, Strike',
  oneLiner:
    'Przycisk Spyglass w grze podaje zawsze jedno następne działanie: darmowy podgląd układu, sondę albo okazję na księżycu.',
  order: 3,

  idea: [
    '**Look** — przejście do układu w Galaktyce: darmowe i niewidoczne dla celu. `×N` mówi, ile obserwowanych ciał odświeży ta jedna wizyta. **Spy** — sonda na jedno ciało, z nickiem gracza: tapnięcie wypełnia formularz floty i przycisk zmienia się na **Send**, kolejne wysyła sondę. **Strike** — podglądy sugerują flotę zaparkowaną na księżycu; podpowiada sondę, żeby to potwierdzić.',
    'Najpierw idą podglądy, potem sondy: najpierw nigdy nieskanowane ciała, potem te oznaczone do ponownego skanu, potem przeterminowane — groźniejsi gracze wyżej. **N left** — ile celów jeszcze czeka.',
  ],

  value: [
    'Nie musisz pamiętać, kogo i kiedy skanowałeś ani gdzie wystarczy podgląd zamiast sondy. Zostaje Ci jedna decyzja — tapnąć albo nie. Najwygodniej na telefonie.',
  ],

  fairplay: {
    summary: [
      'Każde działanie dotyczy **jednego** ciała. Sondę wysyła natywny formularz floty gry (misja **Szpieguj**), ten sam co przy ręcznej wysyłce, po Twoim tapnięciu. Look to zwykłe przejście do układu.',
      'Plan to **lista podpowiedzi, nie zadań** — bez timerów i bez wysyłek w tle.',
    ],
  },

  details: [
    'W ustawieniach wybierasz: co ile ponownie skanować (**Re-scan**) i oglądać (**Re-look**), ile sond, planety i/lub księżyce oraz z której planety startują sondy.',
    'Tam też są **Neighbours** i **Patrol** — dokładają podglądy Twojej okolicy.',
    'Gracza możesz śledzić wyłącznie podglądami — wtedy nie widzi niczego.',
    '**Moon strike** ustala, kiedy zaświecić Strike (off / lone / newest / any).',
  ],

  screenshots: [
    { id: 'look', caption: '„Look": podgląd układu — jedna wizyta odświeża dwa obserwowane ciała.' },
    { id: 'spy', caption: '„Spy": sonda na jedno ciało — tapnięcie przygotowuje wysyłkę, kolejne ją wysyła.' },
    { id: 'settings', caption: 'Ustawienia skanów: sondy, planety/księżyce, planeta startowa, terminy odświeżania, Moon strike.' },
  ],

  codeRefs: [
    'src/features/sendSpy/index.js',
    'src/features/sendSpy/pure.js',
    'src/domain/scanPriority.js',
    'src/domain/galaxyWatch.js',
    'src/domain/fleetLanding.js',
  ],

  status: 'drafted',
};
