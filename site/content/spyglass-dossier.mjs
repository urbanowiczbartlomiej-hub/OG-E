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
    'Rozwinięty wiersz gracza: jedno zdanie werdyktu, rozbicie oceny zagrożenia i tabela wszystkich jego ciał z wiekiem skanu, obroną, flotą i historią łupu.',
  order: 4,

  idea: [
    'Lewa kolumna to **osąd**. Nagłówek w rodzaju `loaded · heavily defended · loot ~16.27B · scan 25h old` streszcza sytuację, a pod nim jedno zdanie mówi, co z tym zrobić. Dalej idzie rozbicie oceny zagrożenia i najciekawsza arytmetyka: publiczne punkty wojskowe **minus** obrona i flota, które widziały Twoje raporty, dają **resztę, której nigdzie nie widać** — czyli flotę w powietrzu, zwykle na fleet-savie. Dopóki nie masz kompletu ciał, ta liczba jest oznaczona jako wstępna.',
    'Prawa kolumna to **dowody**: wiersz na każde ciało (księżyc wcięty pod planetą) z wiekiem Twojego skanu, ostatnią interakcją, obroną, widoczną flotą oraz średnim i szczytowym łupem, jaki tam kiedykolwiek zastałeś. Gwiazdka oznacza ciało z największą widoczną flotą, znacznik skarbca — planetę-matkę. Chipy w nagłówku mówią, ile planet i księżyców masz już zeskanowanych i czego brakuje do kompletu.',
  ],

  value: [
    'To miejsce, w którym podejmujesz decyzję: uderzać czy odpuścić, a jeśli uderzać, to w które ciało. Zamiast przeklikiwać dwadzieścia raportów z różnych tygodni i liczyć w głowie, dostajesz jedną tabelę z historią — widać nie tylko ile tam dziś leży, ale też ile *zwykle* leży i gdzie ten gracz naprawdę trzyma majątek.',
  ],

  fairplay: {
    summary: [
      'Wszystkie twarde liczby — obrona, flota, surowce, łup — pochodzą **wyłącznie z raportów szpiegowskich, które sam otworzyłeś**. Dossier ich nie zdobywa: pamięta je i porządkuje, żebyś nie musiał trzymać notatnika. Reszta to arytmetyka na publicznych punktach i na Twoim własnym przeglądaniu galaktyki.',
      'Dossier jest **czytelnią**: nie ma w nim przycisku wysyłki. Wszystko, co można z niego „odpalić", to oznaczenie ciała jako wymagającego odświeżenia — samą sondę wysyłasz świadomie, z gry.',
    ],
  },

  details: [
    'Łup to **najlepsza jedna planeta** z najświeższego raportu, przeliczona przez procent grabieży — nigdy suma całego imperium, bo w jednym nalocie i tak zabierzesz tylko z jednego ciała.',
    'Werdykty, jakie może postawić: `RAID NOW`, `loaded · fleet risk`, `loaded · heavily defended`, `skip — empty`, `scan first`, `can\'t hit`, `friendly`.',
    '`Civil baseline` porównuje gracza z medianą serwera „ile statków ma budowniczy o takiej gospodarce"; nadwyżka to sufit floty bojowej. Świadomie **nie wchodzi** do oceny zagrożenia — to osobna, ostrożniejsza wskazówka.',
    'Komplet skanów (planety **i** księżyce) zamienia szacunek floty w dokładną liczbę i zdejmuje znak `≤` w rankingu.',
    'Przełącznik `Watch via galaxy | probes` oraz przełącznik pojedynczego ciała pozwalają wyciąć z planu skanów to, czego nie chcesz dotykać sondami.',
  ],

  demo: {
    id: 'dossier',
    caption: 'Prawdziwe dossier rozwinięte pod wierszem gracza, na zmyślonych danych. Linia pokrycia mówi, ile z jego ciał w ogóle widziałeś (3/5 — więc flota jest GÓRNĄ granicą, nie pomiarem), rozbicie zagrożenia wylicza każdy sygnał z osobna, a tabela ciał trzyma wiek skanu, obronę, widoczną flotę i łup.',
  },

  screenshots: [
    { id: 'bodies', caption: 'Tabela ciał: wiek skanu, ostatnia interakcja, obrona, widoczna flota oraz średni i szczytowy łup — z księżycami pod planetami.' },
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
