// @ts-check

// MAIN-world bridge — observe the two "I did the daily Trader thing" XHRs
// and dispatch a cross-world signal so the isolated-world highlight can
// clear the matching glow.
//
// # Why this exists
//
// `traderMenuHighlight` nudges the player toward two daily Trader actions
// with coloured glows: YELLOW = place a bid at the Auctioneer (Licytator),
// RED = take the daily Import/Export container. The glow must clear when
// the player actually PERFORMS the action — not merely when they open the
// Trader menu (opening it proves nothing; the bid/trade button may be
// disabled, the server may reject, or they may just look and leave).
//
// The reliable, locale-independent signal is the action's own XHR. Both
// buttons happen to share the CSS class `pay` ("Zapłać" / "Oddano ofertę",
// and those labels are translated per-language anyway), so the button text
// can't discriminate them — but the request URL can:
//
//   - Auctioneer bid  → component=traderauctioneer … action=submitBid
//   - Import trade    → component=traderimportexport … action=trade
//
// We anchor on BOTH the component and the action: `action=trade` alone is
// ambiguous (the resource market uses trade-shaped actions too), and we
// must not clear the import glow on an unrelated trade.
//
// # Behaviour
//
//   - Dispatch ONLY on HTTP 200 + a non-negative JSON body. The action
//     returns `asJson=1`, so a successful submit is a parseable object; an
//     explicit `success:false` / `error:true` is treated as a failure and
//     skipped. A malformed / non-JSON 200 is treated as failure too — we
//     would rather miss a clear (glow lingers, self-heals next window)
//     than clear on a request that didn't actually go through.
//   - Events are bare notifications — no `detail`. The isolated-world
//     consumer only needs the "it happened" edge; it stamps its own
//     timestamp/day. Delivered on `document`, shared across the world
//     boundary like every other `oge:*` event.
//
// @see ../features/traderMenuHighlight.js — the isolated-world consumer
//   that listens for `oge:traderBidPlaced` / `oge:traderImportTraded`.

import { observeXHR } from './xhrObserver.js';
import { TRADER_BID_PLACED_EVENT, TRADER_IMPORT_TRADED_EVENT } from '../lib/ogeEvents.js';

/** Idempotency sentinel — a second install returns the same teardown. */
/** @type {(() => void) | null} */
let installed = null;

/**
 * Did the trader action succeed? Accepts a 200 response's body and looks
 * for a negative signal. Conservative: anything that isn't a parseable
 * JSON object, or that carries `success:false` / `error:true`, counts as
 * a failure so we don't clear a glow for an action that never landed.
 *
 * @param {string | undefined} response Response text (present on 'load').
 * @returns {boolean}
 */
const succeeded = (response) => {
  if (!response) return false;
  let data;
  try {
    data = JSON.parse(response);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (data);
  if ('success' in obj) return Boolean(obj.success);
  if ('error' in obj) return !obj.error;
  return true;
};

/**
 * Install the trader-action observers. Idempotent.
 *
 * @returns {() => void} Unsubscribe — detaches both XHR observers.
 */
export const installTraderActionHook = () => {
  if (installed) return installed;

  const unsubBid = observeXHR({
    urlPattern: /component=traderauctioneer.*action=submitBid/,
    on: 'load',
    handler: ({ xhr, response }) => {
      if (xhr.status !== 200 || !succeeded(response)) return;
      document.dispatchEvent(new CustomEvent(TRADER_BID_PLACED_EVENT));
    },
  });

  const unsubTrade = observeXHR({
    urlPattern: /component=traderimportexport.*action=trade/,
    on: 'load',
    handler: ({ xhr, response }) => {
      if (xhr.status !== 200 || !succeeded(response)) return;
      document.dispatchEvent(new CustomEvent(TRADER_IMPORT_TRADED_EVENT));
    },
  });

  installed = () => {
    unsubBid();
    unsubTrade();
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset for the module-scope install handle.
 *
 * @returns {void}
 */
export const _resetTraderActionHookForTest = () => {
  if (installed) installed();
  installed = null;
};
