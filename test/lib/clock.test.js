// @vitest-environment happy-dom
//
// Unit tests for the visibility-aware tick bus (lib/clock.js). Built through
// `createClock` with fully injected fakes — a controllable `now`, a single
// capturable base interval (the bus arms exactly one), a single capturable
// timeout (`scheduleAt`), and a fake `doc` whose `hidden` flag + its
// visibilitychange listeners we drive by hand. No real timers, no real DOM:
// every assertion is about the bus's scheduling logic, per TIMERS-AUDIT §10.
//
// happy-dom is only here so importing `logger` (which reads localStorage at
// load) is safe — the clock under test uses the injected fake `doc`, never the
// real document.
//
// @ts-check

import { describe, it, expect } from 'vitest';
import { createClock } from '../../src/lib/clock.js';

const BASE_MS = 1000;

/**
 * A fake environment around one clock: a manual clock (`t`), the single base
 * interval the bus arms, the single timeout `scheduleAt` arms, and a visibility
 * source flipped via `setHidden` (which also dispatches to the bound listener,
 * as a real `visibilitychange` would).
 */
const makeEnv = () => {
  let t = 0;
  let intervalFn = /** @type {(() => void) | null} */ (null);
  let intervalStarts = 0;
  let intervalClears = 0;
  let timeoutFn = /** @type {(() => void) | null} */ (null);
  let timeoutDelay = /** @type {number | null} */ (null);
  /** @type {Set<() => void>} */
  const visHandlers = new Set();

  const doc = {
    hidden: false,
    addEventListener: (/** @type {string} */ type, /** @type {() => void} */ h) => {
      if (type === 'visibilitychange') visHandlers.add(h);
    },
    removeEventListener: (/** @type {string} */ type, /** @type {() => void} */ h) => {
      if (type === 'visibilitychange') visHandlers.delete(h);
    },
  };

  const clock = createClock({
    now: () => t,
    setInterval: (fn) => {
      intervalFn = fn;
      intervalStarts += 1;
      return 'IV';
    },
    clearInterval: (id) => {
      if (id === 'IV') {
        intervalFn = null;
        intervalClears += 1;
      }
    },
    setTimeout: (fn, ms) => {
      timeoutFn = fn;
      timeoutDelay = ms;
      return 'TO';
    },
    clearTimeout: (id) => {
      if (id === 'TO') {
        timeoutFn = null;
        timeoutDelay = null;
      }
    },
    doc,
  });

  return {
    clock,
    /** Advance `steps` base ticks (BASE_MS each), firing the armed base interval as real setInterval(BASE_MS) would. */
    advance: (/** @type {number} */ steps) => {
      for (let i = 0; i < steps; i++) {
        t += BASE_MS;
        if (intervalFn) intervalFn();
      }
    },
    /** Jump the clock WITHOUT ticking the interval (for scheduleAt delay maths / time passing while hidden). */
    setTime: (/** @type {number} */ ms) => {
      t = ms;
    },
    setHidden: (/** @type {boolean} */ v) => {
      doc.hidden = v;
      visHandlers.forEach((h) => h());
    },
    isRunning: () => intervalFn !== null,
    visBoundCount: () => visHandlers.size,
    intervalStarts: () => intervalStarts,
    intervalClears: () => intervalClears,
    fireTimeout: () => {
      const fn = timeoutFn;
      timeoutFn = null; // a fired timeout is no longer pending
      timeoutDelay = null;
      if (fn) fn();
    },
    timeoutArmed: () => timeoutFn !== null,
    timeoutDelay: () => timeoutDelay,
  };
};

describe('createClock — subscribe cadence', () => {
  it('fires every `everyMs`, not on the intermediate base ticks', () => {
    const env = makeEnv();
    let n = 0;
    env.clock.subscribe(() => (n += 1), { everyMs: 2000 });
    env.advance(1); // t=1000
    expect(n).toBe(0);
    env.advance(1); // t=2000 → due
    expect(n).toBe(1);
    env.advance(1); // t=3000
    expect(n).toBe(1);
    env.advance(1); // t=4000 → due again
    expect(n).toBe(2);
  });

  it('rounds a sub-grid cadence UP to a whole base tick', () => {
    const env = makeEnv();
    let n = 0;
    // 2500 ms snaps to 3000; verbatim it would have fired at t=2500≈2000.
    env.clock.subscribe(() => (n += 1), { everyMs: 2500 });
    env.advance(2); // t=2000
    expect(n).toBe(0);
    env.advance(1); // t=3000 → first due tick for the snapped cadence
    expect(n).toBe(1);
  });

  it('defaults to a BASE_MS cadence', () => {
    const env = makeEnv();
    let n = 0;
    env.clock.subscribe(() => (n += 1));
    env.advance(3);
    expect(n).toBe(3);
  });

  it('isolates a throwing subscriber so the others on the bus still fire', () => {
    const env = makeEnv();
    let good = 0;
    env.clock.subscribe(() => {
      throw new Error('boom');
    }, { everyMs: 1000 });
    env.clock.subscribe(() => (good += 1), { everyMs: 1000 });
    env.advance(1);
    expect(good).toBe(1);
  });
});

