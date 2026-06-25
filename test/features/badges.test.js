// @vitest-environment happy-dom
//
// Unit tests for the planet status MARKERS feature (the DOM half,
// `src/features/badges/index.js`). The pure landing-classification core is
// covered separately in `test/features/badges/pure.test.js`.
//
// The module reads two scopes of game DOM:
//   - `#eventContent` rows `tr.eventFleet[id^="eventRow-"]` carrying
//     `data-mission-type` / `data-return-flight`, with `.coordsOrigin`,
//     `.destCoords`, `.originFleet`, `.destFleet`, `.detailsFleet` cells (and a
//     `figure.moon` inside the origin/dest body cell for a moon endpoint),
//   - `#planetList .smallplanet` entries with an inner `a.planetlink`
//     containing `.planet-koords` + a `.planetBarSpaceObjectContainer` host,
//     and optionally `a.moonlink` with its own container for the moon.
//
// It paints a `div.oge-mb-col` column of `span.oge-mb-dot oge-mb-<category>`
// markers into each body's `.planetBarSpaceObjectContainer`. Matching is by
// LANDING body identity `coords:type`, never by fleet name.
//
// The feature also reads an optimistic localStorage cache (`state/badgeCache`)
// and the FS id channel (`state/fleetSaveSet`), so we clear localStorage around
// every case to keep them hermetic.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installBadges, _resetBadgesForTest } from '../../src/features/badges/index.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';
import { galaxyScanConfigStore } from '../../src/state/galaxyScanConfig.js';
import { writeFleetSaveIds } from '../../src/state/fleetSaveSet.js';
import { EVENT_BOX_LOADED_EVENT } from '../../src/lib/ogeEvents.js';

/**
 * One event-list fleet leg fixture.
 *
 * @typedef {object} LegFixture
 * @property {number}  id           Row number → element id `eventRow-${id}`.
 * @property {string}  [mission]    `data-mission-type` (default `'15'`).
 * @property {boolean} [returning]  `data-return-flight` (default false).
 * @property {string}  origin       Origin coords text, e.g. `'1:2:3'`.
 * @property {string}  dest         Dest coords text, e.g. `'4:5:6'`.
 * @property {boolean} [originMoon] Origin body is a moon (figure.moon).
 * @property {boolean} [destMoon]   Dest body is a moon (figure.moon).
 * @property {number}  [ships]      `.detailsFleet` number (default 1).
 */

/**
 * One planet-bar body fixture (a planet, optionally with a moon).
 *
 * @typedef {object} BodyFixture
 * @property {number}  cp     Planet id → element id `planet-${cp}`.
 * @property {string}  coords Rendered `.planet-koords` text, e.g. `'[1:2:3]'`.
 * @property {boolean} [moon] Add a moon link with its own marker container.
 */

/** @param {boolean} isMoon @returns {string} */
const figure = (isMoon) => `<figure class="${isMoon ? 'planetIcon moon' : 'planetIcon planet'}"></figure>`;

/**
 * Paint the document like an in-game page with `#planetList` + `#eventContent`.
 *
 * @param {{ legs?: LegFixture[], bodies?: BodyFixture[] }} [opts]
 * @returns {void}
 */
const setupGameDOM = ({ legs = [], bodies = [] } = {}) => {
  const eventRows = legs
    .map(
      (l) => `
    <tr class="eventFleet" id="eventRow-${l.id}"
        data-mission-type="${l.mission ?? '15'}"
        data-return-flight="${l.returning ? 'true' : 'false'}">
      <td class="originFleet">${figure(Boolean(l.originMoon))}</td>
      <td class="coordsOrigin">${l.origin}</td>
      <td class="destFleet">${figure(Boolean(l.destMoon))}</td>
      <td class="destCoords">${l.dest}</td>
      <td class="detailsFleet"><span>${l.ships ?? 1}</span></td>
    </tr>`,
    )
    .join('');

  const planetRows = bodies
    .map(
      (b) => `
    <div class="smallplanet" id="planet-${b.cp}">
      <a class="planetlink">
        <span class="planet-koords">${b.coords}</span>
        <span class="planetBarSpaceObjectContainer"></span>
      </a>
      ${
        b.moon
          ? `<a class="moonlink"><span class="planetBarSpaceObjectContainer"></span></a>`
          : ''
      }
    </div>`,
    )
    .join('');

  document.body.innerHTML = `
    <div id="planetList">${planetRows}</div>
    <div id="eventContent"><table><tbody>${eventRows}</tbody></table></div>
  `;
};

