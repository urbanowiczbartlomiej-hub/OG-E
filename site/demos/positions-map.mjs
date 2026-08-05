// @ts-check

// LIVE demo: Spyglass → Positions map. See `_kit.mjs`.
//
// Shows the two things the map is for: WHERE the players you track sit relative
// to your own planets, and WHO of them can reach you (the amber ring). Colours
// come from the component's own palette — the demo never names a hex.

import { withStage } from './_kit.mjs';

/** Fictional universe bounds — small enough to read, big enough to look real. */
const GALAXIES = 6;
const SYSTEMS = 499;

export const render = () => withStage(async ({ byId, load, out }) => {
  const map = await load('features/dashboard/mapPrimitives.js');
  const [red, orange, gold, green, blue] = map.WATCH_COLOR_PALETTE.map((c) => c.hex);
  const you = map.MAP_YOU_COLOR;

  /** @type {any[]} */
  const bodies = [
    // Your own empire — one cluster plus a far colony.
    { galaxy: 2, system: 117, position: 4, playerId: 'me', name: 'Cradle', color: you, isYou: true, danger: 0 },
    { galaxy: 2, system: 119, position: 8, playerId: 'me', name: 'Anvil', color: you, isYou: true, danger: 0 },
    { galaxy: 2, system: 143, position: 6, playerId: 'me', name: 'Foundry', color: you, isYou: true, danger: 0 },
    { galaxy: 3, system: 301, position: 9, playerId: 'me', name: 'Kiln', color: you, isYou: true, danger: 0 },
    { galaxy: 6, system: 104, position: 12, playerId: 'me', name: 'Outpost', color: you, isYou: true, danger: 0 },
    // Kestrel — apex, sits on top of you: three bodies inside reach.
    { galaxy: 2, system: 117, position: 8, playerId: '101', name: 'Kestrel I', color: red, danger: 88, reachH: 1.4, inReach: true },
    { galaxy: 2, system: 121, position: 3, playerId: '101', name: 'Kestrel II', color: red, danger: 88, reachH: 3.1, inReach: true },
    { galaxy: 2, system: 166, position: 11, playerId: '101', name: 'Kestrel III', color: red, danger: 88, reachH: 7.2, inReach: true },
    // Wren — same alliance, one body close, the rest of the galaxy away.
    { galaxy: 2, system: 143, position: 4, playerId: '202', name: 'Wren Prime', color: orange, danger: 31, reachH: 0.9, inReach: true },
    { galaxy: 4, system: 402, position: 5, playerId: '202', name: 'Wren Far', color: orange, danger: 31, reachH: 26, inReach: false },
    // Boro — a fat, harmless miner far away.
    { galaxy: 5, system: 233, position: 7, playerId: '303', name: 'Boro Hive', color: green, danger: 22, reachH: 31, inReach: false },
    { galaxy: 5, system: 236, position: 9, playerId: '303', name: 'Boro Reef', color: green, danger: 22, reachH: 32, inReach: false },
    // Ilex — neighbour of your far outpost.
    { galaxy: 6, system: 104, position: 9, playerId: '505', name: 'Ilex', color: blue, danger: 46, reachH: 2.2, inReach: true },
    // Corvid — mid-danger, mid-distance.
    { galaxy: 3, system: 288, position: 6, playerId: '606', name: 'Corvid', color: gold, danger: 57, reachH: 11, inReach: false },
    { galaxy: 1, system: 74, position: 2, playerId: '707', name: 'Pipit', color: map.WATCH_DEFAULT_COLOR, danger: 12, reachH: 40, inReach: false },
  ];

  map.renderPositionsMap({
    hostEl: byId('spyglassMapHost'),
    galaxies: GALAXIES,
    systems: SYSTEMS,
    bodies,
    onPlayerClick: () => {},
  });
  return out(byId('spyMapBlock'));
});
