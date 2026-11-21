// @ts-check

// Discovery: src/domain/dangerScore.js (ocena 0–100, archetypy, sygnały apex),
//   src/domain/dangerJoin.js (złączenie publicznych feedów), src/domain/players.js,
//   src/features/dashboard/targets.js (tabela, kolumny, filtry, top-N).
// KLUCZOWY punkt sprzedaży: liczy się z PUBLICZNYCH danych, więc działa dla
//   całego serwera od pierwszego uruchomienia, bez ani jednej wysłanej sondy.

/** @type {import('./_schema.mjs').Feature} */
export default {
  id: 'spyglass-danger',
  category: 'spyglass',
  locale: 'pl',

  name: 'Ranking zagrożenia (Danger)',
  oneLiner:
    'Cały serwer w jednej tabeli, od najgroźniejszego: liczba 0–100 mówi, z kim nie zadzierać, a kogo można zaatakować.',
  flagship: true,
  order: 2,

  idea: [
    'Tabela **Players** sortuje serwer po kolumnie **Danger**. Ta liczba nie mierzy punktów, tylko **ile z nich może po Ciebie przylecieć**: obrona nie atakuje, więc OG-E oddziela ją od floty, sprawdza, czy flota to transportowce czy okręty bojowe, i dokłada sygnały agresji (zniszczenia, bandyta, rozrzut kolonii, klasa sojuszu).',
    'Kolumna **Fleet** pokazuje **≤** — to górna granica, nie pomiar. Gdy zeskanujesz wszystkie ciała gracza, znak znika i zostaje dokładna liczba.',
  ],

  value: [
    'Ranking punktowy myli: gracz z górą obrony wygląda groźniej niż ten, który realnie zniszczy Twoją flotę. Danger rozdziela te przypadki — dla całego serwera, jeszcze przed pierwszą sondą.',
  ],

  fairplay: {
    summary: [
      'To **arytmetyka na publicznych statystykach serwera** — tych samych, z których korzystają narzędzia społeczności.',
      'Tabela niczego nie wysyła. **+ watch** tylko dopisuje gracza do Twojej listy obserwowanych.',
    ],
  },

  details: [
    'Kto ma choć jeden statek, ma co najmniej 8. Twój sojusz i przyjaciele są oznaczeni jako `friendly`.',
    'Rodzaj konta (np. `fleet-heavy`, `defence only`, `miner`) i powody oceny znajdziesz w dossier gracza.',
    'Filtry: top 50 / 100 / 200 / all, **watch list**, **miners**, ukryj nieaktywnych, widełki punktów wojskowych (wpisz np. `15M` albo `2.5b`). Wyszukiwarka znajduje po nicku, sojuszu i tagu.',
  ],

  screenshots: [
    { id: 'players', caption: 'Ranking graczy posortowany po Danger — obok górna granica floty, punkty wojskowe i rodzaj statków.' },
    { id: 'breakdown', caption: 'Rozbicie oceny w dossier: z czego wzięła się liczba.' },
  ],

  codeRefs: [
    'src/domain/dangerScore.js',
    'src/domain/dangerJoin.js',
    'src/domain/players.js',
    'src/features/dashboard/targets.js',
  ],

  status: 'drafted',
};