/**
 * The marker column for a planet (`type` 1) or its moon (`type` 3).
 *
 * @param {number} cp
 * @param {1 | 3} [type]
 * @returns {Element | null}
 */
const colOf = (cp, type = 1) => {
  const planet = document.getElementById(`planet-${cp}`);
  if (!planet) return null;
  const link =
    type === 3 ? planet.querySelector('a.moonlink') : planet.querySelector('a.planetlink');
  return link?.querySelector('.oge-mb-col') ?? null;
};

/**
 * Marker category classes on a body's column, in DOM order.
 *
 * @param {number} cp
 * @param {1 | 3} [type]
 * @returns {string[]}
 */
const markersOn = (cp, type = 1) => {
  const col = colOf(cp, type);
  if (!col) return [];
  return [...col.querySelectorAll('.oge-mb-dot')].map((el) => {
    const cls = [...el.classList].find((c) => c.startsWith('oge-mb-') && c !== 'oge-mb-dot');
    return cls ? cls.replace('oge-mb-', '') : '';
  });
};

/** Reset the settings store to schema defaults. @returns {void} */
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

beforeEach(() => {
  _resetBadgesForTest();
  document.body.innerHTML = '';
  localStorage.clear();
  resetSettingsToDefaults();
});

afterEach(() => {
  _resetBadgesForTest();
  document.body.innerHTML = '';
  localStorage.clear();
  resetSettingsToDefaults();
});

// ──────────────────────────────────────────────────────────────────
// CSS injection
// ──────────────────────────────────────────────────────────────────

