// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/game/index.php" }
//
// Tests for the fleet-save send-hint bridge. Exercises the full public
// surface (`installFleetSaveSendHint`) through happy-dom's XMLHttpRequest
// shim — same pattern as `sendFleetHook.test.js`. No mocks of observeXHR:
// the integration must break loudly if its contract shifts.
//
// Each case paints the send-time page (the `#durationOneWay` element + the
// origin meta tags), drives a synthetic sendFleet XHR with a urlencoded
// body, and asserts the OBSERVABLE output — the hint stored under
// FS_SEND_HINTS_KEY. The write happens in the SEND phase (race-proof), so
// the response content is irrelevant throughout.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installFleetSaveSendHint,
  _resetFleetSaveSendHintForTest,
} from '../../src/bridges/fleetSaveSendHint.js';
import { _resetObserversForTest } from '../../src/bridges/xhrObserver.js';
import { FS_SEND_HINTS_KEY } from '../../src/lib/storageKeys.js';
import { fakeXHR as fakeXhrRoundTrip } from '../helpers/fakeXhr.js';

const SEND_FLEET_URL =
  '/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet';

/** The stored hints, parsed. @returns {any[]} */
const storedHints = () => JSON.parse(localStorage.getItem(FS_SEND_HINTS_KEY) || '[]');

/**
 * Paint the send-time page and fire one sendFleet XHR.
 *
 * @param {object} o
 * @param {string | null} [o.duration]  `#durationOneWay` text (null = absent).
 * @param {string} [o.originCoords]     Origin meta coords.
 * @param {'planet' | 'moon'} [o.originType]
 * @param {string} o.body               urlencoded request body.
 */
const send = async ({ duration = '01:00:00', originCoords = '1:2:3', originType = 'planet', body }) => {
  document.head.innerHTML = `
    <meta name="ogame-planet-coordinates" content="${originCoords}">
    <meta name="ogame-planet-type" content="${originType}">`;
  document.body.innerHTML =
    duration === null ? '' : `<span id="durationOneWay">${duration}</span>`;
  return fakeXhrRoundTrip(SEND_FLEET_URL, {
    method: 'POST', body, responseText: JSON.stringify({ success: true }),
  });
};

beforeEach(() => {
  _resetObserversForTest();
  _resetFleetSaveSendHintForTest();
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  installFleetSaveSendHint();
});

describe('fleetSaveSendHint — one-way missions (deploy / colonise)', () => {
  it('records the outbound landing at the TARGET for a deployment', async () => {
    const before = Math.floor(Date.now() / 1000);
    await send({ body: 'mission=4&galaxy=4&system=30&position=8&type=1&am204=100' });
    const after = Math.floor(Date.now() / 1000);

    const hints = storedHints();
    expect(hints).toHaveLength(1);
    expect(hints[0].landingKey).toBe('4:30:8:1');
    expect(hints[0].flightSec).toBe(3600); // 01:00:00
    expect(hints[0].arrivalAt).toBeGreaterThanOrEqual(before + 3600);
    expect(hints[0].arrivalAt).toBeLessThanOrEqual(after + 3600);
  });

  it('keys a deployment to a MOON target on the type-3 body', async () => {
    await send({ body: 'mission=4&galaxy=4&system=30&position=8&type=3&am204=100' });
    expect(storedHints()[0].landingKey).toBe('4:30:8:3');
  });

  it('records nothing for a type the fleet cannot sit on (debris)', async () => {
    await send({ body: 'mission=8&galaxy=4&system=30&position=8&type=2&am209=10' });
    // Recycle is round-trip → the hint keys on the ORIGIN, not the debris —
    // so a hint IS recorded, at the origin body.
    expect(storedHints()[0].landingKey).toBe('1:2:3:1');
  });
});

describe('fleetSaveSendHint — round-trip missions', () => {
  it('records the RETURN landing at the ORIGIN, at sentAt + 2×duration', async () => {
    const before = Math.floor(Date.now() / 1000);
    await send({
      originCoords: '7:8:9', originType: 'moon',
      body: 'mission=3&galaxy=4&system=30&position=8&type=1&am203=500',
    });
    const after = Math.floor(Date.now() / 1000);

    const hints = storedHints();
    expect(hints).toHaveLength(1);
    expect(hints[0].landingKey).toBe('7:8:9:3'); // moon origin
    expect(hints[0].flightSec).toBe(3600); // ONE-way duration
    expect(hints[0].arrivalAt).toBeGreaterThanOrEqual(before + 7200);
    expect(hints[0].arrivalAt).toBeLessThanOrEqual(after + 7200);
  });

  it('skips missions with a hold/stay time (ACS-defend 5, expedition 15)', async () => {
    await send({ body: 'mission=5&galaxy=4&system=30&position=8&type=1&am204=1' });
    await send({ body: 'mission=15&galaxy=4&system=30&position=16&type=1&am204=1' });
    expect(storedHints()).toEqual([]);
  });
});

describe('fleetSaveSendHint — guards + hygiene', () => {
  it('records nothing when the duration element is missing or unparseable', async () => {
    await send({ duration: null, body: 'mission=4&galaxy=4&system=30&position=8&type=1' });
    await send({ duration: 'soon™', body: 'mission=4&galaxy=4&system=30&position=8&type=1' });
    expect(storedHints()).toEqual([]);
  });

  it('records nothing when the body carries no mission', async () => {
    await send({ body: 'galaxy=4&system=30&position=8&type=1' });
    expect(storedHints()).toEqual([]);
  });

  it('prunes expired hints on write', async () => {
    const stale = { landingKey: '9:9:9:1', arrivalAt: 1, flightSec: 600 }; // long past
    localStorage.setItem(FS_SEND_HINTS_KEY, JSON.stringify([stale]));
    await send({ body: 'mission=4&galaxy=4&system=30&position=8&type=1' });
    const hints = storedHints();
    expect(hints).toHaveLength(1);
    expect(hints[0].landingKey).toBe('4:30:8:1');
  });

  it('appends across sends (both legs later matchable)', async () => {
    await send({ body: 'mission=4&galaxy=4&system=30&position=8&type=1' });
    await send({ body: 'mission=3&galaxy=4&system=31&position=9&type=1' });
    expect(storedHints().map((h) => h.landingKey)).toEqual(['4:30:8:1', '1:2:3:1']);
  });
});
