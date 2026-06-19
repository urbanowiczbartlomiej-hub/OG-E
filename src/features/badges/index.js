// Planet mission badges — render a column of mission-type icons to the LEFT
// of each `#planetList` body, replacing the old single green expedition dot.
//
// # What it shows
//
// One small icon per (mission type + direction) group on each planet/moon,
// drawn from OGame's own mission sprite so it reads native. A count bubble
// aggregates many fleets of the same kind; a direction marker distinguishes
// arriving (►) / departing (◄) / round-trip (↻); an incoming HOSTILE fleet
// gets a red ring. Click / tap a tile for the per-fleet detail (targets +
// ETA) — pointer-friendly on desktop and mobile alike.
//
// The classification (which body a fleet badges, and how its outbound+return
// legs collapse) is pure and lives in `./pure.js`. This module is the DOM
// half: it scans `#eventContent` + `#planetList`, paints the columns, and
// owns the observer / settings / popover lifecycle.
//
// # Why this is purely passive
//
// Every byte comes from DOM the game itself renders into `#eventContent` and
// `#planetList`. We never fire our own XHR/fetch — we mirror the game's own
// event ticker onto the planet list. No parallel request stream, no polling
// the server: just styling. That is what keeps OG-E on the right side of the
// TOS.
//
// # Expedition detection is untouched
//
// `collectActiveExpeditions` is carried over verbatim from the old badge
// feature (mission 15, return-flight, grouped by origin coords / fleet name).
// `pure.js` skips type 15 so we never double-count; the expedition group is
// merged back in here as a round-trip tile. The DETECTION did not change —
// only the rendering did.
//
// @see ./pure.js — the pure grouping/classification core.
// @see ../../state/settings.js — where `expeditionBadges` lives.

/** @ts-check */

import { settingsStore } from '../../state/settings.js';
import { injectStyle, waitFor } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { GAME } from '../../lib/gameDom.js';
import { groupTiles, sortTiles, bodyKey, MISSION_SPRITE_X, MISSION_LABEL } from './pure.js';

// ── OG-E-owned ids/classes (NOT a DOM contract — ours to rename freely) ──

const STYLE_ID = 'oge-badges-style';
const HIDE_STYLE_ID = 'oge-badges-hide-style';
/** The vertical icon column appended to each body's pic container. */
const COL_CLASS = 'oge-mb-col';
/** One mission tile inside a column. */
const TILE_CLASS = 'oge-mb-tile';
/** Aggregation count bubble. */
const CNT_CLASS = 'oge-mb-cnt';
/** Shared click/tap detail popover (one per page, parked on <body>). */
const POP_ID = 'oge-mb-pop';

/** Mission-type value OGame writes for expeditions (string — it's an attr). */
const MISSION_EXPEDITION = '15';

/**
 * The game's mission-icon sprite (the one AGR's `#ago_fleet2
 * .missionSelection .missionIcon` slices). FRAGILE external asset: the CDN
 * filename is content-hashed, so a game art update changes it and the icons
 * go blank until this one line is refreshed. Kept as a single named constant
 * for exactly that reason. We reference the game CDN rather than bundling the
 * image (no redistribution of game art).
 */
const SPRITE_URL = 'https://gf2.geo.gfsrv.net/cdn14/f45a18b5e55d2d38e7bdc3151b1fee.jpg';

/** Rendered tile edge in px. The sprite cell is 40px at `background-size:440px`. */
const TILE_PX = 22;
const SPRITE_SCALE = TILE_PX / 40;
/** Scaled sprite width (the game uses 440px for the 11-column strip). */
const SPRITE_BG = Math.round(440 * SPRITE_SCALE);
/** Y of the coloured, gold-bordered icon row (`-40px` at native scale). */
const SPRITE_ROW_Y = Math.round(-40 * SPRITE_SCALE);

const REFRESH_DEBOUNCE_MS = 200;

/**
 * Per-tile detail for the popover, attached weakly so re-renders (which
 * recreate the tile elements) don't leak. Keyed by the tile element.
 *
 * @type {WeakMap<Element, TileDetail>}
 */
