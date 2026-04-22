// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/game/index.php" }
//
// Tests for the sendFleet bridge. Exercises the full public surface
// (`installSendFleetHook`) through happy-dom's XMLHttpRequest shim —
// same pattern as `xhrObserver.test.js` and `galaxyHook.test.js`. No
// mocks of observeXHR or the domain/registry helpers: the integration
// must break loudly if their contracts shift.
//
// Each case captures `oge5:colonizeSent` via a per-test listener,
// pokes `#durationOneWay` + `location.search` to stand in for the
// game's fleetdispatch page, and drives a synthetic XHR through the
// patched prototype. `beforeEach` resets the xhrObserver registry,
// the hook's idempotency sentinel, and localStorage so tests do not
// leak into each other.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installSendFleetHook,
  _resetSendFleetHookForTest,
} from '../../src/bridges/sendFleetHook.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { REGISTRY_KEY } from '../../src/state/registry.js';

const SEND_FLEET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet';

/**
 * @typedef {object} SceneOptions
 * @property {string | null} [duration] textContent for `#durationOneWay`
 *   (pass `null` to skip creating the element entirely).
 * @property {number} [galaxy] galaxy query param. Omit the KEY entirely
 *   (`'galaxy' in options` === false) to drop from URL.
 * @property {number} [system] system query param.
 * @property {number} [position] position query param.
 * @property {number | null} [mission] value for the `mission=` body
 *   field (`null` to omit the field entirely).
 * @property {any} [responseObj] object to JSON-stringify as responseText.
 * @property {string | null} [responseText] raw responseText; overrides
 *   responseObj when provided.
 */

/**
 * Prepare the DOM + URL to look like the game's fleetdispatch page at
 * the moment of send, then fire an XHR round-trip through the patched
 * prototype.
 *
 * Presence vs. absence in the query string is controlled by key
 * presence — `{ position: 8 }` includes `position=8`, whereas the
 * plain `{}` (no `position` key) drops it entirely. Default values
 * live in the body, not the destructure, so we can distinguish
 * "caller passed undefined on purpose" from "caller left the key off".
 *
 * @param {SceneOptions} [options]
 */
const setupScene = async (options = {}) => {
  const duration = 'duration' in options ? options.duration : '01:00:00';
  const mission = 'mission' in options ? options.mission : 7;
  const responseObj = 'responseObj' in options ? options.responseObj : { success: true };
  const responseText = 'responseText' in options ? options.responseText : null;

  if (duration === null) {
    document.body.innerHTML = '';
  } else {
    document.body.innerHTML = `<span id="durationOneWay">${duration}</span>`;
  }

  // Build the query string. `undefined` for a coord key means "do not
  // include in URL" — callers use this to simulate a fleetdispatch
  // page that the user navigated to without a full coord set.
  const query = [];
  const addIfPresent = (/** @type {'galaxy' | 'system' | 'position'} */ k) => {
    if (k in options && options[k] !== undefined) {
      query.push(`${k}=${options[k]}`);
    }
  };
  // Default to galaxy=4, system=30, position=8 only when the caller
  // didn't speak up either way. Callers that want to OMIT a key pass
  // it explicitly as `undefined`; see the "URL has no galaxy/system"
  // and "falls back to position=0" cases.
  if (!('galaxy' in options) && !('system' in options) && !('position' in options)) {
    query.push('galaxy=4', 'system=30', 'position=8');
  } else {
    addIfPresent('galaxy');
    addIfPresent('system');
    addIfPresent('position');
  }
  // happy-dom 14's `history.replaceState` does NOT update
  // `location.search`. Assign `location.search` directly to get a
  // deterministic query string — setting `''` clears it for the
  // "no coords" cases below.
  location.search = query.length > 0 ? `?${query.join('&')}` : '';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', SEND_FLEET_URL);
  const body =
    mission === null ? 'type=1&am208=1' : `mission=${mission}&type=1&am208=1`;
  xhr.send(body);

  const text =
    responseText !== null ? responseText : JSON.stringify(responseObj);
  Object.defineProperty(xhr, 'responseText', {
    value: text,
    configurable: true,
  });
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  // Let the `{ once: true }` load handler registered by xhrObserver fire.
  await Promise.resolve();
  return xhr;
};

/**
 * Register a one-shot listener for `oge5:colonizeSent`. Tests call
 * `cleanup()` via the cleanup registry so we don't leak listeners
 * across cases.
 */
const captureColonizeEvents = () => {
  /** @type {any[]} */
  const events = [];
  /** @type {EventListener} */
  const listener = (e) => {
    events.push(/** @type {CustomEvent} */ (e).detail);
  };
  document.addEventListener('oge5:colonizeSent', listener);
  return {
    events,
    cleanup: () => document.removeEventListener('oge5:colonizeSent', listener),
  };
};

