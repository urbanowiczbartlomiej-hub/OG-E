// @ts-check

// Dashboard "Daily Transport" tab — a CLICKABLE editor for the daily-transport
// micro-fleet routes, per selected universe. Sources and OWN-body targets are
// picked from the player's own planets/moons (captured in-game into the
// per-universe `<universeId>:oge_bodies` snapshot by `features/planetBarCapture`),
// so a coordinate can never be mistyped; EXTERNAL targets are typed by hand via
// the inline custom-coords form. The same per-universe
// `<universeId>:oge_dailyRunRoutes` key the in-game dailyRun feature consumes is
// read/written here; the in-game-set collect target is preserved on save.
//
// A route = one or more SOURCE bodies (planets and/or moons) sharing one
// ordered TARGET list, a FLEET (one or more ship+count entries, all selected
// together) and a MISSION. A route can be paused (Enabled toggle) without
// deleting it. Own-body endpoints missing from the captured inventory are
// flagged ⚠ "stale" and removable in one click; custom targets are never
// stale (and the in-game reconcile never prunes them).
//
// Installed like the alarmClock tab: the host passes a `getUniverseId` getter
// and calls the returned `refresh()` whenever the selected universe changes.
//
// @see ../../domain/dailyRunRoutes.js — Route shape + store normalisation.
// @see ../../domain/bodies.js — Body shape + sort.
// @see ../../state/bodies.js / ../../state/dailyRunRoutes.js — per-universe keys.

import { chromeStore } from '../../lib/storage.js';
import { dailyRunRoutesKeyFor, dailyRunRoutesTsKeyFor } from '../../state/dailyRunRoutes.js';
import { bodiesKeyFor } from '../../state/bodies.js';
import { syncRequestKeyFor } from '../../sync/scheduler.js';
import {
  parseDailyRunRoutes,
  coordTypeKey,
} from '../../domain/dailyRunRoutes.js';
import { sortBodies } from '../../domain/bodies.js';
import { setToggleChip, wireToggleChip } from './chips.js';
import {
  TARGET_MOON,
  SHIP_CATALOG,
  SHIP_LARGE_CARGO,
  ROUTE_MISSION_CATALOG,
  MISSION_DEPLOYMENT,
  MISSION_TRANSPORT,
} from '../../domain/rules.js';

/** @typedef {import('../../domain/dailyRunRoutes.js').TargetCoord} TargetCoord */
/** @typedef {import('../../domain/dailyRunRoutes.js').Route} Route */
/** @typedef {import('../../domain/bodies.js').Body} Body */

/** Ship choices offered in the per-route fleet dropdown (from the shared catalog). */
const SHIP_OPTIONS = SHIP_CATALOG.map((s) => ({ id: s.id, label: `${s.name} (${s.id})` }));