const tileDetail = new WeakMap();

/**
 * @typedef {object} TileDetail
 * @property {string} title
 * @property {'rt'|'in'|'out'} kind
 * @property {boolean} hostile
 * @property {string} missionType
 * @property {number} count
 * @property {import('./pure.js').TileFleet[]} fleets
 * @property {string} [note] Standalone summary line (expedition tiles).
 */

// ── DOM read helpers (feature layer — pure.js stays DOM-free) ─────────────

/** @param {string | null | undefined} s @returns {string} */
const trim = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** @param {string | null | undefined} s @returns {string} dense `g:s:p`. */
const denseCoords = (s) => (s || '').replace(/[\s[\]]/g, '');

/** @param {string | null | undefined} text @returns {number} ships, or NaN. */
const shipCountOf = (text) => {
  const digits = (text || '').replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : NaN;
};

/**
 * Body type of an event-row origin/dest cell: a moon carries `figure.moon`,
 * everything else (planet / debris) is treated as planet — only OUR endpoints
 * need an accurate planet-vs-moon split, and ours are never debris.
 *
 * @param {Element | null} cell
 * @returns {number} 1 = planet, 3 = moon.
 */
const figureType = (cell) => {
  const fig = cell?.querySelector('figure');
  return fig && fig.classList.contains('moon') ? 3 : 1;
};

/**
 * Read every fleet leg out of `#eventContent` as plain {@link
 * import('./pure.js').BadgeLeg} data. Expedition rows are kept in the scan
 * but `groupTiles` skips them; the expedition tile comes from
 * {@link collectActiveExpeditions} instead.
 *
 * @returns {import('./pure.js').BadgeLeg[]}
 */
const scanLegs = () => {
  /** @type {import('./pure.js').BadgeLeg[]} */
  const legs = [];
  for (const row of document.querySelectorAll(GAME.EVENT_FLEET_ROWS)) {
    const missionType = row.getAttribute('data-mission-type') || '';
    if (!missionType) continue;
    const arrivalAttr = row.getAttribute('data-arrival-time');
    legs.push({
      id: /** @type {HTMLElement} */ (row).id || '',
      missionType,
      isReturn: row.getAttribute('data-return-flight') === 'true',
      isHostile: Boolean(row.querySelector('.hostile')),
      origin: {
        coords: denseCoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent),
        type: figureType(row.querySelector(GAME.ORIGIN_FLEET)),
      },
      dest: {
        coords: denseCoords(row.querySelector(GAME.COORDS_DEST)?.textContent),
        type: figureType(row.querySelector(GAME.DEST_FLEET)),
      },
      arrivalAt: arrivalAttr ? Number.parseInt(arrivalAttr, 10) : NaN,
      shipCount: shipCountOf(row.querySelector(GAME.DETAILS_FLEET)?.textContent),
    });
  }
  return legs;
};

/**
 * @typedef {object} OwnBody
 * @property {string} coords Dense `g:s:p`.
 * @property {number} type   1 = planet, 3 = moon.
 * @property {string} name   Display name (for the expedition name fallback).
 * @property {HTMLElement} container The body's `.planetBarSpaceObjectContainer`.
 */

/**
 * Walk `#planetList` and collect the player's bodies plus the DOM container
 * each badge column attaches to. A planet and its moon live in the same
 * `.smallplanet` row and share coords; the moon entry uses the moon link's
 * own pic container so a moon mission badges the moon, not the planet.
 *
 * @returns {OwnBody[]}
 */
