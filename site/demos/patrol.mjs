// @ts-check

// LIVE demo: Spyglass → Patrol card (territory mode). See `_kit.mjs`.
//
// The scenario is a healthy patrol with two catchable moons: a `lone` claim
// (the strongest rung — one moon lit while the rest of the system sleeps) and a
// weaker `any`. The head summary shows the coverage side: how much of the
// grounds has a fresh look.

import { withStage } from './_kit.mjs';
import { NOW as WORLD_NOW, PLAYER_META } from './_world.mjs';

const NOW = WORLD_NOW;

/** ±3 systems around two fictional colonies. */
const systems = new Set([
  '2:114', '2:115', '2:116', '2:117', '2:118', '2:119', '2:120',
  '3:298', '3:299', '3:300', '3:301', '3:302', '3:303', '3:304',
]);

/** Occupied slots in the grounds (own bodies excluded upstream). */
const occupants = {
  '2:115': [{ playerId: '404', position: 7 }],
  '2:116': [{ playerId: '101', position: 4 }, { playerId: '707', position: 9 }],
  '2:118': [{ playerId: '303', position: 12 }],
  '3:299': [{ playerId: '606', position: 6 }],
  '3:301': [{ playerId: '101', position: 11 }],
  '3:303': [{ playerId: '505', position: 3 }],
};

/** The strike list — one strong claim, one weak. */
const strikes = {
  101: {
    coord: '2:116:4', bodyType: 3, overrideKey: '2:116:4:3',
    freshAgeMs: 7 * 60_000, quiet: 9, total: 11, confidence: 'strong',
    tier: 'lone', concurrent: false, coMoons: 0, playerId: '101',
  },
  505: {
    coord: '3:303:3', bodyType: 3, overrideKey: '3:303:3:3',
    freshAgeMs: 41 * 60_000, quiet: 3, total: 8, confidence: 'weak',
    tier: 'any', concurrent: true, coMoons: 1, playerId: '505',
  },
};

/** Look coverage: mostly fresh, one stale, one never walked. */
const scans = (() => {
  /** @type {Record<string, { scannedAt?: number }>} */
  const s = {};
  for (const key of systems) s[key] = { scannedAt: NOW - 12 * 60_000 };
  s['2:118'] = { scannedAt: NOW - 31 * 3600_000 };
  delete s['3:299'];
  return s;
})();

export const render = () => withStage(async ({ byId, load, out }) => {
  const mod = await load('features/dashboard/patrol.js');
  mod.renderPatrolCard({
    summaryEl: byId('patrolSummary'),
    hostEl: byId('patrolStrikes'),
    radius: 3,
    systems,
    occupants,
    strikes,
    names: PLAYER_META,
    scans,
    staleMs: 24 * 3600_000,
    nowMs: NOW,
    linkBase: '',
    watchedIds: new Set(['505']),
    onToggleWatch: () => {},
  });
  return out(byId('patrolCard'));
});
