// @vitest-environment happy-dom
//
// Unit tests for the shared FAB settings lifecycle
// (`features/shared/fabSettingsLifecycle.js`) — the mount/teardown + resize
// wiring every send* feature shares. Driven against the REAL settings store
// (so the subscribe semantics under test are the production ones) with spy
// mount/removeButton/updateButtonSize callbacks. The full feature flows are
// covered by `sendExpedition.test.js` / `sendColony.test.js` / the
// sendLifeform suite; here we isolate the wiring.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFabSettingsLifecycle } from '../../src/features/shared/fabSettingsLifecycle.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';

const resetSettingsToDefaults = () => {
  /** @type {Record<string, unknown>} */
  const defaults = {};
  for (const key of /** @type {Array<keyof typeof SETTINGS_SCHEMA>} */ (
    Object.keys(SETTINGS_SCHEMA)
  )) {
    defaults[key] = SETTINGS_SCHEMA[key].default;
  }
  settingsStore.set(
    /** @type {import('../../src/state/settings.js').Settings} */ (
      /** @type {unknown} */ (defaults)
    ),
  );
};

/** @param {Partial<import('../../src/state/settings.js').Settings>} patch */
const setSettings = (patch) =>
  settingsStore.set({ ...settingsStore.get(), ...patch });

/** @type {(() => void) | null} */
let unsub = null;

/** Install the lifecycle with fresh spies; tracks `unsub` for teardown. */
const setup = () => {
  const spies = {
    mount: vi.fn(),
    removeButton: vi.fn(),
    updateButtonSize: vi.fn(),
    onSettingsChange: vi.fn(),
  };
  unsub = installFabSettingsLifecycle({
    settingsStore,
    enabled: (s) => s.showExpeditionButton,
    mount: spies.mount,
    removeButton: spies.removeButton,
    updateButtonSize: spies.updateButtonSize,
    isInstalled: () => true,
    onSettingsChange: spies.onSettingsChange,
  });
  return spies;
};

beforeEach(() => {
  resetSettingsToDefaults(); // showExpeditionButton: true, fabBtnSize: 320
});

afterEach(() => {
  unsub?.();
  unsub = null;
});

describe('installFabSettingsLifecycle', () => {
  it('mounts once on install when showExpeditionButton is on', () => {
    const s = setup();
    expect(s.mount).toHaveBeenCalledTimes(1);
    expect(s.removeButton).not.toHaveBeenCalled();
    expect(s.updateButtonSize).not.toHaveBeenCalled();
  });

  it('does not mount on install when showExpeditionButton is off', () => {
    setSettings({ showExpeditionButton: false });
    const s = setup();
    expect(s.mount).not.toHaveBeenCalled();
  });

  it('mounts on a showExpeditionButton flip to on, removes on a flip to off', () => {
    const s = setup(); // initial mount
    s.mount.mockClear();

    setSettings({ showExpeditionButton: false });
    expect(s.removeButton).toHaveBeenCalledTimes(1);
    expect(s.mount).not.toHaveBeenCalled();

    setSettings({ showExpeditionButton: true });
    expect(s.mount).toHaveBeenCalledTimes(1);
  });

  it('live-resizes on a fabBtnSize change', () => {
    const s = setup();
    setSettings({ fabBtnSize: 480 });
    expect(s.updateButtonSize).toHaveBeenCalledWith(480);
  });

  it('runs onSettingsChange on every notification', () => {
    const s = setup();
    setSettings({ fabBtnSize: 400 });
    setSettings({ showExpeditionButton: false });
    expect(s.onSettingsChange).toHaveBeenCalledTimes(2);
  });

  it('an unrelated settings change touches only onSettingsChange', () => {
    const s = setup();
    s.mount.mockClear();
    setSettings({ maxExpeditionsPerPlanet: 3 });
    expect(s.mount).not.toHaveBeenCalled();
    expect(s.removeButton).not.toHaveBeenCalled();
    expect(s.updateButtonSize).not.toHaveBeenCalled();
    expect(s.onSettingsChange).toHaveBeenCalledTimes(1);
  });

  it('stops reacting after unsubscribe', () => {
    const s = setup();
    s.mount.mockClear();
    unsub?.();
    unsub = null;
    setSettings({ showExpeditionButton: false });
    setSettings({ showExpeditionButton: true });
    expect(s.mount).not.toHaveBeenCalled();
    expect(s.removeButton).not.toHaveBeenCalled();
    expect(s.onSettingsChange).not.toHaveBeenCalled();
  });

  it('works without an onSettingsChange callback', () => {
    unsub = installFabSettingsLifecycle({
      settingsStore,
      enabled: (s) => s.showExpeditionButton,
      mount: vi.fn(),
      removeButton: vi.fn(),
      updateButtonSize: vi.fn(),
      isInstalled: () => true,
    });
    expect(() => setSettings({ fabBtnSize: 200 })).not.toThrow();
  });
});
