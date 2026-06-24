// @vitest-environment happy-dom
//
// Behavioral tests for the fleet GUARDIAN surface
// (`src/features/alarmClock/guardian.js`).
//
// The guardian is the loud half of the post-landing watch: while the producer
// reports any landed-but-unsaved fleet via `state/fleetSaveSet.readLandedFs()`,
// the guardian floats ONE warning button on the unified FAB —
//   • tap        → off a fleetdispatch screen this is two-step: the 1st tap
//                  ACKs ("I'm here" — silences the pulse, stays put) and the
//                  2nd navigates to the body to re-save;
//   • long-press → dismiss this landing.
// It also rides the FAB's `fabMode` / `fabBtnSize` settings live.
//
// We mock the heavy *view* (`shared/button.js` + `shared/buttonChrome.js`) so we
// can capture the button config and drive its `onTap`/`onHold` directly, and we
// mock the producer's output (`readLandedFs`). The real `settingsStore` (defaults
// to fabMode:true, fabBtnSize:320) and the real `safeLS`-backed guardian dismiss
// store are used — happy-dom gives us a working `localStorage`.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the shared button view ────────────────────────────────────────────
// `createButton` records every config it was given and returns a fake Button
// whose methods are spies. `labelLines` is kept faithful (guardian.js calls it
// to build the label) so we can still assert the rendered text.
const buttonMock = vi.hoisted(() => {
  /** @type {any[]} */
  const created = [];
  /** @type {{ value: any }} */
  const last = { value: null };
  return { created, last };
});

vi.mock('../../src/features/shared/button.js', () => ({
  /** @param {{ main: string, sub?: string, hint?: string }} parts */
  labelLines: ({ main, sub, hint }) => {
    /** @type {{ text: string }[]} */
    const lines = [{ text: main }];
    if (sub) lines.push({ text: sub });
    if (hint) lines.push({ text: hint });
    return lines;
  },
  /** @param {any} cfg */
  createButton: (cfg) => {
    const btn = {
      cfg,
      el: document.createElement('div'),
      paintLines: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    buttonMock.created.push(btn);
    buttonMock.last.value = btn;
    return btn;
  },
}));

const installButtonChrome = vi.hoisted(() => vi.fn());
vi.mock('../../src/features/shared/buttonChrome.js', () => ({ installButtonChrome }));

// ── Mock the producer's landed-FS output ───────────────────────────────────
/** @typedef {{ bodyKey: string, landedAt: number }} Landed */
const readLandedFs = vi.hoisted(() =>
  vi.fn(/** @returns {Landed[]} */ () => []),
);
vi.mock('../../src/state/fleetSaveSet.js', () => ({ readLandedFs }));

import { installGuardian, _resetGuardianForTest } from '../../src/features/alarmClock/guardian.js';
import { EVENT_BOX_LOADED_EVENT } from '../../src/lib/ogeEvents.js';
import { settingsStore } from '../../src/state/settings.js';
import { addGuardianDismiss } from '../../src/features/alarmClock/guardianDismiss.js';

const UID = 'uni-77';

/** A far-future timestamp (seconds), used for dismiss-record expiries. */
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

/**
 * One landed-FS entry as the producer publishes it. There is no `expiresAt` any
 * more — the exposed flag is durable (clears only on re-save / departure /
 * dismiss), so an entry carries just its body and landing time.
 *
 * @param {{ bodyKey: string, landedAt?: number }} o
 * @returns {{ bodyKey: string, landedAt: number }}
 */
const landed = ({ bodyKey, landedAt = 1000 }) => ({ bodyKey, landedAt });

/** The most-recently created fake button (or null). */
const lastBtn = () => buttonMock.last.value;

/** The single zone config of the live button. */
const zone = () => lastBtn().cfg.zones[0];

/**
 * Paint the left planet list so `navigateToBody` can resolve a coords → href.
 *
 * @param {{ coords: string, planetHref?: string, moonHref?: string }} o
 * @returns {void}
 */
const paintPlanetList = ({ coords, planetHref, moonHref }) => {
  const moon = moonHref
    ? `<a class="moonlink" href="${moonHref}"></a>`
    : '';
  document.body.innerHTML = `
    <div id="planetList">
      <div class="smallplanet" id="planet-3">
        <a class="planetlink" href="${planetHref || '#'}">
          <span class="planet-koords">[${coords}]</span>
        </a>
        ${moon}
      </div>
    </div>`;
};

beforeEach(() => {
  document.body.innerHTML = '';
  // Reset the URL query: a prior tap test navigates to a gameforge
  // fleetdispatch URL, and that lingering `component=fleetdispatch` would push
  // later cases onto the guardian's on-dispatch branch. (happy-dom 14 honours a
  // direct `location.search =` write — the same workaround the recorder test uses.)
  location.search = '';
  readLandedFs.mockReturnValue([]);
  installButtonChrome.mockClear();
  buttonMock.created.length = 0;
  buttonMock.last.value = null;
  // Known FAB state: visible, size 320 (the schema defaults, but assert it).
  settingsStore.set({ ...settingsStore.get(), fabMode: true, fabBtnSize: 320 });
});

afterEach(() => {
  _resetGuardianForTest();
});

describe('installGuardian — mounting', () => {
  it('mounts no button when the bare set is empty', () => {
    installGuardian({ universeId: UID });
    expect(lastBtn()).toBeNull();
    expect(installButtonChrome).not.toHaveBeenCalled();
  });

  it('mounts one warning button when a fleet is bare and the FAB is on', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    installGuardian({ universeId: UID });
    expect(lastBtn()).not.toBeNull();
    expect(installButtonChrome).toHaveBeenCalledTimes(1);
    // Built on the unified FAB at the settings-driven size.
    expect(lastBtn().cfg.module.id).toBe('guard');
    expect(lastBtn().cfg.size).toBe(320);
  });

  it('does NOT mount while the FAB is disabled, even with a bare fleet', () => {
    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    installGuardian({ universeId: UID });
    expect(lastBtn()).toBeNull();
  });

  it('is idempotent — a second install does not build a second button', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    const dispose1 = installGuardian({ universeId: UID });
    const dispose2 = installGuardian({ universeId: UID });
    expect(dispose2).toBe(dispose1);
    expect(buttonMock.created).toHaveLength(1);
  });
});

