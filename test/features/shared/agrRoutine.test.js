// @vitest-environment happy-dom
//
// Behavioral tests for the shared AGR-routine dispatch primitives
// (src/features/shared/agrRoutine.js). These are DOM-bound: they poll the page
// with `waitFor`, click AGR's `#ago_routine_N`, and read the native
// `#dispatchFleet` + AGR's `#ago_fleet2_main` panel. We drive a real happy-dom
// tree and assert the tagged outcome + the observable click, mirroring the
// routine-7 harness in test/features/sendExpedition.test.js.
//
// `prepareViaRoutine` resolves only after `waitFor` polls (300 ms interval). The
// positive cases simply await its promise (it resolves on the first poll once the
// DOM is ready); the negative outcomes stub `Date.now` to fast-forward past the
// 15 s budget (see below). `dispatchPrepared` is synchronous.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyRoutineFailure,
  prepareViaRoutine,
  dispatchPrepared,
  dispatchWhenReady,
} from '../../../src/features/shared/agrRoutine.js';
import {
  claimFleet2,
  _resetFleetOwnershipForTest,
} from '../../../src/features/shared/fleetOwnership.js';
import { OWNER_EXP, OWNER_FS } from '../../../src/domain/fleetOwnership.js';

/**
 * The NEGATIVE outcomes (`routineOff`, `timeout`) require `waitFor` to exhaust
 * its 15 s budget — far past vitest's 5 s test cap with a real clock. `waitFor`
 * reads wall time via `Date.now`, so we stub it to JUMP forward by a full
 * timeout on the very next read after the first poll tick. The real `setTimeout`
 * interval still fires (one ~300 ms hop), but the elapsed check then trips and
 * the promise resolves `null` ⇒ the source maps it to the negative outcome.
 * Returns a restore fn.
 *
 * @returns {() => void}
 */
const fastForwardClock = () => {
  const real = Date.now;
  const base = real();
  let calls = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    // Advance 60 s of VIRTUAL time per read. Within any one `waitFor`, the
    // tick after `started` is already ≥ the 15 s budget, so it resolves `null`
    // immediately — works no matter how many `waitFor`s the call chains.
    calls += 1;
    return base + calls * 60_000;
  });
  return () => {
    /** @type {any} */ (Date.now).mockRestore?.();
  };
};

/**
 * Mount AGR's `#ago_routine_N`. With `hydrateOnClick`, clicking it adds the
 * native `#dispatchFleet` button + AGR's `#ago_fleet2_main` panel — simulating
 * AGR firing the fleet1→fleet2 transition. `checkClass`, when given, adds the
 * expedition-style `.ago_routine_check` readiness widget.
 *
 * @param {object}  opts
 * @param {number}  opts.routineId
 * @param {string}  [opts.checkClass]      e.g. 'ago_routine_check_3' (ready).
 * @param {boolean} [opts.hydrateOnClick]
 * @returns {HTMLElement}
 */
const mountRoutine = ({ routineId, checkClass, hydrateOnClick = false }) => {
  const routine = document.createElement('div');
  routine.id = `ago_routine_${routineId}`;
  if (checkClass) {
    routine.innerHTML = `<span class="ago_routine_check ${checkClass}"></span>`;
  }
  if (hydrateOnClick) {
    routine.addEventListener('click', () => {
      if (!document.getElementById('ago_fleet2_main')) {
        const panel = document.createElement('div');
        panel.id = 'ago_fleet2_main';
        document.body.appendChild(panel);
        const dispatch = document.createElement('button');
        dispatch.id = 'dispatchFleet';
        document.body.appendChild(dispatch);
      }
    });
  }
  document.body.appendChild(routine);
  return routine;
};

/** Mount the already-up fleet2 state (native dispatch + AGR panel). */
const mountFleet2 = () => {
  const panel = document.createElement('div');
  panel.id = 'ago_fleet2_main';
  document.body.appendChild(panel);
  const dispatch = document.createElement('button');
  dispatch.id = 'dispatchFleet';
  document.body.appendChild(dispatch);
  return dispatch;
};

beforeEach(() => {
  _resetFleetOwnershipForTest();
  document.body.innerHTML = '';
});

afterEach(async () => {
  // `prepareViaRoutine` schedules a deferred 2nd `safeClick(routine)` at +50 ms.
  // Let it fire against THIS test's DOM before we tear down, so a stale callback
  // can't hydrate the next test's fresh routine (cross-test bleed).
  await new Promise((r) => setTimeout(r, 60));
  /** @type {any} */ (Date.now).mockRestore?.();
  _resetFleetOwnershipForTest();
  document.body.innerHTML = '';
});

describe('classifyRoutineFailure', () => {
  it('present-but-not-ready → "timeout"', () => {
    expect(classifyRoutineFailure(true)).toBe('timeout');
  });
  it('element absent → "absent"', () => {
    expect(classifyRoutineFailure(false)).toBe('absent');
  });
});

