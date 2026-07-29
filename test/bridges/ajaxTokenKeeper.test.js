// @vitest-environment happy-dom
//
// Behavioural tests for the ajax-token keeper. Per the project's test policy
// for bridges we drive a fake XHR through happy-dom and assert the OBSERVABLE
// output — what the page's own token holders end up holding, and whether the
// outgoing body was left alone — never module internals. The one exception is
// the masked `window.__ogeToken()` snapshot, which IS a public surface (the
// support affordance users paste back).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installAjaxTokenKeeper,
  _resetAjaxTokenKeeperForTest,
} from '../../src/bridges/ajaxTokenKeeper.js';
import { observeXHR, _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { fakeXHR } from '../helpers/fakeXhr.js';

/** Three well-shaped 32-char tokens, oldest → newest. */
const T0 = 'a0'.repeat(16);
const T1 = 'b1'.repeat(16);
const T2 = 'c2'.repeat(16);

const CHECK_TARGET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=checkTarget&asJson=1';
const EVENTBOX_URL =
  '/game/index.php?page=ingame&component=eventlist&action=fetchEventBox&asJson=1';

/** @param {string} token */
const rotationResponse = (token) => `{"status":"success","newAjaxToken":"${token}"}`;

/** The page global the game's `appendTokenParams()` reads. */
const pageToken = () => /** @type {any} */ (window).token;
/** @param {string | undefined} v */
const setPageToken = (v) => {
  /** @type {any} */ (window).token = v;
};

const snapshot = () => /** @type {any} */ (window).__ogeToken();

beforeEach(() => {
  _resetObserversForTest();
  _resetAjaxTokenKeeperForTest();
  setPageToken(undefined);
  document.body.innerHTML = '';
});

afterEach(() => {
  _resetAjaxTokenKeeperForTest();
  _resetObserversForTest();
});

describe('ajaxTokenKeeper — learning rotations', () => {
  it('repairs a page global the game left on a spent token', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();

    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', responseText: rotationResponse(T1) });

    expect(pageToken()).toBe(T1);
    expect(snapshot().rotations).toBe(1);
    expect(snapshot().repairs).toBe(1);
  });

  it('writes nothing when the game applied the rotation itself', async () => {
    setPageToken(T0);
    // Stand in for the game's own callback, registered BEFORE ours — which is
    // the real order: the game attaches its handler before calling send(), we
    // attach ours from inside it. So by the time we look the holder already
    // agrees, and the happy path must be a no-op.
    observeXHR({
      urlPattern: /action=checkTarget/,
      on: 'load',
      handler: () => setPageToken(T1),
    });
    installAjaxTokenKeeper();

    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', responseText: rotationResponse(T1) });

    expect(pageToken()).toBe(T1);
    expect(snapshot().repairs).toBe(0);
  });

  it('learns from an echoing endpoint too (eventbox), not just checkTarget', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();

    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    expect(pageToken()).toBe(T1);
  });

  it('ignores responses from URLs that are not the game', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();

    await fakeXHR('/some/third-party/endpoint', { responseText: rotationResponse(T1) });

    expect(pageToken()).toBe(T0);
    expect(snapshot().rotations).toBe(0);
  });

  it('leaves a holder value of unknown provenance alone', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    // Something we never observed being issued put this here — it may well be
    // NEWER than what we know, so it must not be downgraded.
    const foreign = 'f9'.repeat(16);
    setPageToken(foreign);
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T2) });

    expect(pageToken()).toBe(foreign);
    expect(snapshot().unknown).toBeGreaterThan(0);
  });

  it('does not learn from a response whose request was sent EARLIER than the last one', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();

    // Two requests in flight: A sent first, B second — B's response lands first.
    const a = new XMLHttpRequest();
    a.open('POST', CHECK_TARGET_URL);
    a.send('token=' + T0);
    const b = new XMLHttpRequest();
    b.open('POST', CHECK_TARGET_URL);
    b.send('token=' + T0);

    const land = async (/** @type {XMLHttpRequest} */ xhr, /** @type {string} */ token) => {
      Object.defineProperty(xhr, 'responseText', {
        value: rotationResponse(token),
        configurable: true,
      });
      xhr.dispatchEvent(new Event('load'));
      await Promise.resolve();
    };

    await land(b, T2);
    await land(a, T1); // stale arrival — must be ignored

    expect(pageToken()).toBe(T2);
  });

  it('repairs the stale-by-design fleetDispatcher.token and the hidden inputs', async () => {
    setPageToken(T0);
    /** @type {any} */ (window).fleetDispatcher = { token: T0 };
    document.body.innerHTML = '<input name="token" value="' + T0 + '">';
    installAjaxTokenKeeper();

    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    expect(/** @type {any} */ (window).fleetDispatcher.token).toBe(T1);
    expect(/** @type {HTMLInputElement} */ (document.querySelector('input[name=token]')).value).toBe(
      T1,
    );
    delete /** @type {any} */ (window).fleetDispatcher;
  });

  it('never fills an OG-E-owned token input', async () => {
    setPageToken(T0);
    document.body.innerHTML = '<div id="oge-panel"><input name="token" value="' + T0 + '"></div>';
    installAjaxTokenKeeper();

    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    expect(/** @type {HTMLInputElement} */ (document.querySelector('input[name=token]')).value).toBe(
      T0,
    );
  });

  it('install is idempotent (a second call adds no second observer)', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    installAjaxTokenKeeper();

    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    expect(snapshot().rotations).toBe(1);
  });
});