describe('installGuardian — label', () => {
  it('paints the single coords as the subtitle for one bare fleet', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '4:115:8:1' })]);
    installGuardian({ universeId: UID });
    const lines = lastBtn().paintLines.mock.calls.at(-1)[1];
    const texts = lines.map(/** @param {{ text: string }} l */ (l) => l.text);
    expect(texts).toContain('You here?');
    expect(texts).toContain('4:115:8');
    expect(texts).toContain('(hold to dismiss)');
  });

  it('summarises the overflow as "coords +N" for multiple bare fleets', () => {
    readLandedFs.mockReturnValue([
      landed({ bodyKey: '1:2:3:1' }),
      landed({ bodyKey: '4:5:6:3' }),
      landed({ bodyKey: '7:8:9:1' }),
    ]);
    installGuardian({ universeId: UID });
    const texts = lastBtn().paintLines.mock.calls
      .at(-1)[1].map(/** @param {{ text: string }} l */ (l) => l.text);
    expect(texts).toContain('1:2:3 +2');
  });
});

describe('installGuardian — tap (ack + navigate)', () => {
  it('acks the primary body then navigates to its planet fleetdispatch page', () => {
    const ack = vi.fn();
    paintPlanetList({
      coords: '1:2:3',
      planetHref: 'https://s1.ogame.gameforge.com/game/index.php?page=ingame&component=overview&cp=33',
    });
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    installGuardian({ ack, universeId: UID });

    // First tap ACKs only — silences the pulse, snoozes the push, stays put.
    zone().onTap();
    expect(ack).toHaveBeenCalledWith('1:2:3:1');
    expect(window.location.href).not.toContain('component=fleetdispatch');

    // Second tap (while still armed) navigates to the body's fleetdispatch.
    zone().onTap();
    expect(window.location.href).toContain('component=fleetdispatch');
    expect(window.location.href).toContain('cp=33');
  });

  it('follows the MOON link when the body type is 3', () => {
    const ack = vi.fn();
    paintPlanetList({
      coords: '1:2:3',
      planetHref: 'https://s1.ogame.gameforge.com/game/index.php?page=ingame&cp=33',
      moonHref: 'https://s1.ogame.gameforge.com/game/index.php?page=ingame&cp=44',
    });
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:3' })]);
    installGuardian({ ack, universeId: UID });

    // First tap ACKs; the second navigates — to the MOON link for a type-3 body.
    zone().onTap();
    zone().onTap();

    expect(window.location.href).toContain('cp=44');
    expect(window.location.href).toContain('component=fleetdispatch');
  });
});

