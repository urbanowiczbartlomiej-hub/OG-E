// @vitest-environment happy-dom
//
// Behavioral tests for the manual landed-FS mark chip
// (src/features/manualFsMark/index.js). The feature is DOM-bound: it injects an
// inline chip on the fleetdispatch screen, resolves the dispatching body to
// `g:s:p:type`, and on click toggles state/manualLandedFs AND dispatches the
// `oge:manualFsChanged` CustomEvent on `document`.
//
// We drive a real happy-dom page and assert the OBSERVABLE output — the stored
// mark and the dispatched event — never internals. Body resolution has two
// sources, both covered: the `ogame-planet-coordinates`/`-type` meta tags
// (primary) and the `cp` query param mapped onto the planet-list rows (fallback).
//
// The install uses a debounced MutationObserver (150 ms) but also calls `sync()`
// once synchronously, so the chip is present right after install with no wait.
//
// @ts-check

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installManualFsMark,
  _resetManualFsMarkForTest,
} from '../../src/features/manualFsMark/index.js';
import {
  MANUAL_LANDED_FS_KEY,
  readManualLandedFs,
  hasManualLandedFs,
} from '../../src/state/manualLandedFs.js';
import { MANUAL_FS_CHANGED_EVENT } from '../../src/lib/ogeEvents.js';

const CHIP_ID = 'oge-mfs-chip';

/** @returns {HTMLElement | null} */
const chip = () => /** @type {HTMLElement | null} */ (document.getElementById(CHIP_ID));

/**
 * Point `location.search` at the given scene. happy-dom lets us assign it
 * directly (same approach the sendExpedition suite uses).
 *
 * @param {string} search
 */
const setSearch = (search) => {
  location.search = search;
};

/**
 * Paint OGame's per-page coordinate meta tags (the PRIMARY body source).
 *
 * @param {{ coords: string, type: 'planet' | 'moon' }} opts
 */
const setMeta = ({ coords, type }) => {
  const c = document.createElement('meta');
  c.setAttribute('name', 'ogame-planet-coordinates');
  c.setAttribute('content', coords);
  document.head.appendChild(c);
  const t = document.createElement('meta');
  t.setAttribute('name', 'ogame-planet-type');
  t.setAttribute('content', type);
  document.head.appendChild(t);
};

/**
 * Paint a fleetdispatch form anchor (so the chip has somewhere to mount) plus,
 * optionally, a planet-list row for the cp fallback path.
 *
 * @param {{ planetRow?: { coords: string, planetCp?: string, moonCp?: string } }} [opts]
 */
const setForm = ({ planetRow } = {}) => {
  const list = planetRow
    ? `<div id="planetList">
         <div class="smallplanet" id="planet-${planetRow.planetCp ?? '1'}">
           <a class="planetlink"${planetRow.planetCp ? ` href="?cp=${planetRow.planetCp}"` : ''}>
             <span class="planet-koords">[${planetRow.coords}]</span>
           </a>
           ${planetRow.moonCp ? `<a class="moonlink" href="?cp=${planetRow.moonCp}"></a>` : ''}
         </div>
       </div>`
    : '';
  // `#fleet1` is the last-resort anchor in ANCHORS — always present here.
  document.body.innerHTML = `${list}<form id="fleet1"></form>`;
};

beforeEach(() => {
  _resetManualFsMarkForTest();
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  setSearch('?page=ingame&component=overview');
});