describe('dispatchPrepared', () => {
  it('returns "notReady" when the fleet2 panel / dispatch control is absent', () => {
    expect(dispatchPrepared({ owner: OWNER_EXP })).toBe('notReady');
  });

  it('returns "foreign" when fleet2 is up but the session belongs to no one (no claim)', () => {
    mountFleet2();
    // No ownership session + no expedition checkTarget ⇒ holder 'unknown'.
    expect(dispatchPrepared({ owner: OWNER_FS })).toBe('foreign');
  });

  it('claims then dispatches: returns "sent" and clicks #dispatchFleet exactly once', () => {
    const dispatch = mountFleet2();
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_FS);
    expect(dispatchPrepared({ owner: OWNER_FS })).toBe('sent');
    expect(clicks).toBe(1);
  });

  it('rejects a foreign claimant even when another owner holds the session', () => {
    const dispatch = mountFleet2();
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_EXP); // someone else owns it
    expect(dispatchPrepared({ owner: OWNER_FS })).toBe('foreign');
    expect(clicks).toBe(0);
  });

  it('returns "notReady" (no click) when #dispatchFleet is present but still .off', () => {
    const dispatch = mountFleet2();
    dispatch.classList.add('off'); // AGR still filling the fleet → disabled
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_FS);
    // Must NOT report a false "sent": clicking a `.off` control launches nothing.
    expect(dispatchPrepared({ owner: OWNER_FS })).toBe('notReady');
    expect(clicks).toBe(0);
  });
});

describe('dispatchWhenReady', () => {
  it('fires immediately when the dispatch is already ready → "sent", one click', async () => {
    const dispatch = mountFleet2();
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_FS);
    expect(await dispatchWhenReady({ owner: OWNER_FS })).toBe('sent');
    expect(clicks).toBe(1);
  });

  it('waits out a still-.off dispatch, then sends once the game clears it → "sent"', async () => {
    const dispatch = mountFleet2();
    dispatch.classList.add('off');
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_FS);
    const pending = dispatchWhenReady({ owner: OWNER_FS });
    // The game clears `.off` shortly after the tap; the poll picks it up.
    setTimeout(() => dispatch.classList.remove('off'), 50);
    expect(await pending).toBe('sent');
    expect(clicks).toBe(1);
  });

  it('returns "foreign" without clicking when fleet2 belongs to someone else', async () => {
    const dispatch = mountFleet2();
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_EXP); // someone else owns it
    expect(await dispatchWhenReady({ owner: OWNER_FS })).toBe('foreign');
    expect(clicks).toBe(0);
  });

  it('returns "timeout" when the .off never clears', async () => {
    const dispatch = mountFleet2();
    dispatch.classList.add('off');
    let clicks = 0;
    dispatch.addEventListener('click', () => {
      clicks += 1;
    });
    claimFleet2(OWNER_FS);
    const restore = fastForwardClock();
    const out = await dispatchWhenReady({ owner: OWNER_FS });
    restore();
    expect(out).toBe('timeout');
    expect(clicks).toBe(0);
  });
});

describe('prepareViaRoutine', () => {
  it('returns "routineOff" when #ago_routine_N is absent', async () => {
    const restore = fastForwardClock();
    const out = await prepareViaRoutine({ routineId: 6, owner: OWNER_FS, requireCheckReady: false });
    restore();
    expect(out).toBe('routineOff');
  });

  it('fleet-save path (requireCheckReady:false): clickable on presence, hydrates → "prepared"', async () => {
    const routine = mountRoutine({ routineId: 6, hydrateOnClick: true });
    let clicked = 0;
    routine.addEventListener('click', () => {
      clicked += 1;
    });
    const out = await prepareViaRoutine({ routineId: 6, owner: OWNER_FS, requireCheckReady: false });
    expect(out).toBe('prepared');
    expect(clicked).toBeGreaterThanOrEqual(1);
    // Ownership was claimed before the transition, so the follow-up dispatch passes.
    expect(dispatchPrepared({ owner: OWNER_FS })).toBe('sent');
  });

  it('fleet-save path: routine present but never hydrates fleet2 → "timeout"', async () => {
    mountRoutine({ routineId: 6, hydrateOnClick: false });
    const restore = fastForwardClock();
    const out = await prepareViaRoutine({ routineId: 6, owner: OWNER_FS, requireCheckReady: false });
    restore();
    expect(out).toBe('timeout');
  });

  it('expedition path (requireCheckReady): check_3 ready + hydrate → "prepared"', async () => {
    mountRoutine({ routineId: 7, checkClass: 'ago_routine_check_3', hydrateOnClick: true });
    const out = await prepareViaRoutine({ routineId: 7, owner: OWNER_EXP });
    expect(out).toBe('prepared');
  });

  it('expedition path: check_1 (no fillable fleet) → "noShips", never clicks', async () => {
    const routine = mountRoutine({ routineId: 7, checkClass: 'ago_routine_check_1', hydrateOnClick: true });
    let clicked = 0;
    routine.addEventListener('click', () => {
      clicked += 1;
    });
    const out = await prepareViaRoutine({ routineId: 7, owner: OWNER_EXP });
    expect(out).toBe('noShips');
    expect(clicked).toBe(0);
    // And it must NOT have hydrated / claimed anything.
    expect(document.getElementById('ago_fleet2_main')).toBeNull();
  });
});
