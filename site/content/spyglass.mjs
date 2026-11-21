// @ts-check

// Discovery: src/features/dashboard/index.js (zakładka Spyglass),
//   src/features/sendSpy/*, src/domain/spyScan.js, src/state/watchList.js.
// To STRONA-WSTĘP całego rozdziału: model myślowy (dwa kanały + lista
//   obserwowanych) i spis sześciu pytań, na które odpowiadają kolejne strony.
//   Szczegóły algorytmów NIE tutaj — one żyją na stronach szczegółowych.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass',
  category: 'spyglass',
  locale: 'pl',

  name: 'Spyglass — wywiad',
  oneLiner:
    'Wywiad o graczach serwera w jednym miejscu: kto jest groźny, kogo warto zaatakować, gdzie leżą surowce i kiedy właściciela nie ma.',
  flagship: true,
  order: 1,

  idea: [
    'Spyglass zbiera wiedzę na dwa sposoby: **podgląd** układu w Galaktyce (darmowy, cel nic nie widzi) i **sonda szpiegowska** (raport pokazuje flotę, obronę i surowce, ale cel o niej wie). Podstawą jest **lista obserwowanych** — plus Twoja okolica (**Neighbours**, **Patrol**).',
    'W grze **przycisk Spyglass** podsuwa jedno następne działanie. W Dashboardzie zakładka **Spyglass** to czytelnia: ranking graczy, dossier, mapa, sąsiedzi i „kto Cię szpieguje". Ranking działa od pierwszego uruchomienia — z publicznych statystyk serwera.',
  ],

  value: [
    'Zamiast setki raportów szpiegowskich w skrzynce i notatnika ze współrzędnymi — gotowe odpowiedzi na sześć pytań (niżej). Kolejne strony tego rozdziału opisują każde z nich.',
  ],

  fairplay: {
    summary: [
      'Spyglass korzysta z **publicznych statystyk serwera**, ze **stron gry, które sam otworzyłeś**, i z **Twoich raportów szpiegowskich** (opcjonalnie także z danych udostępnionych przez sojuszników). Bez otwartej gry nic się nie dzieje.',
      'Zakładka w Dashboardzie **nie ma żadnego przycisku wysyłki**. Sondę wysyłasz tylko z gry, przyciskiem Spyglass, zawsze na jedno ciało. Nie ma „przeskanuj wszystko".',
    ],
  },

  details: [
    '**Kogo unikać, a kogo można zaatakować?** — ranking zagrożenia (Danger).',
    '**Co sprawdzić jako następne?** — przycisk Look / Spy / Strike.',
    '**Czy warto atakować i gdzie leżą surowce?** — dossier gracza.',
    '**Kiedy go nie ma?** — rutyna i okna offline.',
    '**Kto mnie dosięgnie?** — mapa pozycji i zasięg.',
    '**Kto mnie szpieguje i kto mieszka obok?** — „Kto Cię szpieguje" i „Your neighbours".',
  ],

  screenshots: [
    { id: 'tab', caption: 'Zakładka Spyglass: lista obserwowanych, ustawienia skanów i ranking graczy.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/sendSpy/index.js',
    'src/domain/spyScan.js',
    'src/state/watchList.js',
  ],

  status: 'drafted',
};
