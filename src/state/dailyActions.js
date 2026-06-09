// Daily-action state — localStorage keys shared between features and the sync
// scheduler.
//
// Keeping the keys here (rather than in each feature file) lets the sync
// scheduler read and write these values without importing from features/,
// which would invert the dependency direction (sync/ → features/ is
// forbidden by the architecture rules).
//
// All four keys are per-origin by the browser's localStorage scoping: each
// OGame universe lives on its own subdomain, so no extra universe-prefix is
// needed.
//
// @ts-check

import { safeLS } from '../lib/storage.js';

/** game-day key (YYYY-MM-DD, 14:00 reset) when all rewarding tasks were done. */
export const REWARDING_DONE_KEY = 'oge-rewarding-done-day';

/** Calendar-day key (YYYY-MM-DD) when the daily trader import was taken. */
export const TRADER_IMPORT_KEY = 'oge-trader-import-traded-day';

/** Epoch-ms timestamp of the last successful auction bid. */
export const TRADER_AUCTION_BID_KEY = 'oge-trader-auction-bid-at';

/** Epoch-ms timestamp until which the auction yellow-glow is suppressed. */
export const TRADER_AUCTION_QUIET_KEY = 'oge-trader-auction-quiet-until';

/**
 * @typedef {object} DailyState
 * @property {string} rewardingDoneDay   Game-day key or "" when not yet done.
 * @property {string} traderImportDay    Calendar-day key or "" when not traded.
 * @property {number} traderAuctionBidAt Epoch-ms of last bid, 0 when absent.
 * @property {number} traderAuctionQuietUntil Epoch-ms quiet window, 0 when absent.
 */

/** @returns {DailyState} */
export const readDailyState = () => ({
  rewardingDoneDay: safeLS.get(REWARDING_DONE_KEY) ?? '',
  traderImportDay: safeLS.get(TRADER_IMPORT_KEY) ?? '',
  traderAuctionBidAt: safeLS.int(TRADER_AUCTION_BID_KEY, 0),
  traderAuctionQuietUntil: safeLS.int(TRADER_AUCTION_QUIET_KEY, 0),
});

/**
 * Write only the fields present in `state`; absent fields are left untouched.
 *
 * @param {Partial<DailyState>} state
 */
export const writeDailyState = (state) => {
  if (state.rewardingDoneDay != null)
    safeLS.set(REWARDING_DONE_KEY, state.rewardingDoneDay);
  if (state.traderImportDay != null)
    safeLS.set(TRADER_IMPORT_KEY, state.traderImportDay);
  if (state.traderAuctionBidAt != null)
    safeLS.set(TRADER_AUCTION_BID_KEY, state.traderAuctionBidAt);
  if (state.traderAuctionQuietUntil != null)
    safeLS.set(TRADER_AUCTION_QUIET_KEY, state.traderAuctionQuietUntil);
};

/** CustomEvent name dispatched after any daily-state write to trigger a sync upload. */
export const DAILY_STATE_CHANGED_EVENT = 'oge:dailyStateChanged';
