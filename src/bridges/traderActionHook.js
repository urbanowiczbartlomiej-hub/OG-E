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
// can't discriminate them — but the request can. WHERE the discriminator
// lives changed at the 1.13 bump:
//
//   ≤1.12 — per-page components, action in the URL query:
//     - Auctioneer bid  → component=traderauctioneer  … action=submitBid
//     - Import trade    → component=traderimportexport … action=trade
//
//   1.13+ — the trader UNIFIED into one `component=trader`; the page-view GET
//   selects a sub-page by `action=auctioneer` / `action=importexport`, but the
//   ACTION submit is a POST to a bare `…&component=trader&asJson=1` (NO action
//   in the URL) that carries the action in the POST BODY, renamed:
//     - Auctioneer bid  → body `action=auctioneerSubmitBid&bid[planets]…`
//     - Import trade    → body `action=importexportTrade…` (assumed by symmetry
//       with the bid rename; the ≤1.12 name was `trade`)
//
// So we (a) gate on the URL's component — `component=trader` optionally
// followed by the legacy suffix, pinned to a word boundary
// (`component=trader(?:auctioneer|importexport)?(?=&|$)`) so the unified
// `trader` AND the old per-page names match while the resource market
// `traderresources` does NOT — then (b) discriminate bid vs trade by scanning a
// combined URL+body haystack for the action token (`…submitBid` vs `…trade`,
// case-insensitive with a `[a-z]*` prefix so both the bare ≤1.12 and the
// page-prefixed 1.13 spellings match). The action token is what tells the two
// glows apart now that they share one URL; the resource market can't reach the
// discriminator because the component gate already excluded it.
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
 * URL gate: the unified 1.13 `component=trader` and the legacy per-page
 * `traderauctioneer` / `traderimportexport`, but NOT the resource market
 * `traderresources` (the `(?=&|$)` word-boundary after the optional suffix
 * rejects it). See the header for the full rationale.
 */
const TRADER_URL_RE = /component=trader(?:auctioneer|importexport)?(?=&|$)/;

/**
 * Action discriminators, tested against a combined URL+body haystack (the
 * action is in the URL ≤1.12, in the POST body 1.13+). The `[a-z]*` prefix +
 * `i` flag match both the bare (`submitBid` / `trade`) and page-prefixed
 * (`auctioneerSubmitBid` / `importexportTrade`) spellings.
 */
const BID_ACTION_RE = /action=[a-z]*submitbid/i;
const TRADE_ACTION_RE = /action=[a-z]*trade/i;

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

  // One observer gated on the trader component (the URL no longer discriminates
  // bid from trade in 1.13). Success is decided the same way for both; the
  // action token — read from the URL ≤1.12 or the POST body 1.13+ — routes the
  // clear to the matching glow. Bid and trade are mutually exclusive, so the
  // else-if never double-fires.
  const unsub = observeXHR({
    urlPattern: TRADER_URL_RE,
    on: 'load',
    handler: ({ xhr, url, body, response }) => {
      if (xhr.status !== 200 || !succeeded(response)) return;
      const hay = `${url}&${typeof body === 'string' ? body : ''}`;
      if (BID_ACTION_RE.test(hay)) {
        document.dispatchEvent(new CustomEvent(TRADER_BID_PLACED_EVENT));
      } else if (TRADE_ACTION_RE.test(hay)) {
        document.dispatchEvent(new CustomEvent(TRADER_IMPORT_TRADED_EVENT));
      }
    },
  });

  installed = () => {
    unsub();
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
