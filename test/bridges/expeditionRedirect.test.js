// @vitest-environment happy-dom
//
// Tests for the expedition-redirect bridge.
//
// Strategy:
//   - Unit-test the pure helpers (`getMissionFromBody`, `buildRedirectUrl`,
//     `isEnabled`, `findNextPlanetWithoutExpedition`) directly through
//     the `_internalsForTest` export. Small inputs, clean assertions,
//     failures pinpoint the exact helper at fault.
//   - Unit-test `overrideResponseText` by calling it on a handcrafted
//     XHR object with a mock descriptor, so we isolate the response-
//     rewrite contract from the xhrObserver integration.
//   - Smoke-test `installExpeditionRedirect` to prove the xhrObserver
//     wiring fires the handler on mission=15 and leaves mission=7 alone.
//
// Why split responsibilities this way:
//   The response-text rewrite path is genuinely hard to drive end-to-end
//   through happy-dom's XHR — the override's `get` calls
//   `responseTextDescriptor.get.call(this)` which reads from the
//   prototype's native getter, but happy-dom populates `responseText` via
//   internal state that our test fake can't easily reach. Rather than
//   mock half of happy-dom, we use `overrideResponseText` as an injection
//   point: the helper takes the descriptor as an argument, so tests
//   hand in a simple `{ get }` stub and assert on the transformation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installExpeditionRedirect,
  _resetExpeditionRedirectForTest,
  _internalsForTest,
} from '../../src/bridges/expeditionRedirect.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';

const { isEnabled, getMissionFromBody, findNextPlanetWithoutExpedition, buildRedirectUrl, overrideResponseText, ENABLED_KEY } =
  _internalsForTest;

const SEND_FLEET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  _resetObserversForTest();
  _resetExpeditionRedirectForTest();
  // Pin location.href to a predictable base so buildRedirectUrl produces
  // a deterministic output that tests can assert against.
  window.history.replaceState({}, '', '/game/index.php?page=ingame&component=fleetdispatch');
});

afterEach(() => {
  _resetObserversForTest();
  _resetExpeditionRedirectForTest();
  localStorage.clear();
});

/**
 * Build a planet list fixture.
 *
 * @param {Array<{ id: string, current?: boolean, hasExpedition?: boolean }>} entries
 * @returns {void}
 */
const setPlanetList = (entries) => {
  const list = document.createElement('div');
  list.id = 'planetList';
  for (const entry of entries) {
    const planet = document.createElement('div');
    planet.classList.add('smallplanet');
    if (entry.current) planet.classList.add('hightlightPlanet');
    planet.id = 'planet-' + entry.id;
    if (entry.hasExpedition) {
      const dots = document.createElement('span');
      dots.classList.add('ogi-exp-dots');
      planet.appendChild(dots);
    }
    list.appendChild(planet);
  }
  document.body.appendChild(list);
};

// ──────────────────────────────────────────────────────────────────
// getMissionFromBody
// ──────────────────────────────────────────────────────────────────

