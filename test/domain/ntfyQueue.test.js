// Unit tests for domain/ntfyQueue — the ntfy queue as the shared reminder
// state: identity round-trip and the post/cancel planner.

import { describe, it, expect } from 'vitest';
import { clickUrlFor, decodeClick, planQueue, seriesInQueue } from '../../src/domain/ntfyQueue.js';

/** @typedef {import('../../src/domain/ntfyQueue.js').MessageIdentity} MessageIdentity */
/** @typedef {import('../../src/domain/ntfyQueue.js').QueuedMessage} QueuedMessage */

const NOW = 1_800_000_000;
const base = { now: NOW, minDelaySec: 10, maxDelaySec: 3 * 24 * 3600, gone: new Set() };

/**
 * A queued message of a series.
 * @param {string} id
 * @param {Partial<MessageIdentity>} over
 * @returns {QueuedMessage}
 */
const msg = (id, over) => {
  /** @type {MessageIdentity} */
  const identity = { kind: 'fs', key: 'eventRow-1', slot: 0, anchor: NOW + 3600, gen: 1, plan: [0, 600, 1200], ...over };
  return { id, time: identity.anchor + identity.slot, identity };
};

describe('identity in the click URL', () => {
  it('round-trips every field, keys with colons included', () => {
    /** @type {MessageIdentity} */
    const id = { kind: 'fr', key: '5:469:15:3', slot: 1200, anchor: NOW, gen: 3, plan: [1200, 0, -600], extra: '6:115:7:1' };
    const url = clickUrlFor('s280-pl', id);
    expect(url.startsWith('https://s280-pl.ogame.gameforge.com/game/index.php?page=ingame&component=movement#')).toBe(true);
    expect(decodeClick(url)).toEqual({ ...id, plan: [-600, 0, 1200] });
  });

  it('rejects foreign, old-format and mangled URLs', () => {
    expect(decodeClick(undefined)).toBeNull();
    expect(decodeClick('https://example.com/x')).toBeNull();
    expect(decodeClick('https://x/#oge=2&k=fs&id=a&s=0&a=1&g=1&p=0')).toBeNull();
    expect(decodeClick('https://x/#oge=1&k=zz&id=a&s=0&a=1&g=1&p=0')).toBeNull();
    expect(decodeClick('https://x/#oge=1&k=fs&id=a&s=x&a=1&g=1&p=0')).toBeNull();
    expect(decodeClick('https://x/#oge=1&k=fs&id=a&s=0&a=1&g=0&p=0')).toBeNull();
  });
});

describe('planQueue', () => {
  it('posts every future slot of a new series as generation 1', () => {
    const { post, cancel } = planQueue({
      ...base, queue: [],
      wanted: [{ kind: 'fs', key: 'eventRow-1', anchor: NOW + 3600, plan: [1200, 0, 600], extra: '6:115:7:1' }],
    });
    expect(cancel).toEqual([]);
    expect(post.map((p) => p.fireAt)).toEqual([NOW + 3600, NOW + 4200, NOW + 4800]);
    expect(post.every((p) => p.identity.gen === 1 && p.identity.extra === '6:115:7:1')).toBe(true);
    expect(post[0].identity.plan).toEqual([0, 600, 1200]);
  });

  it('skips slots too soon or beyond the 3-day cap', () => {
    const { post } = planQueue({
      ...base, queue: [],
      wanted: [{ kind: 'ad', key: 'r', anchor: NOW, plan: [-600, 5, 60, 4 * 24 * 3600] }],
    });
    expect(post.map((p) => p.identity.slot)).toEqual([60]);
  });

  it('completes only the missing slots of the queued plan (reload mid-post)', () => {
    const { post, cancel } = planQueue({
      ...base,
      queue: [msg('a', { slot: 0 })],
      wanted: [{ kind: 'fs', key: 'eventRow-1', anchor: NOW + 3600, plan: [0, 600, 1200] }],
    });
    expect(cancel).toEqual([]);
    expect(post.map((p) => p.identity.slot)).toEqual([600, 1200]);
  });

  it('never re-adds a slot the newest generation dropped (cancelled elsewhere)', () => {
    const queue = [
      msg('a', { slot: 0, gen: 2, plan: [0, 600] }),
      msg('b', { slot: 600, gen: 2, plan: [0, 600] }),
    ];
    const { post, cancel } = planQueue({
      ...base, queue,
      wanted: [{ kind: 'fs', key: 'eventRow-1', anchor: NOW + 3600, plan: [0, 600, 1200] }],
    });
    expect(post).toEqual([]);
    expect(cancel).toEqual([]);
  });

  it('rewrite → new generation with this plan, every queued future message cancelled', () => {
    const queue = [msg('a', { slot: 0 }), msg('b', { slot: 600 }), msg('c', { slot: 1200 })];
    const { post, cancel } = planQueue({
      ...base, queue,
      wanted: [{ kind: 'fs', key: 'eventRow-1', anchor: NOW + 3600, plan: [0, 600], rewrite: true }],
    });
    expect(cancel.sort()).toEqual(['a', 'b', 'c']);
    expect(post.map((p) => [p.identity.slot, p.identity.gen])).toEqual([[0, 2], [600, 2]]);
  });

  it('a moved anchor (redirected flight) starts a new generation', () => {
    const { post, cancel } = planQueue({
      ...base,
      queue: [msg('a', { slot: 0 })],
      wanted: [{ kind: 'fs', key: 'eventRow-1', anchor: NOW + 7200, plan: [0] }],
    });
    expect(cancel).toEqual(['a']);
    expect(post).toEqual([{ identity: expect.objectContaining({ gen: 2, anchor: NOW + 7200, slot: 0 }), fireAt: NOW + 7200 }]);
  });

  it('sweeps older generations and same-slot duplicates (lowest id wins)', () => {
    const queue = [
      msg('old', { slot: 0, gen: 1 }),
      msg('z', { slot: 0, gen: 2, plan: [0] }),
      msg('m', { slot: 0, gen: 2, plan: [0] }),
    ];
    const { post, cancel } = planQueue({
      ...base, queue,
      wanted: [{ kind: 'fs', key: 'eventRow-1', anchor: NOW + 3600, plan: [0] }],
    });
    expect(post).toEqual([]);
    expect(cancel.sort()).toEqual(['old', 'z']);
  });

  it('leaves a series it does not want alone — another device may own it', () => {
    const { post, cancel } = planQueue({ ...base, queue: [msg('a', { kind: 'ad', key: 'r9' })], wanted: [] });
    expect(post).toEqual([]);
    expect(cancel).toEqual([]);
  });

  it('cancels only the FUTURE messages of a gone series (post-landing sweep)', () => {
    const queue = [
      msg('fired', { slot: 0, anchor: NOW - 100 }),
      msg('later', { slot: 600, anchor: NOW - 100 }),
    ];
    const { cancel } = planQueue({ ...base, queue, wanted: [], gone: new Set(['fs:eventRow-1']) });
    expect(cancel).toEqual(['later']);
  });
});

describe('seriesInQueue', () => {
  it('lists each series once, at its newest generation, delivered ones included', () => {
    const map = seriesInQueue([
      msg('a', { slot: 0, gen: 1, anchor: NOW - 5000 }),
      msg('b', { slot: 0, gen: 2, plan: [0] }),
      msg('c', { kind: 'ad', key: 'r2' }),
    ]);
    expect([...map.keys()].sort()).toEqual(['ad:r2', 'fs:eventRow-1']);
    expect(map.get('fs:eventRow-1')?.gen).toBe(2);
  });
});
