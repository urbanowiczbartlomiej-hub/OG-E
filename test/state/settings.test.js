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
// `adhocOffsetSec` (int) and `reminderNtfyToken` (string) stand in as the
// generic int / string field examples — the colonization fields that used
// to play that role moved to the per-universe galaxyScanConfig store (B2).
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
    // A handful of fields point at a DIFFERENT LS key than their field name:
    // v1.11.0 repointed the wave schedule + FS offsets to fresh keys so the
    // old incompatible stored values are orphaned (a deliberate reset, not a
    // migration — see SETTINGS_SCHEMA). Their keys are pinned explicitly in
    // the "correct types" test below.
    const REMAPPED = new Set(['reminderSchedule', 'fsOffsets']);
    for (const [field, schema] of Object.entries(SETTINGS_SCHEMA)) {
      if (REMAPPED.has(field)) {
        expect(schema.key.startsWith(SETTINGS_PREFIX)).toBe(true);
      } else {
        expect(schema.key).toBe(SETTINGS_PREFIX + field);
      }
    }
  });

  it('declares the expected set of Settings fields with correct types', () => {
    // Pinned so adding/removing a preference is an obvious diff.
    expect(Object.keys(SETTINGS_SCHEMA).sort()).toEqual(
      [
        'adhocOffsetSec',
        'autoRedirectExpedition',
        'cloudSync',
        'eventMenuHighlight',
        'expeditionBadges',
        'fabBtnSize',
        'fabMode',
        'fsEnabled',
        'fsMinFlightSec',
        'fsOffsets',
        'fsThreshold',
        'gistToken',
        'maxExpeditionsPerPlanet',
        'readabilityBoost',
        'remindersMasterEnabled',
        'reminderEnabled',
        'reminderNtfyToken',
        'reminderSchedule',
        'traderMenuHighlight',
      ].sort(),
    );

    expect(SETTINGS_SCHEMA.reminderSchedule).toEqual({
      type: 'string',
      default: '0m, 10m, 30m, 60m',
      key: 'oge_reminderWaveOffsets',
    });

    expect(SETTINGS_SCHEMA.fabMode).toEqual({
      type: 'bool',
      default: true,
      key: 'oge_fabMode',
    });
    expect(SETTINGS_SCHEMA.fabBtnSize).toEqual({
      type: 'int',
      default: 320,
      key: 'oge_fabBtnSize',
    });
    expect(SETTINGS_SCHEMA.reminderNtfyToken).toEqual({
      type: 'string',
      default: '',
      key: 'oge_reminderNtfyToken',
    });
    expect(SETTINGS_SCHEMA.fsEnabled).toEqual({
      type: 'bool',
      default: false,
      key: 'oge_fsEnabled',
    });
    expect(SETTINGS_SCHEMA.fsThreshold).toEqual({
      type: 'int',
      default: 100000,
      key: 'oge_fsThreshold',
    });
    expect(SETTINGS_SCHEMA.fsOffsets).toEqual({
      type: 'string',
      default: '-10m, 0m, 10m',
      key: 'oge_fsReminderOffsets',
    });
    expect(SETTINGS_SCHEMA.fsMinFlightSec).toEqual({
      type: 'int',
      default: 600,
      key: 'oge_fsMinFlightSec',
    });
  });
});

describe('settingsStore — initial state (pre-init)', () => {
  it('holds all schema defaults before initSettingsStore runs', () => {
    // beforeEach resets the store to defaults — but the assertion is that
    // the DEFAULTS are what the store exposes, regardless of init.
    const state = settingsStore.get();
    expect(state.fabMode).toBe(true);
    expect(state.expeditionBadges).toBe(true);
    expect(state.autoRedirectExpedition).toBe(true);
    expect(state.fabBtnSize).toBe(320);
    expect(state.adhocOffsetSec).toBe(60);
    expect(state.reminderNtfyToken).toBe('');
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
    localStorage.setItem('oge_fabMode', 'true');
    initSettingsStore();
    expect(settingsStore.get().fabMode).toBe(true);
  });

  it('hydrates an int field from localStorage', () => {
    localStorage.setItem('oge_adhocOffsetSec', '45');
    initSettingsStore();
    expect(settingsStore.get().adhocOffsetSec).toBe(45);
  });

  it('hydrates a string field from localStorage', () => {
    localStorage.setItem('oge_reminderNtfyToken', 'secret123');
    initSettingsStore();
    expect(settingsStore.get().reminderNtfyToken).toBe('secret123');
  });

  it('treats an empty string as a legitimate stored value (not missing)', () => {
    // Users can explicitly blank out e.g. the reminder schedule — that must
    // hydrate as '' not fall through to the (non-empty) default via the
    // "missing" path. reminderSchedule has a non-empty default, so '' here
    // proves the distinction. (Its LS key is the remapped reminderWaveOffsets.)
    localStorage.setItem('oge_reminderWaveOffsets', '');
    initSettingsStore();
    expect(settingsStore.get().reminderSchedule).toBe('');
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
    localStorage.setItem('oge_adhocOffsetSec', 'not-a-number');
    initSettingsStore();
    expect(settingsStore.get().adhocOffsetSec).toBe(60);
  });

  it('hydrates a mix of fields at once in a single store update', () => {
    localStorage.setItem('oge_fabMode', 'false');
    localStorage.setItem('oge_adhocOffsetSec', '30');
    localStorage.setItem('oge_reminderNtfyToken', 'tk_abc');
    localStorage.setItem('oge_gistToken', 'ghp_abc123');

    initSettingsStore();

    const state = settingsStore.get();
    expect(state.fabMode).toBe(false);
    expect(state.adhocOffsetSec).toBe(30);
    expect(state.reminderNtfyToken).toBe('tk_abc');
    expect(state.gistToken).toBe('ghp_abc123');
    // Untouched fields stay at defaults.
    expect(state.autoRedirectExpedition).toBe(true);
    expect(state.expeditionBadges).toBe(true);
  });
});