describe('getMissionFromBody', () => {
  it('parses `mission=15` from a form-encoded body', () => {
    expect(getMissionFromBody('mission=15&type=1&galaxy=4')).toBe(15);
  });

  it('parses `mission=7` (colonize) as a plain integer', () => {
    expect(getMissionFromBody('galaxy=1&mission=7&position=3')).toBe(7);
  });

  it('returns null when body is not a string', () => {
    expect(getMissionFromBody(null)).toBeNull();
    expect(getMissionFromBody(undefined)).toBeNull();
    expect(getMissionFromBody({})).toBeNull();
    expect(getMissionFromBody(123)).toBeNull();
  });

  it('returns null when the `mission` key is absent from the body', () => {
    expect(getMissionFromBody('galaxy=1&system=2&position=3')).toBeNull();
  });

  it('returns null when `mission` is non-numeric', () => {
    expect(getMissionFromBody('mission=foo&galaxy=1')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// buildRedirectUrl
// ──────────────────────────────────────────────────────────────────

describe('buildRedirectUrl', () => {
  it('builds a fleetdispatch URL with the given cp id (query tail is canonical)', () => {
    const url = buildRedirectUrl('12345');
    // The query tail is what the game actually reads for navigation;
    // the URL scheme + path come from `location.href`, which happy-dom
    // derives from the vitest environment (not under our control here).
    // So we pin the assertion to the tail we DO control.
    expect(url.endsWith('?page=ingame&component=fleetdispatch&cp=12345')).toBe(true);
  });

  it('strips any existing query string off the current location (no state leak)', () => {
    window.history.replaceState(
      {},
      '',
      '/some/path?page=ingame&component=fleetdispatch&cp=99999&position=3',
    );
    const url = buildRedirectUrl('55555');
    // Deterministic tail — no stale `position=3` / `cp=99999` inherited
    // from the prior URL state.
    expect(url.endsWith('?page=ingame&component=fleetdispatch&cp=55555')).toBe(true);
    expect(url.includes('position=3')).toBe(false);
    expect(url.includes('cp=99999')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────
// isEnabled
// ──────────────────────────────────────────────────────────────────

describe('isEnabled', () => {
  it('defaults to true when localStorage has no entry (opt-out)', () => {
    expect(isEnabled()).toBe(true);
  });

  it('returns false when the preference is explicitly disabled', () => {
    localStorage.setItem(ENABLED_KEY, 'false');
    expect(isEnabled()).toBe(false);
  });

  it('returns true when the preference is explicitly enabled', () => {
    localStorage.setItem(ENABLED_KEY, 'true');
    expect(isEnabled()).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// findNextPlanetWithoutExpedition
// ──────────────────────────────────────────────────────────────────

describe('findNextPlanetWithoutExpedition', () => {
  it('returns the next planet after the current one when it lacks .ogi-exp-dots', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: false },
      { id: '333', hasExpedition: false },
    ]);
    expect(findNextPlanetWithoutExpedition()).toBe('222');
  });

  it('skips planets with active expeditions and picks the first clear one', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: true },
      { id: '333', hasExpedition: false },
    ]);
    expect(findNextPlanetWithoutExpedition()).toBe('333');
  });

  it('wraps around to the start of the list when current is the last entry', () => {
    setPlanetList([
      { id: '111', hasExpedition: false },
      { id: '222', hasExpedition: true },
      { id: '333', current: true, hasExpedition: true },
    ]);
    expect(findNextPlanetWithoutExpedition()).toBe('111');
  });

  it('returns null when every OTHER planet already has an expedition', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: false },
      { id: '222', hasExpedition: true },
      { id: '333', hasExpedition: true },
    ]);
    expect(findNextPlanetWithoutExpedition()).toBeNull();
  });

  it('returns null when there are fewer than 2 planets', () => {
    setPlanetList([{ id: '111', current: true, hasExpedition: false }]);
    expect(findNextPlanetWithoutExpedition()).toBeNull();
  });

  it('returns null when no planet is highlighted (edge case)', () => {
    setPlanetList([
      { id: '111', hasExpedition: false },
      { id: '222', hasExpedition: false },
    ]);
    expect(findNextPlanetWithoutExpedition()).toBeNull();
  });

  it('returns null when #planetList is missing entirely', () => {
    expect(findNextPlanetWithoutExpedition()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// overrideResponseText
// ──────────────────────────────────────────────────────────────────

describe('overrideResponseText', () => {
  /**
   * Build a minimal descriptor stub that returns `raw` from `.get.call`.
   * Mirrors what `Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype,
   * 'responseText')` would hand back for a completed request.
   *
   * @param {string | null} raw
   */
  const mockDescriptor = (raw) => ({
    configurable: true,
    enumerable: true,
    get: function () {
      return raw;
    },
  });

  it('rewrites redirectUrl to the next planet when one exists', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: false },
    ]);
    const xhr = /** @type {any} */ ({});
    const raw = JSON.stringify({ success: true, redirectUrl: '/original/redirect' });
    overrideResponseText(xhr, mockDescriptor(raw));

    const rewritten = JSON.parse(xhr.responseText);
    expect(rewritten.success).toBe(true);
    // Match the tail; happy-dom's location supplies the origin.
    expect(rewritten.redirectUrl).toMatch(
      /\?page=ingame&component=fleetdispatch&cp=222$/,
    );
    // The rewrite actually changed the URL from the original.
    expect(rewritten.redirectUrl).not.toBe('/original/redirect');
  });

  it('leaves the raw response untouched when no suitable target exists', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: true },
    ]);
    const xhr = /** @type {any} */ ({});
    const raw = JSON.stringify({ success: true, redirectUrl: '/original' });
    overrideResponseText(xhr, mockDescriptor(raw));

    expect(xhr.responseText).toBe(raw);
  });

  it('leaves malformed JSON untouched', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: false },
      { id: '222', hasExpedition: false },
    ]);
    const xhr = /** @type {any} */ ({});
    overrideResponseText(xhr, mockDescriptor('not valid json {'));
    expect(xhr.responseText).toBe('not valid json {');
  });

  it('leaves the response untouched when success is falsy', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: false },
      { id: '222', hasExpedition: false },
    ]);
    const xhr = /** @type {any} */ ({});
    const raw = JSON.stringify({ success: false, error: 'Not enough ships' });
    overrideResponseText(xhr, mockDescriptor(raw));
    // No rewrite happened — the stringified fallback === the input.
    expect(xhr.responseText).toBe(raw);
  });

  it('leaves the response untouched when redirectUrl is missing', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: false },
      { id: '222', hasExpedition: false },
    ]);
    const xhr = /** @type {any} */ ({});
    const raw = JSON.stringify({ success: true });
    overrideResponseText(xhr, mockDescriptor(raw));
    expect(xhr.responseText).toBe(raw);
  });

  it('caches the rewritten string so repeated reads do not re-transform', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: false },
    ]);
    const xhr = /** @type {any} */ ({});
    const raw = JSON.stringify({ success: true, redirectUrl: '/original' });

    const descriptor = mockDescriptor(raw);
    const getSpy = vi.spyOn(descriptor, 'get');
    overrideResponseText(xhr, descriptor);

    const first = xhr.responseText;
    const second = xhr.responseText;
    const third = xhr.responseText;
    // All three reads return the same cached string ...
    expect(first).toBe(second);
    expect(second).toBe(third);
    // ... and the underlying descriptor getter was consulted only for the
    // first read. Subsequent reads pull from the closure cache.
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw if raw itself is empty/null (no spurious rewrite)', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: false },
      { id: '222', hasExpedition: false },
    ]);
    const xhr = /** @type {any} */ ({});
    overrideResponseText(xhr, mockDescriptor(null));
    expect(xhr.responseText).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// installExpeditionRedirect — integration smoke