const scanOwnBodies = () => {
  /** @type {OwnBody[]} */
  const bodies = [];
  for (const row of document.querySelectorAll(GAME.SMALL_PLANET)) {
    const planetLink = row.querySelector(`a${GAME.PLANET_LINK}`);
    if (!planetLink) continue;
    const coords = denseCoords(planetLink.querySelector(GAME.PLANET_KOORDS)?.textContent);
    if (!coords) continue;
    const planetContainer = planetLink.querySelector('.planetBarSpaceObjectContainer');
    if (planetContainer) {
      bodies.push({
        coords,
        type: 1,
        name: trim(planetLink.querySelector(GAME.PLANET_NAME)?.textContent),
        container: /** @type {HTMLElement} */ (planetContainer),
      });
    }
    const moonLink = row.querySelector(GAME.MOON_LINK);
    const moonContainer = moonLink?.querySelector('.planetBarSpaceObjectContainer');
    if (moonContainer) {
      bodies.push({
        coords,
        type: 3,
        name: trim(moonLink?.querySelector('img.icon-moon')?.getAttribute('alt')),
        container: /** @type {HTMLElement} */ (moonContainer),
      });
    }
  }
  return bodies;
};

/**
 * @typedef {object} ExpeditionInfo
 * @property {number} count
 * @property {number} ships
 * @property {string} name
 * @property {string} coords
 */

/**
 * Scan `#eventContent` for returning expedition fleets, grouped by origin
 * coords (fleet name as fallback). Carried over verbatim from the previous
 * green-dot feature — expedition DETECTION is intentionally unchanged.
 *
 * @returns {Map<string, ExpeditionInfo>}
 */
const collectActiveExpeditions = () => {
  /** @type {Map<string, ExpeditionInfo>} */
  const map = new Map();
  const rows = document.querySelectorAll(
    `#eventContent tr.eventFleet[data-mission-type="${MISSION_EXPEDITION}"][data-return-flight="true"]`,
  );
  for (const row of rows) {
    const name = trim(row.querySelector('.originFleet')?.textContent);
    const coords = denseCoords(row.querySelector(GAME.COORDS_ORIGIN)?.textContent);
    const ships = shipCountOf(row.querySelector(`${GAME.DETAILS_FLEET} span`)?.textContent);
    const key = coords || (name ? `name:${name}` : '');
    if (!key) continue;
    const entry = map.get(key) || { count: 0, ships: 0, name, coords };
    entry.count += 1;
    entry.ships += Number.isFinite(ships) ? ships : 0;
    map.set(key, entry);
  }
  return map;
};

// ── CSS ──────────────────────────────────────────────────────────────────

const buildCss = () => {
  const missionRules = Object.entries(MISSION_SPRITE_X)
    .map(
      ([mt, x]) =>
        `.${TILE_CLASS}.oge-mb-m${mt}{background-position:${Math.round(x * SPRITE_SCALE)}px ${SPRITE_ROW_Y}px;}`,
    )
    .join('\n');
  return `
.${COL_CLASS}{
  position:absolute;
  top:50%;
  right:calc(100% + 2px);
  transform:translateY(-50%);
  display:flex;
  flex-direction:column;
  gap:3px;
  z-index:30;
}
.${TILE_CLASS}{
  position:relative;
  width:${TILE_PX}px;
  height:${TILE_PX}px;
  background-image:url("${SPRITE_URL}");
  background-repeat:no-repeat;
  background-size:${SPRITE_BG}px;
  border-radius:4px;
  cursor:pointer;
  box-shadow:0 0 2px rgba(0,0,0,.85);
}
.${TILE_CLASS}.host{outline:1.5px solid #e24b4a;outline-offset:-1px;}
${missionRules}
.${CNT_CLASS}{
  position:absolute;
  top:-5px;
  left:-5px;
  min-width:13px;
  height:13px;
  padding:0 2px;
  box-sizing:border-box;
  border-radius:7px;
  background:#5a3a0b;
  color:#ffe9c7;
  font:500 9px/13px Verdana,sans-serif;
  text-align:center;
  pointer-events:none;
}
.${CNT_CLASS}.host{background:#a32d2d;color:#fde8e8;}
.oge-mb-dir{position:absolute;width:0;height:0;pointer-events:none;}
.oge-mb-dir.in{
  right:-7px;top:50%;transform:translateY(-50%);
  border-top:4px solid transparent;border-bottom:4px solid transparent;
  border-left:6px solid #5dcaa5;
}
.oge-mb-dir.in.host{border-left-color:#e24b4a;}
.oge-mb-dir.out{
  left:-7px;top:50%;transform:translateY(-50%);
  border-top:4px solid transparent;border-bottom:4px solid transparent;
  border-right:6px solid #8aa3b5;
}
.oge-mb-rt{
  position:absolute;right:-6px;bottom:-6px;
  font:9px/1 Verdana,sans-serif;color:#bfe0f0;
  text-shadow:0 0 2px #000,0 0 2px #000;pointer-events:none;
}
#${POP_ID}{
  position:fixed;
  z-index:99999;
  max-width:240px;
  display:none;
  background:#0d1a24;
  border:1px solid #2c5470;
  border-radius:6px;
  padding:8px 10px;
  color:#cfe6f5;
  font:12px/1.45 Verdana,sans-serif;
  box-shadow:0 2px 10px rgba(0,0,0,.6);
}
#${POP_ID}.open{display:block;}
#${POP_ID} .h{margin:0 0 5px;font-weight:700;color:#fff;}
#${POP_ID} .r{white-space:nowrap;}
#${POP_ID} .r .e{color:#9fb8c9;}
#${POP_ID} .more{color:#9fb8c9;margin-top:3px;}
`;
};

