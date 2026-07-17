// @vitest-environment happy-dom
// @ts-check

import { beforeEach, describe, it, expect } from 'vitest';
import {
  serverNow,
  serverClockOffsetMs,
  _resetServerClockForTest,
} from '../../src/lib/serverClock.js';

/** Put an `ogame-timestamp` meta on the page with the given epoch-seconds.
 * @param {number | string} secs */
const setMeta = (secs) => {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'ogame-timestamp');
  meta.setAttribute('content', String(secs));
  document.head.appendChild(meta);
};

beforeEach(() => {
  _resetServerClockForTest();
  document.head.innerHTML = '';
});

describe('serverClock', () => {
  it('offset 0 and serverNow ≈ Date.now() when the meta is absent', () => {
    expect(serverClockOffsetMs()).toBe(0);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });

  it('applies the (server − local) offset from ogame-timestamp', () => {
    // Server clock 1000 s ahead of this machine's clock.
    setMeta(Math.floor(Date.now() / 1000) + 1000);
    const off = serverClockOffsetMs();
    expect(off).toBeGreaterThan(998 * 1000);
    expect(off).toBeLessThan(1002 * 1000);
    expect(serverNow()).toBeGreaterThan(Date.now() + 990 * 1000);
  });

  it('corrects a BEHIND local clock too (negative offset)', () => {
    setMeta(Math.floor(Date.now() / 1000) - 1000);
    expect(serverClockOffsetMs()).toBeLessThan(-998 * 1000);
  });

  it('caches the offset — a later meta change does not move it', () => {
    setMeta(Math.floor(Date.now() / 1000) + 500);
    const first = serverClockOffsetMs();
    document.head.innerHTML = '';
    setMeta(Math.floor(Date.now() / 1000) + 9999);
    expect(serverClockOffsetMs()).toBe(first);
  });

  it('degrades to 0 on an unparseable / non-positive timestamp', () => {
    setMeta('garbage');
    expect(serverClockOffsetMs()).toBe(0);
  });
});
