// Home watch (in-game half) — turn every galaxy look at one of OUR systems into
// a diff against what was there last time, and log the strangers.
//
// The observation costs nothing extra: the Spy FAB already proposes our own
// systems as Look targets when Home watch is on (domain/homeWatch's plan feeds
// the same look channel as the patrol), and the galaxy ingest already records
// every browsed system into `state/scans`. This feature is purely the reader:
// scans changed → re-diff our systems → persist the new baseline plus any
// arrivals (`state/homeWatch`). The dashboard's Spyglass paints them.
//
// Debounced because a galaxy walk fires the store in bursts (one write per
// browsed system) and the diff is over the whole home set each time.
//
// Passive and local: no requests, no automation, nothing sent — see
// docs/fair-play.md.
//
// @ts-check

import { scansStore } from '../../state/scans.js';
import { bodiesStore } from '../../state/bodies.js';
import { watchListStore } from '../../state/watchList.js';
import { readHomeWatch, writeHomeWatch } from '../../state/homeWatch.js';
import {
  homeSystemKeys, diffHomeSystems, mergeHomeArrivals, friendlyNeighbourIds,
} from '../../domain/homeWatch.js';
import { playersStore } from '../../state/players.js';
import { getApiContext } from '../shared/apiContextStore.js';
import { debounce } from '../../lib/debounce.js';
import { logger } from '../../lib/logger.js';

/** Collapse a galaxy walk's burst of per-system writes into one diff pass. */
const DIFF_DEBOUNCE_MS = 1500;

/** @type {Array<() => void>} */
let unsubs = [];
/** Guards against two overlapping async passes racing on the same key. */
let running = false;

/**
 * One diff pass: read the persisted baseline, compare it against the current
 * scan snapshot for our own systems, write back what changed. No-op while Home
 * watch is off, or before the body inventory has landed (an empty inventory
 * would read as "we own nothing", wiping the baseline).
 *
 * @returns {Promise<void>}
 */
export const runHomeWatchPass = async () => {
  if (running) return;
  if (!((watchListStore.get().homeHours ?? 0) > 0)) return;
  const bodies = bodiesStore.get().bodies;
  if (!bodies || bodies.length === 0) return;
  running = true;
  try {
    const systems = homeSystemKeys(bodies);
    const state = await readHomeWatch();
    const ctx = getApiContext();
    const ownId = Number(ctx?.ownId) || null;
    const apiPlayers = ctx?.players;
    const { arrivals, baseline, changed } = diffHomeSystems({
      systems,
      scans: scansStore.get(),
      baseline: state.baseline,
      ownId,
      // Own alliance + buddy list: company, not exposure. Filtered here rather
      // than at display time so they never enter the stored baseline either.
      skip: friendlyNeighbourIds({
        danger: ctx?.danger,
        playerFlags: playersStore.get(),
        apiPlayers,
        ownAlliance: ownId != null ? apiPlayers?.[String(ownId)]?.alliance : undefined,
      }),
    });
    if (!changed && arrivals.length === 0) return;
    await writeHomeWatch({
      ...state,
      baseline,
      arrivals: mergeHomeArrivals(state.arrivals, arrivals),
    });
  } catch (err) {
    logger.warn('homeWatch: diff pass failed', err);
  } finally {
    running = false;
  }
};

/**
 * Install the scans→diff bridge. Idempotent. Runs one pass immediately so a page
 * load after a galaxy walk in another tab still reconciles — and subscribes to
 * the BODY inventory too, because that hydrates asynchronously: without it, the
 * immediate pass fires on an empty inventory (and bails), and a session where the
 * player never opens the galaxy again would never diff the scans it already has.
 *
 * @returns {void}
 */
export const installHomeWatch = () => {
  if (unsubs.length) return;
  const pass = debounce(() => { void runHomeWatchPass(); }, DIFF_DEBOUNCE_MS);
  unsubs.push(scansStore.subscribe(() => pass()));
  unsubs.push(bodiesStore.subscribe(() => pass()));
  pass();
};

/** Test hook — drop the subscriptions and the in-flight guard. @returns {void} */
export const _resetHomeWatchForTest = () => {
  for (const fn of unsubs) fn();
  unsubs = [];
  running = false;
};