afterEach(() => {
  _resetManualFsMarkForTest();
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('installManualFsMark — visibility gating', () => {
  it('does not inject the chip off the fleetdispatch screen', () => {
    setMeta({ coords: '1:2:3', type: 'planet' });
    setForm();
    installManualFsMark();
    expect(chip()).toBeNull();
  });

  it('does not inject the chip when the body cannot be resolved (no meta, no cp)', () => {
    setSearch('?page=ingame&component=fleetdispatch'); // arrived via the Fleet menu
    setForm();
    installManualFsMark();
    expect(chip()).toBeNull();
  });

  it('injects the chip on fleetdispatch when the body resolves from meta tags', () => {
    setSearch('?page=ingame&component=fleetdispatch');
    setMeta({ coords: '1:2:3', type: 'planet' });
    setForm();
    installManualFsMark();
    expect(chip()).not.toBeNull();
    // Unmarked initially: no `.on`, "Mark FS" label.
    expect(chip()?.classList.contains('on')).toBe(false);
    expect(chip()?.querySelector('.lbl')?.textContent).toBe('Mark FS');
  });
});

describe('installManualFsMark — toggle writes state + fires the event', () => {
  beforeEach(() => {
    setSearch('?page=ingame&component=fleetdispatch');
    setMeta({ coords: '1:2:3', type: 'planet' });
    setForm();
  });

  it('clicking marks the planet body (g:s:p:1), stores it, and dispatches oge:manualFsChanged', () => {
    let events = 0;
    document.addEventListener(MANUAL_FS_CHANGED_EVENT, () => {
      events += 1;
    });
    installManualFsMark();

    chip()?.click();

    expect(events).toBe(1);
    expect(hasManualLandedFs('1:2:3:1')).toBe(true);
    const stored = readManualLandedFs();
    expect(stored).toHaveLength(1);
    expect(stored[0].bodyKey).toBe('1:2:3:1');
    expect(typeof stored[0].markedAt).toBe('number');
    // Chip reflects the marked state.
    expect(chip()?.classList.contains('on')).toBe(true);
    expect(chip()?.querySelector('.lbl')?.textContent).toBe('FS marked');
  });

  it('clicking again unmarks: clears storage, fires a second event, reverts the chip', () => {
    let events = 0;
    document.addEventListener(MANUAL_FS_CHANGED_EVENT, () => {
      events += 1;
    });
    installManualFsMark();

    chip()?.click(); // mark
    chip()?.click(); // unmark

    expect(events).toBe(2);
    expect(readManualLandedFs()).toEqual([]);
    expect(chip()?.classList.contains('on')).toBe(false);
    expect(chip()?.querySelector('.lbl')?.textContent).toBe('Mark FS');
  });

  it('reflects a pre-existing mark from storage on install (chip starts "on")', () => {
    localStorage.setItem(
      MANUAL_LANDED_FS_KEY,
      JSON.stringify([{ bodyKey: '1:2:3:1', markedAt: 123 }]),
    );
    installManualFsMark();
    expect(chip()?.classList.contains('on')).toBe(true);
    expect(chip()?.querySelector('.lbl')?.textContent).toBe('FS marked');
  });
});

describe('installManualFsMark — moon body via meta type', () => {
  it('marks the MOON body (g:s:p:3) when the planet-type meta says moon', () => {
    setSearch('?page=ingame&component=fleetdispatch');
    setMeta({ coords: '4:5:6', type: 'moon' });
    setForm();
    installManualFsMark();

    chip()?.click();

    expect(hasManualLandedFs('4:5:6:3')).toBe(true);
    expect(hasManualLandedFs('4:5:6:1')).toBe(false);
  });
});

describe('installManualFsMark — cp fallback (no meta tags)', () => {
  it('resolves the moon body from the cp param mapped onto the planet-list moonlink', () => {
    // No meta tags ⇒ falls back to cp. cp points at the MOON link of the row.
    setSearch('?page=ingame&component=fleetdispatch&cp=4002');
    setForm({ planetRow: { coords: '1:2:3', planetCp: '4001', moonCp: '4002' } });
    installManualFsMark();
    expect(chip()).not.toBeNull();

    chip()?.click();

    expect(hasManualLandedFs('1:2:3:3')).toBe(true); // moon (type 3)
    expect(hasManualLandedFs('1:2:3:1')).toBe(false);
  });

  it('resolves the planet body from the cp param mapped onto the planetlink', () => {
    setSearch('?page=ingame&component=fleetdispatch&cp=4001');
    setForm({ planetRow: { coords: '7:8:9', planetCp: '4001', moonCp: '4002' } });
    installManualFsMark();

    chip()?.click();

    expect(hasManualLandedFs('7:8:9:1')).toBe(true); // planet (type 1)
  });
});

describe('installManualFsMark — lifecycle', () => {
  it('is idempotent — a second install returns the same disposer and one chip', () => {
    setSearch('?page=ingame&component=fleetdispatch');
    setMeta({ coords: '1:2:3', type: 'planet' });
    setForm();
    const d1 = installManualFsMark();
    const d2 = installManualFsMark();
    expect(d1).toBe(d2);
    expect(document.querySelectorAll(`#${CHIP_ID}`)).toHaveLength(1);
  });

  it('dispose removes the chip', () => {
    setSearch('?page=ingame&component=fleetdispatch');
    setMeta({ coords: '1:2:3', type: 'planet' });
    setForm();
    const dispose = installManualFsMark();
    expect(chip()).not.toBeNull();
    dispose();
    expect(chip()).toBeNull();
  });
});