/** @type {Array<() => void>} */
let pendingCleanups = [];

/**
 * @template {{ cleanup: () => void }} T
 * @param {T} capture
 * @returns {T}
 */
const trackCleanup = (capture) => {
  pendingCleanups.push(capture.cleanup);
  return capture;
};

beforeEach(() => {
  _resetObserversForTest();
  _resetSendFleetHookForTest();
  localStorage.clear();
  pendingCleanups = [];
});

afterEach(() => {
  for (const fn of pendingCleanups) fn();
  _resetObserversForTest();
  _resetSendFleetHookForTest();
  localStorage.clear();
});

describe('installSendFleetHook — colonize pre-register (send phase)', () => {
  it('writes the coord to localStorage synchronously before the response lands', async () => {
    installSendFleetHook();
    trackCleanup(captureColonizeEvents());

    const before = Date.now();
    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });
    const after = Date.now();

    const raw = localStorage.getItem(REGISTRY_KEY);
    expect(raw).not.toBeNull();
    const reg = JSON.parse(/** @type {string} */ (raw));
    expect(Array.isArray(reg)).toBe(true);
    expect(reg).toHaveLength(1);
    expect(reg[0].coords).toBe('4:30:8');
    // sentAt captured inside setupScene, bracketed by our before/after.
    expect(reg[0].sentAt).toBeGreaterThanOrEqual(before);
    expect(reg[0].sentAt).toBeLessThanOrEqual(after);
    // arrivalAt = sentAt + 3600 * 1000 for the 01:00:00 duration.
    expect(reg[0].arrivalAt).toBe(reg[0].sentAt + 3600 * 1000);
  });

  it('dispatches oge5:colonizeSent after a successful response', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    const before = Date.now();
    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });
    const after = Date.now();

    expect(events).toHaveLength(1);
    const detail = events[0];
    expect(detail.galaxy).toBe(4);
    expect(detail.system).toBe(30);
    expect(detail.position).toBe(8);
    expect(detail.sentAt).toBeGreaterThanOrEqual(before);
    expect(detail.sentAt).toBeLessThanOrEqual(after);
    expect(detail.arrivalAt).toBe(detail.sentAt + 3600 * 1000);
  });

  it('ignores non-colonize missions (mission=15 expedition → no LS write, no event)', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 15,
      responseObj: { success: true },
    });

    expect(events).toHaveLength(0);
    expect(localStorage.getItem(REGISTRY_KEY)).toBeNull();
  });

  it('pre-registers on mission=7 even when response.success is false, but dispatches no event', async () => {
    // 4.x semantics: the registry write happens BEFORE the response
    // arrives (sync, mobile-race guard). If the server rejects we leave
    // a ghost entry that pruneRegistry will reap on next read. The
    // event, though, requires an explicit success flag.
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: false, message: 'no ship available' },
    });

    expect(events).toHaveLength(0);
    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    expect(reg).toHaveLength(1);
    expect(reg[0].coords).toBe('4:30:8');
  });

  it('pre-registers on invalid JSON response, but dispatches no event', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseText: 'not json',
    });

    expect(events).toHaveLength(0);
    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    expect(reg).toHaveLength(1);
  });

  it('skips LS write and event when URL has no galaxy/system', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: undefined,
      system: undefined,
      position: undefined,
      mission: 7,
      responseObj: { success: true },
    });

    expect(events).toHaveLength(0);
    expect(localStorage.getItem(REGISTRY_KEY)).toBeNull();
  });
});

describe('installSendFleetHook — duration edge cases', () => {
  it('skips LS write when #durationOneWay is unparseable (textContent = "abc")', async () => {
    // Decision: arrivalAt=0 is never written to localStorage (matches
    // 4.x guard `arrivalAt > 0`). We still dispatch the event on
    // success so the ISOLATED world knows the send happened even
    // without a landing time — consumers must handle arrivalAt=0.
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: 'abc',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    expect(localStorage.getItem(REGISTRY_KEY)).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].arrivalAt).toBe(0);
    expect(events[0].galaxy).toBe(4);
    expect(events[0].system).toBe(30);
    expect(events[0].position).toBe(8);
  });

  it('skips LS write when #durationOneWay is missing entirely', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: null,
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    expect(localStorage.getItem(REGISTRY_KEY)).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].arrivalAt).toBe(0);
  });
});