describe('installGuardian — long-press (dismiss)', () => {
  it('calls the injected dismiss with the primary body, then drops it from the set', () => {
    const dismiss = vi.fn();
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1', landedAt: 555 })]);
    installGuardian({ dismiss, universeId: UID });

    // After the producer command lands, the entry is gone on the next read.
    dismiss.mockImplementation(() => readLandedFs.mockReturnValue([]));
    zone().onHold();

    expect(dismiss).toHaveBeenCalledWith('1:2:3:1', 555);
    // Re-read empties the set → button torn down.
    expect(lastBtn().dispose).toHaveBeenCalled();
  });

  it('wires the deliberate hold duration onto the button', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    installGuardian({ universeId: UID });
    expect(lastBtn().cfg.holdMs).toBe(1500);
  });
});

describe('installGuardian — filtering', () => {
  it('suppresses a landing the user already dismissed (same landedAt)', () => {
    const now = Math.floor(Date.now() / 1000);
    addGuardianDismiss(UID, '1:2:3:1', 4242, FUTURE, now);
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1', landedAt: 4242 })]);
    installGuardian({ universeId: UID });
    expect(lastBtn()).toBeNull();
  });

  it('re-arms when the SAME body lands again with a new landedAt', () => {
    const now = Math.floor(Date.now() / 1000);
    addGuardianDismiss(UID, '1:2:3:1', 4242, FUTURE, now);
    // A fresh landing → different landedAt → not suppressed.
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1', landedAt: 9999 })]);
    installGuardian({ universeId: UID });
    expect(lastBtn()).not.toBeNull();
  });
});

describe('installGuardian — reactivity', () => {
  it('re-reads the bare set on every eventbox refresh', () => {
    installGuardian({ universeId: UID });
    expect(lastBtn()).toBeNull();

    // A fleet lands; the next eventbox load surfaces the button.
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    document.dispatchEvent(new CustomEvent(EVENT_BOX_LOADED_EVENT));
    expect(lastBtn()).not.toBeNull();
  });

  it('mounts / unmounts as the FAB is toggled in settings', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    installGuardian({ universeId: UID });
    expect(lastBtn()).toBeNull();

    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    expect(lastBtn()).not.toBeNull();

    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    expect(lastBtn().dispose).toHaveBeenCalled();
  });

  it('live-resizes the mounted button when fabBtnSize changes', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    installGuardian({ universeId: UID });
    settingsStore.set({ ...settingsStore.get(), fabBtnSize: 96 });
    expect(lastBtn().resize).toHaveBeenCalledWith(96);
  });
});

describe('installGuardian — teardown', () => {
  it('dispose() tears down the button, the eventbox listener and the settings sub', () => {
    readLandedFs.mockReturnValue([landed({ bodyKey: '1:2:3:1' })]);
    const dispose = installGuardian({ universeId: UID });
    const btn = lastBtn();
    dispose();

    expect(btn.dispose).toHaveBeenCalled();

    // Listener gone: a later eventbox event must not rebuild a button.
    buttonMock.last.value = null;
    document.dispatchEvent(new CustomEvent(EVENT_BOX_LOADED_EVENT));
    expect(lastBtn()).toBeNull();

    // Settings sub gone: a toggle must not rebuild a button either.
    settingsStore.set({ ...settingsStore.get(), fabMode: false });
    settingsStore.set({ ...settingsStore.get(), fabMode: true });
    expect(lastBtn()).toBeNull();
  });
});