describe('createClock — lazy lifecycle', () => {
  it('arms the base interval only with a subscriber and stops it when the last one leaves', () => {
    const env = makeEnv();
    expect(env.isRunning()).toBe(false);
    expect(env.intervalStarts()).toBe(0);

    const off1 = env.clock.subscribe(() => {});
    expect(env.isRunning()).toBe(true);
    expect(env.intervalStarts()).toBe(1);

    const off2 = env.clock.subscribe(() => {});
    expect(env.intervalStarts()).toBe(1); // a 2nd sub must NOT arm a 2nd interval

    off1();
    expect(env.isRunning()).toBe(true); // off2 still subscribed
    off2();
    expect(env.isRunning()).toBe(false);
  });

  it('binds the visibilitychange listener only while subscribed', () => {
    const env = makeEnv();
    expect(env.visBoundCount()).toBe(0);
    const off = env.clock.subscribe(() => {});
    expect(env.visBoundCount()).toBe(1);
    off();
    expect(env.visBoundCount()).toBe(0);
  });

  it('unsubscribe is idempotent (no double clear, no throw)', () => {
    const env = makeEnv();
    const off = env.clock.subscribe(() => {});
    off();
    expect(() => off()).not.toThrow();
    expect(env.intervalClears()).toBe(1);
  });
});

describe('createClock — visibility', () => {
  it('stops the interval entirely while hidden (zero wake-ups)', () => {
    const env = makeEnv();
    let n = 0;
    env.clock.subscribe(() => (n += 1), { everyMs: 1000 });
    expect(env.isRunning()).toBe(true);

    env.setHidden(true);
    expect(env.isRunning()).toBe(false);

    env.advance(5); // nothing armed → nothing fires
    expect(n).toBe(0);
  });

  it('snaps every subscriber once and resumes ticking on regaining visibility', () => {
    const env = makeEnv();
    let n = 0;
    env.clock.subscribe(() => (n += 1), { everyMs: 5000 });
    env.setHidden(true);
    expect(n).toBe(0);

    env.setTime(10_000); // time passed while the tab sat hidden
    env.setHidden(false);
    expect(n).toBe(1); // snap-to-truth: exactly one immediate fire
    expect(env.isRunning()).toBe(true); // and the cadence resumes
  });

  it('keeps a whileHidden subscriber ticking in the background', () => {
    const env = makeEnv();
    let n = 0;
    env.clock.subscribe(() => (n += 1), { everyMs: 1000, whileHidden: true });
    env.setHidden(true);
    expect(env.isRunning()).toBe(true); // still armed
    env.advance(2);
    expect(n).toBe(2);
  });
});

describe('createClock — scheduleAt', () => {
  it('arms a single timeout for the delay to the next wake', () => {
    const env = makeEnv();
    env.setTime(1000);
    let fired = 0;
    const h = env.clock.scheduleAt((nowTs) => nowTs + 5000, () => (fired += 1));
    expect(env.timeoutArmed()).toBe(false); // unarmed until reschedule()
    h.reschedule();
    expect(env.timeoutArmed()).toBe(true);
    expect(env.timeoutDelay()).toBe(5000); // next - now
    expect(fired).toBe(0);
    env.fireTimeout();
    expect(fired).toBe(1);
  });

  it('does not auto-rearm — reschedule() arms the next wake', () => {
    const env = makeEnv();
    let fired = 0;
    const h = env.clock.scheduleAt((nowTs) => nowTs + 1000, () => (fired += 1));
    h.reschedule();
    env.fireTimeout();
    expect(fired).toBe(1);
    expect(env.timeoutArmed()).toBe(false); // cleared on fire, NOT re-armed
    h.reschedule();
    expect(env.timeoutArmed()).toBe(true);
  });

  it('stays unarmed when getNextWakeTs returns null', () => {
    const env = makeEnv();
    let fired = 0;
    const h = env.clock.scheduleAt(() => null, () => (fired += 1));
    h.reschedule();
    expect(env.timeoutArmed()).toBe(false);
    expect(fired).toBe(0);
  });

  it('clamps a past wake time to a 0 delay', () => {
    const env = makeEnv();
    env.setTime(10_000);
    const h = env.clock.scheduleAt((nowTs) => nowTs - 5000, () => {});
    h.reschedule();
    expect(env.timeoutDelay()).toBe(0);
  });

  it('reschedule() replaces the pending timeout (no double-fire)', () => {
    const env = makeEnv();
    let fired = 0;
    const h = env.clock.scheduleAt((nowTs) => nowTs + 1000, () => (fired += 1));
    h.reschedule();
    h.reschedule(); // clears the first, arms a fresh one
    env.fireTimeout();
    expect(fired).toBe(1);
  });

  it('dispose() clears a pending timeout', () => {
    const env = makeEnv();
    let fired = 0;
    const h = env.clock.scheduleAt((nowTs) => nowTs + 1000, () => (fired += 1));
    h.reschedule();
    h.dispose();
    expect(env.timeoutArmed()).toBe(false);
    env.fireTimeout();
    expect(fired).toBe(0);
  });
});
