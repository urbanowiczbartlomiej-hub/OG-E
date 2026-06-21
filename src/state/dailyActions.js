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

/**
 * Epoch-ms until which the Artifact-Shop menu highlight is suppressed.
 *
 * Unlike the daily rewarding marker, the Artifact Shop is a multi-day EVENT:
 * once every reward rank is claimed there is nothing left to do for the rest
 * of that event's run, yet the event (and its pulsing menu button) keeps
 * going. We stamp the event's own end time so the highlight stays suppressed
 * for exactly that window and AUTO-clears when the next event begins — the
 * menu has no event identity to compare against, so a self-expiring timestamp
 * is what lets a fresh event light up again without any extra bookkeeping.
 * 0 = not suppressed.
 */
export const ARTIFACT_SHOP_DONE_KEY = 'oge-artifactshop-done-until';

/** Calendar-day key (YYYY-MM-DD) when the daily trader import was taken. */
export const TRADER_IMPORT_KEY = 'oge-trader-import-traded-day';

/** Epoch-ms timestamp of the last successful auction bid. */
export const TRADER_AUCTION_BID_KEY = 'oge-trader-auction-bid-at';

/** Epoch-ms timestamp until which the auction yellow-glow is suppressed. */
export const TRADER_AUCTION_QUIET_KEY = 'oge-trader-auction-quiet-until';

/**
 * Epoch-ms of the START of the most recent 4-hour offer slot (00/04/08/12/16/20)
 * for which the player has already taken the Import/Export container. The import
 * (red) glow stays suppressed until the next slot boundary, then re-arms.
 * 0/absent ⇒ the current slot's offer is still waiting. Meaningful only during
 * the 4-hour-slot ("6×") import cadence (the mode is a per-device preference that
 * lives in the feature, not here — see `features/traderMenuHighlight.js`).
 *
 * Part of the synced {@link DailyState}, max-merged (latest slot wins) so taking
 * the offer on one device clears the nudge on another. A value left over from a
 * previous event is always before the current slot, so it harmlessly reads as
 * "offer waiting now".
 */
export const TRADER_IMPORT_NEXT_KEY = 'oge-trader-import-next-at';

/**
 * @typedef {object} DailyState
 * @property {string} rewardingDoneDay   Game-day key or "" when not yet done.
 * @property {string} traderImportDay    Calendar-day key or "" when not traded.
 * @property {number} traderAuctionBidAt Epoch-ms of last bid, 0 when absent.
 * @property {number} traderAuctionQuietUntil Epoch-ms quiet window, 0 when absent.
 * @property {number} artifactShopDoneUntil Epoch-ms suppress window, 0 when absent.
 * @property {number} traderImportNextAt   Epoch-ms start of the last taken 4h slot, 0 when absent.
 */

/** @returns {DailyState} */
export const readDailyState = () => ({
  rewardingDoneDay: safeLS.get(REWARDING_DONE_KEY) ?? '',
  traderImportDay: safeLS.get(TRADER_IMPORT_KEY) ?? '',
  traderAuctionBidAt: safeLS.int(TRADER_AUCTION_BID_KEY, 0),
  traderAuctionQuietUntil: safeLS.int(TRADER_AUCTION_QUIET_KEY, 0),
  artifactShopDoneUntil: safeLS.int(ARTIFACT_SHOP_DONE_KEY, 0),
  traderImportNextAt: safeLS.int(TRADER_IMPORT_NEXT_KEY, 0),
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
  if (state.artifactShopDoneUntil != null)
    safeLS.set(ARTIFACT_SHOP_DONE_KEY, state.artifactShopDoneUntil);
  if (state.traderImportNextAt != null)
    safeLS.set(TRADER_IMPORT_NEXT_KEY, state.traderImportNextAt);
};
