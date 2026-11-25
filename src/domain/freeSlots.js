// @ts-check

// Free colonization slots per galaxy, plus how many of our abandoned slots the
// game's next two daily cleanups release — the dashboard's outlook under the
// Positions setting.
//
// Same per-coord rule as the colonize button's "N free" count
// (`features/sendColony/pure.js`: countFreeTargetSlots − local blocks + freed
// back), so the two always agree:
//   • a slot the weekly API lists as occupied is free only if our decision log
//     says we abandoned it and the hold has passed (`freedCoords`);
//   • any other slot is free unless the decision log blocks it
//     (`blockingCoords`) or a stored galaxy scan saw it not empty.
//
// The release buckets count `abandoned` decisions still on hold whose release
// (`abandonRecolonizableAt`) is the next 03:00 cleanup, or the one after it.
// Pure: no DOM, no storage, no clock (callers pass `now`).

import {
  DEC_ABANDONED,
  abandonRecolonizableAt,
  blockingCoords,
  freedCoords,
  ABANDON_CLEANUP_HOUR,
} from './colonizeDecisions.js';

/**
 * @typedef {object} FreeSlotRow
 * @property {number} galaxy
 * @property {number} free     Colonizable now.
 * @property {number} next     Released at the next cleanup.
 * @property {number} after    Released at the cleanup after that.
 */

/**
 * @typedef {object} FreeSlotOutlook
 * @property {number} free
 * @property {number} next
 * @property {number} after
 * @property {number} nextAt   Epoch-ms of the next cleanup.
 * @property {number} afterAt  Epoch-ms of the cleanup after it.
 * @property {FreeSlotRow[]} rows  One per galaxy, 1..galaxies.
 */

/**
 * The next daily cleanup strictly after `now` (03:00 local, the same wall clock
 * `abandonRecolonizableAt` uses) and the one after it.
 *
 * @param {number} now  epoch-ms.
 * @returns {{ nextAt: number, afterAt: number }}
 */
export const nextCleanups = (now) => {
  const d = new Date(now);
  d.setHours(ABANDON_CLEANUP_HOUR, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  const nextAt = d.getTime();
  // setDate, not +24 h, so a DST switch keeps it on 03:00 — the value
  // abandonRecolonizableAt produces for a release on that day.
  d.setDate(d.getDate() + 1);
  return { nextAt, afterAt: d.getTime() };
};

/**
 * @param {object} input
 * @param {Iterable<string>} input.occupied  `"g:s:p"` the weekly API lists.
 * @param {number} input.galaxies
 * @param {number} input.systems
 * @param {number[]} input.targets           target positions.
 * @param {import('./colonizeDecisions.js').DecisionMap} input.decisions
 * @param {Record<string, { positions?: Record<string, { status?: string }> }>} [input.scans]
 *   stored galaxy scans keyed `"g:s"`.
 * @param {number} input.now  epoch-ms.
 * @returns {FreeSlotOutlook}
 */
export const freeSlotOutlook = ({ occupied, galaxies, systems, targets, decisions, scans = {}, now }) => {
  const occ = new Set(occupied);
  const blocking = blockingCoords(decisions, now);
  const freed = freedCoords(decisions, now);
  for (const [gs, scan] of Object.entries(scans)) {
    for (const [p, v] of Object.entries(scan?.positions || {})) {
      if (v && v.status !== 'empty') blocking.add(`${gs}:${p}`);
    }
  }
  const targetSet = new Set(targets);
  const { nextAt, afterAt } = nextCleanups(now);

  /** @type {FreeSlotRow[]} */
  const rows = [];
  for (let g = 1; g <= galaxies; g++) rows.push({ galaxy: g, free: 0, next: 0, after: 0 });

  for (let g = 1; g <= galaxies; g++) {
    const row = rows[g - 1];
    for (let s = 1; s <= systems; s++) {
      for (const p of targets) {
        const c = `${g}:${s}:${p}`;
        if (occ.has(c) ? freed.has(c) : !blocking.has(c)) row.free++;
      }
    }
  }

  for (const [c, d] of Object.entries(decisions)) {
    if (d.s !== DEC_ABANDONED || typeof d.ts !== 'number') continue;
    const [g, , p] = c.split(':').map(Number);
    if (!targetSet.has(p) || !(g >= 1 && g <= galaxies)) continue;
    const at = abandonRecolonizableAt(d.ts);
    if (at <= now) continue;
    if (at === nextAt) rows[g - 1].next++;
    else if (at === afterAt) rows[g - 1].after++;
  }

  const sum = (/** @type {'free' | 'next' | 'after'} */ k) => rows.reduce((a, r) => a + r[k], 0);
  return { free: sum('free'), next: sum('next'), after: sum('after'), nextAt, afterAt, rows };
};