const HIDE_CSS = `.${COL_CLASS}{display:none!important;}`;

// ── Popover ────────────────────────────────────────────────────────────────

/** @type {HTMLElement | null} */
let popEl = null;

/** @param {string} c @returns {string} */
const brk = (c) => (c ? `[${c}]` : '?');

/**
 * Format an arrival epoch (seconds) as a short countdown. Clock read happens
 * here in the feature layer; `pure.js` never touches the clock.
 *
 * @param {number} arrivalAt
 * @returns {string}
 */
const fmtEta = (arrivalAt) => {
  if (!Number.isFinite(arrivalAt)) return '—';
  const r = Math.round(arrivalAt - Date.now() / 1000);
  if (r <= 0) return 'now';
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const s = r % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

/** @param {TileDetail} d @returns {DocumentFragment} */
const buildPopContent = (d) => {
  const frag = document.createDocumentFragment();
  const h = document.createElement('div');
  h.className = 'h';
  h.textContent = d.title;
  frag.appendChild(h);

  if (d.note) {
    const n = document.createElement('div');
    n.textContent = d.note;
    frag.appendChild(n);
    return frag;
  }

  const MAX = 12;
  d.fleets.slice(0, MAX).forEach((f) => {
    const row = document.createElement('div');
    row.className = 'r';
    const route = document.createElement('span');
    route.textContent = `${brk(f.origin)} → ${brk(f.dest)}${f.isReturn ? ' ↩' : ''} `;
    const eta = document.createElement('span');
    eta.className = 'e';
    eta.textContent = `· ${fmtEta(f.arrivalAt)}`;
    row.append(route, eta);
    frag.appendChild(row);
  });
  if (d.fleets.length > MAX) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `…${d.fleets.length - MAX} more`;
    frag.appendChild(more);
  }
  return frag;
};

/**
 * @param {Element} tileEl
 * @param {TileDetail} detail
 * @returns {void}
 */
const openPopover = (tileEl, detail) => {
  if (!popEl) return;
  popEl.replaceChildren(buildPopContent(detail));
  popEl.classList.add('open');
  const r = tileEl.getBoundingClientRect();
  const pw = popEl.offsetWidth;
  const ph = popEl.offsetHeight;
  // Prefer the space to the LEFT of the planet bar; fall back to the right.
  let left = r.left - pw - 6;
  if (left < 4) left = r.right + 6;
  let top = r.top + r.height / 2 - ph / 2;
  top = Math.max(4, Math.min(top, window.innerHeight - ph - 4));
  popEl.style.left = `${Math.round(left)}px`;
  popEl.style.top = `${Math.round(top)}px`;
};

const closePopover = () => {
  if (popEl) popEl.classList.remove('open');
};

// ── Render ─────────────────────────────────────────────────────────────────

const clearColumns = () => {
  document.querySelectorAll(`.${COL_CLASS}`).forEach((el) => el.remove());
};

