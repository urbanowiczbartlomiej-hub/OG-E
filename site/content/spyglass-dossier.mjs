// @ts-check

// Discovery: src/features/dashboard/dossier.js (obie kolumny, tabela ciał,
//   chipy pokrycia), src/domain/raidVerdict.js (nagłówek + jednozdaniowy
//   werdykt), src/domain/threatModel.js (widoczne/ukryte), src/domain/
//   civilBaseline.js (odniesienie do budowniczego), src/domain/lootRhythm.js
//   (loot avg / peak, znacznik skarbca).
// Podział rozdziału: TU są twarde liczby (materia), rytm w czasie jest na
//   stronie „Rutyna i okna offline".

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-dossier',
  category: 'spyglass',
  locale: 'pl',

  name: 'Dossier gracza',
  oneLiner:
    'Wszystko o jednym graczu: werdykt w jednym zdaniu, skąd ocena zagrożenia i tabela jego planet i księżyców z obroną, flotą i surowcami.',
  order: 4,

  idea: [
    'Po lewej **werdykt** — np. `loaded · heavily defended · loot ~16.27B · scan 25h old` — i jedno zdanie, co z tym zrobić. Niżej rozbicie oceny i ciekawa liczba: punkty wojskowe **minus** to, co widziały Twoje raporty, daje flotę, której nigdzie nie ma — zwykle jest w locie, na fleet-save.',
    'Po prawej **tabela ciał**: dla każdej planety i księżyca wiek skanu, ostatnia aktywność, obrona, flota oraz średnie i najwyższe surowce, jakie tam zastałeś (**loot avg**, **peak**).',
  ],

  value: [
    'Tu decydujesz: atakować czy odpuścić, a jeśli atakować — to gdzie. Zamiast dwudziestu raportów szpiegowskich z różnych tygodni masz jedną tabelę z historią.',
  ],

  fairplay: {
    summary: [
      'Obrona, flota i surowce pochodzą **tylko z raportów szpiegowskich, które sam otworzyłeś**. Dossier je pamięta i porządkuje, nic nie zdobywa samo.',
      'Dossier nie ma przycisku wysyłki — sondę wysyłasz świadomie z gry.',
    ],
  },

  details: [
    'Łup w werdykcie to **najbogatsza jedna planeta** przeliczona przez procent łupu — bo jeden atak zabiera z jednego ciała.',
    'Werdykty: `RAID NOW`, `loaded · fleet risk`, `loaded · heavily defended`, `skip — empty`, `scan first`, `can\'t hit` (poza Twoim zasięgiem ataku), `friendly`.',
    '**Watch via** (galaxy / probes) i przełącznik sond przy każdym ciele decydują, gdzie wolno wysyłać sondy.',
  ],

  screenshots: [
    { id: 'report', caption: 'Dossier: po lewej werdykt i ocena, po prawej wszystkie ciała gracza.' },
    { id: 'bodies', caption: 'Tabela ciał: wiek skanu, aktywność, obrona, flota oraz średnie i najwyższe surowce.' },
  ],

  codeRefs: [
    'src/features/dashboard/dossier.js',
    'src/domain/raidVerdict.js',
    'src/domain/threatModel.js',
    'src/domain/civilBaseline.js',
    'src/domain/lootRhythm.js',
  ],

  status: 'drafted',
};
