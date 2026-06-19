// Planet status markers — paint a tiny column of subtle status dots beside each
// `#planetList` body (LEFT of a planet, RIGHT of its moon so the two columns
// never collide), replacing the old single green expedition dot.
//
// # What it shows
//
// At most three small markers per body, one per CATEGORY present, ordered by
// priority (see `./pure.js`):
//
//   🟥 red SQUARE  — incoming attack (a foreign aggressive fleet at me) — danger
//   🔴 red circle  — my own aggression flying out
//   🟡 yellow      — a detected fleet-save
//   💙 teal HEART  — my expedition
//   🟢 green       — my logistics (transport / deploy / ACS defend)
//   🔵 blue        — my recycle
//
// Mine are round (+ a heart for expeditions); the external THREAT is the odd
// square. No counts, no direction arrows — the marker is a glanceable status
// dot, not a readout. Click / tap a marker for the per-fleet detail (targets +
// ETA). The whole point is to tell, at a glance, that the fleets are well
// positioned WITHOUT burying the planet skins under our own clutter.
//
// # Why this is purely passive
//
// Every byte comes from DOM the game itself renders into `#eventContent` and
// `#planetList`. We never fire our own XHR/fetch — we mirror the game's own
// event ticker onto the planet list. The fleet-save flags come from the
// reminders producer via `state/fleetSaveSet.js` (no feature-to-feature import).
// No parallel request stream, no polling the server: just styling.
//
// The classification (which body a leg marks, and as which category) is pure
// and lives in `./pure.js`. This module is the DOM half: it scans
// `#eventContent` + `#planetList`, paints the columns, and owns the observer /
// settings / popover / optimistic-cache lifecycle.
//
// @see ./pure.js — the pure landing-classification core.
// @see ../../state/fleetSaveSet.js — the FS id channel the producer publishes.
// @see ../../state/badgeCache.js — the optimistic pre-XHR paint cache.

/** @ts-check */

import { settingsStore } from '../../state/settings.js';
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { readFleetSaveIds } from '../../state/fleetSaveSet.js';
import { readBadgeCache, writeBadgeCache, clearBadgeCache } from '../../state/badgeCache.js';
import { injectStyle, waitFor } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { GAME } from '../../lib/gameDom.js';
import { EVENT_BOX_LOADED_EVENT } from '../../lib/ogeEvents.js';
import { groupMarkers, bodyKey, MARKER_LABEL } from './pure.js';

// ── OG-E-owned ids/classes (NOT a DOM contract — ours to rename freely) ──

const STYLE_ID = 'oge-badges-style';
const HIDE_STYLE_ID = 'oge-badges-hide-style';
/** The vertical marker column appended to each body's pic container. */
const COL_CLASS = 'oge-mb-col';
/** Modifier on a moon's column: anchor it to the RIGHT of the moon, not left. */
const MOON_COL_CLASS = 'oge-mb-col-moon';
/** One status marker inside a column (category class added alongside). */
const DOT_CLASS = 'oge-mb-dot';
/** Shared click/tap detail popover (one per page, parked on <body>). */
const POP_ID = 'oge-mb-pop';

const REFRESH_DEBOUNCE_MS = 200;

/**
 * Per-marker detail for the popover, attached weakly so re-renders (which
 * recreate the marker elements) don't leak. Keyed by the marker element.
 *
 * @type {WeakMap<Element, MarkerDetail>}
 */
const markerDetail = new WeakMap();

/**
 * @typedef {object} MarkerDetail
 * @property {string} label    Category label (popover header).
 * @property {string} category Category id.
 * @property {import('./pure.js').TileFleet[]} fleets
 */

// ── DOM read helpers (feature layer — pure.js stays DOM-free) ─────────────

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
 * import('./pure.js').BadgeLeg} data for {@link groupMarkers} to classify.
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
 * @property {HTMLElement} container The body's `.planetBarSpaceObjectContainer`.
 */

/**
 * Walk `#planetList` and collect the player's bodies plus the DOM container
 * each marker column attaches to. A planet and its moon live in the same
 * `.smallplanet` row and share coords; the moon entry uses the moon link's own
 * pic container so a moon's markers attach to the moon, not the planet.
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
      bodies.push({ coords, type: 1, container: /** @type {HTMLElement} */ (planetContainer) });
    }
    const moonLink = row.querySelector(GAME.MOON_LINK);
    const moonContainer = moonLink?.querySelector('.planetBarSpaceObjectContainer');
    if (moonContainer) {
      bodies.push({ coords, type: 3, container: /** @type {HTMLElement} */ (moonContainer) });
    }
  }
  return bodies;
};