/**
 * Short title for both the native `title` tooltip and the popover header.
 *
 * @param {{ missionType: string, count: number, kind: 'rt'|'in'|'out', hostile: boolean }} t
 * @returns {string}
 */
const tileTitle = (t) => {
  const label = MISSION_LABEL[t.missionType] || 'Mission';
  const kind =
    t.kind === 'in' ? (t.hostile ? 'incoming' : 'arriving') : t.kind === 'rt' ? 'round trip' : 'departing';
  return `${label}${t.count > 1 ? ` ×${t.count}` : ''} · ${kind}`;
};

/**
 * @param {import('./pure.js').Tile & { note?: string }} t
 * @returns {HTMLElement}
 */
const buildTile = (t) => {
  const el = document.createElement('div');
  el.className = `${TILE_CLASS} oge-mb-m${t.missionType}`;
  const hostileIn = t.kind === 'in' && t.hostile;
  if (hostileIn) el.classList.add('host');

  if (t.count > 1) {
    const cnt = document.createElement('span');
    cnt.className = `${CNT_CLASS}${hostileIn ? ' host' : ''}`;
    cnt.textContent = t.count > 99 ? '99+' : String(t.count);
    el.appendChild(cnt);
  }

  const dir = document.createElement('span');
  if (t.kind === 'rt') {
    dir.className = 'oge-mb-rt';
    dir.textContent = '↻';
  } else {
    dir.className = `oge-mb-dir ${t.kind}${hostileIn ? ' host' : ''}`;
  }
  el.appendChild(dir);

  const title = tileTitle(t);
  el.title = title;
  tileDetail.set(el, {
    title,
    kind: t.kind,
    hostile: t.hostile,
    missionType: t.missionType,
    count: t.count,
    fleets: t.fleets,
    ...(t.note ? { note: t.note } : {}),
  });
  return el;
};

/**
 * One render pass: wipe old columns, read the current event + planet state,
 * group it, merge the (untouched) expedition detection, and paint one icon
 * column per body that has activity.
 *
 * @returns {void}
 */
const renderColumns = () => {
  clearColumns();
  const bodies = scanOwnBodies();
  if (bodies.length === 0) return;
  const expeditions = collectActiveExpeditions();
  const myKeys = new Set(bodies.map((b) => bodyKey(b.coords, b.type)));
  const byAnchor = groupTiles(scanLegs(), myKeys);

  for (const body of bodies) {
    /** @type {(import('./pure.js').Tile & { note?: string })[]} */
    const tiles = [...(byAnchor.get(bodyKey(body.coords, body.type)) || [])];

    // Expeditions launch from a planet's link container — merge the existing
    // detector's result as a round-trip tile, matched by coords or name.
    if (body.type === 1) {
      const exp = expeditions.get(body.coords) || (body.name ? expeditions.get(`name:${body.name}`) : undefined);
      if (exp) {
        tiles.push({
          coords: body.coords,
          type: 1,
          missionType: MISSION_EXPEDITION,
          kind: 'rt',
          hostile: false,
          count: exp.count,
          fleets: [],
          note: `${exp.count} expedition${exp.count === 1 ? '' : 's'} · ${exp.ships.toLocaleString('en-US')} ships`,
        });
      }
    }

    if (tiles.length === 0) continue;
    // Defensive: make the pic container the positioning context so the
    // column anchors to its left edge (the green dot relied on this too).
    if (getComputedStyle(body.container).position === 'static') {
      body.container.style.position = 'relative';
    }
    const col = document.createElement('div');
    col.className = COL_CLASS;
    for (const t of sortTiles(tiles)) col.appendChild(buildTile(t));
    body.container.appendChild(col);
  }
};

// ── Install / dispose ────────────────────────────────────────────────────

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Attach the MutationObserver to `#planetList` + `#eventContent` when present,
 * always also observing `<body>` (OGame AJAX-swaps both containers, detaching
 * a scoped observer). Mirrors the previous badge feature's strategy.
 *
 * @param {MutationObserver} observer
 * @returns {void}
 */
