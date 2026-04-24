// @vitest-environment happy-dom
//
// Unit tests for the storage helpers.
//
// `safeLS` is exercised against the real happy-dom `localStorage` (cleared
// between cases). `chromeStore` is exercised against a stubbed global
// `chrome` namespace: `vi.stubGlobal` injects a callback-shaped fake so we
// can assert both the wire-level calls to chrome.storage.local and the
// Promise facade presented to callers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeLS, chromeStore } from '../../src/lib/storage.js';

describe('safeLS', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('get / set / remove', () => {
    it('round-trips a string value', () => {
      safeLS.set('k', 'hello');
      expect(safeLS.get('k')).toBe('hello');
    });

    it('get returns null for missing keys', () => {
      expect(safeLS.get('missing')).toBeNull();
    });

    it('set coerces non-string values via String()', () => {
      safeLS.set('n', 42);
      expect(safeLS.get('n')).toBe('42');

      safeLS.set('b', true);
      expect(safeLS.get('b')).toBe('true');

      safeLS.set('nil', null);
      expect(safeLS.get('nil')).toBe('null');
    });

    it('remove deletes the key (subsequent get returns null)', () => {
      safeLS.set('k', 'v');
      safeLS.remove('k');
      expect(safeLS.get('k')).toBeNull();
    });

    it('remove on a missing key is a no-op (does not throw)', () => {
      expect(() => safeLS.remove('never-set')).not.toThrow();
    });
  });

  describe('bool', () => {
    it("returns true when stored value is the string 'true'", () => {
      safeLS.set('flag', 'true');
      expect(safeLS.bool('flag')).toBe(true);
    });

    it("returns false when stored value is the string 'false'", () => {
      safeLS.set('flag', 'false');
      expect(safeLS.bool('flag')).toBe(false);
    });

    it('returns default (false) for missing key', () => {
      expect(safeLS.bool('missing')).toBe(false);
    });

    it('honors explicit default when key is missing', () => {
      expect(safeLS.bool('missing', true)).toBe(true);
    });

    it("returns default for unrecognized strings like 'yes'", () => {
      safeLS.set('flag', 'yes');
      expect(safeLS.bool('flag')).toBe(false);
      expect(safeLS.bool('flag', true)).toBe(true);
    });
  });

  describe('int', () => {
    it("parses '42' to 42", () => {
      safeLS.set('n', '42');
      expect(safeLS.int('n')).toBe(42);
    });

    it("parses '0' to 0 (NOT the default — pure parser)", () => {
      safeLS.set('n', '0');
      expect(safeLS.int('n', 99)).toBe(0);
    });

    it("parses '-7' to -7 (negatives preserved)", () => {
      safeLS.set('n', '-7');
      expect(safeLS.int('n', 99)).toBe(-7);
    });

    it("returns default for non-numeric string 'abc'", () => {
      safeLS.set('n', 'abc');
      expect(safeLS.int('n', 3)).toBe(3);
    });

    it("returns default for empty string ''", () => {
      safeLS.set('n', '');
      expect(safeLS.int('n', 3)).toBe(3);
    });

    it('returns default (0) for missing key', () => {
      expect(safeLS.int('missing')).toBe(0);
    });

    it('honors explicit default when key is missing', () => {
      expect(safeLS.int('missing', 123)).toBe(123);
    });
  });

  describe('json', () => {
    it('parses valid JSON objects', () => {
      safeLS.set('obj', '{"a":1,"b":"x"}');
      expect(safeLS.json('obj')).toEqual({ a: 1, b: 'x' });
    });

    it('parses valid JSON arrays', () => {
      safeLS.set('arr', '[1,2,3]');
      expect(safeLS.json('arr')).toEqual([1, 2, 3]);
    });

    it('returns default (null) for invalid JSON', () => {
      safeLS.set('bad', '{not-json');
      expect(safeLS.json('bad')).toBeNull();
    });

    it('honors explicit default for invalid JSON', () => {
      safeLS.set('bad', '{not-json');
      expect(safeLS.json('bad', { fallback: true })).toEqual({ fallback: true });
    });

    it('returns default (null) for missing key', () => {
      expect(safeLS.json('missing')).toBeNull();
    });

    it('honors explicit default when key is missing', () => {
      expect(safeLS.json('missing', [])).toEqual([]);
    });
  });

  describe('setJSON + json round-trip', () => {
    it('round-trips an object', () => {
      const value = { count: 3, tags: ['a', 'b'], nested: { ok: true } };
      safeLS.setJSON('o', value);
      expect(safeLS.json('o')).toEqual(value);
    });

    it('round-trips an array of primitives', () => {
      const value = [1, 'two', null, true];
      safeLS.setJSON('arr', value);
      expect(safeLS.json('arr')).toEqual(value);
    });
  });
});

