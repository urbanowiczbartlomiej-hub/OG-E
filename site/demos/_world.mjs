// @ts-check

// Jeden zmyślony wszechświat dla wszystkich żywych demo.
//
// Po co wspólny, a nie fixture per demo: strona czyta się wtedy jak JEDNA
// rozgrywka. Ten sam Kestrel jest apexem w rankingu, siedzi na mapie tuż obok
// Twojej planety i ma to samo dossier — czytelnik przechodzi między funkcjami
// bez resetowania obsady.
//
// Wszystko tu jest WYMYŚLONE i tak ma zostać: dokumentacja nie publikuje pozycji
// ani nicka żadnego realnego gracza — cudzego ani autora. Nazwy są ptasie po to,
// żeby nie dało się ich pomylić z prawdziwym kontem.
//
// Liczby, które da się POLICZYĆ, są liczone prawdziwym kodem domenowym
// (`buildDangerProfiles`), a nie wpisywane z palca. Dzięki temu demo nie może
// pokazać werdyktu, którego OG-E by nie wystawił — a zmiana modelu zagrożenia
// przechodzi na stronę razem z kodem.

/** Stały „teraz" — build musi być deterministyczny (żadnego Date.now()). */
export const NOW = 1_800_000_000_000;

/** Nasze konto. */
export const ME = { id: '900', name: 'Vireo', alliance: 'AL3', totalScore: 1_450_000 };

/** id → sojusz. */
export const ALLIANCES = {
  AL1: { tag: 'NOVA', name: 'Nova Ordo' },
  AL2: { tag: 'KRAB', name: 'Krab Klan' },
  AL3: { tag: 'VIR', name: 'Vireo Solo' },
};

/** Klasy sojuszy (źródło sygnału „warrior" bez szpiegowania). */
export const ALLIANCE_CLASSES = { AL1: 'warrior', AL2: 'trader', AL3: 'explorer' };

/**
 * Obsada. `ships`/`military`/`destroyed`/`honor` są tak dobrane, żeby
 * prawdziwy model zagrożenia wystawił cały wachlarz werdyktów: apex, fleeter,
 * farmę i śpiocha.
 * @type {Array<{id: string, name: string, alliance?: string, status?: string,
 *   totalScore: number, totalRank: number, militaryScore: number, militaryRank: number,
 *   ships: number, destroyedScore: number, honorScore: number, honorRank: number,
 *   planets: Array<[number, number, number]>}>}
 */
export const CAST = [
  {
    id: '101', name: 'Kestrel', alliance: 'AL1',
    totalScore: 4_120_000, totalRank: 12, militaryScore: 2_960_000, militaryRank: 8,
    ships: 5_400, destroyedScore: 1_870_000, honorScore: -240_000, honorRank: 640,
    planets: [[2, 117, 8], [2, 121, 3], [2, 166, 11], [4, 388, 5], [7, 41, 9]],
  },
  {
    id: '202', name: 'Wren', alliance: 'AL1',
    totalScore: 1_980_000, totalRank: 58, militaryScore: 640_000, militaryRank: 71,
    ships: 1_180, destroyedScore: 120_000, honorScore: 4_000, honorRank: 210,
    planets: [[2, 143, 4], [4, 402, 5], [4, 407, 7]],
  },
  {
    id: '303', name: 'Boro', alliance: 'AL2',
    totalScore: 2_640_000, totalRank: 31, militaryScore: 210_000, militaryRank: 260,
    ships: 90, destroyedScore: 0, honorScore: 26_000, honorRank: 74,
    planets: [[5, 233, 7], [5, 234, 4], [5, 236, 9], [5, 238, 6], [5, 240, 10]],
  },
  {
    id: '404', name: 'Tanhil',
    totalScore: 720_000, totalRank: 190, militaryScore: 88_000, militaryRank: 430,
    ships: 210, destroyedScore: 4_000, honorScore: 900, honorRank: 380,
    planets: [[2, 117, 12], [3, 55, 4]],
  },
  {
    id: '505', name: 'Ilex', alliance: 'AL2',
    totalScore: 1_310_000, totalRank: 96, militaryScore: 470_000, militaryRank: 110,
    ships: 830, destroyedScore: 61_000, honorScore: -12_000, honorRank: 590,
    planets: [[6, 104, 9], [6, 108, 3], [1, 12, 6]],
  },
  {
    id: '606', name: 'Corvid', alliance: 'AL1',
    totalScore: 2_050_000, totalRank: 47, militaryScore: 910_000, militaryRank: 52,
    ships: 1_940, destroyedScore: 300_000, honorScore: -3_000, honorRank: 470,
    planets: [[3, 288, 6], [3, 292, 2], [6, 155, 8]],
  },
  {
    id: '707', name: 'Pipit', status: 'i',
    totalScore: 410_000, totalRank: 320, militaryScore: 26_000, militaryRank: 700,
    ships: 40, destroyedScore: 0, honorScore: 300, honorRank: 300,
    planets: [[1, 74, 2], [1, 76, 9]],
  },
];

/** `TargetCandidate[]` — wejście listy celów i rankingu. */
export const CANDIDATES = CAST.map((p) => ({
  id: p.id,
  name: p.name,
  status: p.status || '',
  alliance: p.alliance || '',
  totalScore: p.totalScore,
  totalRank: p.totalRank,
  militaryScore: p.militaryScore,
  militaryRank: p.militaryRank,
  ships: p.ships,
  destroyedScore: p.destroyedScore,
}));

/** Surowe wiersze planet (`universe.xml`) — sygnał rozrzutu w modelu zagrożenia. */
export const UNIVERSE_PLANETS = CAST.flatMap((p) =>
  p.planets.map(([g, s, pos]) => ({ coords: `${g}:${s}:${pos}`, player: Number(p.id) })));

/** id → nick/sojusz w formacie, którego oczekują komponenty dashboardu. */
export const PLAYER_META = Object.fromEntries(
  CAST.map((p) => [p.id, { name: p.name, alliance: p.alliance }]));

/**
 * Profile zagrożenia policzone PRAWDZIWYM modelem (`domain/dangerScore.js`).
 * @param {any} mod  Zaimportowany moduł `domain/dangerScore.js`.
 * @returns {Map<number, any>}
 */
export const dangerProfiles = (mod) => mod.buildDangerProfiles({
  military: Object.fromEntries(CAST.map((p) => [p.id, { score: p.militaryScore, ships: p.ships }])),
  destroyed: Object.fromEntries(CAST.map((p) => [p.id, { score: p.destroyedScore }])),
  honor: Object.fromEntries(CAST.map((p) => [p.id, { position: p.honorRank, score: p.honorScore }])),
  honorTotal: 800,
  apiPlayers: Object.fromEntries(CAST.map((p) => [p.id, { alliance: p.alliance || '', status: p.status || '' }])),
  universePlanets: UNIVERSE_PLANETS,
  allianceClasses: ALLIANCE_CLASSES,
  ownMilitary: 520_000,
});
