// @ts-check

// Discovery: src/features/agrLogo.js — przejmuje bezczynny do tej pory
//   przycisk logo AntiGameReborn (AGR): podmienia obrazek na ikonę OG-E i
//   spina klik z otwarciem menu AGR + rozwinięciem zakładki Ustawień OG-E.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'agr-logo',
  category: 'other',
  locale: 'pl',

  name: 'Logo AGR jako skrót do ustawień',
  oneLiner:
    'Bezczynny dotąd przycisk logo AntiGameReborn dostaje ikonę OG-E i jednym kliknięciem otwiera menu opcji razem z zakładką Ustawień OG-E.',
  order: 2,

  idea: [
    'AGR ma w rogu przycisk-logo, który domyślnie prawie nic nie robi po kliknięciu. Zamiast malować drugi, osobny przycisk na pasku, OG-E przejmuje ten — podmienia obrazek na własną ikonę i podpina klik pod dwie rzeczy naraz: otwarcie menu opcji AGR i automatyczne rozwinięcie w nim zakładki Ustawień OG-E.',
    'To czysto kosmetyczna podmiana grafiki i jeden listener kliknięcia — reszta menu AGR działa dokładnie tak samo jak zawsze.',
  ],

  value: [
    'Jedno kliknięcie zamiast dwóch (otwórz menu, potem znajdź zakładkę OG-E) — a przy okazji od razu widać, że rozszerzenie jest aktywne, bo ikona w rogu to nie jest już domyślne logo AGR.',
  ],

  fairplay: {
    summary: [
      'To wyłącznie **podmiana obrazka i skrót klawiszowy do już istniejącego menu** — nie dodaje żadnej nowej funkcji ani żądania do gry, tylko szybszą ścieżkę do ustawień, które i tak są dostępne przez AGR.',
      'Jeśli AGR nie załaduje się w ciągu 10 sekund, moduł po cichu nic nie robi — logo AGR zostaje bez zmian, żadnego błędu na ekranie.',
    ],
  },

  screenshots: [
    { id: 'logo', caption: 'Ikona OG-E w miejscu domyślnego logo AGR, w rogu paska.' },
  ],

  codeRefs: [
    'src/features/agrLogo.js',
  ],

  status: 'drafted',
};