// ── CSS ──────────────────────────────────────────────────────────────────

const buildCss = () => `
.${COL_CLASS}{
  position:absolute;
  top:50%;
  right:calc(100% + 7px);
  transform:translateY(-50%);
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:3px;
  z-index:30;
}
.${MOON_COL_CLASS}{
  right:auto;
  left:calc(100% + 3px);
}
.${DOT_CLASS}{
  width:7px;
  height:7px;
  box-sizing:border-box;
  border-radius:50%;
  cursor:pointer;
  box-shadow:0 0 2px rgba(0,0,0,.9);
}
/* Mine = round; the external THREAT is the odd square. */
.oge-mb-threat{background:#e24b4a;border-radius:1px;}
.oge-mb-aggro{background:#e24b4a;}
.oge-mb-fs{background:#f0c23c;}
.oge-mb-logistics{background:#4caf6a;}
.oge-mb-economy{background:#3d7fd0;}
/* Expedition heart — the expeditor's pride. A glyph, not a filled dot. */
.oge-mb-explore{
  width:auto;height:auto;
  background:none;box-shadow:none;border-radius:0;
  color:#3fb6c8;
  font:9px/1 Verdana,sans-serif;
  text-shadow:0 0 2px #000,0 0 1px #000;
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

/** @param {MarkerDetail} d @returns {DocumentFragment} */
const buildPopContent = (d) => {
  const frag = document.createDocumentFragment();
  const h = document.createElement('div');
  h.className = 'h';
  h.textContent = d.label;
  frag.appendChild(h);

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
 * @param {Element} markerEl
 * @param {MarkerDetail} detail
 * @returns {void}
 */
const openPopover = (markerEl, detail) => {
  if (!popEl) return;
  popEl.replaceChildren(buildPopContent(detail));
  popEl.classList.add('open');
  const r = markerEl.getBoundingClientRect();
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
 * @param {import('./pure.js').Marker} m
 * @returns {HTMLElement}
 */
const buildMarker = (m) => {
  const el = document.createElement('span');
  el.className = `${DOT_CLASS} oge-mb-${m.category}`;
  if (m.category === 'explore') el.textContent = '♥';
  const label = MARKER_LABEL[m.category] || 'Fleet';
  el.title = label;
  markerDetail.set(el, { label, category: m.category, fleets: m.fleets });
  return el;
};

/**
 * Flipped true once OGame's event-list XHR has populated `#eventContent` (the
 * `oge:eventBoxLoaded` bridge signal). Until then a render with no legs is
 * AMBIGUOUS — "no activity" vs "data not here yet" — so we must not let an
 * empty live pass overwrite the optimistic cache paint.
 */
let eventBoxReady = false;

/**
 * Whether the event list is loaded, so an empty render is authoritative. The
 * presence of any event row is a sufficient signal on its own; the flag
 * additionally covers the loaded-but-idle (zero fleets) case.
 *
 * @returns {boolean}
 */
const eventBoxLoaded = () => eventBoxReady || document.querySelector(GAME.EVENT_FLEET_ROWS) != null;

/**
 * The detected fleet-save row-ids to mark — but only while reminders' master
 * switch AND the per-universe FS toggle are both on, so a stale published set
 * never paints FS markers after the feature is turned off.
 *
 * @returns {Set<string>}
 */
const fsIdSet = () => {
  const on = settingsStore.get().remindersMasterEnabled && galaxyScanConfigStore.get().fsEnabled;
  return new Set(on ? readFleetSaveIds() : []);
};

/**
 * Paint one body's marker column. Shared by the live render and the optimistic
 * cache render so both produce identical DOM.
 *
 * @param {OwnBody} body
 * @param {import('./pure.js').Marker[]} markers
 * @returns {void}
 */
const paintBody = (body, markers) => {
  if (markers.length === 0) return;
  // Defensive: make the pic container the positioning context so the column
  // anchors to its edge (the green dot relied on this too).
  if (getComputedStyle(body.container).position === 'static') {
    body.container.style.position = 'relative';
  }
  const col = document.createElement('div');
  col.className = body.type === 3 ? `${COL_CLASS} ${MOON_COL_CLASS}` : COL_CLASS;
  for (const m of markers) col.appendChild(buildMarker(m));
  body.container.appendChild(col);
};

/**
 * Slim the painted markers to the cache shape (just the ordered category ids —
 * the optimistic paint needs nothing else; per-fleet detail is re-derived live).
 *
 * @param {Record<string, import('./pure.js').Marker[]>} snapshot
 * @returns {Record<string, string[]>}
 */
