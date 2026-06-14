// @ts-check

// Dashboard "Daily Transport" tab — a CLICKABLE editor for the daily-transport
// micro-fleet routes, per selected universe. Sources and targets are picked
// from the player's own planets/moons (captured in-game into the per-universe
// `<universeId>:oge_bodies` snapshot by `features/planetBarCapture`), so a
// coordinate can never be mistyped. The same per-universe
// `<universeId>:oge_dailyRunRoutes` key the in-game dailyRun feature consumes is
// read/written here; the in-game-set collect target is preserved on save.
//
// A route = one or more SOURCE bodies (planets and/or moons) sharing one
// ordered TARGET list and one micro-fleet (ship + count). Endpoints whose
// body is missing from the captured inventory are flagged ⚠ "stale" (only
// once an inventory actually exists) and can be removed in one click.
//
// The legacy text DSL lives on under a collapsed "Advanced" section for
// import/export and as the cross-device sync format — `Apply` parses it back
// into the cards.
//
// Installed like the reminders tab: the host passes a `getUniverseId` getter
// and calls the returned `refresh()` whenever the selected universe changes.
//
// @see ../../domain/dailyRunRoutes.js — Route shape, DSL parse/format, parse.
// @see ../../domain/bodies.js — Body shape + sort.
// @see ../../state/bodies.js / ../../state/dailyRunRoutes.js — per-universe keys.

import { chromeStore } from '../../lib/storage.js';
import { dailyRunRoutesKeyFor, dailyRunRoutesTsKeyFor } from '../../state/dailyRunRoutes.js';
import { bodiesKeyFor } from '../../state/bodies.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  parseRoutesDsl,
  formatRoutesDsl,
  parseDailyRunRoutes,
  coordTypeKey,
} from '../../domain/dailyRunRoutes.js';
import { sortBodies } from '../../domain/bodies.js';
import {
  TARGET_MOON,
  SHIP_SMALL_CARGO,
  SHIP_LARGE_CARGO,
  SHIP_PATHFINDER,
} from '../../domain/rules.js';

/** @typedef {import('../../domain/dailyRunRoutes.js').TargetCoord} TargetCoord */
/** @typedef {import('../../domain/dailyRunRoutes.js').Route} Route */
/** @typedef {import('../../domain/bodies.js').Body} Body */

/** Ship choices offered in the per-route fleet dropdown. */
const SHIP_OPTIONS = [
  { id: SHIP_SMALL_CARGO, label: 'Small cargo (202)' },
  { id: SHIP_LARGE_CARGO, label: 'Large cargo (203)' },
  { id: SHIP_PATHFINDER, label: 'Pathfinder (219)' },
];

// ── tiny DOM helpers ─────────────────────────────────────────────────────

/**
 * Make an element with inline CSS + optional text. Keeps the imperative
 * builder readable without a framework.
 *
 * @param {string} tag
 * @param {string} [css]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const mk = (tag, css, text) => {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (text != null) el.textContent = text;
  return el;
};

/** @param {TargetCoord} c @returns {string} `"g:s:p"`. */
const short = (c) => `${c.galaxy}:${c.system}:${c.position}`;
/** @param {TargetCoord} c @returns {boolean} */
const isMoon = (c) => c.type === TARGET_MOON;

// ── component ──────────────────────────────────────────────────────────────

/**
 * @param {{ getUniverseId: () => string }} opts
 * @returns {{ refresh: () => void }}
 */