/** Mission choices offered per route (from the shared catalog). */
const MISSION_OPTIONS = ROUTE_MISSION_CATALOG.map((m) => ({ id: m.id, label: m.name }));

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
  // Segmented chip groups (same .chip-group.seg pattern as the Spyglass Scan
  // chips) — `data-value` on the group is the value, `.on` marks the chip.
  const collectMissionChips = document.getElementById('routesCollectMission');
  const collectShipsChips = document.getElementById('routesCollectShips');
  const collectResourcesChips = document.getElementById('routesCollectResources');
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
   *   collectMission: number,
   *   collectShips: 'all' | 'most',
   *   collectResources: 'all' | 'most',
   *   bodies: Body[],
   *   bodyByKey: Map<string, Body>,
   *   hasInventory: boolean,
   * }}
   */
  let model = { routes: [], collectTarget: null, collectMission: MISSION_DEPLOYMENT, collectShips: 'most', collectResources: 'most', bodies: [], bodyByKey: new Map(), hasInventory: false };
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

  /**
   * Set a chip group's value: `data-value` + the `.on` marker on the matching
   * button (the shared .chip-group contract). Null group = markup absent — no-op.
   * @param {HTMLElement | null} group
   * @param {string} value
   */
  const setChipValue = (group, value) => {
    if (!group) return;
    group.dataset.value = value;
    for (const b of group.querySelectorAll('button')) {
      b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.value === value);
    }
  };

  /** Reflect {@link model}'s collect config onto the three Send-All chip groups. */
  const syncCollectChips = () => {
    setChipValue(collectMissionChips, String(model.collectMission));
    setChipValue(collectShipsChips, model.collectShips);
    setChipValue(collectResourcesChips, model.collectResources);
  };

  /**
   * Persist a patch to the collect ("Send All") config for the selected
   * universe. Independent of the route-card Save: it writes IMMEDIATELY — a
   * read-modify-write that preserves the persisted `routes` + `collectTarget`
   * and overlays `patch` onto the collect fields — then stamps the sync clock
   * + request exactly like {@link save}, so the change rides the same
   * per-universe newest-wins sync. No-op when no universe is selected.
   *
   * @param {Partial<{ collectMission: number, collectShips: 'all' | 'most', collectResources: 'all' | 'most' }>} patch
   * @returns {Promise<void>}
   */
  const writeCollectConfig = async (patch) => {
    const uni = getUniverseId();
    if (!uni) return;
    const stored = await chromeStore.get(dailyRunRoutesKeyFor(uni));
    const { routes, collectTarget, collectMission, collectShips, collectResources } = parseDailyRunRoutes(stored);
    await chromeStore.set(dailyRunRoutesKeyFor(uni), {
      routes, collectTarget, collectMission, collectShips, collectResources, ...patch,
    });
    await chromeStore.set(dailyRunRoutesTsKeyFor(uni), Date.now());
    await chromeStore.set(syncRequestKeyFor(uni), Date.now());
  };

  /** @param {TargetCoord} coord @returns {boolean} True if an OWN-body coord
   *  has no captured match. Custom (external) coords are never stale. */
  const isStale = (coord) => !coord.custom && model.hasInventory && !model.bodyByKey.has(coordTypeKey(coord));

  /** @param {TargetCoord} coord @returns {string} Human label for a chip. */
  const labelForCoord = (coord) => {
    const icon = isMoon(coord) ? '🌙' : '🪐';
    // Custom (external) coords have no inventory name — show just icon + coords.
    if (coord.custom) return `${icon} [${short(coord)}]`;
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
    // ≥36px touch hit-box (coarse pointers only) — the ✕ is the chip's only
    // control, so the pad's bleed is harmless.
    x.className = 'hit-pad';
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
    // Padding-grown hit box (~24px) with negative vertical margins so the
    // chip row keeps its height. NOT the 36px .hit-pad — ▲/▼/× sit directly
    // beside each other and full pads would swallow their neighbours.
    const b = /** @type {HTMLButtonElement} */ (
      mk('button', 'background:none;border:none;color:#9bd;cursor:pointer;font-size:12px;line-height:1;padding:6px;margin:-6px 0;', glyph)
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

  /**
   * A compact inline form for adding an EXTERNAL (custom) target — a
   * coordinate that isn't one of the player's own bodies (an ally hub, a
   * deep-space slot, …). Three g/s/p number inputs, a planet/moon select and
   * an Add button; on Add it validates the coords are positive and calls
   * `onAdd` with a `custom`-flagged {@link TargetCoord}.
   *
   * @param {(coord: TargetCoord) => void} onAdd
   * @returns {HTMLElement}
   */
  const customForm = (onAdd) => {
    const wrap = mk(
      'span',
      'display:inline-flex;align-items:center;gap:4px;margin:3px;padding:4px 8px;border-radius:14px;background:#1a2433;border:1px dashed #3a5a7a;',
    );
    /** @param {string} ph @param {number} w @returns {HTMLInputElement} */
    const numInput = (ph, w) => {
      const i = /** @type {HTMLInputElement} */ (
        mk('input', `width:${w}px;background:#0d1620;color:#cfe;border:1px solid #244;border-radius:5px;padding:3px 4px;font-size:12px;text-align:center;`)
      );
      i.type = 'number';
      i.min = '1';
      i.placeholder = ph;
      return i;
    };
    const g = numInput('G', 30);
    const s = numInput('S', 40);
    const p = numInput('P', 30);
    const colon = () => mk('span', 'color:#667;font-size:12px;', ':');
    wrap.appendChild(g);
    wrap.appendChild(colon());
    wrap.appendChild(s);
    wrap.appendChild(colon());
    wrap.appendChild(p);
    const typeSel = /** @type {HTMLSelectElement} */ (
      mk('select', 'background:#0d1620;color:#cfe;border:1px solid #244;border-radius:5px;padding:3px 4px;font-size:12px;')
    );
    for (const [val, lab] of [['1', '🪐 planet'], ['3', '🌙 moon']]) {
      const o = /** @type {HTMLOptionElement} */ (mk('option', '', lab));
      o.value = val;
      typeSel.appendChild(o);
    }
    wrap.appendChild(typeSel);
    const add = /** @type {HTMLButtonElement} */ (
      mk('button', 'background:#16252f;border:1px solid #2a4a5a;color:#9bd;border-radius:5px;padding:3px 8px;font-size:12px;cursor:pointer;', 'Add')
    );
    add.dataset.role = 'add-custom-target';
    add.addEventListener('click', () => {
      const gg = parseInt(g.value, 10);
      const ss = parseInt(s.value, 10);
      const pp = parseInt(p.value, 10);
      if (!(gg > 0) || !(ss > 0) || !(pp > 0)) return;
      onAdd({ galaxy: gg, system: ss, position: pp, type: parseInt(typeSel.value, 10), custom: true });
    });
    wrap.appendChild(add);
    return wrap;
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

    // A paused route stays in the editor but dims and is skipped in-game.
    const enabled = route.enabled !== false;
    if (!enabled) card.style.opacity = '0.6';

    // Header: title + enable toggle + remove route.
    const head = mk('div', 'display:flex;align-items:center;gap:10px;margin-bottom:8px;');
    head.appendChild(
      mk('strong', 'flex:1;color:#4a9eff;font-size:14px;', `Route ${idx + 1}${enabled ? '' : ' — paused'}`),
    );

    // Enable / pause toggle — the shared `.toggle-chip` pill (dashboard.html
    // CSS reaches inside #routesList; only `.controls button` doesn't).
    const toggle = /** @type {HTMLButtonElement} */ (mk('button', '', 'Enabled'));
    toggle.type = 'button';
    toggle.className = 'toggle-chip';
    toggle.dataset.role = 'enabled';
    setToggleChip(toggle, enabled);
    wireToggleChip(toggle, (on) => { route.enabled = on; render(); });
    head.appendChild(toggle);

    // Inline-styled (it lives inside #routesList, so the dashboard's
    // `.controls button` CSS doesn't reach it). Shares the danger palette
    // (#4a2a2a / #6a3a3a / #ff8888) used by the per-galaxy reset button.
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

    // Fleet — one or more ship types, all selected together for the send.
    card.appendChild(mk('div', 'color:#8aa;font-size:12px;margin:8px 0 4px;', 'Fleet (all ships selected together)'));
    const fleetWrap = mk('div', 'display:flex;flex-direction:column;gap:6px;align-items:flex-start;');
    const fleetIds = SHIP_OPTIONS.map((o) => o.id);
    route.fleet.forEach((f, j) => {
      const row = mk('div', 'display:flex;align-items:center;gap:8px;');
      const shipSel = /** @type {HTMLSelectElement} */ (
        mk('select', 'background:#0d1620;color:#cfe;border:1px solid #244;border-radius:6px;padding:4px 6px;font-size:12px;')
      );
      shipSel.dataset.role = 'ship';
      for (const o of SHIP_OPTIONS) {
        const opt = /** @type {HTMLOptionElement} */ (mk('option', '', o.label));
        opt.value = String(o.id);
        shipSel.appendChild(opt);
      }
      // Unknown raw id (e.g. synced from a newer build) → keep an option so it round-trips.
      if (!fleetIds.includes(f.shipId)) {
        const opt = /** @type {HTMLOptionElement} */ (mk('option', '', `Ship ${f.shipId}`));
        opt.value = String(f.shipId);
        shipSel.appendChild(opt);
      }
      shipSel.value = String(f.shipId);
      shipSel.addEventListener('change', () => { f.shipId = parseInt(shipSel.value, 10); updateSaveState(); });
      row.appendChild(shipSel);

      const countInput = /** @type {HTMLInputElement} */ (
        mk('input', 'width:110px;background:#0d1620;color:#cfe;border:1px solid #244;border-radius:6px;padding:4px 6px;font-size:12px;')
      );
      countInput.type = 'number';
      countInput.min = '1';
      countInput.value = String(f.count);
      countInput.addEventListener('input', () => {
        const n = parseInt(countInput.value, 10);
        f.count = Number.isFinite(n) && n > 0 ? n : 0;
        updateSaveState();
      });
      row.appendChild(countInput);
      row.appendChild(mk('span', 'color:#667;font-size:12px;', 'ships'));
      // A route must keep ≥1 ship — only offer removal when there's more than one.
      if (route.fleet.length > 1) {
        row.appendChild(iconBtn('×', `Remove ship ${f.shipId}`, () => { route.fleet.splice(j, 1); render(); }));
      }
      fleetWrap.appendChild(row);
    });
    const addShipBtn = /** @type {HTMLButtonElement} */ (
      mk('button', 'background:#16252f;border:1px solid #2a4a5a;color:#9bd;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;', '+ add ship')
    );
    addShipBtn.dataset.role = 'add-ship';
    addShipBtn.addEventListener('click', () => {
      const used = new Set(route.fleet.map((f) => f.shipId));
      const next = SHIP_OPTIONS.find((o) => !used.has(o.id)) || SHIP_OPTIONS[0];
      route.fleet.push({ shipId: next.id, count: 1 });
      render();
    });
    fleetWrap.appendChild(addShipBtn);
    card.appendChild(fleetWrap);

    // Mission. The game validates the mission against each target on send,
    // so an illegal combo surfaces in-game as "Bad target" rather than here.
    const missionWrap = mk('div', 'display:flex;align-items:center;gap:8px;margin:10px 0;');
    missionWrap.appendChild(mk('span', 'color:#8aa;font-size:12px;', 'Mission'));
    const missionSel = /** @type {HTMLSelectElement} */ (
      mk('select', 'background:#0d1620;color:#cfe;border:1px solid #244;border-radius:6px;padding:4px 6px;font-size:12px;')
    );
    missionSel.dataset.role = 'mission';
    const curMission = route.mission ?? MISSION_DEPLOYMENT;
    for (const o of MISSION_OPTIONS) {
      const opt = /** @type {HTMLOptionElement} */ (mk('option', '', o.label));
      opt.value = String(o.id);
      missionSel.appendChild(opt);
    }
    // Unknown mission id (e.g. synced from a newer build) → keep an option.
    if (!MISSION_OPTIONS.some((o) => o.id === curMission)) {
      const opt = /** @type {HTMLOptionElement} */ (mk('option', '', `Mission ${curMission}`));
      opt.value = String(curMission);
      missionSel.appendChild(opt);
    }
    missionSel.value = String(curMission);
    missionSel.addEventListener('change', () => { route.mission = parseInt(missionSel.value, 10); updateSaveState(); });
    missionWrap.appendChild(missionSel);
    card.appendChild(missionWrap);

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
    tgtWrap.appendChild(customForm((coord) => { route.targets.push(coord); render(); }));
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
      model = { routes: [], collectTarget: null, collectMission: MISSION_DEPLOYMENT, collectShips: 'most', collectResources: 'most', bodies: [], bodyByKey: new Map(), hasInventory: false };
      baseline = '[]';
      syncCollectChips();
      render();
      setStatus('');
      return;
    }
    const [storedRoutes, storedBodies] = await Promise.all([
      chromeStore.get(dailyRunRoutesKeyFor(uni)),
      chromeStore.get(bodiesKeyFor(uni)),
    ]);
    const { routes, collectTarget, collectMission, collectShips, collectResources } = parseDailyRunRoutes(storedRoutes);
    const bodies = Array.isArray(/** @type {any} */ (storedBodies)?.bodies)
      ? /** @type {Body[]} */ (/** @type {any} */ (storedBodies).bodies)
      : [];
    const bodyByKey = new Map(bodies.map((b) => [coordTypeKey(b), b]));
    model = { routes: clone(routes), collectTarget, collectMission, collectShips, collectResources, bodies, bodyByKey, hasInventory: bodies.length > 0 };
    baseline = JSON.stringify(model.routes);
    syncCollectChips();
    render();
    setStatus('');
  };

  const save = async () => {
    const uni = getUniverseId();
    if (!uni) { setStatus('No universe selected.', '#e66'); return; }
    // A route needs ≥1 source and ≥1 target to do anything in-game — drop
    // incomplete ones on save and tell the user how many.
    const clean = model.routes.filter(
      (r) => r.sources.length > 0 && r.targets.length > 0 && r.fleet.some((f) => f.count > 0),
    );
    const dropped = model.routes.length - clean.length;
    // Preserve the in-game-set collect target and the (separately-saved)
    // collect mission / ships / resources; we only own `routes` in this Save path.
    const stored = await chromeStore.get(dailyRunRoutesKeyFor(uni));
    const { collectTarget } = parseDailyRunRoutes(stored);
    await chromeStore.set(dailyRunRoutesKeyFor(uni), { routes: clean, collectTarget, collectMission: model.collectMission, collectShips: model.collectShips, collectResources: model.collectResources });
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
    model.routes.push({ sources: [], targets: [], fleet: [{ shipId: SHIP_LARGE_CARGO, count: 15000 }] });
    render();
  });
  saveBtn?.addEventListener('click', () => void save());

  // Send-All chips persist on the spot (no "Save routes" needed), mirroring
  // how the dashboard's shared-settings controls write on change.
  /**
   * Wire one chip group: a button click sets the group value + persists via
   * `apply`. Null group (markup absent) = no-op.
   * @param {HTMLElement | null} group
   * @param {(v: string) => void} apply
   */
  const wireCollectChips = (group, apply) => {
    if (!group) return;
    for (const b of group.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const v = /** @type {HTMLElement} */ (b).dataset.value;
        if (!v || group.dataset.value === v) return;
        setChipValue(group, v);
        apply(v);
      });
    }
  };
  wireCollectChips(collectMissionChips, (v) => {
    const mission = parseInt(v, 10);
    // Only the two missions this group offers are valid here.
    if (mission !== MISSION_DEPLOYMENT && mission !== MISSION_TRANSPORT) return;
    model.collectMission = mission;
    void writeCollectConfig({ collectMission: mission });
  });
  wireCollectChips(collectShipsChips, (v) => {
    const ships = v === 'all' ? 'all' : 'most';
    model.collectShips = ships;
    void writeCollectConfig({ collectShips: ships });
  });
  wireCollectChips(collectResourcesChips, (v) => {
    const res = v === 'all' ? 'all' : 'most';
    model.collectResources = res;
    void writeCollectConfig({ collectResources: res });
  });

  return { refresh: () => void refresh() };
};