const slimSnapshot = (snapshot) => {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [key, markers] of Object.entries(snapshot)) {
    out[key] = markers.map((m) => m.category);
  }
  return out;
};

/**
 * One LIVE render pass: read the current event + planet state, classify it into
 * per-body markers, paint one column per active body, and refresh the
 * optimistic cache.
 *
 * @returns {void}
 */
const renderColumns = () => {
  const ready = eventBoxLoaded();
  // Pre-XHR window: keep the optimistic cache paint rather than wiping it with
  // an empty live pass. Once the event box has loaded, the live result is
  // authoritative and replaces it.
  if (!ready && document.querySelector(`.${COL_CLASS}`)) return;

  clearColumns();
  const bodies = scanOwnBodies();
  if (bodies.length === 0) return;
  const myKeys = new Set(bodies.map((b) => bodyKey(b.coords, b.type)));
  const byBody = groupMarkers(scanLegs(), myKeys, fsIdSet());

  /** @type {Record<string, import('./pure.js').Marker[]>} */
  const snapshot = {};
  for (const body of bodies) {
    const key = bodyKey(body.coords, body.type);
    const markers = byBody.get(key);
    if (!markers || markers.length === 0) continue;
    paintBody(body, markers);
    snapshot[key] = markers;
  }

  // Persist for the next reload's instant paint. Overwrite with an EMPTY result
  // only when the event list is genuinely loaded-and-idle — never in the
  // pre-XHR gap (handled by the early-return above).
  if (Object.keys(snapshot).length > 0) writeBadgeCache(slimSnapshot(snapshot));
  else if (ready) clearBadgeCache();
};

/**
 * Optimistic paint from the previous page's cached markers, so the badges show
 * instantly on load — before the event-list XHR (which {@link renderColumns}
 * computes everything from) has even arrived. The live render replaces it.
 * Cached markers carry no fleets, so their popover is empty until the live pass.
 *
 * @returns {void}
 */
const renderFromCache = () => {
  const cache = readBadgeCache();
  if (!cache) return;
  const bodies = scanOwnBodies();
  if (bodies.length === 0) return;
  clearColumns();
  for (const body of bodies) {
    const cats = cache[bodyKey(body.coords, body.type)];
    if (!cats || cats.length === 0) continue;
    paintBody(
      body,
      cats.map((category) => ({ category, fleets: [] })),
    );
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
 * Install the planet status markers. Idempotent: a second call while installed
 * returns the same dispose handle. The dispose fn disconnects the observer,
 * clears the safety poll, unsubscribes from settings, removes every column +
 * the popover + both style nodes, and detaches the document handlers.
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

  // Run a paint with the observer paused so our own DOM writes don't feed back
  // into a refresh loop (the writes would otherwise re-trigger it).
  /** @param {() => void} fn */
  const guarded = (fn) => {
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer) attachObserver(observer);
    }
  };
  const renderGuarded = () => guarded(renderColumns);

  /** @param {boolean} enabled @returns {void} */
  const applyVisibility = (enabled) => {
    if (enabled) {
      document.getElementById(HIDE_STYLE_ID)?.remove();
      // Instant optimistic paint from the previous load's cache, BEFORE the
      // live render — so the markers show while the event XHR is still in
      // flight. The live pass then preserves it (pre-XHR) or replaces it.
      guarded(renderFromCache);
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

  // Click / tap: open a marker's detail, or close the popover on an outside
  // click. Capture phase + preventDefault so a marker click never navigates the
  // planet link it sits inside.
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    const target = /** @type {Element | null} */ (e.target);
    const markerEl = target?.closest?.(`.${DOT_CLASS}`);
    if (markerEl) {
      e.preventDefault();
      e.stopPropagation();
      const detail = markerDetail.get(markerEl);
      if (detail) openPopover(markerEl, detail);
      return;
    }
    if (popEl && !popEl.contains(/** @type {Node} */ (e.target))) closePopover();
  };
  document.addEventListener('click', onClick, true);

  // The event-list XHR landing is our authority for "an empty render is real".
  // Mark it ready and refresh so a loaded-but-idle list clears the cache.
  const onEventBox = () => {
    eventBoxReady = true;
    scheduleRefresh();
  };
  document.addEventListener(EVENT_BOX_LOADED_EVENT, onEventBox);

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
      document.removeEventListener(EVENT_BOX_LOADED_EVENT, onEventBox);
      eventBoxReady = false;
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