describe('chromeStore', () => {
  /** @type {{
   *   get: import('vitest').Mock,
   *   set: import('vitest').Mock,
   *   remove: import('vitest').Mock,
   * }} */
  let localApi;
  /** @type {{
   *   addListener: import('vitest').Mock,
   *   removeListener: import('vitest').Mock,
   * }} */
  let onChanged;
  /** @type {Set<(changes: Record<string, unknown>, areaName: string) => void>} */
  let listeners;

  beforeEach(() => {
    localApi = {
      get: vi.fn((/** @type {string} */ k, /** @type {(items: Record<string, unknown>) => void} */ cb) => {
        cb({ [k]: 'stored-value' });
      }),
      set: vi.fn((/** @type {Record<string, unknown>} */ _obj, /** @type {(() => void) | undefined} */ cb) => {
        cb?.();
      }),
      remove: vi.fn((/** @type {string | string[]} */ _keys, /** @type {(() => void) | undefined} */ cb) => {
        cb?.();
      }),
    };
    listeners = new Set();
    onChanged = {
      addListener: vi.fn((/** @type {(changes: Record<string, unknown>, areaName: string) => void} */ cb) => {
        listeners.add(cb);
      }),
      removeListener: vi.fn((/** @type {(changes: Record<string, unknown>, areaName: string) => void} */ cb) => {
        listeners.delete(cb);
      }),
    };
    vi.stubGlobal('chrome', { storage: { local: localApi, onChanged } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('get', () => {
    it("resolves with the stored value and calls api.get with the key", async () => {
      const value = await chromeStore.get('some-key');
      expect(value).toBe('stored-value');
      expect(localApi.get).toHaveBeenCalledTimes(1);
      expect(localApi.get).toHaveBeenCalledWith('some-key', expect.any(Function));
    });

    it('resolves with undefined when the backing response lacks the key', async () => {
      localApi.get.mockImplementationOnce((/** @type {string} */ _k, /** @type {(items: Record<string, unknown>) => void} */ cb) => {
        cb({});
      });
      const value = await chromeStore.get('absent');
      expect(value).toBeUndefined();
    });
  });

  describe('set', () => {
    it('calls api.set with { [key]: value } and resolves void', async () => {
      const result = await chromeStore.set('my-key', 123);
      expect(result).toBeUndefined();
      expect(localApi.set).toHaveBeenCalledTimes(1);
      expect(localApi.set).toHaveBeenCalledWith({ 'my-key': 123 }, expect.any(Function));
    });

    it('persists complex values (objects, arrays)', async () => {
      await chromeStore.set('settings', { a: 1, b: [2, 3] });
      expect(localApi.set).toHaveBeenCalledWith(
        { settings: { a: 1, b: [2, 3] } },
        expect.any(Function),
      );
    });
  });

  describe('remove', () => {
    it('forwards a string key to api.remove and resolves void', async () => {
      const result = await chromeStore.remove('my-key');
      expect(result).toBeUndefined();
      expect(localApi.remove).toHaveBeenCalledTimes(1);
      expect(localApi.remove).toHaveBeenCalledWith('my-key', expect.any(Function));
    });

    it('forwards an array of keys to api.remove', async () => {
      await chromeStore.remove(['a', 'b']);
      expect(localApi.remove).toHaveBeenCalledWith(['a', 'b'], expect.any(Function));
    });
  });

  describe('onChanged', () => {
    it('registers the listener with chrome.storage.onChanged', () => {
      const cb = vi.fn();
      chromeStore.onChanged(cb);
      expect(onChanged.addListener).toHaveBeenCalledTimes(1);
      expect(onChanged.addListener).toHaveBeenCalledWith(cb);
      expect(listeners.has(cb)).toBe(true);
    });

    it('propagates change events to the registered listener', () => {
      const cb = vi.fn();
      chromeStore.onChanged(cb);
      // Simulate the browser dispatching a storage change.
      for (const listener of listeners) listener({ foo: { newValue: 1 } }, 'local');
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ foo: { newValue: 1 } }, 'local');
    });

    it('returned unsubscribe calls removeListener with the same callback', () => {
      const cb = vi.fn();
      const unsubscribe = chromeStore.onChanged(cb);
      unsubscribe();
      expect(onChanged.removeListener).toHaveBeenCalledTimes(1);
      expect(onChanged.removeListener).toHaveBeenCalledWith(cb);
      expect(listeners.has(cb)).toBe(false);
    });

    it('unsubscribe is idempotent — second call does not throw or re-remove', () => {
      const cb = vi.fn();
      const unsubscribe = chromeStore.onChanged(cb);
      expect(() => {
        unsubscribe();
        unsubscribe();
        unsubscribe();
      }).not.toThrow();
      expect(onChanged.removeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('when no WebExtension API is available', () => {
    beforeEach(() => {
      // Wipe the `chrome` stub the outer beforeEach installed, and
      // explicitly blank both namespaces so pickStorage() returns null.
      vi.unstubAllGlobals();
      vi.stubGlobal('chrome', undefined);
      vi.stubGlobal('browser', undefined);
    });

    it('get resolves with undefined', async () => {
      const value = await chromeStore.get('k');
      expect(value).toBeUndefined();
    });

    it('set resolves with void (no throw)', async () => {
      const result = await chromeStore.set('k', 1);
      expect(result).toBeUndefined();
    });

    it('remove resolves with void (no throw)', async () => {
      const result = await chromeStore.remove('k');
      expect(result).toBeUndefined();
    });

    it('onChanged returns a no-op unsubscribe that does not throw', () => {
      const cb = vi.fn();
      const unsubscribe = chromeStore.onChanged(cb);
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
      // Listener was never registered, so no dispatch path exists.
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