describe('ajaxTokenKeeper — outgoing traffic', () => {
  /**
   * Spy on what actually goes on the wire. Registered AFTER the keeper, so the
   * observer chain hands it the keeper's replacement body — this is the only
   * honest way to assert a rewrite (the alternative is reading internals).
   *
   * @param {RegExp} [urlPattern]
   * @returns {unknown[]} Bodies observed, in send order.
   */
  const spyOnWire = (urlPattern = /action=checkTarget/) => {
    /** @type {unknown[]} */
    const bodies = [];
    observeXHR({ urlPattern, on: 'send', handler: ({ body }) => void bodies.push(body) });
    return bodies;
  };

  it('substitutes a spent token in an outgoing checkTarget (the private-cache case)', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    const onWire = spyOnWire();
    // The 2026-07-29 shape: a third-party serialiser replaying a token the
    // game spent seconds earlier — token appended LAST, ships up front.
    await fakeXHR(CHECK_TARGET_URL, {
      method: 'POST',
      body: `am203=4188&galaxy=1&system=2&position=3&type=1&union=0&token=${T0}`,
    });

    expect(onWire).toEqual([
      `am203=4188&galaxy=1&system=2&position=3&type=1&union=0&token=${T1}`,
    ]);
    expect(snapshot().staleOutgoing).toBe(1);
    expect(snapshot().rewrites).toBe(1);
  });

  it('substitutes in the middle of a body without disturbing the fields around it', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    const onWire = spyOnWire();
    // The game's own field order — token BETWEEN `type` and `union`.
    await fakeXHR(CHECK_TARGET_URL, {
      method: 'POST',
      body: `galaxy=1&system=2&position=3&type=1&token=${T0}&union=0`,
    });

    expect(onWire).toEqual([`galaxy=1&system=2&position=3&type=1&token=${T1}&union=0`]);
  });

  it('never touches a sendFleet body, even when it carries a spent token', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    const onWire = spyOnWire(/action=sendFleet/);
    const body = `galaxy=1&mission=3&token=${T0}`;
    await fakeXHR('/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet', {
      method: 'POST',
      body,
    });

    // Scope is the whole fair-play argument: no repair can ever be part of a
    // fleet leaving. Unchanged body, and not even counted as stale.
    expect(onWire).toEqual([body]);
    expect(snapshot().rewrites).toBe(0);
    expect(snapshot().staleOutgoing).toBe(0);
  });

  it('leaves a token of unknown provenance strictly alone', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    const onWire = spyOnWire();
    // T2 was never observed — it may be NEWER than ours (a rotation that
    // reached the page through a channel we don't see), so hands off.
    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', body: `galaxy=1&token=${T2}` });

    expect(onWire).toEqual([`galaxy=1&token=${T2}`]);
    expect(snapshot().rewrites).toBe(0);
    expect(snapshot().unknown).toBeGreaterThan(0);
  });

  it('refuses to substitute when our own token is not provably NEWER than the one sent', async () => {
    // The shape that makes this guard necessary: a rotation we OBSERVED but
    // could not apply (its request was sent earlier than the one we last
    // learned from, so the send-order guard discarded it). Its token is now in
    // the provenance set — known — while being NEWER than what we hold. Without
    // a direction check, "known and different" would be read as "safe to
    // overwrite" and we would downgrade a request that was about to succeed.
    setPageToken(T0);
    installAjaxTokenKeeper();

    const a = new XMLHttpRequest();
    a.open('POST', CHECK_TARGET_URL);
    a.send(`galaxy=1&token=${T0}`);
    const b = new XMLHttpRequest();
    b.open('POST', CHECK_TARGET_URL);
    b.send(`galaxy=1&token=${T0}`);

    const land = async (/** @type {XMLHttpRequest} */ xhr, /** @type {string} */ token) => {
      Object.defineProperty(xhr, 'responseText', {
        value: rotationResponse(token),
        configurable: true,
      });
      xhr.dispatchEvent(new Event('load'));
      await Promise.resolve();
    };

    await land(b, T1); // B was sent second and lands first → applied
    await land(a, T2); // A was sent first and lands late → observed, not applied

    expect(pageToken()).toBe(T1);
    expect(snapshot().outOfOrder).toBe(1);

    const onWire = spyOnWire();
    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', body: `galaxy=1&token=${T2}` });

    // Detected as "not ours", but refused rather than moved backwards.
    expect(onWire).toEqual([`galaxy=1&token=${T2}`]);
    expect(snapshot().staleOutgoing).toBe(1);
    expect(snapshot().rewrites).toBe(0);
  });

  it('does not move the token BACKWARDS when a slow echo lands after a rotation', async () => {
    // eventbox / catchEvents only ECHO the current token; a late echo used to
    // be "learned" and would downgrade us to a value the server had retired.
    setPageToken(T0);
    installAjaxTokenKeeper();

    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });
    await fakeXHR(CHECK_TARGET_URL, {
      method: 'POST',
      body: `galaxy=1&token=${T1}`,
      responseText: rotationResponse(T2),
    });
    expect(pageToken()).toBe(T2);

    // The straggler: an echo still carrying T1, arriving after T2 was issued.
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    expect(pageToken()).toBe(T2);
    expect(snapshot().downgrades).toBe(1);
  });

  it('disarms itself for good after repaired requests keep being refused', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    const refusal = '{"status":"failure","errors":[{"error":100}],"error":100}';
    for (let i = 0; i < 3; i += 1) {
      await fakeXHR(CHECK_TARGET_URL, {
        method: 'POST',
        body: `galaxy=1&token=${T0}`,
        responseText: refusal,
      });
    }

    expect(snapshot().failedRewrites).toBe(3);
    expect(snapshot().disarmed).toBe(true);

    // Detection survives the disarm — the counter is how we tell "the fix is
    // working" from "the fix never had to fire" — but the body is now untouched.
    const onWire = spyOnWire();
    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', body: `galaxy=1&token=${T0}` });

    expect(onWire).toEqual([`galaxy=1&token=${T0}`]);
    expect(snapshot().rewrites).toBe(3);
    expect(snapshot().staleOutgoing).toBe(4);
  });

  it('does not flag an outgoing body that already carries the fresh token', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', body: `galaxy=1&token=${T1}` });

    expect(snapshot().staleOutgoing).toBe(0);
  });

  it('counts every game request it saw (the "did we install in time" signal)', async () => {
    installAjaxTokenKeeper();

    await fakeXHR(EVENTBOX_URL, { responseText: '{}' });
    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', body: 'galaxy=1' });
    await fakeXHR('/some/third-party/endpoint');

    expect(snapshot().requests).toBe(2);
  });

  it('masks the live token in the support snapshot', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });

    const { latest } = snapshot();
    expect(latest).toBe(`${T1.slice(0, 4)}…(32)`);
    expect(latest).not.toContain(T1);
  });

  it('traces its decisions in the snapshot, with tokens masked', async () => {
    setPageToken(T0);
    installAjaxTokenKeeper();
    await fakeXHR(EVENTBOX_URL, { responseText: rotationResponse(T1) });
    await fakeXHR(CHECK_TARGET_URL, { method: 'POST', body: `galaxy=1&token=${T0}` });

    const { log } = snapshot();
    // The counters cannot say WHY a decision went the way it did; this trail
    // can, and it is safe to paste into a bug report.
    expect(log).toEqual([
      `rot ${T1.slice(0, 4)} seq=1`,
      `repair ${T1.slice(0, 4)} holders=1`,
      `rewrite ${T0.slice(0, 4)} →${T1.slice(0, 4)}`,
    ]);
    expect(log.join(' ')).not.toContain(T0);
    expect(log.join(' ')).not.toContain(T1);
  });
});
