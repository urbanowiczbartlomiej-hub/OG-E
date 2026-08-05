// @ts-check

// LIVE demo: Spyglass → the watch-list card strip. See `_kit.mjs`.
//
// One card per watched player: the verdict on top ("RAID NOW" / "scan first"),
// then the loot, the danger and the coverage. The demo watches four of the
// invented cast so the strip shows four DIFFERENT answers — that contrast is
// the whole point of the card, and a single-card screenshot never shows it.
//
// The verdicts and the hidden-fleet estimates are COMPUTED by the real domain
// code (`raidVerdict`, `estimateHiddenFleet`) from the invented spy reports
// below — the demo cannot print a verdict OG-E would not reach.

import { withStage } from './_kit.mjs';
import { NOW, CANDIDATES, UNIVERSE_PLANETS, dangerProfiles } from './_world.mjs';

const HOUR = 3600_000;

/**
 * Kogo obserwujemy w tym demo. Czterech, bo dopiero czterech pokazuje CAŁĄ
 * skalę werdyktów: gotową farmę, cel z ryzykiem odbicia, pustego i takiego,
 * o którym nie wiadomo nic.
 */
const WATCHED = ['707', '303', '101', '505'];

/**
 * Zmyślone raporty szpiegowskie (`SpyReport`) — tylko te pola, które czytają
 * `estimateHiddenFleet` i `raidVerdict`.
 * @type {Record<string, any[]>}
 */
const REPORTS = {
  // Kestrel: obejrzany częściowo, sporo obrony — ryzyko, nie farma.
  101: [
    { galaxy: 2, system: 117, position: 8, planetType: 1, playerId: 101, timestamp: NOW - 3 * HOUR,
      defenseValue: 210_000, fleetValue: 1_900_000, militaryPoints: 2_960_000, resources: 410_000 },
    { galaxy: 2, system: 121, position: 3, planetType: 1, playerId: 101, timestamp: NOW - 29 * HOUR,
      defenseValue: 74_000, fleetValue: 210_000, militaryPoints: 2_960_000, resources: 180_000 },
  ],
  // Boro: górnik z pełnym pokryciem i pełnymi magazynami — klasyczna farma.
  303: [
    { galaxy: 5, system: 233, position: 7, planetType: 1, playerId: 303, timestamp: NOW - 2 * HOUR,
      defenseValue: 18_000, fleetValue: 0, militaryPoints: 210_000, resources: 2_400_000 },
    { galaxy: 5, system: 234, position: 4, planetType: 1, playerId: 303, timestamp: NOW - 2 * HOUR,
      defenseValue: 9_000, fleetValue: 0, militaryPoints: 210_000, resources: 1_150_000 },
    { galaxy: 5, system: 236, position: 9, planetType: 1, playerId: 303, timestamp: NOW - 3 * HOUR,
      defenseValue: 12_000, fleetValue: 0, militaryPoints: 210_000, resources: 860_000 },
    { galaxy: 5, system: 238, position: 6, planetType: 1, playerId: 303, timestamp: NOW - 3 * HOUR,
      defenseValue: 4_000, fleetValue: 0, militaryPoints: 210_000, resources: 520_000 },
    { galaxy: 5, system: 240, position: 10, planetType: 1, playerId: 303, timestamp: NOW - 4 * HOUR,
      defenseValue: 0, fleetValue: 0, militaryPoints: 210_000, resources: 310_000 },
  ],
  // Ilex: nigdy nie szpiegowany — karta ma o tym powiedzieć wprost.
  505: [],
  // Pipit: nieaktywny, obejrzany w całości, bez floty — farma podręcznikowa.
  707: [
    { galaxy: 1, system: 74, position: 2, planetType: 1, playerId: 707, timestamp: NOW - 1 * HOUR,
      defenseValue: 3_000, fleetValue: 0, militaryPoints: 26_000, resources: 1_900_000 },
    { galaxy: 1, system: 76, position: 9, planetType: 1, playerId: 707, timestamp: NOW - 1 * HOUR,
      defenseValue: 0, fleetValue: 0, militaryPoints: 26_000, resources: 740_000 },
  ],
};

export const render = () => withStage(async ({ byId, load, out }) => {
  const cards = await load('features/dashboard/cards.js');
  const danger = dangerProfiles(await load('domain/dangerScore.js'));
  const { estimateHiddenFleet } = await load('domain/threatModel.js');
  const { raidVerdict } = await load('domain/raidVerdict.js');

  /** @type {Record<string, any>} */
  const estimates = {};
  /** @type {Record<string, any>} */
  const verdicts = {};
  /** @type {Record<string, any>} */
  const reportsByPlayer = {};
  for (const pid of WATCHED) {
    const reports = REPORTS[pid] || [];
    const planetCount = UNIVERSE_PLANETS.filter((p) => String(p.player) === pid).length;
    const estimate = estimateHiddenFleet({
      militaryPoints: (CANDIDATES.find((c) => c.id === pid) || {}).militaryScore,
      reports,
      planetCount,
    });
    estimates[pid] = estimate;
    verdicts[pid] = raidVerdict({
      profile: danger.get(Number(pid)),
      estimate,
      reports,
      inBand: true,
      nowMs: NOW,
    });
    reportsByPlayer[pid] = Object.fromEntries(
      reports.map((r) => [`${r.galaxy}:${r.system}:${r.position}`, { ts: r.timestamp }]));
  }

  cards.renderWatchlistCards({
    hostEl: byId('watchCards'),
    watchedIds: new Set(WATCHED),
    candidates: CANDIDATES,
    verdicts,
    estimates,
    danger,
    routines: {},
    colors: { 101: '#e2726a', 303: '#7fd6a8', 505: '#7bb8ff', 707: '#e6c054' },
    reportsByPlayer,
    inBand: { 101: true, 303: true, 505: true, 707: true },
    nowMs: NOW,
    onOpen: () => {},
    onToggleWatch: () => {},
  });
  return out(byId('watchCards'));
});
