// @vitest-environment happy-dom
//
// Tests for the expedition-redirect bridge.
//
// Strategy:
//   - Unit-test the pure helpers (`getMissionFromBody`, `buildRedirectUrl`,
//     `isEnabled`, `findNextPlanetWithFreeSlot`) directly through
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

const { isEnabled, getMissionFromBody, findNextPlanetWithFreeSlot, buildRedirectUrl, overrideResponseText, ENABLED_KEY, MAX_PER_PLANET_KEY, SKIP_COORDS_KEY } =
  _internalsForTest;

const SEND_FLEET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.querySelectorAll('meta[name="ogame-planet-type"]').forEach((m) => m.remove());
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
 * Build a planet-list fixture PLUS the matching event ticker — the bridge
 * counts a planet's in-flight expeditions off `#eventContent`, so the tally is
 * expressed in ticker rows, not in a badge on the row.
 *
 * Each planet gets synthetic coords `1:1:<n>` (n = its position in the list) and
 * every expedition is rendered as the TWO rows the game writes at dispatch for a
 * two-way mission: an outbound leg and a return leg, both reading
 * `origin = launcher` (coords are direction-stable). The bridge must attribute
 * the pair to ONE expedition — counting rows is what used to make every planet
 * look over its cap after a single round-robin pass.
 *
 * `expeditions` sets the count explicitly; the legacy `hasExpedition` boolean is
 * shorthand for one (1) expedition.
 *
 * @param {Array<{ id: string, current?: boolean, currentMoon?: boolean,
 *   moonCp?: string, hasExpedition?: boolean, expeditions?: number }>} entries
 * @returns {void}
 */
