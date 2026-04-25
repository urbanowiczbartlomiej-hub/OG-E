// @vitest-environment happy-dom
//
// Unit tests for the expedition-badge feature.
//
// The module reads two scopes of DOM:
//   - `#eventContent` rows of the form
//       `tr.eventFleet[data-mission-type="15"][data-return-flight="true"]`
//     with `.originFleet`, `.coordsOrigin`, `.detailsFleet span` cells,
//   - `#planetList .smallplanet` entries with an inner `a.planetlink`
//     containing `.planet-name`, `.planet-koords`, and a
//     `.planetBarSpaceObjectContainer` host for the dot cluster.
//
// Tests use happy-dom, a shared `setupGameDOM` helper to paint a
// canonical game scene, and reset both the settings store and the
// module-scope `installed` sentinel between cases via
// `_resetBadgesForTest`. The MutationObserver-driven cases use fake
// timers to advance the debounce window deterministically — happy-dom
// fires MutationObserver callbacks on a microtask queue, so
// `await Promise.resolve()` (chained via `vi.advanceTimersByTimeAsync`)
// lets the observer flush before we check the debounced render.
//
// @ts-check

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installBadges, _resetBadgesForTest } from '../../src/features/badges.js';
import { settingsStore, SETTINGS_SCHEMA } from '../../src/state/settings.js';

/**
 * @typedef {object} ExpeditionFixture
 * @property {string}  coords    Origin coords text, e.g. `'1:2:3'`.
 * @property {string}  name      Origin fleet name text.
 * @property {number}  ships     Number rendered in `.detailsFleet span`.
 * @property {boolean} returning Whether `data-return-flight` is `true`.
 * @property {string}  [missionType] Override for `data-mission-type`
 *   (default `'15'`; used by the non-expedition test).
 */

/**
 * @typedef {object} PlanetFixture
 * @property {number} cp      Planet id — becomes element id `planet-${cp}`.
 * @property {string} name    Rendered `.planet-name` text.
 * @property {string} coords  Rendered `.planet-koords` text.
 */

/**
 * Paint the document to look like an in-game page with
 * `#planetList` + `#eventContent`. Each argument maps to one row in
 * the corresponding container. Defaults are empty arrays so every
 * test is explicit about what it expects to be there.
 *
 * @param {{ expeditions?: ExpeditionFixture[], planets?: PlanetFixture[] }} [opts]
 * @returns {void}
 */
const setupGameDOM = ({ expeditions = [], planets = [] } = {}) => {
  const eventRows = expeditions
    .map(
      (e) => `
    <tr class="eventFleet" data-mission-type="${e.missionType ?? '15'}" data-return-flight="${e.returning ? 'true' : 'false'}">
      <td class="originFleet">${e.name}</td>
      <td class="coordsOrigin">${e.coords}</td>
      <td class="detailsFleet"><span>${e.ships}</span></td>
    </tr>
  `,
    )
    .join('');
  const planetRows = planets
    .map(
      (p) => `
    <div class="smallplanet" id="planet-${p.cp}">
      <a class="planetlink">
        <span class="planet-name">${p.name}</span>
        <span class="planet-koords">${p.coords}</span>
        <span class="planetBarSpaceObjectContainer"></span>
      </a>
    </div>
  `,
    )
    .join('');

  document.body.innerHTML = `
    <div id="planetList">${planetRows}</div>
    <div id="eventContent"><table><tbody>${eventRows}</tbody></table></div>
  `;
};

/**
 * Count the number of `.ogi-exp-dot` children inside the
 * `.ogi-exp-dots` cluster of a given planet. Returns 0 when the
 * planet has no cluster yet (the common "not matched" state).
 *
 * @param {number} cp
 * @returns {number}
 */
const dotsOn = (cp) => {
  const planet = document.getElementById(`planet-${cp}`);
  if (!planet) return 0;
  const cluster = planet.querySelector('.ogi-exp-dots');
  if (!cluster) return 0;
  return cluster.querySelectorAll('.ogi-exp-dot').length;
};

/**
 * Reset the settings store to schema defaults (rather than leaving
 * whatever the previous test left behind). Mirrors the pattern used
 * by `test/state/settings.test.js`.
 *
 * @returns {void}
 */
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
  resetSettingsToDefaults();
});

