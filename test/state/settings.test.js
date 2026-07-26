// @vitest-environment happy-dom
//
// Unit tests for state/settings — the localStorage-backed reactive bag of
// user preferences.
//
// happy-dom provides a real `localStorage` implementation, which we wipe
// between cases. The module uses per-key persist (one localStorage key per
// preference under `oge_`), so tests exercise the wire directly: set
// localStorage, init, assert store; mutate the store, assert localStorage.
// No stubs — the whole point of per-key persist is DevTools-visibility, so
// testing through the real substrate matches how users and the AGR panel
// see the data.
//
// `fabBtnSize` (int) and `alarmClockNtfyToken` (string) stand in as the
// generic int / string field examples — the colonization fields that used
// to play that role moved to the per-universe galaxyScanConfig store (B2),
// and the alarmClock schedule / ad-hoc lead time moved to the global
// alarmClockGlobalConfig store (B3c).
//
// Setup order in beforeEach mirrors state/registry.test.js:
//   1. disposeSettingsStore() — cut any leftover subscription.
//   2. localStorage.clear()   — wipe persisted data.
//   3. settingsStore.set(defaults) — reset in-memory state to defaults.
// Order matters: step 1 before 3 so the reset doesn't trigger a stale
// write-through back into localStorage.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  settingsStore,
  initSettingsStore,
  disposeSettingsStore,
  SETTINGS_SCHEMA,
  SETTINGS_PREFIX,
} from '../../src/state/settings.js';

/** @typedef {import('../../src/state/settings.js').Settings} Settings */

/**
 * Rebuild the defaults object by iterating the public schema. Kept
 * in-test so we don't depend on an internal helper — if the schema ever
 * changes, tests that reset via this function automatically track it.
 *
 * @returns {Settings}
 */
const defaultsFromSchema = () => {
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (const [field, schema] of Object.entries(SETTINGS_SCHEMA)) {
    obj[field] = schema.default;
  }
  return /** @type {Settings} */ (/** @type {unknown} */ (obj));
};

beforeEach(() => {
  // Order matters — see file header.
  disposeSettingsStore();
  localStorage.clear();
  settingsStore.set(defaultsFromSchema());
});

afterEach(() => {
  // Defensive: make sure a failed test cannot leak a live subscription.
  disposeSettingsStore();
});

describe('SETTINGS_PREFIX and SETTINGS_SCHEMA', () => {
  it('exports the namespaced prefix', () => {
    expect(SETTINGS_PREFIX).toBe('oge_');
  });

  it('every schema key is prefixed with SETTINGS_PREFIX + field name', () => {
    // Every remaining field's LS key is just the prefix + field name. (The one
    // historical exception, the remapped alarmClockSchedule key, moved out to the
    // global alarmClockGlobalConfig store in B3c.)
    for (const [field, schema] of Object.entries(SETTINGS_SCHEMA)) {
      expect(schema.key).toBe(SETTINGS_PREFIX + field);
    }
  });

  it('declares the expected set of Settings fields with correct types', () => {
    // Pinned so adding/removing a preference is an obvious diff.
    expect(Object.keys(SETTINGS_SCHEMA).sort()).toEqual(
      [
        'threatHighlight',
        'autoRedirectExpedition',
        'cloudSync',
        'eventMenuHighlight',
        'expeditionBadges',
        'fabBtnSize',
        'gistToken',
        'maxExpeditionsPerPlanet',
        'readabilityBoost',
        'showExpeditionButton',
        'showColonizeButton',
        'showLifeformButton',
        'showDailyRunButton',
        'showWhosSpying',
        'spyRange',
        'alarmClockMasterEnabled',
        'alarmClockNtfyToken',
        'traderMenuHighlight',
      ].sort(),
    );

    expect(SETTINGS_SCHEMA.showExpeditionButton).toEqual({
      type: 'bool',
      default: true,
      key: 'oge_showExpeditionButton',
    });
    expect(SETTINGS_SCHEMA.fabBtnSize).toEqual({
      type: 'int',
      default: 320,
      key: 'oge_fabBtnSize',
    });
    expect(SETTINGS_SCHEMA.alarmClockNtfyToken).toEqual({
      type: 'string',
      default: '',
      key: 'oge_alarmClockNtfyToken',
    });
  });
});

