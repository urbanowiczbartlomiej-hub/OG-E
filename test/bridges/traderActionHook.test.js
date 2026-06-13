// @vitest-environment happy-dom
//
// Tests for the trader-action bridge. Driven through its real public
// surface (`installTraderActionHook`) plus a hand-rolled XHR that exercises
// the patched prototype, mirroring `galaxyHook.test.js`. We assert on the
// `oge:traderBidPlaced` / `oge:traderImportTraded` CustomEvents the bridge
// dispatches on `document`.
//
// The `xhrObserver` prototype patch persists across cases by design; we
// reset the observer registry and the hook sentinel between tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installTraderActionHook,
  _resetTraderActionHookForTest,
} from '../../src/bridges/traderActionHook.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { fakeXHR as fakeXhrRoundTrip } from '../helpers/fakeXhr.js';

/**
 * Simulate one trader-action POST round-trip with a given HTTP status and
 * response body. Thin wrapper over the shared round-trip helper, keeping this
 * file's positional `(url, responseText, status)` shape.
 *
 * @param {string} url
 * @param {string} responseText
 * @param {number} [status]
 * @returns {Promise<void>}
 */
const fakeXHR = async (url, responseText, status = 200) => {
  await fakeXhrRoundTrip(url, { method: 'POST', responseText, status });
};

/**
 * Count dispatches of `type` on `document`. `count` is a function so the
 * shape stays a plain `{ count, cleanup }` object (no getter inference).
 *
 * @param {string} type
 * @returns {{ count: () => number, cleanup: () => void }}
 */
const capture = (type) => {
  let n = 0;
  const listener = () => {
    n += 1;
  };
  document.addEventListener(type, listener);
  return {
    count: () => n,
    cleanup: () => document.removeEventListener(type, listener),
  };
};

const BID_URL =
  '/game/index.php?page=ajax&component=traderauctioneer&ajax=1&action=submitBid&asJson=1';
const TRADE_URL =
  '/game/index.php?page=ajax&component=traderimportexport&ajax=1&action=trade&asJson=1';

/** @type {Array<() => void>} */
let cleanups = [];

beforeEach(() => {
  _resetObserversForTest();
  _resetTraderActionHookForTest();
  cleanups = [];
});

afterEach(() => {
  for (const fn of cleanups) fn();
  _resetObserversForTest();
  _resetTraderActionHookForTest();
});

/**
 * @template {{ cleanup: () => void }} T
 * @param {T} cap
 * @returns {T}
 */
const track = (cap) => {
  cleanups.push(cap.cleanup);
  return cap;
};

describe('installTraderActionHook — bid', () => {
  it('fires oge:traderBidPlaced on a 200 submitBid', async () => {
    installTraderActionHook();
    const cap = track(capture('oge:traderBidPlaced'));
    await fakeXHR(BID_URL, JSON.stringify({ message: 'ok' }));
    expect(cap.count()).toBe(1);
  });

  it('does NOT fire for a submitBid on a non-200', async () => {
    installTraderActionHook();
    const cap = track(capture('oge:traderBidPlaced'));
    await fakeXHR(BID_URL, JSON.stringify({ message: 'ok' }), 500);
    expect(cap.count()).toBe(0);
  });

  it('does NOT fire when the body says success:false', async () => {
    installTraderActionHook();
    const cap = track(capture('oge:traderBidPlaced'));
    await fakeXHR(BID_URL, JSON.stringify({ success: false }));
    expect(cap.count()).toBe(0);
  });

  it('does NOT fire on a non-JSON 200', async () => {
    installTraderActionHook();
    const cap = track(capture('oge:traderBidPlaced'));
    await fakeXHR(BID_URL, '<html>error</html>');
    expect(cap.count()).toBe(0);
  });
});

describe('installTraderActionHook — import trade', () => {
  it('fires oge:traderImportTraded on a 200 trade', async () => {
    installTraderActionHook();
    const cap = track(capture('oge:traderImportTraded'));
    await fakeXHR(TRADE_URL, JSON.stringify({ item: 'container' }));
    expect(cap.count()).toBe(1);
  });

  it('does NOT fire when the body says error:true', async () => {
    installTraderActionHook();
    const cap = track(capture('oge:traderImportTraded'));
    await fakeXHR(TRADE_URL, JSON.stringify({ error: true }));
    expect(cap.count()).toBe(0);
  });
});

describe('installTraderActionHook — discrimination', () => {
  it('a bid does not fire the import event and vice-versa', async () => {
    installTraderActionHook();
    const bid = track(capture('oge:traderBidPlaced'));
    const trade = track(capture('oge:traderImportTraded'));

    await fakeXHR(BID_URL, JSON.stringify({ ok: 1 }));
    expect(bid.count()).toBe(1);
    expect(trade.count()).toBe(0);

    await fakeXHR(TRADE_URL, JSON.stringify({ ok: 1 }));
    expect(bid.count()).toBe(1);
    expect(trade.count()).toBe(1);
  });

  it('ignores unrelated trader URLs (refreshPlanet, bargain, resource market)', async () => {
    installTraderActionHook();
    const bid = track(capture('oge:traderBidPlaced'));
    const trade = track(capture('oge:traderImportTraded'));

    await fakeXHR('/x?component=traderauctioneer&action=refreshPlanet', JSON.stringify({ ok: 1 }));
    await fakeXHR('/x?component=traderimportexport&action=bargain', JSON.stringify({ ok: 1 }));
    await fakeXHR('/x?component=traderresources&action=trade', JSON.stringify({ ok: 1 }));

    expect(bid.count()).toBe(0);
    expect(trade.count()).toBe(0);
  });
});

describe('installTraderActionHook — idempotency', () => {
  it('repeated install does not double-fire', async () => {
    installTraderActionHook();
    installTraderActionHook();
    const cap = track(capture('oge:traderBidPlaced'));
    await fakeXHR(BID_URL, JSON.stringify({ ok: 1 }));
    expect(cap.count()).toBe(1);
  });

  it('unsubscribe silences further events', async () => {
    const unsub = installTraderActionHook();
    const cap = track(capture('oge:traderBidPlaced'));
    await fakeXHR(BID_URL, JSON.stringify({ ok: 1 }));
    expect(cap.count()).toBe(1);
    unsub();
    await fakeXHR(BID_URL, JSON.stringify({ ok: 1 }));
    expect(cap.count()).toBe(1);
  });
});