afterEach(() => {
  _resetBadgesForTest();
  document.body.innerHTML = '';
  resetSettingsToDefaults();
});

// ──────────────────────────────────────────────────────────────────
// CSS injection
// ──────────────────────────────────────────────────────────────────

describe('installBadges — style injection', () => {
  it('injects the badge CSS with id oge-badges-style on install', () => {
    setupGameDOM();
    installBadges();

    const styleEl = document.getElementById('oge-badges-style');
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain('.ogi-exp-dots');
    expect(styleEl?.textContent).toContain('.ogi-exp-dot');
    // Sanity: the colour and positioning rules from the brief are there.
    expect(styleEl?.textContent).toContain('rgba(0, 255, 0, 0.9)');
    expect(styleEl?.textContent).toContain('position: absolute');
  });
});

// ──────────────────────────────────────────────────────────────────
// Render gating
// ──────────────────────────────────────────────────────────────────

describe('installBadges — render gating', () => {
  it('renders no dots when there are no expeditions', () => {
    setupGameDOM({
      expeditions: [],
      planets: [{ cp: 1, name: 'Alpha', coords: '[1:1:1]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(0);
  });

  it('renders one dot when a single returning expedition matches a planet by coords', () => {
    setupGameDOM({
      expeditions: [
        { coords: '1:2:3', name: 'Attacker', ships: 100, returning: true },
      ],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(1);
    expect(dotsOn(1)).toBe(1);
  });

  it('stacks dots when the same origin has multiple returning expeditions', () => {
    setupGameDOM({
      expeditions: [
        { coords: '1:2:3', name: 'Alpha', ships: 100, returning: true },
        { coords: '1:2:3', name: 'Alpha', ships: 200, returning: true },
        { coords: '1:2:3', name: 'Alpha', ships: 300, returning: true },
      ],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    // Exactly one cluster, with three dots inside it.
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(1);
    expect(dotsOn(1)).toBe(3);
  });

  it('renders dots on every matching planet independently', () => {
    setupGameDOM({
      expeditions: [
        { coords: '1:2:3', name: 'A', ships: 10, returning: true },
        { coords: '4:5:6', name: 'B', ships: 20, returning: true },
        { coords: '4:5:6', name: 'B', ships: 30, returning: true },
      ],
      planets: [
        { cp: 1, name: 'Home', coords: '[1:2:3]' },
        { cp: 2, name: 'Away', coords: '[4:5:6]' },
        // Planet 3 has no matching expedition — must stay bare.
        { cp: 3, name: 'Lonely', coords: '[7:8:9]' },
      ],
    });
    installBadges();

    expect(dotsOn(1)).toBe(1);
    expect(dotsOn(2)).toBe(2);
    expect(dotsOn(3)).toBe(0);
  });

  it('skips expedition rows whose data-return-flight is false', () => {
    setupGameDOM({
      expeditions: [
        { coords: '1:2:3', name: 'Outbound', ships: 100, returning: false },
      ],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(0);
  });

  it('skips non-expedition mission types even when returning', () => {
    // mission=15 is expedition; anything else (e.g. 3 = transport) must
    // be ignored regardless of the return-flight flag.
    setupGameDOM({
      expeditions: [
        {
          coords: '1:2:3',
          name: 'Cargo',
          ships: 100,
          returning: true,
          missionType: '3',
        },
      ],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(0);
  });

  it('falls back to matching by fleet name when coords are missing', () => {
    // Empty coordsOrigin forces the grouping key to `name:<name>`, and
    // the planet's `.planet-name` must match for a dot to land. We use
    // `coords=''` here AND set the planet's `.planet-koords` to
    // something that would not match, to prove the name-path works.
    setupGameDOM({
      expeditions: [
        { coords: '', name: 'FleetA', ships: 100, returning: true },
      ],
      planets: [{ cp: 7, name: 'FleetA', coords: '[9:9:9]' }],
    });
    installBadges();

    expect(dotsOn(7)).toBe(1);
  });

  it('writes a tooltip summarising count and ships', () => {
    setupGameDOM({
      expeditions: [
        { coords: '1:2:3', name: 'X', ships: 100, returning: true },
        { coords: '1:2:3', name: 'X', ships: 200, returning: true },
      ],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    const cluster = document.querySelector('.ogi-exp-dots');
    expect(cluster).not.toBeNull();
    // 100 + 200 = 300; en-US locale writes it plain as "300" (no thousand sep).
    expect(cluster?.getAttribute('title')).toBe('Expeditions: 2 | Ships: 300');
  });
});

// ──────────────────────────────────────────────────────────────────
// Settings-driven visibility
// ──────────────────────────────────────────────────────────────────

describe('installBadges — visibility via settings', () => {
  it('injects a hide-CSS override when expeditionBadges starts disabled', () => {
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));
    setupGameDOM({
      expeditions: [{ coords: '1:2:3', name: 'A', ships: 100, returning: true }],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    const hideEl = document.getElementById('oge-badges-hide-style');
    expect(hideEl).not.toBeNull();
    expect(hideEl?.textContent).toContain('display: none');
    expect(hideEl?.textContent).toContain('.ogi-exp-dots');
  });

  it('hides dots when expeditionBadges toggles off after install', () => {
    setupGameDOM({
      expeditions: [{ coords: '1:2:3', name: 'A', ships: 100, returning: true }],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    // Dots are there initially.
    expect(dotsOn(1)).toBe(1);
    expect(document.getElementById('oge-badges-hide-style')).toBeNull();

    // Toggle off — hide CSS must appear.
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));

    expect(document.getElementById('oge-badges-hide-style')).not.toBeNull();
    // The dots are still in the DOM (CSS-hidden, not removed) — the
    // feature keeps them so toggling back on is instant. We assert the
    // node is still present via querySelector rather than getting
    // computed style from happy-dom, which is unreliable for `!important`.
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(1);
  });

  it('shows dots again when expeditionBadges toggles back on', () => {
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));
    setupGameDOM({
      expeditions: [{ coords: '1:2:3', name: 'A', ships: 100, returning: true }],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();

    // Starting state: hidden, no dots rendered yet.
    expect(document.getElementById('oge-badges-hide-style')).not.toBeNull();
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(0);

    // Toggle on — hide CSS removed, dots rendered from current DOM.
    settingsStore.update((s) => ({ ...s, expeditionBadges: true }));

    expect(document.getElementById('oge-badges-hide-style')).toBeNull();
    expect(dotsOn(1)).toBe(1);
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

  it('re-renders dots when a new expedition row appears in #eventContent', async () => {
    setupGameDOM({
      expeditions: [],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();
    expect(dotsOn(1)).toBe(0);

    // Inject a new expedition row into the already-observed
    // #eventContent. The observer should fire, the 200ms debounce
    // should elapse, and the render should pick up the new fleet.
    const tbody = document.querySelector('#eventContent tbody');
    expect(tbody).not.toBeNull();
    const row = document.createElement('tr');
    row.className = 'eventFleet';
    row.setAttribute('data-mission-type', '15');
    row.setAttribute('data-return-flight', 'true');
    row.innerHTML = `
      <td class="originFleet">Incoming</td>
      <td class="coordsOrigin">1:2:3</td>
      <td class="detailsFleet"><span>150</span></td>
    `;
    tbody?.appendChild(row);

    // Happy-dom delivers MutationObserver callbacks on a microtask;
    // advancing the debounce timer past 200ms also flushes pending
    // microtasks, which is what we want.
    await vi.advanceTimersByTimeAsync(250);

    expect(dotsOn(1)).toBe(1);
  });

  it('removes dots when the corresponding expedition row is deleted', async () => {
    setupGameDOM({
      expeditions: [{ coords: '1:2:3', name: 'A', ships: 100, returning: true }],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    installBadges();
    expect(dotsOn(1)).toBe(1);

    // Drop the expedition row — the observer must notice and re-render
    // with an empty expedition map, which (per `renderBadges`) calls
    // clearBadges and then no-ops because the map is size 0.
    const row = document.querySelector('#eventContent tr.eventFleet');
    row?.remove();

    await vi.advanceTimersByTimeAsync(250);

    expect(dotsOn(1)).toBe(0);
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose
// ──────────────────────────────────────────────────────────────────

describe('installBadges — dispose', () => {
  it('dispose removes all dots and style nodes', () => {
    setupGameDOM({
      expeditions: [{ coords: '1:2:3', name: 'A', ships: 100, returning: true }],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });
    const dispose = installBadges();

    // Sanity: dots and main style are there.
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(1);
    expect(document.getElementById('oge-badges-style')).not.toBeNull();

    dispose();

    // After dispose: no dots, no style nodes owned by the feature.
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(0);
    expect(document.getElementById('oge-badges-style')).toBeNull();
    expect(document.getElementById('oge-badges-hide-style')).toBeNull();
  });

  it('dispose also removes the hide-style when it was installed', () => {
    settingsStore.update((s) => ({ ...s, expeditionBadges: false }));
    setupGameDOM();
    const dispose = installBadges();

    expect(document.getElementById('oge-badges-hide-style')).not.toBeNull();
    dispose();
    expect(document.getElementById('oge-badges-hide-style')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Idempotency
// ──────────────────────────────────────────────────────────────────

describe('installBadges — idempotency', () => {
  it('a second install returns the same dispose handle without duplicating state', () => {
    setupGameDOM({
      expeditions: [{ coords: '1:2:3', name: 'A', ships: 100, returning: true }],
      planets: [{ cp: 1, name: 'Home', coords: '[1:2:3]' }],
    });

    const dispose1 = installBadges();
    expect(dotsOn(1)).toBe(1);

    const dispose2 = installBadges();
    const dispose3 = installBadges();

    // Same handle every time.
    expect(dispose2).toBe(dispose1);
    expect(dispose3).toBe(dispose1);

    // Still exactly one cluster / one dot — no duplicate render.
    expect(document.querySelectorAll('.ogi-exp-dots').length).toBe(1);
    expect(dotsOn(1)).toBe(1);

    // Still exactly one style node — injectStyle is idempotent by id.
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

  it('does not feedback-loop on its own DOM mutations (regression for "DOM skacze")', async () => {
    setupGameDOM({
      expeditions: [
        { coords: '1:2:3', name: 'P1', ships: 1, returning: true },
      ],
      planets: [{ cp: 1, name: 'P1', coords: '[1:2:3]' }],
    });
    installBadges();

    // Install-time render produces 1 cluster — capture its identity.
    const initial = document.querySelector('.ogi-exp-dots');
    expect(initial).not.toBeNull();

    // Trigger ONE external mutation to wake the observer up. The new
    // planet has no matching expedition, so render output is unchanged
    // (still exactly one cluster on planet-1); we're testing whether
    // the observer-driven render STAYS quiescent or feedback-loops on
    // its own clearBadges + appendChild mutations.
    const planetList = /** @type {HTMLElement} */ (
      document.getElementById('planetList')
    );
    const newRow = document.createElement('div');
    newRow.className = 'smallplanet';
    newRow.id = 'planet-2';
    newRow.innerHTML =
      '<a class="planetlink"><span class="planet-name">P2</span>' +
      '<span class="planet-koords">[4:5:6]</span>' +
      '<span class="planetBarSpaceObjectContainer"></span></a>';
    planetList.appendChild(newRow);

    // Settle the debounced render triggered by the external mutation
    // (200 ms debounce + microtask flush).
    await vi.advanceTimersByTimeAsync(300);

    // Snapshot the cluster element AFTER that one render pass.
    const afterFirstRender = document.querySelector('.ogi-exp-dots');
    expect(afterFirstRender).not.toBeNull();

    // Advance another 1500 ms — well past 7 more 200 ms debounce
    // windows but short of the 3 s safety-poll. Without the loop fix,
    // the renderBadges in the previous step would have fired the
    // observer (clear + append on `.ogi-exp-dots`), which would have
    // scheduled another render, which would fire the observer again,
    // etc. Each loop iteration creates a fresh cluster element via
    // `clearBadges` + `container.appendChild`, so the identity captured
    // at `afterFirstRender` would NOT be the current cluster anymore.
    // With the fix (observer paused around our own renders), no further
    // renders happen and the cluster identity is preserved.
    await vi.advanceTimersByTimeAsync(1500);

    const afterQuiescence = document.querySelector('.ogi-exp-dots');
    expect(afterQuiescence).toBe(afterFirstRender);
  });
});