const attachObserver = (observer) => {
  const planetList = document.getElementById('planetList');
  const eventContent = document.querySelector(GAME.EVENT_CONTENT);
  if (planetList) observer.observe(planetList, { childList: true, subtree: true });
  if (eventContent) observer.observe(eventContent, { childList: true, subtree: true });
  observer.observe(document.body, { childList: true, subtree: true });
};

/**
 * Install the planet mission badges. Idempotent: a second call while
 * installed returns the same dispose handle. The dispose fn disconnects the
 * observer, clears the safety poll, unsubscribes from settings, removes every
 * column + the popover + both style nodes, and detaches the document click
 * handler.
 *
 * @returns {() => void}
 */
export const installBadges = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, buildCss());

  popEl = document.createElement('div');
  popEl.id = POP_ID;
  document.body.appendChild(popEl);

  /** @type {MutationObserver | null} */
  let observer = null;

  // Run a render with the observer paused so our own DOM writes don't feed
  // back into a refresh loop (the writes would otherwise re-trigger it).
  const renderGuarded = () => {
    if (observer) observer.disconnect();
    try {
      renderColumns();
    } finally {
      if (observer) attachObserver(observer);
    }
  };

  /** @param {boolean} enabled @returns {void} */
  const applyVisibility = (enabled) => {
    if (enabled) {
      document.getElementById(HIDE_STYLE_ID)?.remove();
      renderGuarded();
      // Post-reload race: containers exist but are empty until OGame's inline
      // scripts populate them. Poll until the planet list has rows, then
      // render once more. No-op if the first render already succeeded.
      void waitFor(() => document.querySelectorAll(GAME.SMALL_PLANET).length > 0, {
        timeoutMs: 5000,
        intervalMs: 250,
      }).then(() => {
        if (installed && settingsStore.get().expeditionBadges) renderGuarded();
      });
    } else {
      closePopover();
      injectStyle(HIDE_STYLE_ID, HIDE_CSS);
    }
  };

  applyVisibility(settingsStore.get().expeditionBadges);

  const scheduleRefresh = debounce(() => {
    if (!installed) return;
    if (settingsStore.get().expeditionBadges) renderGuarded();
  }, REFRESH_DEBOUNCE_MS);

  let prevEnabled = settingsStore.get().expeditionBadges;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.expeditionBadges !== prevEnabled) {
      applyVisibility(next.expeditionBadges);
      prevEnabled = next.expeditionBadges;
    }
  });

  // Click / tap: open a tile's detail, or close the popover on an outside
  // click. Capture phase + preventDefault so a tile click never navigates the
  // planet link it sits inside.
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    const target = /** @type {Element | null} */ (e.target);
    const tileEl = target?.closest?.(`.${TILE_CLASS}`);
    if (tileEl) {
      e.preventDefault();
      e.stopPropagation();
      const detail = tileDetail.get(tileEl);
      if (detail) openPopover(tileEl, detail);
      return;
    }
    if (popEl && !popEl.contains(/** @type {Node} */ (e.target))) closePopover();
  };
  document.addEventListener('click', onClick, true);

  observer = new MutationObserver(() => scheduleRefresh());
  attachObserver(observer);

  // Safety net: OGame refreshes #eventContent on a ~30s AJAX tick and has
  // historically dodged scoped observers. 3s is far tighter than that and the
  // re-render is O(#planets) — practically free. Gated on the setting.
  const safetyPoll = setInterval(() => {
    if (settingsStore.get().expeditionBadges) renderGuarded();
  }, 3000);

  installed = {
    dispose: () => {
      observer?.disconnect();
      clearInterval(safetyPoll);
      unsubSettings();
      document.removeEventListener('click', onClick, true);
      clearColumns();
      popEl?.remove();
      popEl = null;
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById(HIDE_STYLE_ID)?.remove();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset: runs the current dispose fn (if any) so DOM/observers are
 * left clean between cases. Do not import from production code.
 *
 * @returns {void}
 */
export const _resetBadgesForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