describe('settingsStore — initial state (pre-init)', () => {
  it('holds all schema defaults before initSettingsStore runs', () => {
    // beforeEach resets the store to defaults — but the assertion is that
    // the DEFAULTS are what the store exposes, regardless of init.
    const state = settingsStore.get();
    expect(state.showExpeditionButton).toBe(true);
    expect(state.expeditionBadges).toBe(true);
    expect(state.autoRedirectExpedition).toBe(true);
    expect(state.fabBtnSize).toBe(320);
    expect(state.alarmClockMasterEnabled).toBe(false);
    expect(state.alarmClockNtfyToken).toBe('');
    expect(state.maxExpeditionsPerPlanet).toBe(1);
    expect(state.readabilityBoost).toBe(true);
    expect(state.cloudSync).toBe(false);
    expect(state.gistToken).toBe('');
  });
});

describe('initSettingsStore — hydration', () => {
  it('keeps all defaults when localStorage is empty', () => {
    // localStorage cleared in beforeEach — nothing to hydrate from.
    initSettingsStore();
    expect(settingsStore.get()).toEqual(defaultsFromSchema());
  });

  it('hydrates a boolean field from localStorage', () => {
    localStorage.setItem('oge_showExpeditionButton', 'true');
    initSettingsStore();
    expect(settingsStore.get().showExpeditionButton).toBe(true);
  });

  it('hydrates an int field from localStorage', () => {
    localStorage.setItem('oge_fabBtnSize', '45');
    initSettingsStore();
    expect(settingsStore.get().fabBtnSize).toBe(45);
  });

  it('hydrates a string field from localStorage', () => {
    localStorage.setItem('oge_alarmClockNtfyToken', 'secret123');
    initSettingsStore();
    expect(settingsStore.get().alarmClockNtfyToken).toBe('secret123');
  });

  it('falls back to default when a bool value is unparseable', () => {
    // safeLS.bool only accepts 'true' / 'false' — anything else yields
    // the default, which here is `expeditionBadges: true`.
    localStorage.setItem('oge_expeditionBadges', 'garbage');
    initSettingsStore();
    expect(settingsStore.get().expeditionBadges).toBe(true);
  });

  it('falls back to default when an int value is unparseable', () => {
    // safeLS.int returns the default when parseInt fails entirely.
    localStorage.setItem('oge_fabBtnSize', 'not-a-number');
    initSettingsStore();
    expect(settingsStore.get().fabBtnSize).toBe(320);
  });

  it('hydrates a mix of fields at once in a single store update', () => {
    localStorage.setItem('oge_showExpeditionButton', 'false');
    localStorage.setItem('oge_fabBtnSize', '30');
    localStorage.setItem('oge_alarmClockNtfyToken', 'tk_abc');
    localStorage.setItem('oge_gistToken', 'ghp_abc123');

    initSettingsStore();

    const state = settingsStore.get();
    expect(state.showExpeditionButton).toBe(false);
    expect(state.fabBtnSize).toBe(30);
    expect(state.alarmClockNtfyToken).toBe('tk_abc');
    expect(state.gistToken).toBe('ghp_abc123');
    // Untouched fields stay at defaults.
    expect(state.autoRedirectExpedition).toBe(true);
    expect(state.expeditionBadges).toBe(true);
  });
});

describe('initSettingsStore — write-through (per-key diff)', () => {
  it('writes a changed bool field to its own localStorage key', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, showExpeditionButton: false }));
    expect(localStorage.getItem('oge_showExpeditionButton')).toBe('false');
  });

  it('writes a changed int field to its own localStorage key', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, fabBtnSize: 30 }));
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('30');
  });

  it('writes a changed string field to its own localStorage key', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, alarmClockNtfyToken: 'tk_789' }));
    expect(localStorage.getItem('oge_alarmClockNtfyToken')).toBe('tk_789');
  });

  it('writes multiple changed fields in the same set/update call', () => {
    initSettingsStore();
    settingsStore.update((s) => ({
      ...s,
      fabBtnSize: 30,
      alarmClockNtfyToken: 'tk_7',
      showExpeditionButton: false,
    }));

    expect(localStorage.getItem('oge_fabBtnSize')).toBe('30');
    expect(localStorage.getItem('oge_alarmClockNtfyToken')).toBe('tk_7');
    expect(localStorage.getItem('oge_showExpeditionButton')).toBe('false');
  });

  it('does NOT touch localStorage keys for fields that did not change', () => {
    // Pre-seed a sentinel value under a key the test will NOT modify.
    // The hydrate will read it as an int (parseInt('SENTINEL') → NaN →
    // default 1) but the LS string itself remains untouched unless
    // the store writes back. Since we only mutate `fabBtnSize`, the
    // sentinel must survive — proving the diff write-through.
    localStorage.setItem('oge_maxExpeditionsPerPlanet', 'SENTINEL');

    initSettingsStore();

    // Change only fabBtnSize.
    settingsStore.update((s) => ({ ...s, fabBtnSize: 30 }));

    expect(localStorage.getItem('oge_fabBtnSize')).toBe('30');
    // maxExpeditionsPerPlanet key was not written because the store value (1,
    // hydrated as default) did not change from its hydrated state.
    expect(localStorage.getItem('oge_maxExpeditionsPerPlanet')).toBe('SENTINEL');
  });

  it('coerces values via String(): true → "true", 42 → "42"', () => {
    initSettingsStore();

    settingsStore.update((s) => ({
      ...s,
      showExpeditionButton: false,
      expeditionBadges: false,
      fabBtnSize: 42,
      gistToken: 'abc',
    }));

    expect(localStorage.getItem('oge_showExpeditionButton')).toBe('false');
    expect(localStorage.getItem('oge_expeditionBadges')).toBe('false');
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('42');
    expect(localStorage.getItem('oge_gistToken')).toBe('abc');
  });

  it('writes when a field changes back to its default value', () => {
    // If the user had a non-default value and resets it, we still write
    // the default string to LS — per-key diff compares to the PREVIOUS
    // state, not to the schema default.
    localStorage.setItem('oge_fabBtnSize', '90');
    initSettingsStore();
    expect(settingsStore.get().fabBtnSize).toBe(90);

    // Reset to the default.
    settingsStore.update((s) => ({ ...s, fabBtnSize: 320 }));

    expect(localStorage.getItem('oge_fabBtnSize')).toBe('320');
  });
});

