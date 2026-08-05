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
    'Cały serwer w jednej tabeli, posortowany od najgroźniejszego: liczba 0–100 i jedno słowo archetypu mówią, z kim nie zadzierać, a kogo można ruszyć.',
  flagship: true,
  order: 2,

  idea: [
    'Tabela `Players` to cały serwer poukładany według kolumny `Danger`. Ta liczba nie mierzy „ile ktoś ma punktów", tylko **ile z tych punktów może po Ciebie przylecieć**: punkty wojskowe zawierają obronę, a obrona nie atakuje — więc OG-E rozdziela je na część mobilną i nieruchomą, ocenia jakość kadłubów (koszt jednego statku) i porównuje wynik z całym serwerem. Do tego dokłada sygnały drapieżnika: procent zniszczeń, tier bandyty, rozrzut kolonii (ile serwera realnie dosięga) i klasę sojuszu.',
    'W kolumnie stoi sama liczba. **Rodzaj konta** — „fleet-heavy", „defence only", „active bandit", „miner", „cargo/probe swarm" — czeka w dossier gracza, tuż nad listą powodów, które go wyznaczyły: tam jest miejsce, żeby to wyjaśnić, a w kolumnie było tylko słowem do najechania kursorem. Kolumna `Fleet` pokazuje `≤`, bo to **sufit, nie pomiar** — dopiero komplet Twoich własnych raportów zbija go do dokładnej liczby i znak `≤` znika.',
  ],

  value: [
    'Highscore kłamie w obie strony: turtle z górą punktów obrony wygląda groźniej niż fleeter, który realnie Cię zniesie, a skarbiec bez floty wygląda jak drapieżnik. Jedna kolumna rozdziela te przypadki, więc wybór celu i ocena ryzyka to spojrzenie, nie śledztwo — i masz to dla całego serwera, jeszcze przed wysłaniem pierwszej sondy.',
  ],

  fairplay: {
    summary: [
      'Cała tabela to **arytmetyka na publicznych plikach statystyk serwera** — tych samych, z których korzystają narzędzia społeczności. Nic tu nie jest wykradzione: to liczby, które każdy widzi w highscore, tylko poukładane w odpowiedź na pytanie „kto jest groźny". Pliki mają termin świeżości i są czytane przy okazji Twojej wizyty w grze, nie cyklicznie.',
      'Tabela **niczego nie wysyła** i nie ma w sobie żadnej akcji w grze — gwiazdka `+ watch` tylko dopisuje gracza do Twojej własnej notatki. Dane od sojuszników (jeśli włączysz dzielenie) są **wyłącznie do podglądu**: z zasady nie wchodzą ani do liczby `Danger`, ani do planu skanów.',
    ],
  },

  details: [
    'Zero statków to zawsze `Danger 0`; własny sojusz i buddy również 0. Każdy, kto ma czym latać, ma co najmniej 8.',
    'Koszt jednego kadłuba dzieli flotę na klasy: poniżej ~20 tys. surowców — `civilian` (transportery, sondy), 20–100 tys. — `combat`, powyżej — `capitals` albo `defence?`, jeśli skany jeszcze tego nie potwierdziły.',
    'Bonusy agresora (bandyta, zasięg, klasa wojownik) **nie sumują się w nieskończoność** — wypełniają zapas do 100. Dzięki temu spokojny gigant nigdy nie zostanie „apexem".',
    'Najwyższy stopień agresora (w dossier: „top aggressor") wymaga co najmniej dwóch z sześciu sygnałów, w tym **przynajmniej jednego agresywnego** (zniszczenia, zasięg, ustawienie kolonii) — sama wielkość floty nie wystarczy.',
    'Filtry: ukryj nieaktywnych, tylko lista obserwowanych, tylko skupione konta (`miners`), widełki punktów wojskowych — przyjmują `15M`, `2.5b`, `800k`, `15kk` — oraz `top 50 / 100 / 200 / all`. Konta na wakacjach, zbanowane i administracyjne są ukryte zawsze.',
    '**Jedna wyszukiwarka** obsługuje nick, nazwę sojuszu i tag: znajduje też graczy odfiltrowanych (z powodem, dlaczego byli ukryci), a `+ watch all` dopisuje całą znalezioną listę do obserwowanych za jednym kliknięciem.',
  ],

  screenshots: [
    { id: 'players', caption: 'Ranking graczy posortowany po kolumnie Danger — dalej sufit floty, punkty wojskowe i klasa kadłubów.' },
    { id: 'breakdown', caption: 'Rozbicie oceny w dossier: z czego wzięła się liczba i które sygnały ją podniosły.' },
  ],

  codeRefs: [
    'src/domain/dangerScore.js',
    'src/domain/dangerJoin.js',
    'src/domain/players.js',
    'src/features/dashboard/targets.js',
  ],

  status: 'drafted',
};