export const installRoutes = ({ getUniverseId }) => {
  const list = document.getElementById('routesList');
  const invStatus = document.getElementById('routesInvStatus');
  const addBtn = document.getElementById('routesAddBtn');
  const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('routesSaveBtn'));
  const status = document.getElementById('routesStatus');
  const dsl = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('routesDsl'));
  const dslApply = document.getElementById('routesDslApply');
  const dslStatus = document.getElementById('routesDslStatus');
  // Defensive: if the markup is absent (older dashboard.html), no-op so a
  // missing tab never throws during boot.
  if (!list) return { refresh: () => {} };

  /**
   * In-memory editing model for the selected universe. `routes` is mutated
   * by the card controls and only persisted on Save. `bodyByKey` maps a
   * {@link coordTypeKey} to the captured {@link Body} for label/picker use.
   *
   * @type {{
   *   routes: Route[],
   *   collectTarget: TargetCoord | null,
   *   bodies: Body[],
   *   bodyByKey: Map<string, Body>,
   *   hasInventory: boolean,
   * }}
   */
  let model = { routes: [], collectTarget: null, bodies: [], bodyByKey: new Map(), hasInventory: false };
  /** Snapshot for Revert — the last loaded/saved routes (deep-cloned). */
  let baseline = '[]';

  /** @param {string} msg @param {string} [color] */
  const setStatus = (msg, color) => {
    if (status) {
      status.textContent = msg;
      status.style.color = color || '#888';
    }
  };

  /** @param {unknown} v @returns {any} */
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** @param {TargetCoord} coord @returns {boolean} True if no captured body matches. */
  const isStale = (coord) => model.hasInventory && !model.bodyByKey.has(coordTypeKey(coord));

  /** @param {TargetCoord} coord @returns {string} Human label for a chip. */
  const labelForCoord = (coord) => {
    const icon = isMoon(coord) ? '🌙' : '🪐';
    const b = model.bodyByKey.get(coordTypeKey(coord));
    return b ? `${icon} ${b.name} [${short(coord)}]` : `${icon} [${short(coord)}]`;
  };

  // ── chip + picker builders ───────────────────────────────────────────

  /**
   * A removable chip for one source/target endpoint.
   *
   * @param {TargetCoord} coord
   * @param {() => void} onRemove
   * @param {HTMLElement[]} [lead]  optional leading controls (e.g. up/down)
   * @returns {HTMLElement}
   */
  const chip = (coord, onRemove, lead = []) => {
    const stale = isStale(coord);
    const c = mk(
      'span',
      'display:inline-flex;align-items:center;gap:6px;margin:3px;padding:4px 8px;border-radius:14px;font-size:12px;' +
        (stale
          ? 'background:#3a1f1f;border:1px solid #a44;color:#f3b0b0;'
          : 'background:#16252f;border:1px solid #2a4a5a;color:#cfe;'),
    );
    for (const l of lead) c.appendChild(l);
    c.appendChild(mk('span', '', (stale ? '⚠ ' : '') + labelForCoord(coord)));
    const x = mk('button', 'background:none;border:none;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0;', '×');
    x.setAttribute('aria-label', `Remove ${short(coord)}`);
    x.addEventListener('click', onRemove);
    c.appendChild(x);
    return c;
  };

  /**
   * A small up/down/× control button.
   *
   * @param {string} glyph @param {string} aria @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  const iconBtn = (glyph, aria, onClick) => {
    const b = /** @type {HTMLButtonElement} */ (
      mk('button', 'background:none;border:none;color:#9bd;cursor:pointer;font-size:12px;line-height:1;padding:0 2px;', glyph)
    );
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  };

  /**
   * A "+ add …" picker `<select>` listing inventory bodies not already in
   * `chosen`. Picking one calls `onPick(coord)` and re-renders. Disabled
   * (with a hint) when there's nothing left to add.
   *
   * @param {TargetCoord[]} chosen
   * @param {(coord: TargetCoord) => void} onPick
   * @param {string} placeholder
   * @param {string} role  `data-role` for stable test/automation hooks.
   * @returns {HTMLElement}
   */
  const picker = (chosen, onPick, placeholder, role) => {
    const chosenKeys = new Set(chosen.map(coordTypeKey));
    const sel = /** @type {HTMLSelectElement} */ (
      mk('select', 'margin:3px;background:#0d1620;color:#cfe;border:1px solid #244;border-radius:6px;padding:4px 6px;font-size:12px;')
    );
    sel.dataset.role = role;
    const ph = /** @type {HTMLOptionElement} */ (mk('option', '', placeholder));
    ph.value = '';
    sel.appendChild(ph);
    const available = sortBodies(model.bodies).filter((b) => !chosenKeys.has(coordTypeKey(b)));
    for (const b of available) {
      const o = /** @type {HTMLOptionElement} */ (
        mk('option', '', `${isMoon(b) ? '🌙' : '🪐'} ${b.name} [${short(b)}]`)
      );
      o.value = coordTypeKey(b);
      sel.appendChild(o);
    }
    if (!model.hasInventory) {
      ph.textContent = 'No inventory yet — open the game';
      sel.disabled = true;
    } else if (available.length === 0) {
      ph.textContent = 'Nothing left to add';
      sel.disabled = true;
    }
    sel.addEventListener('change', () => {
      const b = model.bodyByKey.get(sel.value);
      if (b) onPick({ galaxy: b.galaxy, system: b.system, position: b.position, type: b.type });
    });
    return sel;
  };

  // ── route card ───────────────────────────────────────────────────────

  /**
   * @param {Route} route
   * @param {number} idx
   * @returns {HTMLElement}
   */
  const buildCard = (route, idx) => {
    const card = mk(
      'div',
      'background:#0f1a24;border:1px solid #233;border-radius:8px;padding:12px;margin-bottom:12px;',
    );

    // Header: title + remove route.
    const head = mk('div', 'display:flex;align-items:center;margin-bottom:8px;');
    head.appendChild(mk('strong', 'flex:1;color:#4a9eff;font-size:14px;', `Route ${idx + 1}`));
    // Inline-styled (it lives inside #routesList, so the dashboard's
    // `.controls button` CSS doesn't reach it). Danger palette matching
    // dashboard.html's `.controls button.danger`.
    const del = /** @type {HTMLButtonElement} */ (
      mk(
        'button',
        'background:#4a2a2a;border:1px solid #6a3a3a;color:#ff8888;padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;',
        'Remove route',
      )
    );
    del.addEventListener('click', () => { model.routes.splice(idx, 1); render(); });
    head.appendChild(del);
    card.appendChild(head);

    // Sources.
    card.appendChild(mk('div', 'color:#8aa;font-size:12px;margin:4px 0;', 'Sources (any of these fires the route)'));
    const srcWrap = mk('div', 'display:flex;flex-wrap:wrap;align-items:center;');
    route.sources.forEach((s, j) => {
      srcWrap.appendChild(chip(s, () => { route.sources.splice(j, 1); render(); }));
    });
    srcWrap.appendChild(picker(route.sources, (coord) => { route.sources.push(coord); render(); }, '+ add source', 'add-source'));
    card.appendChild(srcWrap);

    // Fleet.
    const fleetWrap = mk('div', 'display:flex;align-items:center;gap:8px;margin:10px 0;');
    fleetWrap.appendChild(mk('span', 'color:#8aa;font-size:12px;', 'Fleet'));
    const shipSel = /** @type {HTMLSelectElement} */ (
      mk('select', 'background:#0d1620;color:#cfe;border:1px solid #244;border-radius:6px;padding:4px 6px;font-size:12px;')
    );
    shipSel.dataset.role = 'ship';
    const ids = SHIP_OPTIONS.map((o) => o.id);
    for (const o of SHIP_OPTIONS) {
      const opt = /** @type {HTMLOptionElement} */ (mk('option', '', o.label));
      opt.value = String(o.id);
      shipSel.appendChild(opt);
    }
    // Unknown raw id → add an option so it round-trips.
    if (!ids.includes(route.microFleet.shipId)) {
      const opt = /** @type {HTMLOptionElement} */ (mk('option', '', `Ship ${route.microFleet.shipId}`));
      opt.value = String(route.microFleet.shipId);
      shipSel.appendChild(opt);
    }
    shipSel.value = String(route.microFleet.shipId);
    shipSel.addEventListener('change', () => { route.microFleet.shipId = parseInt(shipSel.value, 10); updateSaveState(); });
    fleetWrap.appendChild(shipSel);

    const countInput = /** @type {HTMLInputElement} */ (
      mk('input', 'width:110px;background:#0d1620;color:#cfe;border:1px solid #244;border-radius:6px;padding:4px 6px;font-size:12px;')
    );
    countInput.type = 'number';
    countInput.min = '1';
    countInput.value = String(route.microFleet.count);
    countInput.addEventListener('input', () => {
      const n = parseInt(countInput.value, 10);
      route.microFleet.count = Number.isFinite(n) && n > 0 ? n : 0;
      updateSaveState();
    });
    fleetWrap.appendChild(countInput);
    fleetWrap.appendChild(mk('span', 'color:#667;font-size:12px;', 'ships'));
    card.appendChild(fleetWrap);

    // Targets (ordered).
    card.appendChild(mk('div', 'color:#8aa;font-size:12px;margin:4px 0;', 'Targets (sent in this order)'));
    const tgtWrap = mk('div', 'display:flex;flex-wrap:wrap;align-items:center;');
    route.targets.forEach((t, j) => {
      const lead = [];
      if (j > 0) {
        lead.push(iconBtn('▲', `Move ${short(t)} up`, () => {
          [route.targets[j - 1], route.targets[j]] = [route.targets[j], route.targets[j - 1]];
          render();
        }));
      }
      if (j < route.targets.length - 1) {
        lead.push(iconBtn('▼', `Move ${short(t)} down`, () => {
          [route.targets[j + 1], route.targets[j]] = [route.targets[j], route.targets[j + 1]];
          render();
        }));
      }
      tgtWrap.appendChild(chip(t, () => { route.targets.splice(j, 1); render(); }, lead));
    });
    tgtWrap.appendChild(picker(route.targets, (coord) => { route.targets.push(coord); render(); }, '+ add target', 'add-target'));
    card.appendChild(tgtWrap);

    return card;
  };

  // ── render ─────────────────────────────────────────────────────────────

  const render = () => {
    // Inventory status line.
    if (invStatus) {
      if (!model.hasInventory) {
        invStatus.textContent =
          '⚠ No planet/moon inventory captured for this universe yet — open the game once so OG-E can read your planet bar, then come back.';
        invStatus.style.color = '#e6a23c';
      } else {
        const moons = model.bodies.filter(isMoon).length;
        const planets = model.bodies.length - moons;
        invStatus.textContent = `Inventory: ${planets} planet(s) + ${moons} moon(s) to pick from.`;
        invStatus.style.color = '#888';
      }
    }

    list.textContent = '';
    if (model.routes.length === 0) {
      list.appendChild(mk('p', 'color:#667;font-size:13px;', 'No routes yet — click “+ Add route”.'));
    } else {
      model.routes.forEach((r, i) => list.appendChild(buildCard(r, i)));
    }

    // Keep the Advanced DSL mirror in sync (export view).
    if (dsl) dsl.value = formatRoutesDsl(model.routes);
    if (dslStatus) dslStatus.textContent = '';

    updateSaveState();
  };

  /**
   * Reflect unsaved-changes state on the Save button: emphasised (accent +
   * trailing dot) when the in-memory routes differ from what was last
   * loaded/saved, muted + disabled when everything is already persisted.
   * There's no Revert — discarding is just a page refresh — so this dirty
   * cue is the one nudge not to forget to save.
   *
   * @returns {void}
   */
  const updateSaveState = () => {
    if (!saveBtn) return;
    const dirty = JSON.stringify(model.routes) !== baseline;
    saveBtn.disabled = !dirty;
    saveBtn.textContent = dirty ? 'Save routes •' : 'Save routes';
    saveBtn.style.opacity = dirty ? '1' : '0.55';
    saveBtn.style.cursor = dirty ? 'pointer' : 'default';
    // Empty string clears the inline override → falls back to the dashboard's
    // base `.controls button` style when clean.
    saveBtn.style.background = dirty ? '#2a5a2a' : '';
    saveBtn.style.borderColor = dirty ? '#3a8a3a' : '';
    saveBtn.style.color = dirty ? '#eaffea' : '';
    saveBtn.style.fontWeight = dirty ? 'bold' : '';
  };

  // ── load / save ──────────────────────────────────────────────────────

  const refresh = async () => {
    const uni = getUniverseId();
    if (!uni) {
      model = { routes: [], collectTarget: null, bodies: [], bodyByKey: new Map(), hasInventory: false };
      baseline = '[]';
      render();
      setStatus('');
      return;
    }
    const [storedRoutes, storedBodies] = await Promise.all([
      chromeStore.get(dailyRunRoutesKeyFor(uni)),
      chromeStore.get(bodiesKeyFor(uni)),
    ]);
    const { routes, collectTarget } = parseDailyRunRoutes(storedRoutes);
    const bodies = Array.isArray(/** @type {any} */ (storedBodies)?.bodies)
      ? /** @type {Body[]} */ (/** @type {any} */ (storedBodies).bodies)
      : [];
    const bodyByKey = new Map(bodies.map((b) => [coordTypeKey(b), b]));
    model = { routes: clone(routes), collectTarget, bodies, bodyByKey, hasInventory: bodies.length > 0 };
    baseline = JSON.stringify(model.routes);
    render();
    setStatus('');
  };

  const save = async () => {
    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected.', '#e66'); return; }
    // A route needs ≥1 source and ≥1 target to do anything in-game — drop
    // incomplete ones on save and tell the user how many.
    const clean = model.routes.filter((r) => r.sources.length > 0 && r.targets.length > 0);
    const dropped = model.routes.length - clean.length;
    // Preserve the in-game-set collect target; we only own `routes` here.
    const stored = await chromeStore.get(dailyRunRoutesKeyFor(uni));
    const { collectTarget } = parseDailyRunRoutes(stored);
    await chromeStore.set(dailyRunRoutesKeyFor(uni), { routes: clean, collectTarget });
    // Stamp the cross-device sync clock (whole-universe newest-wins) and poke
    // any open game tab to push the change to the gist (same tombstone the
    // "Sync now" button uses). Harmless no-op when cloud sync is off.
    await chromeStore.set(dailyRunRoutesTsKeyFor(uni), Date.now());
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());
    model.routes = clean;
    baseline = JSON.stringify(clean);
    render();
    setStatus(
      dropped > 0
        ? `Saved ${clean.length} route(s). ${dropped} incomplete route(s) dropped.`
        : `Saved ${clean.length} route(s).`,
      dropped > 0 ? '#e6a23c' : '#67c23a',
    );
  };

  addBtn?.addEventListener('click', () => {
    model.routes.push({ sources: [], targets: [], microFleet: { shipId: SHIP_LARGE_CARGO, count: 15000 } });
    render();
  });
  saveBtn?.addEventListener('click', () => void save());
  dslApply?.addEventListener('click', () => {
    if (!dsl) return;
    const { routes, errors } = parseRoutesDsl(dsl.value);
    model.routes = routes;
    render();
    if (dslStatus) {
      if (errors.length) {
        dslStatus.textContent = `Applied ${routes.length} route(s); ${errors.length} line(s) skipped (L${errors[0].line}: ${errors[0].message}).`;
        dslStatus.style.color = '#e6a23c';
      } else {
        dslStatus.textContent = `Applied ${routes.length} route(s) to the editor — press Save to persist.`;
        dslStatus.style.color = '#67c23a';
      }
    }
  });

  return { refresh: () => void refresh() };
};