// ──────────────────────────────────────────────────────────────────

/**
 * Drive one sendFleet POST through happy-dom's XHR shim. Mirrors the
 * helper used in sibling bridge tests. We specifically care about the
 * `send`-phase path here, because that's where the observer fires; we
 * don't need to simulate the response load for these integration tests.
 *
 * @param {string} body
 * @param {string} [url]
 * @returns {XMLHttpRequest}
 */
const fakeSendFleetXHR = (body, url = SEND_FLEET_URL) => {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);
  xhr.send(body);
  return xhr;
};

describe('installExpeditionRedirect — integration smoke', () => {
  beforeEach(() => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: false },
    ]);
  });

  it('overrides xhr.responseText on a mission=15 sendFleet (user preference enabled)', () => {
    installExpeditionRedirect();

    const xhr = fakeSendFleetXHR('mission=15&galaxy=4&system=30&position=16');
    const descriptor = Object.getOwnPropertyDescriptor(xhr, 'responseText');

    // The override is an instance-level descriptor (what our module put
    // there), not the prototype's one.
    expect(descriptor).toBeDefined();
    expect(typeof descriptor?.get).toBe('function');
    expect(descriptor?.configurable).toBe(true);
  });

  it('does NOT override xhr.responseText on mission=7 (colonize) sendFleet', () => {
    installExpeditionRedirect();

    const xhr = fakeSendFleetXHR('mission=7&galaxy=4&system=30&position=3');
    const descriptor = Object.getOwnPropertyDescriptor(xhr, 'responseText');

    // No override — the responseText property still lives on the
    // prototype, not the instance.
    expect(descriptor).toBeUndefined();
  });

  it('does NOT override when the user preference is disabled', () => {
    localStorage.setItem(ENABLED_KEY, 'false');
    installExpeditionRedirect();

    const xhr = fakeSendFleetXHR('mission=15&galaxy=4&system=30&position=16');
    const descriptor = Object.getOwnPropertyDescriptor(xhr, 'responseText');

    expect(descriptor).toBeUndefined();
  });

  it('does NOT override on non-sendFleet URLs (URL filter still applies)', () => {
    installExpeditionRedirect();

    const xhr = fakeSendFleetXHR(
      'mission=15&galaxy=4&system=30&position=16',
      '/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent',
    );
    const descriptor = Object.getOwnPropertyDescriptor(xhr, 'responseText');

    expect(descriptor).toBeUndefined();
  });

  it('is idempotent — repeated install calls return the same unsubscribe', () => {
    const unsub1 = installExpeditionRedirect();
    const unsub2 = installExpeditionRedirect();
    expect(unsub1).toBe(unsub2);
  });

  it('does not double-register on repeated installs (override runs once per xhr)', () => {
    installExpeditionRedirect();
    installExpeditionRedirect();
    installExpeditionRedirect();

    // Build an xhr and check that the override descriptor exists exactly
    // once on the instance. `defineProperty` with the same key replaces
    // the descriptor rather than stacking, so we can't directly count
    // registrations — but the observer COUNT matters: if we had three
    // observers all wiring up the same override, we'd still see only one
    // instance-level descriptor. Instead we spy on `defineProperty` to
    // confirm that the observer runs exactly once per send.
    const spy = vi.spyOn(Object, 'defineProperty');
    fakeSendFleetXHR('mission=15&galaxy=4&system=30&position=16');

    // Filter out descriptor calls on non-xhr targets (happy-dom's internal
    // bookkeeping etc.) — we only care about `responseText` overrides on
    // XMLHttpRequest instances.
    const responseTextOverrides = spy.mock.calls.filter(
      ([, prop]) => prop === 'responseText',
    );
    spy.mockRestore();

    expect(responseTextOverrides).toHaveLength(1);
  });

  it('unsubscribe stops further overrides', () => {
    const unsub = installExpeditionRedirect();

    const xhr1 = fakeSendFleetXHR('mission=15&galaxy=4&system=30&position=16');
    expect(Object.getOwnPropertyDescriptor(xhr1, 'responseText')).toBeDefined();

    unsub();

    const xhr2 = fakeSendFleetXHR('mission=15&galaxy=4&system=30&position=16');
    expect(Object.getOwnPropertyDescriptor(xhr2, 'responseText')).toBeUndefined();
  });
});