describe('initSettingsStore — persistence round-trip', () => {
  it('values written during one init survive dispose + re-init', () => {
    initSettingsStore();
    settingsStore.update((s) => ({
      ...s,
      showExpeditionButton: false,
      fabBtnSize: 45,
      alarmClockNtfyToken: 'tk_789',
      gistToken: 'ghp_roundtrip',
    }));
    disposeSettingsStore();

    // Wipe in-memory state back to defaults to prove the next init
    // hydrates from LS and not from leftover memory.
    settingsStore.set(defaultsFromSchema());
    expect(settingsStore.get().showExpeditionButton).toBe(true);

    initSettingsStore();

    const state = settingsStore.get();
    expect(state.showExpeditionButton).toBe(false);
    expect(state.fabBtnSize).toBe(45);
    expect(state.alarmClockNtfyToken).toBe('tk_789');
    expect(state.gistToken).toBe('ghp_roundtrip');
  });
});

describe('disposeSettingsStore', () => {
  it('prevents further writes to localStorage', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, fabBtnSize: 30 }));
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('30');

    disposeSettingsStore();

    settingsStore.update((s) => ({ ...s, fabBtnSize: 99 }));

    // LS value is frozen at pre-dispose state.
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('30');
  });

  it('is safe to call when never initialized', () => {
    expect(() => disposeSettingsStore()).not.toThrow();
  });

  it('is safe to call twice in a row (idempotent)', () => {
    initSettingsStore();
    disposeSettingsStore();
    expect(() => disposeSettingsStore()).not.toThrow();
  });
});

describe('initSettingsStore — idempotent', () => {
  it('returns the same dispose fn across repeated calls', () => {
    const d1 = initSettingsStore();
    const d2 = initSettingsStore();
    expect(d2).toBe(d1);
  });

  it('a second init does not install a duplicate write-through', () => {
    // If a duplicate subscription were installed, disposing ONCE would
    // only cut one of them and the second would keep writing. We
    // exercise the same invariant pattern used in state/registry.test.js.
    initSettingsStore();
    initSettingsStore();

    settingsStore.update((s) => ({ ...s, fabBtnSize: 50 }));
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('50');

    disposeSettingsStore();

    settingsStore.update((s) => ({ ...s, fabBtnSize: 99 }));

    // If a duplicate subscription existed, we'd see '99' here.
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('50');
  });

  it('a second init does not re-run hydration (in-memory changes survive)', () => {
    localStorage.setItem('oge_fabBtnSize', '30');
    initSettingsStore();
    expect(settingsStore.get().fabBtnSize).toBe(30);

    // Mutate in memory without touching LS — but write-through will fire.
    // The point of the test is: if re-init re-hydrated, it would clobber
    // this mutation back to the LS value. We prove it does not.
    settingsStore.update((s) => ({ ...s, fabBtnSize: 77 }));
    // LS is now '77' thanks to write-through.
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('77');

    // Manually stomp LS as if an external writer changed it.
    localStorage.setItem('oge_fabBtnSize', '30');

    // Second init should be a no-op: it must NOT re-hydrate from '30'.
    initSettingsStore();
    expect(settingsStore.get().fabBtnSize).toBe(77);
  });
});