const setPlanetList = (entries) => {
  const list = document.createElement('div');
  list.id = 'planetList';
  /** @type {string[]} */
  const rows = [];
  entries.forEach((entry, i) => {
    const coords = `1:1:${i + 1}`;
    const planet = document.createElement('div');
    planet.classList.add('smallplanet');
    if (entry.current) planet.classList.add('hightlightPlanet');
    // Moon pages highlight the row with hightlightMoon INSTEAD (the game
    // swaps the class) — see lib/gameDom.ACTIVE_MOON_CLASS.
    if (entry.currentMoon) planet.classList.add('hightlightMoon');
    planet.id = 'planet-' + entry.id;
    planet.insertAdjacentHTML(
      'beforeend',
      `<a class="planetlink"><span class="planet-koords">[${coords}]</span></a>`,
    );
    if (entry.moonCp) {
      planet.insertAdjacentHTML(
        'beforeend',
        `<a class="moonlink" href="?page=ingame&component=overview&cp=${entry.moonCp}"></a>`,
      );
    }
    const count = entry.expeditions ?? (entry.hasExpedition ? 1 : 0);
    for (let k = 0; k < count; k++) {
      rows.push(`
        <tr class="eventFleet" data-mission-type="15" data-return-flight="false">
          <td class="coordsOrigin">[${coords}]</td>
          <td class="destCoords">[1:1:16]</td>
        </tr>
        <tr class="eventFleet" data-mission-type="15" data-return-flight="true">
          <td class="coordsOrigin">[${coords}]</td>
          <td class="destCoords">[1:1:16]</td>
        </tr>`);
    }
    list.appendChild(planet);
  });
  document.body.appendChild(list);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="eventContent"><table><tbody>${rows.join('')}</tbody></table></div>`,
  );
};

/** Stamp the page's `ogame-planet-type` meta — how the bridge learns whether
 * the send left from a moon. Cleared in the shared beforeEach.
 * @param {'planet'|'moon'} type */
const setBodyTypeMeta = (type) => {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'ogame-planet-type');
  meta.setAttribute('content', type);
  document.head.appendChild(meta);
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
// findNextPlanetWithFreeSlot — default cap (1)
// ──────────────────────────────────────────────────────────────────

describe('findNextPlanetWithFreeSlot — default cap (1)', () => {
  it('returns the next planet after the current one when it lacks .ogi-exp-dots', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: false },
      { id: '333', hasExpedition: false },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('222');
  });

  it('skips planets with active expeditions and picks the first clear one', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: true },
      { id: '222', hasExpedition: true },
      { id: '333', hasExpedition: false },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('333');
  });

  it('wraps around to the start of the list when current is the last entry', () => {
    setPlanetList([
      { id: '111', hasExpedition: false },
      { id: '222', hasExpedition: true },
      { id: '333', current: true, hasExpedition: true },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('111');
  });

  it('returns null when every OTHER planet already has an expedition', () => {
    setPlanetList([
      { id: '111', current: true, hasExpedition: false },
      { id: '222', hasExpedition: true },
      { id: '333', hasExpedition: true },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });

  it('returns null when there are fewer than 2 planets', () => {
    setPlanetList([{ id: '111', current: true, hasExpedition: false }]);
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });

  it('returns null when no planet is highlighted (edge case)', () => {
    setPlanetList([
      { id: '111', hasExpedition: false },
      { id: '222', hasExpedition: false },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });

  it('returns null when #planetList is missing entirely', () => {
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// findNextPlanetWithFreeSlot — moon-launched expeditions
// ──────────────────────────────────────────────────────────────────

describe('findNextPlanetWithFreeSlot — moon mode', () => {
  it('recognises the hightlightMoon row as active (a moon send previously matched no row at all)', () => {
    setBodyTypeMeta('moon');
    setPlanetList([
      { id: '111', currentMoon: true, moonCp: '911' },
      { id: '222', moonCp: '922' },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('922');
  });

  it('hops moon→moon: rows without a moon are skipped, the cp comes from the moonlink', () => {
    setBodyTypeMeta('moon');
    setPlanetList([
      { id: '111', currentMoon: true, moonCp: '911' },
      { id: '222' }, // no moon here — not a candidate
      { id: '333', moonCp: '933' },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('933');
  });

  it('the cap still gates in moon mode (dots on the row)', () => {
    setBodyTypeMeta('moon');
    setPlanetList([
      { id: '111', currentMoon: true, moonCp: '911' },
      { id: '222', moonCp: '922', hasExpedition: true },
      { id: '333', moonCp: '933' },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('933');
  });

  it('returns null when no other row has a moon', () => {
    setBodyTypeMeta('moon');
    setPlanetList([
      { id: '111', currentMoon: true, moonCp: '911' },
      { id: '222' },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });

  it('a planet-launched send ignores moonlinks entirely (row cp as before)', () => {
    setBodyTypeMeta('planet');
    setPlanetList([
      { id: '111', current: true },
      { id: '222', moonCp: '922' },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('222');
  });
});

// ──────────────────────────────────────────────────────────────────
// findNextPlanetWithFreeSlot — cap > 1 (round-robin)
// ──────────────────────────────────────────────────────────────────

describe('findNextPlanetWithFreeSlot — cap of 2 (round-robin)', () => {
  beforeEach(() => {
    localStorage.setItem(MAX_PER_PLANET_KEY, '2');
  });

  it('still picks a planet that already has ONE expedition (under the cap of 2)', () => {
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 1 },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('222');
  });

  it('walks in list order, NOT to the emptiest planet (true round-robin)', () => {
    // B has one expedition, C has none — but B comes first in the wrap from A,
    // so the next pass tops B up before reaching the emptier C.
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 1 },
      { id: '333', expeditions: 0 },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('222');
  });

  it('skips a planet already at the cap and picks the next under it', () => {
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 2 },
      { id: '333', expeditions: 1 },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('333');
  });

  it('returns null when every OTHER planet has reached the cap', () => {
    setPlanetList([
      { id: '111', current: true, expeditions: 0 },
      { id: '222', expeditions: 2 },
      { id: '333', expeditions: 2 },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });

  it('treats a missing / non-positive stored cap as 1', () => {
    localStorage.setItem(MAX_PER_PLANET_KEY, '0');
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 1 },
    ]);
    // Clamped to 1 ⇒ a planet with one expedition is already full.
    expect(findNextPlanetWithFreeSlot()).toBeNull();
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

// ──────────────────────────────────────────────────────────────────
// findNextPlanetWithFreeSlot — the standing skip list
// ──────────────────────────────────────────────────────────────────
//
// The hop must apply the SAME exclusion the button's own walk applies
// (`features/sendExpedition/domHelpers.js`), or a successful send would still
// land the player on a body the button then refuses to send from.

describe('findNextPlanetWithFreeSlot — standing skip list', () => {
  it('never hops to an excluded body, however empty it is', () => {
    // The reported bug: planet 3 is a colony kept for something else, so it
    // sits at zero expeditions and looks like the emptiest body on the list —
    // the hop lands there, the send is refused, and the wave stalls. Excluded,
    // the hop carries on to planet 4, which is under the cap and does fly.
    localStorage.setItem(MAX_PER_PLANET_KEY, '2');
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 2 },
      { id: '333', expeditions: 0 },
      { id: '444', expeditions: 1 },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('333');

    localStorage.setItem(SKIP_COORDS_KEY, '1:1:3');
    expect(findNextPlanetWithFreeSlot()).toBe('444');
  });

  it('returns null when every body that still flies is at the cap', () => {
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 1 },
      { id: '333', expeditions: 0 },
    ]);
    localStorage.setItem(SKIP_COORDS_KEY, '1:1:3');
    expect(findNextPlanetWithFreeSlot()).toBeNull();
  });

  it('excludes nothing when the key is unset — the pre-existing behaviour', () => {
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 0 },
    ]);
    expect(findNextPlanetWithFreeSlot()).toBe('222');
  });

  it('matches a stored coord written with brackets or spaces', () => {
    setPlanetList([
      { id: '111', current: true, expeditions: 1 },
      { id: '222', expeditions: 0 },
      { id: '333', expeditions: 0 },
    ]);
    localStorage.setItem(SKIP_COORDS_KEY, ' [1:1:2] ');
    expect(findNextPlanetWithFreeSlot()).toBe('333');
  });
});
