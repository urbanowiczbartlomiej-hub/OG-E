// @ts-check

// LIVE demo: Spyglass → Players table (the Danger ranking). See `_kit.mjs`.
//
// This is the table the whole Spyglass tab points at: every neighbour ranked by
// what the danger model makes of their public numbers. The demo renders it over
// the shared invented cast (`_world.mjs`), and the DANGER COLUMN IS COMPUTED —
// the same `buildDangerProfiles` the extension runs, not numbers typed by hand.

import { withStage, card } from './_kit.mjs';
import { NOW, ME, ALLIANCES, CANDIDATES, UNIVERSE_PLANETS, dangerProfiles } from './_world.mjs';

export const render = () => withStage(async ({ byId, load, out, doc }) => {
  const targets = await load('features/dashboard/targets.js');
  const danger = dangerProfiles(await load('domain/dangerScore.js'));

  const host = byId('targetsContainer');
  targets.renderTargets({
    containerEl: host,
    candidates: CANDIDATES,
    opts: {
      ownPlayerId: ME.id,
      ownTotalScore: ME.totalScore,
      ownAlliance: ME.alliance,
      protectionFactor: 0,
      excludeVacation: true,
      excludeInactive: false, // the demo keeps the inactive row — it is a farm
      excludeBanned: true,
    },
    limit: 0,
    estimates: {},
    sort: targets.DEFAULT_TARGET_SORT,
    onSort: () => {},
    watchedIds: new Set(['101', '505']),
    onToggleWatch: () => {},
    onRescan: () => {},
    rescan: {},
    universePlanets: UNIVERSE_PLANETS,
    reportsByPlayer: {},
    moonsByPlayer: {},
    nowMs: NOW,
    expandedIds: new Set(),
    onToggleExpand: () => {},
    countInfoEl: doc.createElement('span'),
    danger,
    verdicts: {},
    alliances: ALLIANCES,
  });
  return out(card(host));
});