describe('installSendFleetHook — registry behaviour', () => {
  it('deduplicates a second send with the same coords within ±2s tolerance', async () => {
    installSendFleetHook();
    trackCleanup(captureColonizeEvents());

    // First send
    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    // Second send with the same coords, essentially the same tick.
    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    expect(reg).toHaveLength(1);
    expect(reg[0].coords).toBe('4:30:8');
  });

  it('prunes expired entries at write time', async () => {
    // Pre-populate with an expired entry and a future one.
    const now = Date.now();
    const preloaded = [
      { coords: '1:1:1', sentAt: now - 10_000, arrivalAt: now - 1000 }, // expired
      { coords: '2:2:2', sentAt: now - 1000, arrivalAt: now + 60_000 }, // pending
    ];
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(preloaded));

    installSendFleetHook();
    trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    // Expired '1:1:1' is gone; '2:2:2' survives; our new '4:30:8' is appended.
    const coords = reg.map(/** @param {{ coords: string }} r */ (r) => r.coords).sort();
    expect(coords).toEqual(['2:2:2', '4:30:8']);
  });

  it('treats corrupted localStorage (non-JSON) as empty and writes cleanly', async () => {
    localStorage.setItem(REGISTRY_KEY, 'not json');

    installSendFleetHook();
    trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    expect(reg).toHaveLength(1);
    expect(reg[0].coords).toBe('4:30:8');
  });

  it('treats a non-array localStorage payload as empty', async () => {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify({ not: 'an array' }));

    installSendFleetHook();
    trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    expect(Array.isArray(reg)).toBe(true);
    expect(reg).toHaveLength(1);
    expect(reg[0].coords).toBe('4:30:8');
  });

  it('falls back to position=0 when the URL omits position', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: undefined,
      mission: 7,
      responseObj: { success: true },
    });

    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    expect(reg).toHaveLength(1);
    expect(reg[0].coords).toBe('4:30:0');
    expect(events[0].position).toBe(0);
  });
});

describe('installSendFleetHook — context isolation', () => {
  it('dispatches using send-phase context, not load-phase DOM/URL', async () => {
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    // Mirror setupScene's opening steps manually so we can mutate the
    // DOM + URL between `send` and `load`. happy-dom 14 needs
    // `location.search` assignment (not history.replaceState).
    document.body.innerHTML = '<span id="durationOneWay">01:00:00</span>';
    location.search = '?galaxy=4&system=30&position=8';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', SEND_FLEET_URL);
    xhr.send('mission=7&type=1&am208=1');

    // Now corrupt the DOM + URL — as if the game had navigated before
    // the XHR's load event fires. The load-phase observer MUST use
    // the context captured during `send`, not the current state.
    document.body.innerHTML = '<span id="durationOneWay">99:99:99</span>';
    location.search = '?galaxy=9&system=99&position=1';

    const sentAtExpected = JSON.parse(
      /** @type {string} */ (localStorage.getItem(REGISTRY_KEY)),
    )[0].sentAt;

    Object.defineProperty(xhr, 'responseText', {
      value: JSON.stringify({ success: true }),
      configurable: true,
    });
    Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
    xhr.dispatchEvent(new Event('load'));
    await Promise.resolve();

    expect(events).toHaveLength(1);
    const detail = events[0];
    // Original coords, NOT the mutated URL values.
    expect(detail.galaxy).toBe(4);
    expect(detail.system).toBe(30);
    expect(detail.position).toBe(8);
    // arrivalAt reflects the original 01:00:00 duration, NOT 99:99:99.
    expect(detail.arrivalAt).toBe(sentAtExpected + 3600 * 1000);
    expect(detail.sentAt).toBe(sentAtExpected);
  });
});

describe('installSendFleetHook — idempotency', () => {
  it('does not register a second pair of observers on repeated install', async () => {
    installSendFleetHook();
    installSendFleetHook();
    installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });

    // A second install that stacked observers would double-fire.
    expect(events).toHaveLength(1);
    const reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
    // Dedup means we'd end up with one entry either way, but the
    // event count is the real idempotency signal here.
    expect(reg).toHaveLength(1);
  });

  it('returns an unsubscribe that silences both phases', async () => {
    const unsubscribe = installSendFleetHook();
    const { events } = trackCleanup(captureColonizeEvents());

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });
    expect(events).toHaveLength(1);
    expect(localStorage.getItem(REGISTRY_KEY)).not.toBeNull();

    unsubscribe();
    localStorage.clear();

    await setupScene({
      duration: '01:00:00',
      galaxy: 4,
      system: 30,
      position: 8,
      mission: 7,
      responseObj: { success: true },
    });
    // Still one event from before — no new send-phase write, no new
    // load-phase dispatch.
    expect(events).toHaveLength(1);
    expect(localStorage.getItem(REGISTRY_KEY)).toBeNull();
  });
});