describe('installBadges — style injection', () => {
  it('injects the marker CSS with id oge-badges-style on install', () => {
    setupGameDOM();
    installBadges();

    const styleEl = document.getElementById('oge-badges-style');
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain('.oge-mb-col');
    expect(styleEl?.textContent).toContain('.oge-mb-dot');
    // Category + legend rules are present.
    expect(styleEl?.textContent).toContain('.oge-mb-threat');
    expect(styleEl?.textContent).toContain('.oge-mb-legend');
    // The "?" legend chip is mounted at the top of the planet list.
    expect(document.querySelector('.oge-mb-help')).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────

describe('installBadges — rendering', () => {
  it('renders no columns when no leg lands on any of my bodies', () => {
    setupGameDOM({
      // An expedition heading OUT to 7:8:9 (not mine); landing body foreign.
      legs: [{ id: 1, mission: '15', returning: false, origin: '1:2:3', dest: '7:8:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(0);
  });

  it('renders one marker for a returning expedition landing home', () => {
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '7:8:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(1);
    expect(markersOn(1)).toEqual(['explore']);
  });

  it('stacks several categories on one body in priority order', () => {
    // All my own returns landing home at 1:2:3: economy(8), explore(15),
    // logistics(3) — rendered in MARKER_ORDER (explore, logistics, economy).
    setupGameDOM({
      legs: [
        { id: 1, mission: '8', returning: true, origin: '1:2:3', dest: '4:4:4' },
        { id: 2, mission: '15', returning: true, origin: '1:2:3', dest: '5:5:5' },
        { id: 3, mission: '3', returning: true, origin: '1:2:3', dest: '6:6:6' },
      ],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(1);
    expect(markersOn(1)).toEqual(['explore', 'logistics', 'economy']);
  });

  it('renders markers on independent bodies', () => {
    setupGameDOM({
      legs: [
        { id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' },
        { id: 2, mission: '3', returning: true, origin: '4:5:6', dest: '9:9:9' },
      ],
      bodies: [
        { cp: 1, coords: '[1:2:3]' },
        { cp: 2, coords: '[4:5:6]' },
        { cp: 3, coords: '[7:8:9]' }, // no leg lands here → bare
      ],
    });
    installBadges();

    expect(markersOn(1)).toEqual(['explore']);
    expect(markersOn(2)).toEqual(['logistics']);
    expect(markersOn(3)).toEqual([]);
  });

  it('skips excluded missions (colonisation / discovery)', () => {
    setupGameDOM({
      legs: [
        { id: 1, mission: '7', returning: true, origin: '1:2:3', dest: '9:9:9' },
        { id: 2, mission: '18', returning: true, origin: '1:2:3', dest: '9:9:9' },
      ],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Threat (foreign aggressive arrival) vs own-fleet categories
// ──────────────────────────────────────────────────────────────────

describe('installBadges — threat vs own categories', () => {
  it('marks a foreign aggressive arrival at my body as threat', () => {
    // Outbound attack from a foreign 9:9:9 landing on my planet 1:2:3.
    setupGameDOM({
      legs: [{ id: 1, mission: '1', returning: false, origin: '9:9:9', dest: '1:2:3' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(markersOn(1)).toEqual(['threat']);
  });

  it('ignores a foreign non-aggressive arrival', () => {
    // A foreign transport (mission 3) arriving at my planet → no marker.
    setupGameDOM({
      legs: [{ id: 1, mission: '3', returning: false, origin: '9:9:9', dest: '1:2:3' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(0);
  });

  it("marks my own outgoing attack's return leg as aggro", () => {
    // My attack flying home (return leg) lands at my origin 1:2:3.
    setupGameDOM({
      legs: [{ id: 1, mission: '1', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(markersOn(1)).toEqual(['aggro']);
  });
});

// ──────────────────────────────────────────────────────────────────
// Moon column
// ──────────────────────────────────────────────────────────────────

describe('installBadges — moon body', () => {
  it('attaches the moon column with the moon modifier class to the moon link', () => {
    // My fleet lands on the MOON at 1:2:3 (dest figure.moon).
    setupGameDOM({
      legs: [
        { id: 1, mission: '15', returning: true, origin: '1:2:3', originMoon: true, dest: '9:9:9' },
      ],
      bodies: [{ cp: 1, coords: '[1:2:3]', moon: true }],
    });
    installBadges();

    // Marker on the MOON column, not the planet column.
    expect(markersOn(1, 3)).toEqual(['explore']);
    expect(markersOn(1, 1)).toEqual([]);
    const moonCol = colOf(1, 3);
    expect(moonCol?.classList.contains('oge-mb-col-moon')).toBe(true);
    // The planet column (if any) must NOT carry the moon modifier.
    const planetCol = colOf(1, 1);
    expect(planetCol).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Fleet-save (fs) category — end to end
// ──────────────────────────────────────────────────────────────────

describe('installBadges — fleet-save category', () => {
  it('marks a published FS row-id as fs when both gates are on', () => {
    settingsStore.update((s) => ({ ...s, alarmClockMasterEnabled: true }));
    galaxyScanConfigStore.update((c) => ({ ...c, fsEnabled: true }));
    writeFleetSaveIds(['eventRow-1']);

    // My logistics fleet flying home — would normally be 'logistics', but the
    // FS flag promotes it to 'fs'.
    setupGameDOM({
      legs: [{ id: 1, mission: '3', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(markersOn(1)).toEqual(['fs']);
  });

  it('does not mark fs when the per-universe gate is off', () => {
    settingsStore.update((s) => ({ ...s, alarmClockMasterEnabled: true }));
    galaxyScanConfigStore.update((c) => ({ ...c, fsEnabled: false }));
    writeFleetSaveIds(['eventRow-1']);

    setupGameDOM({
      legs: [{ id: 1, mission: '3', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    // Falls back to its base category.
    expect(markersOn(1)).toEqual(['logistics']);
  });
});

// ──────────────────────────────────────────────────────────────────
// Settings-driven visibility
// ──────────────────────────────────────────────────────────────────

describe('installBadges — visibility via settings', () => {
  it('injects a hide-CSS override when expeditionBadges starts disabled', () => {
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    const hideEl = document.getElementById('oge-badges-hide-style');
    expect(hideEl).not.toBeNull();
    // The override hides the marker columns (and the "?" legend chip alongside).
    expect(hideEl?.textContent).toContain('.oge-mb-col');
    expect(hideEl?.textContent).toContain('display:none!important;');
  });

  it('hides columns (CSS, not removal) when toggled off after install', () => {
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(markersOn(1)).toEqual(['explore']);
    expect(document.getElementById('oge-badges-hide-style')).toBeNull();

    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));

    expect(document.getElementById('oge-badges-hide-style')).not.toBeNull();
    // Column kept in the DOM (hidden via CSS), so toggling back on is instant.
    expect(document.querySelectorAll('.oge-mb-col').length).toBe(1);
  });

  it('shows columns again when toggled back on', () => {
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.getElementById('oge-badges-hide-style')).not.toBeNull();
    expect(document.querySelectorAll('.oge-mb-col').length).toBe(0);

    settingsStore.update((s) => ({ ...s, expeditionBadges: true }));

    expect(document.getElementById('oge-badges-hide-style')).toBeNull();
    expect(markersOn(1)).toEqual(['explore']);
  });
});

// ──────────────────────────────────────────────────────────────────
// MutationObserver-driven refresh
// ──────────────────────────────────────────────────────────────────

describe('installBadges — MutationObserver refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-renders when a new matching leg appears in #eventContent', async () => {
    setupGameDOM({
      // Start with one (non-matching) event row so the live render is
      // authoritative (event-box loaded) and nothing lands on planet 1 yet.
      legs: [{ id: 9, mission: '15', returning: false, origin: '1:2:3', dest: '7:8:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();
    expect(markersOn(1)).toEqual([]);

    const tbody = document.querySelector('#eventContent tbody');
    const row = document.createElement('tr');
    row.className = 'eventFleet';
    row.id = 'eventRow-1';
    row.setAttribute('data-mission-type', '15');
    row.setAttribute('data-return-flight', 'true');
    row.innerHTML = `
      <td class="originFleet">${figure(false)}</td>
      <td class="coordsOrigin">1:2:3</td>
      <td class="destFleet">${figure(false)}</td>
      <td class="destCoords">9:9:9</td>
      <td class="detailsFleet"><span>5</span></td>`;
    tbody?.appendChild(row);

    await vi.advanceTimersByTimeAsync(250);

    expect(markersOn(1)).toEqual(['explore']);
  });

  it('removes the column when the matching leg is deleted', async () => {
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();
    expect(markersOn(1)).toEqual(['explore']);

    // Remove the only leg, then signal the event box has (re)loaded so the
    // empty render is authoritative and clears the column.
    document.querySelector('#eventContent tr.eventFleet')?.remove();
    document.dispatchEvent(new CustomEvent(EVENT_BOX_LOADED_EVENT));

    await vi.advanceTimersByTimeAsync(250);

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose
// ──────────────────────────────────────────────────────────────────

describe('installBadges — dispose', () => {
  it('removes all columns, the legend chip, and style nodes', () => {
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    const dispose = installBadges();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(1);
    expect(document.getElementById('oge-badges-style')).not.toBeNull();
    expect(document.querySelector('.oge-mb-help')).not.toBeNull();

    dispose();

    expect(document.querySelectorAll('.oge-mb-col').length).toBe(0);
    expect(document.getElementById('oge-badges-style')).toBeNull();
    expect(document.getElementById('oge-badges-hide-style')).toBeNull();
    expect(document.querySelector('.oge-mb-help')).toBeNull();
  });

  it('also removes the hide-style when it was installed', () => {
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));
    setupGameDOM();
    const dispose = installBadges();

    expect(document.getElementById('oge-badges-hide-style')).not.toBeNull();
    dispose();
    expect(document.getElementById('oge-badges-hide-style')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Legend portal — the legend is a <body>-level singleton (NOT a child of
// the "?" chip) so its z-index escapes #planetList's stacking context and
// paints above OGame's left column. JS-driven show/hide replaces the old
// CSS :hover rule.
// ──────────────────────────────────────────────────────────────────

describe('installBadges — legend portal', () => {
  it('opens the legend on <body> (not inside the chip) on hover', () => {
    setupGameDOM();
    installBadges();
    const chip = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-help'));
    expect(chip).not.toBeNull();
    // Portaled: never a descendant of the chip, and not built until first shown.
    expect(chip.querySelector('.oge-mb-legend')).toBeNull();
    expect(document.querySelector('.oge-mb-legend')).toBeNull();

    chip.dispatchEvent(new Event('mouseenter'));

    const legend = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-legend'));
    expect(legend).not.toBeNull();
    expect(legend.parentElement).toBe(document.body); // root stacking context
    expect(legend.style.display).toBe('block');
  });

  it('hides the legend after the grace delay on mouseleave', () => {
    vi.useFakeTimers();
    setupGameDOM();
    installBadges();
    const chip = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-help'));
    chip.dispatchEvent(new Event('mouseenter'));
    const legend = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-legend'));
    expect(legend.style.display).toBe('block');

    chip.dispatchEvent(new Event('mouseleave'));
    expect(legend.style.display).toBe('block'); // still up during the grace window
    vi.advanceTimersByTime(200); // past the 160ms grace
    expect(legend.style.display).toBe('none');
    vi.useRealTimers();
  });

  it('removes the portaled legend from <body> on dispose', () => {
    setupGameDOM();
    const dispose = installBadges();
    const chip = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-help'));
    chip.dispatchEvent(new Event('mouseenter'));
    expect(document.querySelector('.oge-mb-legend')).not.toBeNull();

    dispose();
    expect(document.querySelector('.oge-mb-legend')).toBeNull();
  });

  it('resets a lingering legend when #planetList is rebuilt (AJAX swap)', async () => {
    vi.useFakeTimers();
    setupGameDOM();
    installBadges();
    const chip = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-help'));
    chip.dispatchEvent(new Event('mouseenter'));
    const legend = /** @type {HTMLElement} */ (document.querySelector('.oge-mb-legend'));
    expect(legend.style.display).toBe('block');

    // Simulate the swap: the chip is destroyed with the old list, leaving the
    // body-portaled legend detached. A re-render rebuilds the chip and, finding
    // none present, calls hideLegend().
    chip.remove();
    document.getElementById('planetList')?.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(250);

    expect(document.querySelector('.oge-mb-help')).not.toBeNull(); // chip rebuilt
    expect(legend.style.display).toBe('none'); // lingering legend reset
    vi.useRealTimers();
  });
});

// ──────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────

describe('installBadges — idempotency', () => {
  it('a second install returns the same dispose handle without duplicating state', () => {
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });

    const dispose1 = installBadges();
    expect(markersOn(1)).toEqual(['explore']);

    const dispose2 = installBadges();
    const dispose3 = installBadges();

    expect(dispose2).toBe(dispose1);
    expect(dispose3).toBe(dispose1);

    // Still exactly one column / one marker — no duplicate render.
    expect(document.querySelectorAll('.oge-mb-col').length).toBe(1);
    expect(markersOn(1)).toEqual(['explore']);
    expect(document.querySelectorAll('#oge-badges-style').length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// MutationObserver feedback-loop regression
// ──────────────────────────────────────────────────────────────────

describe('installBadges — observer feedback loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not feedback-loop on its own DOM mutations', async () => {
    setupGameDOM({
      legs: [{ id: 1, mission: '15', returning: true, origin: '1:2:3', dest: '9:9:9' }],
      bodies: [{ cp: 1, coords: '[1:2:3]' }],
    });
    installBadges();

    const initial = document.querySelector('.oge-mb-col');
    expect(initial).not.toBeNull();

    // Count how many fresh columns get appended into the host. A feedback loop
    // (our own clearColumns + appendChild firing the observer, scheduling a
    // render, firing the observer again) would re-append ~9× over the settle
    // window; with the observer correctly paused around our writes it settles
    // after the one render the external mutation legitimately triggers. We
    // assert on RATE, not node identity (happy-dom delivers records on a
    // microtask, so an occasional benign stray can slip the disconnect gap).
    const host = /** @type {HTMLElement} */ (
      /** @type {Element} */ (initial).parentElement
    );
    let appends = 0;
    const counter = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (
            node.nodeType === 1 &&
            /** @type {Element} */ (node).classList.contains('oge-mb-col')
          ) {
            appends += 1;
          }
        }
      }
    });
    counter.observe(host, { childList: true });

    // One external mutation that does NOT change the render output (a new
    // planet with no leg landing on it) to wake the observer.
    const planetList = /** @type {HTMLElement} */ (document.getElementById('planetList'));
    const newRow = document.createElement('div');
    newRow.className = 'smallplanet';
    newRow.id = 'planet-2';
    newRow.innerHTML =
      '<a class="planetlink"><span class="planet-koords">[4:5:6]</span>' +
      '<span class="planetBarSpaceObjectContainer"></span></a>';
    planetList.appendChild(newRow);

    // Settle past several 200ms debounce windows, short of the 3s safety poll.
    await vi.advanceTimersByTimeAsync(1800);
    counter.disconnect();

    expect(appends).toBeLessThan(4);
    expect(document.querySelectorAll('.oge-mb-col').length).toBe(1);
  });
});
