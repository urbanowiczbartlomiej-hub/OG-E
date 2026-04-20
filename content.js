// OG-E: UI annotations + local data collection (no HTTP requests initiated here)
//
// What this script does:
//   - Adds small green dot annotations next to planets in #planetList that
//     currently have expedition fleets in transit. Parses #eventContent that
//     the game itself renders — pure DOM read.
//   - When the user visits a newly colonized planet (usedFields == 0 on the
//     overview page), records its field size to chrome.storage for later
//     display in the colony size histogram. Read from DOM the game renders.
//   - When the user navigates the galaxy view in-game, our MAIN-world XHR
//     listener (colonize.js) observes the game's response and forwards
//     per-position data to this script via a custom event. We store it in
//     chrome.storage so the histogram page can visualize it. No data request
//     is initiated by us — we only record what the game sends in response
//     to the user's own navigation.
//
// What this script does NOT do:
//   - Does NOT fetch anything from the game server.
//   - Does NOT run timers or periodic work touching the game.
//   - Does NOT observe anything the user hasn't navigated to themselves.
(() => {
  const STYLE_ID = 'oge-expedition-badge-style';

  // ── Unified storage.local helper (Firefox desktop & mobile, Chrome) ──
  /**
   * Returns the platform's `chrome.storage.local` namespace (or null in
   * iframes whose extension context didn't initialise). See
   * `mobile.js:getExtStorage` for the full doc — duplicated here because
   * content scripts can't share modules.
   *
   * @returns {object|null} chrome.storage.local-compatible API or null
   */
  const getExtStorage = () => {
    if (typeof browser !== 'undefined' && browser.storage) return browser.storage.local;
    if (typeof chrome !== 'undefined' && chrome.storage) return chrome.storage.local;
    return null;
  };

  // ── Styles ──

  const injectStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ogi-exp-dots {
        position: absolute;
        left: 2px;
        bottom: 2px;
        display: flex;
        gap: 2px;
        pointer-events: none;
        z-index: 5;
      }
      .ogi-exp-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: rgba(0, 255, 0, 0.9);
        box-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
      }
    `;
    document.head.appendChild(style);
  };

  // ── Helpers ──

  const trim = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const trimCoords = (s) => trim(s).replace(/\s/g, '');

  const parseShipCount = (text) => {
    if (!text) return 0;
    const digits = text.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  };

  // ── Expedition detection ──

  /**
   * Scan the game's `#eventContent` for active expedition return-flights
   * (mission type 15, returning), grouped by origin coords. Used to render
   * the small green dots on `#planetList` showing which planets currently
   * have an expedition out.
   *
   * Pure DOM read — no requests issued. Falls back to grouping by fleet name
   * when origin coords aren't available in the row.
   *
   * @returns {Map<string, {count: number, ships: number, name: string, coords: string}>}
   *          keyed by `coords` (or `name:<name>` fallback)
   */
  const collectActiveExpeditions = () => {
    const map = new Map();
    const rows = document.querySelectorAll(
      '#eventContent tr.eventFleet[data-mission-type="15"][data-return-flight="true"]'
    );

    for (const row of rows) {
      const name = trim(row.querySelector('.originFleet')?.textContent);
      const coords = trimCoords(row.querySelector('.coordsOrigin')?.textContent);
      const ships = parseShipCount(row.querySelector('.detailsFleet span')?.textContent);
      const key = coords || `name:${name}`;
      if (!key) continue;

      const entry = map.get(key) || { count: 0, ships: 0, name, coords };
      entry.count += 1;
      entry.ships += ships;
      map.set(key, entry);
    }

    return map;
  };

  // ── Badge rendering ──

  const clearBadges = () => {
    document.querySelectorAll('.ogi-exp-badge, .ogi-exp-dots').forEach((el) => el.remove());
  };

  const renderBadges = () => {
    injectStyles();
    const expeditions = collectActiveExpeditions();
    const planets = document.querySelectorAll('#planetList .smallplanet');

    clearBadges();

    for (const planet of planets) {
      const link = planet.querySelector('a.planetlink');
      if (!link) continue;

      const name = trim(link.querySelector('.planet-name')?.textContent);
      const coords = trimCoords(link.querySelector('.planet-koords')?.textContent);
      const info = expeditions.get(coords || `name:${name}`);
      if (!info) continue;

      const container = link.querySelector('.planetBarSpaceObjectContainer');
      if (!container) continue;

      const dots = document.createElement('div');
      dots.className = 'ogi-exp-dots';
      dots.title = `Ekspedycje: ${info.count} | Statki: ${info.ships.toLocaleString('pl-PL')}`;

      for (let i = 0; i < info.count; i++) {
        const dot = document.createElement('div');
        dot.className = 'ogi-exp-dot';
        dots.appendChild(dot);
      }

      container.appendChild(dots);
    }
  };

  // ── Refresh scheduling ──

  const debounce = (fn, ms = 200) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  const scheduleRefresh = debounce(renderBadges, 150);

  const refreshAfterFrames = (n = 2) => {
    let count = 0;
    const tick = () => (++count < n ? requestAnimationFrame(tick) : scheduleRefresh());
    requestAnimationFrame(tick);
  };

  // ── DOM & network observers ──

  const observeDOM = () => {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList' ||
            (m.type === 'attributes' && ['class', 'id', 'value'].includes(m.attributeName))) {
          refreshAfterFrames();
          return;
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id', 'value'],
    });
  };

  const isGalaxyFetch = (url) => {
    try {
      const s = String(url);
      return s.includes('component=galaxy') && s.includes('action=fetchGalaxyContent');
    } catch {
      return false;
    }
  };

  const hookNetwork = () => {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        return origFetch.apply(this, args).then((res) => {
          if (isGalaxyFetch(args[0])) setTimeout(refreshAfterFrames, 100);
          return res;
        });
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__oge_url = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('loadend', () => {
        if (isGalaxyFetch(this.__oge_url)) setTimeout(refreshAfterFrames, 100);
      });
      return origSend.apply(this, args);
    };
  };

  const bindClickEvents = () => {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.closest?.('span.galaxy_icons.prev') ||
          t.closest?.('span.galaxy_icons.next') ||
          t.closest?.('#discoverSystemBtn') ||
          t.closest?.('.btn_blue[onclick*="submitForm"]')) {
        refreshAfterFrames();
      }
    }, true);

    for (const el of [document.getElementById('galaxy_input'),
                       document.getElementById('system_input')]) {
      if (!el) continue;
      el.addEventListener('input', scheduleRefresh, true);
      el.addEventListener('change', scheduleRefresh, true);
      el.addEventListener('keyup', (ev) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(ev.key)) {
          refreshAfterFrames();
        }
      }, true);
    }
  };

  // ── Boot ──

  const applyBadgeVisibility = () => {
    let style = document.getElementById('oge-badge-visibility');
    const hidden = localStorage.getItem('oge_expeditionBadges') === 'false';
    if (hidden && !style) {
      style = document.createElement('style');
      style.id = 'oge-badge-visibility';
      style.textContent = '.ogi-exp-dots { display: none !important; }';
      document.head.appendChild(style);
    } else if (!hidden && style) {
      style.remove();
    }
  };

  const boot = () => {
    observeDOM();
    hookNetwork();
    bindClickEvents();
    injectStyles();
    applyBadgeVisibility();
    scheduleRefresh();
    collectColonyData();
    document.addEventListener('oge:badgesToggle', applyBadgeVisibility);
  };

  // ── Colony data collection (for histogram) ──

  /**
   * If the user is on the overview page of a freshly-colonised planet
   * (usedFields == 0), record its size to `oge_colonyHistory` for later
   * display in the histogram. Pure DOM read — parses
   * `#diameterContentField` and `#positionContentField`.
   *
   * Dedup: skipped if an entry with this `cp` (planet ID) already exists.
   * Captured fields: `cp`, `fields` (max), `coords`, `position`, `timestamp`.
   *
   * @see SCHEMAS.md#oge_colonyhistory
   */
  const collectColonyData = () => {
    if (!location.search.includes('component=overview')) return;

    const active = document.querySelector('#planetList .hightlightPlanet');
    if (!active) return;

    const cp = parseInt(active.id.replace('planet-', ''), 10);
    if (!cp) return;

    const diameterEl = document.getElementById('diameterContentField');
    if (!diameterEl) return;
    const fieldMatch = diameterEl.textContent.match(/\((\d+)\/(\d+)\)/);
    if (!fieldMatch) return;
    const usedFields = parseInt(fieldMatch[1], 10);
    const maxFields = parseInt(fieldMatch[2], 10);

    // Only record fresh colonies (0 used fields = just colonized)
    if (usedFields !== 0) return;

    const coordsEl = document.querySelector('#positionContentField a');
    const coords = coordsEl?.textContent?.trim() || '';
    const posMatch = coords.match(/\[(\d+):(\d+):(\d+)\]/);
    const position = posMatch ? parseInt(posMatch[3], 10) : 0;

    const storage = getExtStorage();
    if (!storage) return;

    storage.get('oge_colonyHistory', (result) => {
      const history = result.oge_colonyHistory || [];
      if (history.some(h => h.cp === cp)) return;
      history.push({ cp, fields: maxFields, coords, position, timestamp: Date.now() });
      storage.set({ oge_colonyHistory: history });
    });
  };

  // ── Galaxy scan results storage ──

  // Schema v2: full per-position scan map.
  // detail = { galaxy, system, scannedAt, positions: { 1..15: { status, player?, flags? } }, canColonize }
  //
  // Merge policy: fresh scan is normally the source of truth, EXCEPT for slots
  // where we have a pending colonization fleet. The game's galaxy view never
  // knows about our in-flight missions (the slot just looks empty until the
  // fleet lands), so we must preserve our local 'empty_sent' marker instead of
  // letting the fresh 'empty' silently overwrite it. Without this guard,
  // findNextColonizeTarget would re-pick the slot as a free candidate and
  // double-send a fleet to it.
  document.addEventListener('oge:galaxyScanned', (e) => {
    const { galaxy, system, scannedAt, positions } = e.detail || {};
    if (!galaxy || !system || !positions) return;

    const store = getExtStorage();
    if (!store) return;

    // Read the pending-fleet registry SYNC from localStorage (moved there in
    // 4.8.5 to beat the navigation race on mobile). See fleet-redirect.js for
    // the write side. SCHEMAS.md documents the layout.
    let reg = [];
    try { reg = JSON.parse(localStorage.getItem('oge_colonizationRegistry') || '[]'); } catch {}
    const pendingCoords = new Set(
      reg.filter(r => (r.arrivalAt || 0) > Date.now()).map(r => r.coords)
    );

    store.get('oge_galaxyScans', (result) => {
      const scans = (result && result.oge_galaxyScans) || {};
      const key = galaxy + ':' + system;
      const existingScan = scans[key];

      // Per-position merge: preserve 'empty_sent' iff (a) we previously marked
      // it empty_sent, (b) the fresh scan still sees the slot as empty, and
      // (c) the registry confirms our fleet hasn't landed yet. Any in-game
      // change (mine / occupied / abandoned / ...) wins — the scan is the
      // source of truth for everything observable.
      const mergedPositions = { ...positions };
      if (existingScan?.positions) {
        for (const pos of Object.keys(positions)) {
          const oldP = existingScan.positions[pos];
          const newP = positions[pos];
          if (oldP?.status === 'empty_sent' && newP?.status === 'empty') {
            const coordKey = galaxy + ':' + system + ':' + pos;
            if (pendingCoords.has(coordKey)) {
              mergedPositions[pos] = oldP;
            }
          }
        }
      }

      scans[key] = {
        scannedAt: scannedAt || Date.now(),
        positions: mergedPositions,
      };
      store.set({ oge_galaxyScans: scans });
    });
  });

  // When fleet-redirect.js observes a successful colonize send it fires
  // `oge:colonizeSent`. We use it to update the scan DB entry (position →
  // 'empty_sent') so the UI reflects the pending mission immediately.
  //
  // Note: `oge_colonizationRegistry` is NOT touched here anymore. As of 4.8.5
  // fleet-redirect.js pre-registers the entry SYNCHRONOUSLY into localStorage
  // before nativeSend, which avoids the navigation race that was losing
  // registry writes on mobile (chrome.storage.set is async and was racing
  // against `location.href = redirectUrl`). localStorage is the primary
  // source of truth for in-flight coords; this handler's scan update is a
  // best-effort eventual-consistency UI hint.
  //
  // @see SCHEMAS.md#oge_colonizationregistry
  document.addEventListener('oge:colonizeSent', (e) => {
    const { galaxy, system, position } = e.detail || {};
    if (!galaxy || !system) return;

    const store = getExtStorage();
    if (!store) return;

    store.get('oge_galaxyScans', (result) => {
      const scans = (result && result.oge_galaxyScans) || {};
      const key = galaxy + ':' + system;
      if (!scans[key]) scans[key] = { scannedAt: Date.now(), positions: {} };
      if (!scans[key].positions) scans[key].positions = {};
      if (position) {
        scans[key].positions[position] = { ...(scans[key].positions[position] || {}), status: 'empty_sent' };
      }
      store.set({ oge_galaxyScans: scans });
    });
  });

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