describe('initSettingsStore — write-through (per-key diff)', () => {
  it('writes a changed bool field to its own localStorage key', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, fabMode: false }));
    expect(localStorage.getItem('oge_fabMode')).toBe('false');
  });

  it('writes a changed int field to its own localStorage key', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 30 }));
    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('30');
  });

  it('writes a changed string field to its own localStorage key', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, reminderNtfyToken: 'tk_789' }));
    expect(localStorage.getItem('oge_reminderNtfyToken')).toBe('tk_789');
  });

  it('writes multiple changed fields in the same set/update call', () => {
    initSettingsStore();
    settingsStore.update((s) => ({
      ...s,
      adhocOffsetSec: 30,
      reminderNtfyToken: 'tk_7',
      fabMode: false,
    }));

    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('30');
    expect(localStorage.getItem('oge_reminderNtfyToken')).toBe('tk_7');
    expect(localStorage.getItem('oge_fabMode')).toBe('false');
  });

  it('does NOT touch localStorage keys for fields that did not change', () => {
    // Pre-seed a sentinel value under a key the test will NOT modify.
    // The hydrate will read it as an int (parseInt('SENTINEL') → NaN →
    // default 320) but the LS string itself remains untouched unless
    // the store writes back. Since we only mutate `adhocOffsetSec`, the
    // sentinel must survive — proving the diff write-through.
    localStorage.setItem('oge_fabBtnSize', 'SENTINEL');

    initSettingsStore();

    // Change only adhocOffsetSec.
    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 30 }));

    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('30');
    // fabBtnSize key was not written because the store value (320,
    // hydrated as default) did not change from its hydrated state.
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('SENTINEL');
  });

  it('coerces values via String(): true → "true", 42 → "42"', () => {
    initSettingsStore();

    settingsStore.update((s) => ({
      ...s,
      fabMode: false,
      expeditionBadges: false,
      fabBtnSize: 42,
      gistToken: 'abc',
    }));

    expect(localStorage.getItem('oge_fabMode')).toBe('false');
    expect(localStorage.getItem('oge_expeditionBadges')).toBe('false');
    expect(localStorage.getItem('oge_fabBtnSize')).toBe('42');
    expect(localStorage.getItem('oge_gistToken')).toBe('abc');
  });

  it('writes when a field changes back to its default value', () => {
    // If the user had a non-default value and resets it, we still write
    // the default string to LS — per-key diff compares to the PREVIOUS
    // state, not to the schema default.
    localStorage.setItem('oge_adhocOffsetSec', '90');
    initSettingsStore();
    expect(settingsStore.get().adhocOffsetSec).toBe(90);

    // Reset to the default.
    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 60 }));

    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('60');
  });
});

describe('initSettingsStore — persistence round-trip', () => {
  it('values written during one init survive dispose + re-init', () => {
    initSettingsStore();
    settingsStore.update((s) => ({
      ...s,
      fabMode: false,
      adhocOffsetSec: 45,
      reminderNtfyToken: 'tk_789',
      gistToken: 'ghp_roundtrip',
    }));
    disposeSettingsStore();

    // Wipe in-memory state back to defaults to prove the next init
    // hydrates from LS and not from leftover memory.
    settingsStore.set(defaultsFromSchema());
    expect(settingsStore.get().fabMode).toBe(true);

    initSettingsStore();

    const state = settingsStore.get();
    expect(state.fabMode).toBe(false);
    expect(state.adhocOffsetSec).toBe(45);
    expect(state.reminderNtfyToken).toBe('tk_789');
    expect(state.gistToken).toBe('ghp_roundtrip');
  });
});

describe('disposeSettingsStore', () => {
  it('prevents further writes to localStorage', () => {
    initSettingsStore();
    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 30 }));
    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('30');

    disposeSettingsStore();

    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 99 }));

    // LS value is frozen at pre-dispose state.
    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('30');
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

    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 50 }));
    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('50');

    disposeSettingsStore();

    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 99 }));

    // If a duplicate subscription existed, we'd see '99' here.
    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('50');
  });

  it('a second init does not re-run hydration (in-memory changes survive)', () => {
    localStorage.setItem('oge_adhocOffsetSec', '30');
    initSettingsStore();
    expect(settingsStore.get().adhocOffsetSec).toBe(30);

    // Mutate in memory without touching LS — but write-through will fire.
    // The point of the test is: if re-init re-hydrated, it would clobber
    // this mutation back to the LS value. We prove it does not.
    settingsStore.update((s) => ({ ...s, adhocOffsetSec: 77 }));
    // LS is now '77' thanks to write-through.
    expect(localStorage.getItem('oge_adhocOffsetSec')).toBe('77');

    // Manually stomp LS as if an external writer changed it.
    localStorage.setItem('oge_adhocOffsetSec', '30');

    // Second init should be a no-op: it must NOT re-hydrate from '30'.
    initSettingsStore();
    expect(settingsStore.get().adhocOffsetSec).toBe(77);
  });
});
