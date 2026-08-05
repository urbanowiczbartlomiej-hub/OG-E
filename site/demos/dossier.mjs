// @ts-check

// LIVE demo: Spyglass → a player's dossier. See `_kit.mjs`.
//
// The dossier is the answer to "what do I actually know about this player" — so
// the demo shows it OPEN under its own row, exactly as a tap on the Players
// table opens it. Same call as `targets-table.mjs`, one candidate, expanded.
//
// The scan history below is invented, but nothing about the verdict is: the
// danger score, its reasons and the coverage line are computed by the real code
// from the numbers in `_world.mjs`.

import { withStage, card } from './_kit.mjs';
import { NOW, ME, ALLIANCES, CANDIDATES, UNIVERSE_PLANETS, dangerProfiles } from './_world.mjs';

const HOUR = 3600_000;

/** Kestrel — the cast's apex, the one worth a dossier. */
const PID = '101';

/**
 * Zmyślone raporty szpiegowskie: trzy z pięciu planet obejrzane, jedna świeżo,
 * dwie starsze — czyli dokładnie ten stan, o którym dossier ma coś do
 * powiedzenia (niepełne pokrycie, więc flota to GÓRNA granica).
 * @type {Record<string, any>}
 */
const REPORTS = {
  '2:117:8': { ts: NOW - 3 * HOUR, defPts: 210_000, fleetPts: 1_900_000, avgLoot: 640_000, maxLoot: 1_100_000, lootSamples: 4 },
  '2:121:3': { ts: NOW - 29 * HOUR, defPts: 74_000, fleetPts: 210_000, avgLoot: 180_000, maxLoot: 260_000, lootSamples: 2 },
  '4:388:5': { ts: NOW - 51 * HOUR, defPts: 12_000, fleetPts: 0, avgLoot: 90_000, maxLoot: 90_000, lootSamples: 1 },
};

/** Jeden obejrzany księżyc — nośnik uderzenia księżycowego. */
const MOONS = {
  '2:117:8': { ts: NOW - 3 * HOUR, defPts: 0, fleetPts: 340_000 },
};

export const render = () => withStage(async ({ byId, load, out, doc }) => {
  const targets = await load('features/dashboard/targets.js');
  const danger = dangerProfiles(await load('domain/dangerScore.js'));

  const host = byId('targetsContainer');
  targets.renderTargets({
    containerEl: host,
    candidates: CANDIDATES.filter((c) => c.id === PID),
    opts: {
      ownPlayerId: ME.id,
      ownTotalScore: ME.totalScore,
      ownAlliance: ME.alliance,
      protectionFactor: 0,
      excludeVacation: true,
      excludeInactive: false,
      excludeBanned: true,
    },
    limit: 0,
    estimates: {},
    sort: targets.DEFAULT_TARGET_SORT,
    onSort: () => {},
    watchedIds: new Set([PID]),
    onToggleWatch: () => {},
    onRescan: () => {},
    rescan: {},
    universePlanets: UNIVERSE_PLANETS,
    reportsByPlayer: { [PID]: REPORTS },
    moonsByPlayer: { [PID]: MOONS },
    scanBodies: 'both',
    nowMs: NOW,
    expandedIds: new Set([PID]),
    onToggleExpand: () => {},
    countInfoEl: doc.createElement('span'),
    danger,
    verdicts: {},
    alliances: ALLIANCES,
  });
  return out(card(host));
});
