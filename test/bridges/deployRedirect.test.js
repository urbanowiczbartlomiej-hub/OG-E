// @vitest-environment happy-dom
//
// Tests for the deployment-redirect bridge — a "dumb rewriter" that swaps
// the game's post-send `redirectUrl` for a precomputed URL the isolated
// world stashed in `oge_fsRedirect`.
//
// Strategy mirrors expeditionRedirect.test.js: unit-test the helpers
// directly via `_internalsForTest`, drive `overrideResponseText` against a
// handcrafted XHR + mock descriptor, and smoke-test the install wiring
// through the shared xhrObserver.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installDeployRedirect,
  _resetDeployRedirectForTest,
  _internalsForTest,
  DAILY_RUN_REDIRECT_KEY,
} from '../../src/bridges/deployRedirect.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { safeLS } from '../../src/lib/storage.js';

const { getMissionFromBody, overrideResponseText } = _internalsForTest;

const NEXT_URL = 'https://s163-pl.ogame.gameforge.com/game/index.php?page=ingame&component=fleetdispatch';

beforeEach(() => {
  localStorage.clear();
  _resetObserversForTest();
  _resetDeployRedirectForTest();
});

afterEach(() => {
  _resetObserversForTest();
  _resetDeployRedirectForTest();
  localStorage.clear();
});

describe('getMissionFromBody', () => {
  it('parses mission=4 (deployment)', () => {
    expect(getMissionFromBody('mission=4&type=3&galaxy=4')).toBe(4);
  });
  it('returns null for a non-string body', () => {
    expect(getMissionFromBody(null)).toBeNull();
    expect(getMissionFromBody(undefined)).toBeNull();
  });
  it('returns null when mission is absent', () => {
    expect(getMissionFromBody('type=3&galaxy=4')).toBeNull();
  });
});

describe('overrideResponseText', () => {
  /**
   * Build a fake xhr + descriptor returning `raw` from the native getter.
   * @param {string} raw
   */
  const makeXhr = (raw) => {
    const xhr = /** @type {any} */ ({});
    const descriptor = { configurable: true, get: () => raw };
    return { xhr, descriptor };
  };

  it('swaps redirectUrl on a successful response', () => {
    const raw = JSON.stringify({ success: true, redirectUrl: 'https://old/target' });
    const { xhr, descriptor } = makeXhr(raw);
    overrideResponseText(xhr, descriptor, NEXT_URL);
    const out = JSON.parse(xhr.responseText);
    expect(out.success).toBe(true);
    expect(out.redirectUrl).toBe(NEXT_URL);
  });

  it('leaves a failed response untouched', () => {
    const raw = JSON.stringify({ success: false, redirectUrl: 'https://old/target' });
    const { xhr, descriptor } = makeXhr(raw);
    overrideResponseText(xhr, descriptor, NEXT_URL);
    expect(JSON.parse(xhr.responseText).redirectUrl).toBe('https://old/target');
  });

  it('passes malformed JSON through unchanged', () => {
    const { xhr, descriptor } = makeXhr('<html>error</html>');
    overrideResponseText(xhr, descriptor, NEXT_URL);
    expect(xhr.responseText).toBe('<html>error</html>');
  });

  it('caches the rewrite across repeated reads', () => {
    let calls = 0;
    const raw = JSON.stringify({ success: true, redirectUrl: 'x' });
    const xhr = /** @type {any} */ ({});
    const descriptor = { configurable: true, get: () => { calls += 1; return raw; } };
    overrideResponseText(xhr, descriptor, NEXT_URL);
    void xhr.responseText;
    void xhr.responseText;
    expect(calls).toBe(1); // second read served from cache
  });
});

describe('installDeployRedirect — handoff consumption', () => {
  it('consumes (removes) the handoff key on a matching deployment send', () => {
    installDeployRedirect();
    safeLS.set(DAILY_RUN_REDIRECT_KEY, NEXT_URL);

    // Simulate a sendFleet send-phase by invoking a fresh XHR through the
    // shared observer. We register a sentinel observer to capture that the
    // bridge's own send handler ran and removed the key.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet');
    xhr.send('mission=4&type=3&galaxy=4&system=472&position=15');

    expect(safeLS.get(DAILY_RUN_REDIRECT_KEY)).toBeNull();
  });

  it('leaves the handoff key alone for a non-deployment send', () => {
    installDeployRedirect();
    safeLS.set(DAILY_RUN_REDIRECT_KEY, NEXT_URL);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet');
    xhr.send('mission=15&type=1&galaxy=4');

    expect(safeLS.get(DAILY_RUN_REDIRECT_KEY)).toBe(NEXT_URL);
  });

  it('is idempotent — second install returns the same unsubscribe', () => {
    const u1 = installDeployRedirect();
    const u2 = installDeployRedirect();
    expect(u1).toBe(u2);
  });
});
