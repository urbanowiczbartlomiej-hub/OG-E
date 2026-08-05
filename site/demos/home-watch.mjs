// @ts-check

// LIVE demo: Spyglass → Home watch card. See `_kit.mjs` for how these work and
// the rules they keep (invented data, fail-soft, real markup + real stylesheet).

import { withStage } from './_kit.mjs';
import { NOW as WORLD_NOW, PLAYER_META, ALLIANCES, dangerProfiles } from './_world.mjs';

/** Fictional scenario — see the anonymity note in `_world.mjs`. */
const FIXTURE = () => {
  const NOW = WORLD_NOW;
  /** Our own systems (fictional). */
  const systems = new Set([
    '2:117', '2:118', '2:119', '2:143', '2:144', '2:187', '2:203', '2:266',
    '3:288', '3:301', '3:302', '3:377', '4:412', '4:498', '6:104', '6:155',
  ]);
  // NOVA: Kestrel (2:117, 2:119, 3:301) + Wren (2:143) → ×4 together vs ×3 alone.
  // KRAB: Boro (2:117) + Ilex (6:104)                  → ×2 together vs ×1 alone.
  // Tanhil: no alliance, one system.
  const occupants = {
    '2:117': [{ playerId: '101', position: 8 }, { playerId: '303', position: 6 },
      { playerId: '404', position: 12 }],
    '2:119': [{ playerId: '101', position: 3 }],
    '3:301': [{ playerId: '101', position: 11 }],
    '2:143': [{ playerId: '202', position: 4 }],
    '6:104': [{ playerId: '505', position: 9 }],
  };
  /** @type {Record<string, { scannedAt?: number }>} */
  const scans = {};
  for (const s of systems) scans[s] = { scannedAt: NOW - 4 * 60_000 };
  scans['3:377'] = { scannedAt: NOW - 40 * 3600_000 };
  return {
    NOW,
    systems,
    occupants,
    scans,
    arrivals: [{ system: '2:143', coord: '2:143:4', playerId: 202, atMs: NOW - 8 * 60_000 }],
  };
};

export const render = () => withStage(async ({ byId, load, out }) => {
  const mod = await load('features/dashboard/homeWatch.js');
  // Zagrożenie liczy prawdziwy model, nie fixture — patrz `_world.mjs`.
  const danger = dangerProfiles(await load('domain/dangerScore.js'));
  const f = FIXTURE();
  const card = byId('homeWatchCard');
  mod.renderHomeWatchCard({
    summaryEl: byId('homeWatchSummary'),
    hostEl: byId('homeWatchBody'),
    systems: f.systems,
    occupants: f.occupants,
    arrivals: f.arrivals,
    names: PLAYER_META,
    alliances: ALLIANCES,
    danger,
    scans: f.scans,
    staleMs: 24 * 3600_000,
    nowMs: f.NOW,
  });
  return out(card);
});
