// OG-E: OGame UI modification — content script (document_start)
//
// What this script does:
//   - Adds a large floating "Send Exp" button on top of the game's page. Each
//     user tap on this button relays to ONE click on a native game UI button
//     (Ago routine / Wyślij flotę). The button is needed because on mobile the
//     game scales to ~50%, making original buttons too small to tap reliably.
//   - Adds a large floating "Send Col" button with Send/Scan halves. Each tap
//     performs ONE navigation or ONE click on a native game button (nothing
//     is chained — each tap = one action).
//   - ArrowRight keyboard shortcut on fleetdispatch: same effect as pressing
//     the game's own "next panel" button. User-initiated.
//   - Black loading background so mobile flash isn't jarring.
//   - Button focus persistence across page reloads (keyboard users).
//
// What this script does NOT do:
//   - Does NOT initiate HTTP requests to the game. All server communication
//     is triggered by the game's own code, reacting to our click on a game
//     UI element — equivalent to a user tap.
//   - Does NOT run anything on a timer or in the background. All actions are
//     reactions to user input (click, tap, key press).
//   - Does NOT chain multiple game-state-changing actions from one click.
//     One user click = at most one native game action = at most one request
//     from the game's own code.
(() => {
  const STORAGE_KEY = 'oge_mobileMode';
  const COL_STORAGE_KEY = 'oge_colonizeMode';
  const SIZE_KEY = 'oge_enterBtnSize';
  const POS_KEY = 'oge_enterBtnPos';
  const COL_POS_KEY = 'oge_colBtnPos';
  const FOCUS_KEY = 'oge_focusedBtn';
  const DEFAULT_SIZE = 560;

  // ── safeLS: localStorage with type coercion + try/catch baked in ──
  /**
   * localStorage helper namespace. All methods silently swallow exceptions —
   * localStorage can throw in private mode, on quota exhaustion, or inside
   * sandboxed iframes, and we never want one storage failure to crash the UI.
   *
   * Methods:
   *   get(k)            → string|null              raw value or null
   *   set(k, v)         → void                     coerces v to String
   *   remove(k)         → void
   *   bool(k, d=false)  → boolean                  parses 'true'/'false'; default if absent
   *   int(k, d=0)       → number                   parseInt; default if non-positive or NaN
   *   json(k, d=null)   → any|null                 JSON.parse; default if absent or invalid
   *   setJSON(k, v)     → void                     JSON.stringify
   *
   * @see SCHEMAS.md#localstorage-origin-ogamegameforgecom
   */
  const safeLS = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} },
    remove: (k) => { try { localStorage.removeItem(k); } catch {} },
    bool: (k, d = false) => { try { const v = localStorage.getItem(k); return v == null ? d : v === 'true'; } catch { return d; } },
    int: (k, d = 0) => { try { const v = parseInt(localStorage.getItem(k), 10); return v > 0 ? v : d; } catch { return d; } },
    json: (k, d = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    setJSON: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ── chrome.storage.local helper (Firefox desktop & mobile, Chrome) ──
  /**
   * Returns the platform's `chrome.storage.local` namespace, preferring
   * `browser.*` (Firefox / WebExtensions promise-style) over `chrome.*`
   * (Chrome callback-style — Firefox also exposes this for compatibility).
   * Returns null when neither API is available (e.g. inside an iframe whose
   * extension context didn't initialise yet).
   *
   * Callers MUST null-check; storage operations are async (callback-style:
   * `store.get(keys, cb)`, `store.set(obj, cb?)`).
   *
   * @returns {object|null} chrome.storage.local-compatible API or null
   */
  const getExtStorage = () => {
    if (typeof browser !== 'undefined' && browser.storage) return browser.storage.local;
    if (typeof chrome !== 'undefined' && chrome.storage) return chrome.storage.local;
    return null;
  };

  const getSize = () => safeLS.int(SIZE_KEY, DEFAULT_SIZE);

  // ── Black background (always, immediate at document_start) ──

  const bgStyle = document.createElement('style');
  bgStyle.id = 'oge-mobile-bg';
  bgStyle.textContent = 'html, body { background: #000 !important; }';
  (document.head || document.documentElement).appendChild(bgStyle);

  // One-time cleanup of stale key from removed Quick Galaxy Expedition feature
  safeLS.remove('oge_lastExpProblem');

  // ── Schema migration v1 → v2 ──
  // v1 stored: { '4:200': { status, position, ts } }   (best-status per system)
  // v2 stores: { '4:200': { scannedAt, positions: { 1..15: { status, player?, flags? } } }
  // The shapes are incompatible — wipe local scans on first v2 boot, write a
  // tombstone so sync.js wipes the gist too (otherwise old data would re-import).
  // User re-scans from scratch.
  const SCANS_SCHEMA_VERSION = 2;
  if (safeLS.int('oge_scansSchemaVersion', 1) < SCANS_SCHEMA_VERSION) {
    const store = getExtStorage();
    if (store) {
      store.remove(['oge_galaxyScans', 'oge_colonizationRegistry'], () => {
        store.set({ oge_clearRemoteAt: Date.now() });
      });
    }
    safeLS.set('oge_scansSchemaVersion', SCANS_SCHEMA_VERSION);
  }

  // 4.8.5 one-shot migration: `oge_colonizationRegistry` moved from
  // chrome.storage.local to localStorage (sync writes to beat the mobile
  // navigation race). Carry forward any existing entries + clear the old
  // slot so chrome.storage no longer holds the key.
  if (!safeLS.bool('oge_registryMigrated485')) {
    const migrStore = getExtStorage();
    if (migrStore) {
      migrStore.get('oge_colonizationRegistry', (data) => {
        const oldReg = (data && data.oge_colonizationRegistry) || [];
        if (oldReg.length) {
          try {
            const current = JSON.parse(localStorage.getItem('oge_colonizationRegistry') || '[]');
            const byKey = new Map();
            for (const r of [...current, ...oldReg]) {
              const key = r.coords + '|' + r.sentAt;
              if (!byKey.has(key)) byKey.set(key, r);
            }
            const merged = [...byKey.values()].filter(r => (r.arrivalAt || 0) > Date.now());
            localStorage.setItem('oge_colonizationRegistry', JSON.stringify(merged));
          } catch {}
        }
        migrStore.remove('oge_colonizationRegistry');
        safeLS.set('oge_registryMigrated485', 'true');
      });
    } else {
      safeLS.set('oge_registryMigrated485', 'true');
    }
  }

  window.addEventListener('load', () => {
    setTimeout(() => {
      const el = document.getElementById('oge-mobile-bg');
      if (el) el.remove();
    }, 300);
  }, { once: true });

  // ── Preferences ──

  const isEnabled = () => safeLS.bool(STORAGE_KEY);

  // ── Focus persistence helper ──
  // Remembers which of our buttons was last focused so it stays focused after F5.
  // Enter triggers click natively because all targets are <button> elements.
  const setupBtnFocusPersist = (el, key) => {
    el.addEventListener('focus', () => safeLS.set(FOCUS_KEY, key));
    el.addEventListener('blur', () => {
      if (safeLS.get(FOCUS_KEY) === key) safeLS.remove(FOCUS_KEY);
    });
    if (safeLS.get(FOCUS_KEY) === key) {
      setTimeout(() => el.focus(), 50);
    }
  };

  // ── Styles ──

  const injectStyles = () => {
    if (document.getElementById('oge-mobile-style')) return;
    const style = document.createElement('style');
    style.id = 'oge-mobile-style';
    style.textContent = `
      #oge-mobile-enter {
        position: fixed;
        border-radius: 50%;
        border: none;
        background: rgba(0, 150, 255, 0.7);
        color: #fff;
        font-weight: bold;
        letter-spacing: 0.5px;
        cursor: pointer;
        z-index: 99999;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
        touch-action: none;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      #oge-mobile-enter.oge-dragging,
      #oge-mobile-col.oge-dragging {
        opacity: 0.6;
        transform: scale(1.05);
      }
      #oge-mobile-col {
        position: fixed;
        border-radius: 50%;
        border: none;
        background: transparent;
        z-index: 99999;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
        touch-action: none;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 0;
      }
      #oge-mobile-col .oge-col-half {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-weight: bold;
        cursor: pointer;
        border: none;
        width: 100%;
        padding: 0 15%;
        box-sizing: border-box;
        text-align: center;
        line-height: 1.2;
        font-family: inherit;
      }
      #oge-mobile-col .oge-col-send {
        background: rgba(0, 160, 0, 0.75);
        border-radius: 999px 999px 0 0;
        border-bottom: 1px solid rgba(255,255,255,0.15);
        padding-top: 12%;
      }
      #oge-mobile-col .oge-col-scan {
        background: rgba(200, 100, 0, 0.75);
        border-radius: 0 0 999px 999px;
        padding-bottom: 12%;
      }
      /* Focus ring for our floating buttons (visible only when reached via keyboard) */
      #oge-mobile-enter:focus-visible,
      #oge-mobile-col .oge-col-half:focus-visible {
        outline: 3px solid #ffd54a;
        outline-offset: -3px;
      }
      #oge-mobile-enter:focus-visible {
        outline-offset: 2px;
      }
    `;
    document.head.appendChild(style);
  };

  // ── Safe click: remove javascript: href before clicking to avoid CSP errors ──
  const safeClick = (el) => {
    if (!el) return;
    if (el.getAttribute('href')?.startsWith('javascript:')) el.removeAttribute('href');
    el.click();
  };

  // ── Send Exp: expedition logic ──

  const pollDOM = (checkFn, timeout = 15000, interval = 300) => {
    const start = Date.now();
    const id = setInterval(() => {
      checkFn((done) => {
        if (done || Date.now() - start > timeout) clearInterval(id);
      });
    }, interval);
  };

  let expBusy = false;

  const setExpBtnText = (text) => {
    const btn = document.getElementById('oge-mobile-enter');
    if (btn) btn.textContent = text;
  };

  const lockExpBtn = () => {
    expBusy = true;
    const btn = document.getElementById('oge-mobile-enter');
    if (btn) btn.style.opacity = '0.5';
  };

  const unlockExpBtn = () => {
    expBusy = false;
    const btn = document.getElementById('oge-mobile-enter');
    if (btn) btn.style.opacity = '1';
  };

  const tryExpedition = () => {
    // Phase 0: check if current planet already at max expeditions
    const currentDots = countExpDots(document.querySelector('#planetList .hightlightPlanet'));
    if (currentDots >= getMaxExpPerPlanet()) {
      setExpBtnText('Maxed');
      const nextCp = findPlanetWithExpSlot(true);
      if (nextCp) {
        const base = location.href.split('?')[0];
        location.href = base + '?page=ingame&component=fleetdispatch&cp=' + nextCp;
      } else {
        setExpBtnText('All maxed');
        unlockExpBtn();
      }
      return;
    }

    // Phase 1: dispatchFleet visible AND fleet panel loaded → user's 2nd click → send
    const existingDispatch = document.getElementById('dispatchFleet');
    const fleetPanelLoaded = !!document.getElementById('ago_fleet2_main');
    if (existingDispatch && fleetPanelLoaded) {
      safeClick(existingDispatch);
      setExpBtnText('Sent!');
      return; // stay locked until page reload
    }

    // Phase 2: poll for routine → click → then wait for dispatchFleet
    setExpBtnText('Loading...');
    let didClickRoutine = false;

    pollDOM((resolve) => {
      // After routine clicked — wait for fleet panel to load
      if (didClickRoutine) {
        const dispatch = document.getElementById('dispatchFleet');
        const fleetPanel = document.getElementById('ago_fleet2_main');
        if (dispatch && fleetPanel) {
          setExpBtnText('Dispatch!');
          unlockExpBtn();
          return resolve(true); // user must click again to dispatch
        }
        return resolve(false); // keep waiting
      }

      // Look for routine
      const routine = document.getElementById('ago_routine_7');
      if (!routine) return resolve(false);

      const check = routine.querySelector('.ago_routine_check');
      if (!check) return resolve(false);

      if (check.classList.contains('ago_routine_check_3')) {
        safeClick(routine);
        setTimeout(() => safeClick(routine), 50);
        didClickRoutine = true;
        setExpBtnText('Preparing...');
        return resolve(false); // keep polling
      }

      // check_1 or check_2 — no ships
      setExpBtnText('No ships');
      const nextCp = findPlanetWithExpSlot(true);
      if (nextCp) {
        const base = location.href.split('?')[0];
        location.href = base + '?page=ingame&component=fleetdispatch&cp=' + nextCp;
      } else {
        setExpBtnText('All maxed');
        unlockExpBtn();
      }
      return resolve(true);
    }, 30000, 300);
    setTimeout(unlockExpBtn, 31000);
  };

  const getMaxExpPerPlanet = () => safeLS.int('oge_maxExpPerPlanet', 1);

  // Count expedition dots on a planet element (from content.js badges)
  const countExpDots = (planetEl) => {
    const dotsContainer = planetEl.querySelector('.ogi-exp-dots');
    if (!dotsContainer) return 0;
    return dotsContainer.querySelectorAll('.ogi-exp-dot').length;
  };

  // Find first planet that has room for more expeditions
  // skipCurrent=true → start from next planet
  const findPlanetWithExpSlot = (skipCurrent) => {
    const maxExp = getMaxExpPerPlanet();
    const planets = [...document.querySelectorAll('#planetList .smallplanet')];
    const activeIdx = planets.findIndex(p => p.classList.contains('hightlightPlanet'));
    const startOffset = skipCurrent ? 1 : 0;

    for (let i = startOffset; i < planets.length; i++) {
      const idx = (activeIdx + i) % planets.length;
      const p = planets[idx];
      const dots = countExpDots(p);
      if (dots < maxExp) {
        return p.id.replace('planet-', '');
      }
    }
    return null;
  };

  const onSendExpClick = () => {
    if (expBusy) return;
    lockExpBtn();
    if (!location.search.includes('component=fleetdispatch')) {
      const cpId = findPlanetWithExpSlot();
      if (!cpId) {
        setExpBtnText('All maxed');
        unlockExpBtn();
        return;
      }

      setExpBtnText('Going...');
      const base = location.href.split('?')[0];
      location.href = base + '?page=ingame&component=fleetdispatch&cp=' + cpId;
      return;
    }
    tryExpedition();
  };

  // ── Keybinding: ArrowRight on fleetdispatch ──
  if (location.search.includes('component=fleetdispatch')) {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight') return;
      // Don't intercept if user is typing in an input
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Panel 2: allresources (fleet detail view with resources)
      const allRes = document.getElementById('allresources');
      if (allRes && allRes.offsetParent !== null) {
        e.preventDefault();
        safeClick(allRes);
        return;
      }

      // Panel 1: send_all (ship selection view)
      const sendAll = document.querySelector('.send_all a') || document.getElementById('sendall');
      if (sendAll && sendAll.offsetParent !== null) {
        e.preventDefault();
        safeClick(sendAll);
        return;
      }
    });
  }

  // No auto-action after reload — every step requires user click

  // ── Button position persistence ──

  const getSavedPos = () => {
    const p = safeLS.json(POS_KEY);
    return (p && typeof p.x === 'number' && typeof p.y === 'number') ? p : null;
  };

  const showEnterButton = () => {
    if (document.getElementById('oge-mobile-enter')) return;
    const btn = document.createElement('button');
    btn.id = 'oge-mobile-enter';
    btn.type = 'button';
    btn.tabIndex = 0;
    btn.setAttribute('aria-label', 'Send expedition');
    // Context-aware label
    const isFleetPage = location.search.includes('component=fleetdispatch');
    const hasDispatchBtn = !!document.getElementById('dispatchFleet');
    const hasRoutine = !!document.getElementById('ago_routine_7');
    btn.textContent = isFleetPage ? (hasDispatchBtn ? 'Dispatch!' : hasRoutine ? 'Prepare' : 'Send Exp') : 'Send Exp';
    const size = getSize();
    btn.style.width = size + 'px';
    btn.style.height = size + 'px';
    btn.style.fontSize = Math.round(size * 0.23) + 'px';

    // Restore saved position or default (bottom-right)
    const savedPos = getSavedPos();
    if (savedPos) {
      btn.style.left = Math.min(savedPos.x, window.innerWidth - size) + 'px';
      btn.style.top = Math.min(savedPos.y, window.innerHeight - size) + 'px';
    } else {
      btn.style.right = '20px';
      btn.style.bottom = '20px';
    }

    // ── Drag logic (touch + mouse) ──
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const DRAG_THRESHOLD = 8;

    const onStart = (clientX, clientY) => {
      isDragging = true;
      hasMoved = false;
      startX = clientX;
      startY = clientY;
      const rect = btn.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
    };

    const onMove = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      hasMoved = true;
      btn.classList.add('oge-dragging');
      // Clear right/bottom, use left/top
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
      const newX = Math.max(0, Math.min(startLeft + dx, window.innerWidth - size));
      const newY = Math.max(0, Math.min(startTop + dy, window.innerHeight - size));
      btn.style.left = newX + 'px';
      btn.style.top = newY + 'px';
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      btn.classList.remove('oge-dragging');
      if (hasMoved) {
        safeLS.setJSON(POS_KEY, {
          x: parseInt(btn.style.left, 10),
          y: parseInt(btn.style.top, 10),
        });
      }
    };

    // Touch events
    btn.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      onStart(t.clientX, t.clientY);
    }, { passive: true });

    btn.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      onMove(t.clientX, t.clientY);
      if (hasMoved) e.preventDefault();
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      onEnd();
      if (hasMoved) {
        e.preventDefault();
        return; // Don't trigger click after drag
      }
    });

    // Mouse events (for desktop testing)
    btn.addEventListener('mousedown', (e) => {
      onStart(e.clientX, e.clientY);
      const moveHandler = (ev) => onMove(ev.clientX, ev.clientY);
      const upHandler = () => {
        onEnd();
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
      };
      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });

    // Tap / Enter → Send Exp flow (Enter triggers click natively on <button>)
    btn.addEventListener('click', (e) => {
      if (hasMoved) { hasMoved = false; return; }
      e.preventDefault();
      onSendExpClick();
    });

    document.body.appendChild(btn);
    setupBtnFocusPersist(btn, 'enter');
  };

  const hideEnterButton = () => {
    const btn = document.getElementById('oge-mobile-enter');
    if (btn) btn.remove();
    safeLS.remove(POS_KEY);
  };

  // ── Send Col: Colonize button ──

  const COL_MAX_SYSTEM = 499;
  const COL_MAX_GALAXY = 7;

  // Get home planet coords from active planet in planet list
  const getHomePlanetCoords = () => {
    const active = document.querySelector('#planetList .hightlightPlanet');
    if (!active) return null;
    const coords = active.querySelector('.planet-koords')?.textContent?.trim();
    const m = (coords || '').match(/\[(\d+):(\d+):(\d+)\]/);
    if (!m) return null;
    return { galaxy: parseInt(m[1], 10), system: parseInt(m[2], 10), position: parseInt(m[3], 10) };
  };

  /**
   * Wrap-aware distance between two systems. Galaxy systems wrap around
   * (system 1 is one step away from system 499), so naive `|a - b|` would
   * overestimate distance for cross-boundary pairs.
   *
   * Examples:
   *   sysDist(10, 50)   → 40
   *   sysDist(498, 2)   → 3      (not 496 — wraps via 499→1)
   *
   * @param {number} a  system 1..COL_MAX_SYSTEM
   * @param {number} b  system 1..COL_MAX_SYSTEM
   * @returns {number}  smaller of the two arc distances
   */
  const sysDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, COL_MAX_SYSTEM - d); };

  /**
   * Parse a `oge_colPositions`-style string into an ordered, deduped array of
   * 1..15 ints. The input order is preserved (priority-significant): the first
   * occurrence of a position wins; later duplicates are dropped.
   *
   * Examples:
   *   parsePositions("8")          → [8]
   *   parsePositions("8,9,7")      → [8, 9, 7]      // 8 has priority over 9 over 7
   *   parsePositions("1,3-5,8")    → [1, 3, 4, 5, 8]
   *   parsePositions("8,8,9")      → [8, 9]         // dedup
   *   parsePositions("0,16,5")     → [5]            // out-of-range silently dropped
   *
   * @param {string} str  comma-separated position list with optional ranges
   * @returns {number[]}  ordered list of 1..15 ints
   */
  const parsePositions = (str) => {
    const positions = [];
    const seen = new Set();
    for (const part of (str || '8').split(',')) {
      const trimmed = part.trim();
      const range = trimmed.match(/^(\d+)-(\d+)$/);
      if (range) {
        const from = parseInt(range[1], 10);
        const to = parseInt(range[2], 10);
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
          if (i >= 1 && i <= 15 && !seen.has(i)) { positions.push(i); seen.add(i); }
        }
      } else {
        const n = parseInt(trimmed, 10);
        if (n >= 1 && n <= 15 && !seen.has(n)) { positions.push(n); seen.add(n); }
      }
    }
    return positions;
  };

  /**
   * Build the galaxy traversal order starting from home, expanding outward
   * in alternating ±1 steps. Used to prioritise nearer galaxies for both scan
   * and send (closer = shorter flight times = better for colonization).
   *
   * Example for homeGalaxy=4 (with COL_MAX_GALAXY=7):
   *   → [4, 5, 3, 6, 2, 7, 1]
   *
   * @param {number} homeGalaxy  galaxy of the active planet (1..COL_MAX_GALAXY)
   * @returns {number[]}  all galaxies, near-first
   */
  const buildGalaxyOrder = (homeGalaxy) => {
    const order = [homeGalaxy];
    for (let d = 1; d <= Math.floor(COL_MAX_GALAXY / 2); d++) {
      const g1 = ((homeGalaxy - 1 + d) % COL_MAX_GALAXY) + 1;
      const g2 = ((homeGalaxy - 1 - d + COL_MAX_GALAXY) % COL_MAX_GALAXY) + 1;
      if (!order.includes(g1)) order.push(g1);
      if (!order.includes(g2)) order.push(g2);
    }
    return order;
  };

  // Re-scan policy: how stale a position must be (ms) before we re-scan its system.
  // Statuses not listed here NEVER trigger a re-scan (empty/mine/admin are stable).
  // `abandoned` uses a dynamic deadline instead (see `abandonedCleanupDeadline`).
  const RESCAN_AFTER = {
    reserved:      24 * 3600 * 1000,        // 24h — someone reserved slot for planet-move (cooldown ~22h in practice)
    inactive:      5 * 24 * 3600 * 1000,    // 5 days — i flag (7-28 days inactive)
    long_inactive: 5 * 24 * 3600 * 1000,    // 5 days — I flag (28+ days inactive)
    vacation:      30 * 24 * 3600 * 1000,   // 30 days
    banned:        30 * 24 * 3600 * 1000,   // 30 days
    occupied:      30 * 24 * 3600 * 1000,   // 30 days — active player
    empty_sent:    4 * 3600 * 1000,         // 4h — our fleet should have arrived; verify what happened
  };

  /**
   * Earliest wall-clock time at which the game will have cleaned up an
   * `abandoned` slot we first observed at `scannedAt`.
   *
   * OGame mechanics (per FAQ): the "Porzucona planeta" marker persists for
   * 24-48h after abandon. The cleanup sweep runs at **3 AM server time**
   * each day, removing any abandoned planet whose 24h grace period has
   * already elapsed.
   *
   * Deadline = first 3 AM that is strictly after (`scannedAt` + 24h).
   * Yields variable waits of 25h-47h (avg ~36h), perfectly tracking
   * the game's actual sweep — one rescan cycle is always sufficient
   * (no double-rescan like naive 24h threshold, no over-waiting like
   * fixed 48h).
   *
   * Assumption: browser local TZ matches server TZ. For PL users on the
   * PL server both are Europe/Warsaw — exact match. If a user ever runs
   * a different TZ against this server, the deadline will be off by the
   * TZ delta (1-2h at most) — still far better than any fixed threshold.
   *
   * @param {number} scannedAt  ms timestamp of the observation that saw 'abandoned'
   * @returns {number}  ms timestamp of expected cleanup
   */
  const abandonedCleanupDeadline = (scannedAt) => {
    const earliest = scannedAt + 24 * 3600 * 1000;
    const deadline = new Date(earliest);
    deadline.setHours(3, 0, 0, 0);             // 3 AM local of that day
    if (deadline.getTime() < earliest) {       // 3 AM already passed that day → next day
      deadline.setDate(deadline.getDate() + 1);
    }
    return deadline.getTime();
  };

  /**
   * Returns true iff this system's stored scan is old enough that we should
   * re-observe it. A system is stale iff ANY of its positions has either:
   *   - a status listed in RESCAN_AFTER whose threshold has elapsed, OR
   *   - status `abandoned` and the dynamic cleanup deadline has passed
   *
   * Statuses without a threshold and not special-cased (`empty`, `mine`,
   * `admin`) NEVER trigger re-scan — they're considered stable.
   *
   * @param {object} scan  SystemScan from oge_galaxyScans (see SCHEMAS.md)
   * @returns {boolean}    true if needs re-scan, false if fresh enough
   */
  const isSystemStale = (scan) => {
    if (!scan?.positions || !scan.scannedAt) return true; // no data yet → needs scan
    const age = Date.now() - scan.scannedAt;
    for (const p of Object.values(scan.positions)) {
      if (p.status === 'abandoned') {
        if (Date.now() >= abandonedCleanupDeadline(scan.scannedAt)) return true;
        continue;
      }
      const threshold = RESCAN_AFTER[p.status];
      if (threshold && age > threshold) return true;
    }
    return false;
  };

  /**
   * Pick the next system to scan. Strictly sequential +1 traversal — anti-bot
   * detection systems flag distance-based jumping (e.g. 200, 199, 201, 198,
   * 202, ...) as non-human, so we always advance to the immediately neighboring
   * system.
   *
   * Starting point:
   *   - On galaxy view → continue from current (galaxy, system) + 1
   *   - Elsewhere      → home galaxy, home.system + 1
   *
   * Galaxy progression: when the current galaxy is exhausted (all systems
   * scanned and fresh), jump to the next galaxy in `buildGalaxyOrder`
   * priority and start from system 1 there. One galaxy-jump per full sweep
   * mirrors how a human switches galaxies after exploring one.
   *
   * @param {(target: {galaxy: number, system: number} | null) => void} callback
   *        invoked with the next system to scan, or null if everything
   *        is already fresh (per RESCAN_AFTER policy).
   */
  const getNextScanSystem = (callback) => {
    const home = getHomePlanetCoords();
    if (!home) return callback(null);

    const params = new URLSearchParams(location.search);
    const isGalaxyView = location.search.includes('component=galaxy');
    const startG = (isGalaxyView && params.get('galaxy')) ? +params.get('galaxy') : home.galaxy;
    const startS = (isGalaxyView && params.get('system')) ? +params.get('system') : home.system;

    const store = getExtStorage();
    if (!store) return callback(null);

    try {
      store.get('oge_galaxyScans', (result) => {
        const scans = (result && result.oge_galaxyScans) || {};
        const galaxyOrder = buildGalaxyOrder(home.galaxy);
        const startGalaxyIdx = Math.max(0, galaxyOrder.indexOf(startG));

        for (let gi = 0; gi < galaxyOrder.length; gi++) {
          const g = galaxyOrder[(startGalaxyIdx + gi) % galaxyOrder.length];
          // Current galaxy: start at startS+1 (and wrap). Other galaxies: start at 1.
          const offset = (gi === 0) ? startS : 0;
          for (let i = 0; i < COL_MAX_SYSTEM; i++) {
            const s = ((offset + i) % COL_MAX_SYSTEM) + 1;
            const scan = scans[g + ':' + s];
            if (!scan || isSystemStale(scan)) {
              return callback({ galaxy: g, system: s });
            }
          }
        }
        callback(null); // everything scanned and fresh
      });
    } catch { callback(null); }
  };

  /**
   * Pick the next colonization target from the local scan database.
   *
   * Hard filter: only positions in the user's `oge_colPositions` list are
   * ever considered. Within those, iteration follows the user's priority
   * order (the array returned by `parsePositions`).
   *
   * Two-stage filtering for double-send prevention:
   *   1. `scan.positions[pos].status === 'empty'` (game-observed empty slot)
   *   2. `inFlight` set built from `oge_colonizationRegistry` —
   *      excludes coords with `arrivalAt > Date.now()` (our pending fleet).
   *      This is the second line of defence after content.js's empty_sent
   *      preservation in oge:galaxyScanned merge.
   *
   * Galaxy order (configurable via `oge_colPreferOtherGalaxies`):
   *   - default (OFF): [home, home+1, home-1, home+2, home-2, ...]
   *   - ON:            [home+1, home-1, home+2, home-2, ..., home]
   *     Home moved to the end — trades fast home-galaxy sends for
   *     predictable min-gap timing. Within the same galaxy, flight time
   *     varies wildly with system distance; across galaxies, the
   *     galaxy-jump dominates so destinations have near-uniform flight
   *     times. The toggle lets the user choose which they'd rather have.
   *
   * System order (within each galaxy):
   *   - home galaxy → farthest first (better arrival-time spreading)
   *   - other galaxies → 1..499 sequential
   *
   * @param {(target: {galaxy: number, system: number, position: number, link: string} | null) => void} callback
   *        invoked with the next candidate, or null if no eligible target.
   */
  const findNextColonizeTarget = (callback) => {
    const targets = parsePositions(safeLS.get('oge_colPositions') || '8');
    if (targets.length === 0) return callback(null);
    const home = getHomePlanetCoords();
    if (!home) return callback(null);

    const store = getExtStorage();
    if (!store) return callback(null);

    // Sync read of in-flight coords from localStorage (moved from chrome.storage
    // in 4.8.5 — see fleet-redirect.js for why). Always fresh; no race.
    let reg = [];
    try { reg = JSON.parse(localStorage.getItem('oge_colonizationRegistry') || '[]'); } catch {}
    const inFlight = new Set(
      reg.filter(r => (r.arrivalAt || 0) > Date.now()).map(r => r.coords)
    );

    try {
      store.get('oge_galaxyScans', (data) => {
        const scans = (data && data.oge_galaxyScans) || {};

        const galaxyOrder = buildGalaxyOrder(home.galaxy);
        const orderedGalaxies = safeLS.bool('oge_colPreferOtherGalaxies')
          ? [...galaxyOrder.slice(1), galaxyOrder[0]]
          : galaxyOrder;

        for (const g of orderedGalaxies) {
          // Send: farthest first in home galaxy, sequential elsewhere
          const systems = (g === home.galaxy)
            ? Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1)
                .sort((a, b) => sysDist(b, home.system) - sysDist(a, home.system))
            : Array.from({ length: COL_MAX_SYSTEM }, (_, i) => i + 1);

          for (const s of systems) {
            const scan = scans[g + ':' + s];
            if (!scan?.positions) continue;
            for (const pos of targets) {
              const p = scan.positions[pos];
              if (!p || p.status !== 'empty') continue;
              const coordKey = g + ':' + s + ':' + pos;
              if (inFlight.has(coordKey)) continue;
              const base = location.href.split('?')[0];
              const link = base + '?page=ingame&component=fleetdispatch'
                + '&galaxy=' + g + '&system=' + s
                + '&position=' + pos + '&type=1&mission=7&am208=1';
              return callback({ galaxy: g, system: s, position: pos, link });
            }
          }
        }
        callback(null);
      });
    } catch { callback(null); }
  };

  const getColSavedPos = () => {
    const p = safeLS.json(COL_POS_KEY);
    return (p && typeof p.x === 'number' && typeof p.y === 'number') ? p : null;
  };

  const getColMinGap = () => safeLS.int('oge_colMinGap', 20);

  /**
   * Compute how many seconds we must wait before dispatching the current
   * fleetdispatch's mission=7 to keep min-gap with all our pending
   * colonization arrivals. Fully synchronous — registry lives in localStorage
   * (since 4.8.5) and `#durationOneWay` is a DOM node. Must still be called
   * from a sync click handler, before any await/then, so the DOM hasn't been
   * rewritten by game-side reactions.
   *
   * Algorithm:
   *   ourArrival = Date.now() + parseDuration(#durationOneWay)
   *   for each pending entry r in registry (arrivalAt > now):
   *     gap = |ourArrival - r.arrivalAt|
   *     if gap < minGap: candidateWait = minGap - gap
   *   wait = max(candidateWait)   // worst conflict wins
   *
   * Returns 0 (safe to send) when:
   *   - #durationOneWay missing or unparseable
   *   - no registry conflicts within minGap window
   *
   * @returns {number}  whole seconds to wait (Math.ceil), 0 if safe
   * @see SCHEMAS.md#oge_colonizationregistry
   */
  const getColonizeWaitTime = () => {
    const durationEl = document.getElementById('durationOneWay');
    if (!durationEl) return 0;
    const parts = durationEl.textContent.trim().split(':').map(Number);
    let durationSec = 0;
    if (parts.length === 3) durationSec = parts[0]*3600 + parts[1]*60 + parts[2];
    else if (parts.length === 4) durationSec = parts[0]*86400 + parts[1]*3600 + parts[2]*60 + parts[3];
    if (!durationSec) return 0;

    const now = Date.now();
    const ourArrival = now + durationSec * 1000;
    const minGapMs = getColMinGap() * 1000;

    // Defensive: coerce arrivalAt/sentAt to Number, in case older entries
    // ever stored them as strings (no current write path does this, but the
    // cost is one map — worth the safety against silent NaN comparisons).
    let reg = [];
    try {
      reg = (JSON.parse(localStorage.getItem('oge_colonizationRegistry') || '[]') || [])
        .map(r => ({
          coords: r.coords,
          sentAt: Number(r.sentAt) || 0,
          arrivalAt: Number(r.arrivalAt) || 0,
        }));
    } catch {}
    const pending = reg.filter(r => r.arrivalAt > now);

    let maxWaitMs = 0;
    const conflicts = [];
    for (const r of pending) {
      const gap = Math.abs(ourArrival - r.arrivalAt);
      if (gap < minGapMs) {
        const wait = minGapMs - gap;
        if (wait > maxWaitMs) maxWaitMs = wait;
        conflicts.push({ coords: r.coords, gapSec: Math.round(gap / 1000), waitSec: Math.round(wait / 1000) });
      }
    }

    // Optional diagnostic log — enable by setting localStorage.setItem('oge_debugMinGap', 'true').
    // Emits a compact dump at every min-gap computation so the user can see
    // exactly what was in the registry and why a block did or didn't fire.
    if (safeLS.bool('oge_debugMinGap')) {
      const iso = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
      console.debug('[OG-E min-gap]', {
        ourDuration: durationSec + 's',
        ourArrival: iso(ourArrival),
        minGap: (minGapMs / 1000) + 's',
        pendingCount: pending.length,
        pending: pending.map(r => ({
          coords: r.coords,
          arrival: iso(r.arrivalAt),
          gapSec: Math.round(Math.abs(ourArrival - r.arrivalAt) / 1000),
        })),
        conflicts,
        resultWaitSec: Math.ceil(maxWaitMs / 1000),
      });
    }

    return Math.ceil(maxWaitMs / 1000);
  };

  let colWaitInterval = null;
  let pendingColLink = null;
  // Armed after checkTarget reports stale; disarmed after the navigation or
  // after a successful 'Ready' check. While armed, the next Send click takes
  // the user to the galaxy view of the stale system so the game's own
  // fetchGalaxyContent refreshes our DB for that system (reservedPositions
  // etc.) — 1 click → 1 location.href → 1 game request.
  let staleRetryActive = false;
  // Coords of the stale target (set in the checkTargetResult handler, used
  // by the Send click branch to build the galaxy-view URL).
  let staleTargetCoords = null;

  /**
   * Send button action on fleetdispatch?mission=7. Checks min-gap; if a wait
   * is needed, paints "Wait Xs" on the Send half and starts a 1Hz countdown
   * to "Dispatch!" — user must click again to actually send (we never auto-fire).
   * Otherwise synthesises Enter on the focused element to trigger the form's
   * native submit handler (which the game wires to fire sendFleet via its own JS).
   *
   * Fully synchronous since 4.8.5 (registry moved to localStorage).
   */
  const dispatchColonizeWithGapCheck = () => {
    const waitSec = getColonizeWaitTime();
    const sendEl = document.getElementById('oge-col-send');

    if (waitSec > 0 && sendEl) {
      sendEl.style.background = 'rgba(200, 200, 0, 0.8)';
      sendEl.textContent = 'Wait ' + waitSec + 's';

      if (colWaitInterval) clearInterval(colWaitInterval);
      let remaining = waitSec;
      colWaitInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(colWaitInterval);
          colWaitInterval = null;
          sendEl.style.background = 'rgba(0, 200, 0, 0.85)';
          sendEl.textContent = 'Dispatch!';
        } else {
          sendEl.textContent = 'Wait ' + remaining + 's';
        }
      }, 1000);
      return;
    }

    // Safe to send — synthesize Enter on the fleet form
    const target = document.activeElement || document;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
    target.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
  };

  // Listen for galaxy scan results from colonize.js (MAIN world).
  // New schema: detail = { galaxy, system, scannedAt, positions: { 1..15: {...} }, canColonize }
  document.addEventListener('oge:galaxyScanned', (e) => {
    const { galaxy, system, positions, canColonize } = e.detail || {};
    if (!positions) return;

    const sendHalf = document.getElementById('oge-col-send');
    const scanHalf = document.getElementById('oge-col-scan');
    if (!sendHalf || !scanHalf) return;

    // Find first target position that's empty (in user's priority order)
    const targets = parsePositions(safeLS.get('oge_colPositions') || '8');
    let foundPos = null;
    for (const pos of targets) {
      if (positions[pos]?.status === 'empty') { foundPos = pos; break; }
    }

    if (foundPos && canColonize) {
      const base = location.href.split('?')[0];
      pendingColLink = base + '?page=ingame&component=fleetdispatch'
        + '&galaxy=' + galaxy + '&system=' + system
        + '&position=' + foundPos + '&type=1&mission=7&am208=1';
      sendHalf.style.background = 'rgba(0, 200, 0, 0.85)';
      sendHalf.textContent = 'Found! Go';
      scanHalf.textContent = 'Skip';
    } else if (foundPos && !canColonize) {
      pendingColLink = null;
      sendHalf.style.background = 'rgba(200, 0, 0, 0.8)';
      sendHalf.textContent = 'No ship!';
      scanHalf.textContent = 'Scan next';
    } else {
      pendingColLink = null;
      sendHalf.style.background = 'rgba(0, 160, 0, 0.75)';
      sendHalf.textContent = 'Send';
      scanHalf.textContent = 'Scan next';
    }
  });

  // Helper used by Scan flow when on galaxy view: in-page nav (faster than full reload)
  const navigateToSystem = (galaxy, system) => {
    const galInput = document.getElementById('galaxy_input');
    const sysInput = document.getElementById('system_input');
    if (!sysInput) return false;
    if (galInput) galInput.value = galaxy;
    sysInput.value = system;
    const submitBtn = document.querySelector('.btn_blue[onclick*="submitForm"]')
      || document.querySelector('#galaxyHeader .btn_blue');
    if (submitBtn) { submitBtn.click(); return true; }
    return false;
  };

  // ── Stale-target verification on fleetdispatch?mission=7 ──
  //
  // Passive XHR observer (colonize.js MAIN world) watches the game's own
  // checkTarget request (fired automatically by the game whenever galaxy /
  // system / position inputs change on fleetdispatch). Its response carries
  // enough info to tell us whether our pending send is still viable.
  //
  // Three outcomes we distinguish:
  //   1. colonizable → label "Ready! [g:s:p]"
  //   2. error 140016 "reserved for planet-move" → mark 'reserved' (24h re-scan)
  //                 + label "Reserved — click Send to check system"
  //   3. any other failure → mark 'abandoned' (24h re-scan)
  //                 + label "Stale — click Send to check system"
  //
  // Stale-retry (cases 2 + 3): the user's NEXT Send click calls
  // `navigateToStaleSystem()` — a single `location.href = galaxy-view-url`.
  // The game then refreshes its own fetchGalaxyContent, colonize.js observes
  // the response, content.js merges it into the DB (including reservedPositions
  // metadata). User lands on galaxy view and can inspect + choose next step.
  //
  // Strict 1:1: each user click triggers AT MOST one location.href navigation.
  // No form manipulation, no silent retry loops. Earlier (4.7.x) versions
  // auto-swapped fleetdispatch form fields to the next DB candidate —
  // effective but invisible, and didn't reveal reserved-for-move state.
  //
  // Pending state is stored in localStorage (`oge_pendingColVerify`) so we
  // know across page-loads which target was sent through OUR Send Col flow
  // vs the user manually typing into the form (we never touch a
  // manually-entered target).
  const COL_VERIFY_KEY = 'oge_pendingColVerify';

  const setColVerifyState = (galaxy, system, position) => {
    safeLS.setJSON(COL_VERIFY_KEY, { galaxy, system, position, ts: Date.now() });
  };
  const getColVerifyState = () => {
    const v = safeLS.json(COL_VERIFY_KEY);
    if (!v || !v.ts) return null;
    if (Date.now() - v.ts > 5 * 60 * 1000) { // 5 min stale
      safeLS.remove(COL_VERIFY_KEY);
      return null;
    }
    return v;
  };
  const clearColVerifyState = () => safeLS.remove(COL_VERIFY_KEY);

  /**
   * Mark a single position as 'abandoned' in oge_galaxyScans. Called from the
   * stale-target handler when checkTarget reports our previously-empty slot
   * is no longer colonizable.
   *
   * Status choice rationale: we don't know what actually happened (someone
   * colonized, debris, ...). 'abandoned' triggers re-scan after 24h
   * (vs 30 days for 'occupied'), giving us quick reality check.
   *
   * @param {number} g          galaxy
   * @param {number} s          system
   * @param {number} p          position 1..15
   * @param {() => void} [callback]  invoked after store.set completes
   */
  const markPositionAbandoned = (g, s, p, callback) => {
    const store = getExtStorage();
    if (!store) return callback && callback();
    store.get('oge_galaxyScans', (data) => {
      const scans = (data && data.oge_galaxyScans) || {};
      const key = g + ':' + s;
      if (!scans[key]) scans[key] = { scannedAt: Date.now(), positions: {} };
      if (!scans[key].positions) scans[key].positions = {};
      scans[key].positions[p] = { status: 'abandoned', flags: { hasAbandonedPlanet: true } };
      scans[key].scannedAt = Date.now();
      store.set({ oge_galaxyScans: scans }, callback);
    });
  };

  /**
   * Mark a position as 'reserved' in oge_galaxyScans. Triggered when checkTarget
   * returns error 140016 ("Planeta została już zarezerwowana do przeniesienia")
   * or when `reservedPositions` in fetchGalaxyContent flags the slot. Re-scan
   * policy: 24h (cooldown in practice is ~22h, after which the reservation
   * expires and the slot becomes colonizable again).
   *
   * @param {number} g
   * @param {number} s
   * @param {number} p
   * @param {() => void} [callback]
   */
  const markPositionReserved = (g, s, p, callback) => {
    const store = getExtStorage();
    if (!store) return callback && callback();
    store.get('oge_galaxyScans', (data) => {
      const scans = (data && data.oge_galaxyScans) || {};
      const key = g + ':' + s;
      if (!scans[key]) scans[key] = { scannedAt: Date.now(), positions: {} };
      if (!scans[key].positions) scans[key].positions = {};
      scans[key].positions[p] = { status: 'reserved' };
      scans[key].scannedAt = Date.now();
      store.set({ oge_galaxyScans: scans }, callback);
    });
  };

  // Game's checkTarget error codes we recognise.
  const ERR_RESERVED_FOR_MOVE = 140016;

  // Listen for checkTarget responses dispatched by colonize.js MAIN-world hook.
  // detail shape — see SCHEMAS.md#ogechecktargetresult.
  // Extended in 4.9.2 with `success` and `errorCodes` so we can distinguish a
  // 'reserved for planet move' slot (error 140016) from a generic stale result.
  document.addEventListener('oge:checkTargetResult', (e) => {
    const verify = getColVerifyState();
    if (!verify) return; // not in our Send Col flow — ignore (user manually browsing)

    const { galaxy, system, position, success, targetOk, targetInhabited, orders, errorCodes } = e.detail || {};
    if (!galaxy || !system || !position) return;

    // Only react when result is for the coords we're currently verifying
    if (galaxy !== verify.galaxy || system !== verify.system || position !== verify.position) {
      return;
    }

    const sendEl = document.getElementById('oge-col-send');
    const setLabel = (text, color) => {
      if (sendEl) {
        sendEl.textContent = text;
        if (color) sendEl.style.background = color;
      }
    };

    const colonizable = success && targetOk && orders && orders['7'] === true && !targetInhabited;
    if (colonizable) {
      // All good — position is genuinely empty and colonize mission available
      setLabel('Ready! [' + galaxy + ':' + system + ':' + position + ']', 'rgba(0,200,0,0.85)');
      clearColVerifyState();
      staleRetryActive = false;
      staleTargetCoords = null;
      return;
    }

    // Unreachable for colonize. Distinguish known "reserved for move" case
    // (fiolet label + specific DB marker) from generic stale (orange + 'abandoned').
    // Either way, next Send click navigates to the galaxy view of this system
    // so the game's own fetchGalaxyContent refreshes our DB.
    const isReserved = Array.isArray(errorCodes) && errorCodes.includes(ERR_RESERVED_FOR_MOVE);
    if (isReserved) {
      markPositionReserved(galaxy, system, position);
      setLabel('Reserved — click Send to check system', 'rgba(160,60,200,0.85)');
    } else {
      markPositionAbandoned(galaxy, system, position);
      setLabel('Stale — click Send to check system', 'rgba(200,80,0,0.85)');
    }
    staleRetryActive = true;
    staleTargetCoords = { galaxy, system, position };
    clearColVerifyState();
  });

  /**
   * Handle Send click while in "Stale — click Send" state. Navigates to the
   * galaxy view for the stale target's system — the game then fires its own
   * fetchGalaxyContent, our MAIN-world `colonize.js` hook observes the response
   * (including `reservedPositions`), and the DB gets a fresh, authoritative
   * snapshot for the entire system. User can then decide next step visually.
   *
   * Replaces 4.7.x's `retryWithNextCandidate` (which swapped form fields
   * silently — effective but invisible). Trade-off accepted because:
   *   - Reserved-for-move slots look like empty in galaxy listings and were
   *     causing repeat dispatches to same coords; a visual check is the
   *     right UX here
   *   - 1 click → 1 location.href → 1 game request is the simplest possible
   *     TOS-compliant primitive
   */
  const navigateToStaleSystem = () => {
    if (!staleTargetCoords) return;
    const { galaxy, system } = staleTargetCoords;
    staleRetryActive = false;
    staleTargetCoords = null;
    const base = location.href.split('?')[0];
    location.href = base + '?page=ingame&component=galaxy&galaxy=' + galaxy + '&system=' + system;
  };

  // ── Abandon colony logic (on overview page) ──

  const getMinFields = () => safeLS.int('oge_colMinFields', 200);
  const getColPassword = () => safeLS.get('oge_colPassword') || '';

  /**
   * Decide whether the current page is showing a freshly-colonised planet
   * that's too small to keep (trigger condition for the Abandon helper).
   *
   * Conditions ALL must hold:
   *   - URL contains `component=overview`
   *   - `#diameterContentField` exists and parses as `(used/max)`
   *   - `used === 0` (no buildings yet — definitely fresh)
   *   - `max < oge_colMinFields` (below user's keep-threshold)
   *
   * @returns {{used: number, max: number, minFields: number} | null}
   *          object with the parsed values when abandon is warranted, else null
   */
  const checkAbandonState = () => {
    if (!location.search.includes('component=overview')) return null;
    const diameterEl = document.getElementById('diameterContentField');
    if (!diameterEl) return null;
    const m = diameterEl.textContent.match(/\((\d+)\/(\d+)\)/);
    if (!m) return null;
    const used = parseInt(m[1], 10);
    const max = parseInt(m[2], 10);
    if (used !== 0) return null; // not a fresh colony
    const minFields = getMinFields();
    if (max >= minFields) return null; // big enough, keep it
    return { used, max, minFields };
  };

  // ── Abandon flow: 3 user clicks, 3 game requests (1:1 TOS-compliant) ──
  //
  // Context: on mobile the game's native buttons are too small to tap reliably
  // (page auto-scales to ~50%, zoom resets on AJAX refresh). Our Abandon helper
  // relays each user click to one game action.
  //
  // Why "inject buttons inside the game's popup" for clicks 2 and 3:
  // Click 1 opens game's rename/giveup popup. Subsequent clicks on our own
  // floating button (outside the popup DOM) caused the popup to close on mobile
  // — jQuery UI dialog's focus management treats "click on element outside
  // dialog" as a focus leave and hides the popup. Fix: we inject our big
  // "submit" and "confirm" buttons INSIDE the dialog's DOM, so clicks on them
  // count as clicks inside the popup (focus stays within dialog, no close).
  //
  // Strict 1:1 user click → game HTTP request mapping:
  //
  //   Click 1 (user taps floating Abandon button):
  //     safeClick(.openPlanetRenameGiveupBox)  → GAME: GET /planetlayer
  //     + pure-DOM: click #block, autofill password (no HTTP)
  //     + overlay orange "SUBMIT PASSWORD" button across the popup content
  //
  //   Click 2 (user taps overlaid Submit button — it covers the whole popup):
  //     safeClick(submitBtn)                    → GAME: POST /confirmPlanetGiveup
  //     + overlay red "⚠ CONFIRM DELETE ⚠" button across confirm dialog
  //
  //   Click 3 (user taps overlaid CONFIRM DELETE):
  //     safeClick(.yes)                         → GAME: POST /planetGiveup
  //     + cleanup local DB + reload
  //
  // 4.9.3 UI change: proxy buttons now use `position:absolute; inset:0` to
  // fully cover the game's popup content (rather than being appended below
  // it with forced min-width). Eliminates the dialog-width expansion dance
  // and makes the action unambiguous — user sees ONLY our button in the
  // popup, not game's description text or native buttons.
  //
  // Why safeClick for game elements: many OGame buttons are <a href="javascript:…">
  // — calling .click() on them triggers the javascript: navigation, which the
  // page's CSP blocks (no 'unsafe-inline'). safeClick strips the href first so
  // only the addEventListener handlers fire — no inline navigation.
  //
  // Three layers of safety against accidental deletion of a built-up planet:
  //   1. Floating Abandon button only appears when checkAbandonState() valid
  //      (used==0, max < settings.minFields).
  //   2. #giveupCoordinates (after click 1) must match planet's coords.
  //   3. Confirmation dialog text (after click 2) must include our coords.

  /**
   * Post-abandon cleanup: mark the slot 'abandoned' in `oge_galaxyScans` (24h
   * re-scan policy will pick up the eventual debris-clear).
   *
   * We INTENTIONALLY do NOT touch `oge_colonyHistory` here. Rationale:
   * colonyHistory is the SIZE-HISTOGRAM dataset — every fresh observation of
   * a newly-colonized planet (usedFields==0) is a valid data point for the
   * distribution of possible planet sizes on the user's target position(s).
   * Abandoned planets are in fact the MOST important data points (they're
   * the small ones — without them the histogram's left tail disappears).
   *
   * Earlier versions (≤ 4.8.2) removed the entry here on the assumption that
   * "histogram = our current colonies"; this discarded ~95% of useful
   * statistical data in practice (typical flow: 20 colonized → 19 abandoned
   * as too small → only 1 row survived in the histogram). Fixed in 4.8.3.
   *
   * Note: if the user decides later that they want "current-only" mode,
   * add a boolean flag on entries (`abandoned: true`) instead of removing
   * — preserves the dataset while letting the UI filter.
   *
   * @param {number} g  galaxy
   * @param {number} s  system
   * @param {number} p  position
   * @returns {Promise<void>}  resolves after store.set completes
   */
  const cleanupAbandonedPlanet = (g, s, p) => new Promise((resolve) => {
    const store = getExtStorage();
    if (!store) return resolve();

    store.get('oge_galaxyScans', (data) => {
      const updates = {};

      // Mark position as abandoned in scan DB (preserves other positions in this system)
      const scans = (data && data.oge_galaxyScans) || {};
      const sysKey = g + ':' + s;
      if (!scans[sysKey]) scans[sysKey] = { scannedAt: Date.now(), positions: {} };
      if (!scans[sysKey].positions) scans[sysKey].positions = {};
      scans[sysKey].positions[p] = { status: 'abandoned', flags: { hasAbandonedPlanet: true } };
      scans[sysKey].scannedAt = Date.now();
      updates.oge_galaxyScans = scans;

      store.set(updates, resolve);
    });
  });

  // Helper: poll for a DOM condition (returns truthy value or null on timeout)
  const waitFor = (predicate, timeoutMs = 5000, intervalMs = 100) => new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const result = predicate();
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });

  // Flag to prevent re-entry if user rapidly clicks Abandon multiple times
  let abandonInProgress = false;

  /**
   * Construct a big action button that **fully covers** the game's popup
   * content area. Inserted INSIDE the popup DOM (focus stays in dialog scope
   * on mobile — jQuery UI would otherwise close it on outside-click), but
   * positioned `absolute; inset: 0` so it overlays whatever game content was
   * there (form fields, Polish description, native yes/no buttons, ...).
   *
   * Why overlay vs. append-below:
   *   Earlier versions (≤4.9.2) appended below content + forced dialog
   *   width to 600px + tall padding to make the tap target big enough.
   *   Overlay is simpler — no size forcing, no viewport-edge recentering.
   *   The game's own field values we need (password) are already auto-filled
   *   programmatically before injection; the native confirm buttons are
   *   still clicked via `safeClick()` from our click handler, independent
   *   of their z-order.
   *
   * Caller responsibilities (both done by the two callers in abandonPlanet):
   *   - Set `parent.style.position = 'relative'` so our `inset:0` anchors
   *     to the content area.
   *   - Optionally set `parent.style.minHeight` for a reasonable minimum
   *     tap area when the original content was tiny.
   *
   * @param {string} text     button label
   * @param {string} bgColor  CSS background color
   * @returns {HTMLButtonElement}  unattached button element
   */
  const makeInjectedButton = (text, bgColor) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.style.cssText = [
      'position:absolute', 'inset:0',
      'width:100%', 'height:100%', 'box-sizing:border-box',
      'margin:0', 'padding:16px',
      'background:' + bgColor, 'color:#fff',
      'font-size:24px', 'font-weight:bold', 'text-align:center',
      'display:flex', 'align-items:center', 'justify-content:center',
      'border:3px solid #fff', 'border-radius:10px',
      'cursor:pointer', 'touch-action:manipulation',
      'z-index:10',
    ].join(';');
    return btn;
  };

  /**
   * 3-click abandon flow with strict 1:1 user-click → game-request mapping.
   *
   * Flow:
   *   Click 1 (user taps floating Abandon)        → GAME: GET /planetlayer
   *           + pure-DOM: click #block, autofill password, inject Submit button
   *   Click 2 (user taps injected Submit in popup) → GAME: POST /confirmPlanetGiveup
   *           + inject Confirm button in error dialog
   *   Click 3 (user taps injected Confirm)         → GAME: POST /planetGiveup
   *           + cleanup local DB + reload
   *
   * Three independent safety checks:
   *   1. checkAbandonState() must hold (overview, used==0, max < minFields)
   *   2. #giveupCoordinates after click 1 must equal expectedCoords
   *   3. Confirm dialog text must contain expectedCoords
   *
   * Watchdogs detect manual popup-close between steps and abort cleanly.
   *
   * @returns {Promise<void>}  resolves after reload (or aborts silently)
   */
  const abandonPlanet = async () => {
    if (abandonInProgress) return;
    const scanEl = document.getElementById('oge-col-scan');
    const setLabel = (text, color) => {
      if (scanEl) {
        scanEl.textContent = text;
        if (color) scanEl.style.background = color;
      }
    };

    // Safety #1: re-verify abandon condition (page may have changed since UI rendered)
    if (!checkAbandonState()) { setLabel('Cancelled', 'rgba(150,150,150,0.8)'); return; }

    // Safety #2: capture planet coords for later verification
    const currentCoordsEl = document.querySelector('#positionContentField a');
    const m = (currentCoordsEl?.textContent?.trim() || '').match(/\[(\d+):(\d+):(\d+)\]/);
    if (!m) { setLabel('No coords', 'rgba(200,0,0,0.8)'); return; }
    const expectedCoords = '[' + m[1] + ':' + m[2] + ':' + m[3] + ']';

    // Safety #3: password configured
    const password = getColPassword();
    if (!password) { setLabel('Set password!', 'rgba(200,100,0,0.8)'); return; }

    abandonInProgress = true;
    setLabel('Opening…', 'rgba(200,150,0,0.85)');

    try {
      // ═══ Click 1 work: open popup + reveal form + autofill + inject Submit button ═══

      const giveupLink = document.querySelector('.openPlanetRenameGiveupBox');
      if (!giveupLink) { setLabel('No giveup link', 'rgba(200,0,0,0.8)'); return; }
      safeClick(giveupLink); // HTTP: game does GET /planetlayer

      // Wait for popup; verify it shows OUR planet
      const giveupCoordsEl = await waitFor(() => {
        const el = document.getElementById('giveupCoordinates');
        return el && el.textContent.trim() ? el : null;
      }, 5000);
      if (!giveupCoordsEl) { setLabel('Popup timeout', 'rgba(200,0,0,0.85)'); return; }
      if (giveupCoordsEl.textContent.trim() !== expectedCoords) {
        console.warn('[OG-E abandon] coords mismatch');
        setLabel('Coords mismatch!', 'rgba(200,0,0,0.85)');
        return;
      }

      // Pure-DOM ops: reveal password field + autofill (no HTTP)
      const blockBtn = document.getElementById('block');
      if (!blockBtn) { setLabel('No block btn', 'rgba(200,0,0,0.8)'); return; }
      safeClick(blockBtn);

      const validateDiv = await waitFor(() => {
        const el = document.getElementById('validate');
        return el && el.offsetParent !== null ? el : null;
      }, 3000);
      if (!validateDiv) { setLabel('Form hidden', 'rgba(200,0,0,0.85)'); return; }

      const pwField = validateDiv.querySelector('input[type="password"]');
      const nativeSubmit = validateDiv.querySelector('input[type="submit"]');
      if (!pwField || !nativeSubmit) { setLabel('Form incomplete', 'rgba(200,0,0,0.85)'); return; }
      pwField.value = password;
      pwField.dispatchEvent(new Event('input', { bubbles: true }));
      pwField.dispatchEvent(new Event('change', { bubbles: true }));

      // Inject our BIG Submit button INSIDE the popup (so clicks stay within
      // the popup's DOM scope — focus doesn't leave, popup doesn't close).
      const abandonContent = document.getElementById('abandonplanet');
      if (!abandonContent) { setLabel('No popup content', 'rgba(200,0,0,0.85)'); return; }

      const proxySubmit = makeInjectedButton('SUBMIT PASSWORD', '#c07020');
      proxySubmit.id = 'oge-abandon-proxy-submit';
      abandonContent.style.position = 'relative';
      abandonContent.style.minHeight = '200px';
      abandonContent.appendChild(proxySubmit);

      setLabel('Click SUBMIT in popup', 'rgba(200,150,0,0.85)');

      // ═══ Click 2: user taps injected Submit (inside popup) ═══
      await new Promise((resolve, reject) => {
        proxySubmit.addEventListener('click', () => {
          proxySubmit.disabled = true;
          proxySubmit.textContent = 'Submitting…';
          safeClick(nativeSubmit); // HTTP: game does POST /confirmPlanetGiveup
          resolve();
        }, { once: true });
        // Auto-abort if popup closes (user canceled manually)
        const watchdog = setInterval(() => {
          if (!document.getElementById('oge-abandon-proxy-submit')) {
            clearInterval(watchdog);
            reject(new Error('popup closed'));
          }
        }, 500);
      }).catch(() => {
        setLabel('Cancelled by user', 'rgba(150,150,150,0.8)');
        throw new Error('aborted');
      });

      // ═══ Click 2 result: wait for confirm dialog; inject CONFIRM button ═══

      const yesBtn = await waitFor(() => {
        const btn = document.querySelector('#errorBoxDecision .yes')
          || document.querySelector('.errorBox .yes');
        if (!btn) return null;
        const dialog = document.querySelector('#errorBoxDecision') || document.querySelector('.errorBox');
        const dialogText = dialog?.textContent || '';
        if (!dialogText.includes(expectedCoords)) return null;
        return btn;
      }, 5000);
      if (!yesBtn) { setLabel('No confirm dialog', 'rgba(200,0,0,0.85)'); return; }

      const confirmDialog = document.getElementById('errorBoxDecision')
        || document.querySelector('.errorBox');
      if (!confirmDialog) { setLabel('No confirm dialog', 'rgba(200,0,0,0.85)'); return; }

      const proxyConfirm = makeInjectedButton('⚠ CONFIRM DELETE ⚠', '#a02020');
      proxyConfirm.id = 'oge-abandon-proxy-confirm';
      confirmDialog.style.position = 'relative';
      confirmDialog.style.minHeight = '200px';
      confirmDialog.appendChild(proxyConfirm);

      setLabel('Click CONFIRM in popup', 'rgba(200,80,0,0.85)');

      // ═══ Click 3: user taps injected CONFIRM (inside confirm dialog) ═══
      await new Promise((resolve, reject) => {
        proxyConfirm.addEventListener('click', () => {
          proxyConfirm.disabled = true;
          proxyConfirm.textContent = 'Deleting…';
          safeClick(yesBtn); // HTTP: game does POST /planetGiveup
          resolve();
        }, { once: true });
        const watchdog = setInterval(() => {
          if (!document.getElementById('oge-abandon-proxy-confirm')) {
            clearInterval(watchdog);
            reject(new Error('dialog closed'));
          }
        }, 500);
      }).catch(() => {
        setLabel('Cancelled by user', 'rgba(150,150,150,0.8)');
        throw new Error('aborted');
      });

      // ═══ Success: cleanup local DB + reload ═══

      await new Promise(r => setTimeout(r, 800));
      await cleanupAbandonedPlanet(+m[1], +m[2], +m[3]);

      const sendEl = document.getElementById('oge-col-send');
      if (sendEl) {
        sendEl.style.background = 'rgba(100,100,100,0.8)';
        sendEl.textContent = 'Done';
      }
      setLabel('Abandoned!', 'rgba(100,100,100,0.85)');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      if (err.message !== 'aborted') console.warn('[OG-E abandon]', err);
    } finally {
      abandonInProgress = false;
    }
  };

  const showColonizeButton = () => {
    if (document.getElementById('oge-mobile-col')) return;

    const getColSize = () => safeLS.int('oge_colBtnSize', 336);
    const size = getColSize();
    const fontSize = Math.round(size * 0.12) + 'px';

    // Container (the circle) — purely visual, drag-only. Halves are the actual buttons.
    const btn = document.createElement('div');
    btn.id = 'oge-mobile-col';
    btn.style.width = size + 'px';
    btn.style.height = size + 'px';

    // Top half — SEND (go to saved available positions). <button> for native Enter/Space.
    const sendHalf = document.createElement('button');
    sendHalf.type = 'button';
    sendHalf.className = 'oge-col-half oge-col-send';
    sendHalf.id = 'oge-col-send';
    sendHalf.tabIndex = 0;
    sendHalf.setAttribute('aria-label', 'Send colonization');
    sendHalf.style.fontSize = fontSize;
    sendHalf.textContent = 'Send';

    // Bottom half — SCAN (search for new positions). <button> for native Enter/Space.
    const scanHalf = document.createElement('button');
    scanHalf.type = 'button';
    scanHalf.className = 'oge-col-half oge-col-scan';
    scanHalf.id = 'oge-col-scan';
    scanHalf.tabIndex = 0;
    scanHalf.setAttribute('aria-label', 'Scan next system');
    scanHalf.style.fontSize = fontSize;
    scanHalf.textContent = 'Scan';

    btn.appendChild(sendHalf);
    btn.appendChild(scanHalf);

    // Context-aware labels on load
    const isFleetCol = location.search.includes('component=fleetdispatch') && location.search.includes('mission=7');
    const abandonInfo = checkAbandonState();

    if (abandonInfo) {
      // On overview with colony too small → abandon mode
      sendHalf.style.background = 'rgba(200, 0, 0, 0.85)';
      sendHalf.textContent = 'Too small! (' + abandonInfo.max + ')';
      scanHalf.style.background = 'rgba(150, 0, 0, 0.75)';
      scanHalf.textContent = 'Abandon';
    } else if (isFleetCol) {
      sendHalf.textContent = 'Dispatch!';
      sendHalf.style.background = 'rgba(0, 200, 0, 0.85)';
    }

    // Position
    const savedPos = getColSavedPos();
    if (savedPos) {
      btn.style.left = Math.min(savedPos.x, window.innerWidth - size) + 'px';
      btn.style.top = Math.min(savedPos.y, window.innerHeight - size) + 'px';
    } else {
      btn.style.left = '20px';
      btn.style.bottom = '20px';
    }

    // Drag logic on container
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const DRAG_THRESHOLD = 8;

    const onStart = (cx, cy) => { isDragging = true; hasMoved = false; startX = cx; startY = cy; const r = btn.getBoundingClientRect(); startLeft = r.left; startTop = r.top; };
    const onMove = (cx, cy) => {
      if (!isDragging) return;
      const dx = cx - startX, dy = cy - startY;
      if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      hasMoved = true; btn.classList.add('oge-dragging');
      btn.style.right = 'auto'; btn.style.bottom = 'auto';
      btn.style.left = Math.max(0, Math.min(startLeft + dx, window.innerWidth - size)) + 'px';
      btn.style.top = Math.max(0, Math.min(startTop + dy, window.innerHeight - size)) + 'px';
    };
    const onEnd = () => {
      if (!isDragging) return; isDragging = false; btn.classList.remove('oge-dragging');
      if (hasMoved) safeLS.setJSON(COL_POS_KEY, { x: parseInt(btn.style.left, 10), y: parseInt(btn.style.top, 10) });
    };

    btn.addEventListener('touchstart', (e) => { onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    btn.addEventListener('touchmove', (e) => { onMove(e.touches[0].clientX, e.touches[0].clientY); if (hasMoved) e.preventDefault(); }, { passive: false });
    btn.addEventListener('touchend', () => { onEnd(); });
    btn.addEventListener('mousedown', (e) => {
      onStart(e.clientX, e.clientY);
      const mv = (ev) => onMove(ev.clientX, ev.clientY);
      const up = () => { onEnd(); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });

    // Prevent our <button> halves from stealing focus from the game's popups.
    // Some game dialogs (jQuery UI overlay) auto-close when focus leaves their
    // contents — tapping our button would close the popup before our click
    // handler could interact with it (e.g. the abandon flow's 2/3 submit step).
    //
    // Two layers, must coexist with tabindex=0 (we still want keyboard Tab):
    //   1. mousedown preventDefault: blocks focus shift on mouse / synthesized
    //      mousedown from touch. Primary fix.
    //   2. pointerdown flag + focus event: if layer 1 fails (some browsers
    //      under some conditions), we detect focus arriving right after a tap
    //      and immediately bounce it back to the prior focused element.
    //      200ms flag window distinguishes pointer-triggered focus from
    //      keyboard Tab focus — keyboard users still get to tab into our
    //      buttons normally (no bounce).
    let priorFocus = null;
    let bounceFocusNext = false;
    const capturePriorFocus = () => {
      priorFocus = document.activeElement;
      bounceFocusNext = true;
      setTimeout(() => { bounceFocusNext = false; }, 200);
    };
    const preventFocusSteal = (e) => e.preventDefault();
    const maybeBounceFocus = () => {
      if (!bounceFocusNext) return; // keyboard Tab — let focus land normally
      bounceFocusNext = false;
      if (priorFocus && priorFocus !== document.body && document.contains(priorFocus)) {
        try { priorFocus.focus({ preventScroll: true }); } catch {}
      }
    };
    sendHalf.addEventListener('mousedown', preventFocusSteal);
    scanHalf.addEventListener('mousedown', preventFocusSteal);
    sendHalf.addEventListener('pointerdown', capturePriorFocus);
    scanHalf.addEventListener('pointerdown', capturePriorFocus);
    sendHalf.addEventListener('focus', maybeBounceFocus);
    scanHalf.addEventListener('focus', maybeBounceFocus);

    // SEND half click — find best target from DB or dispatch fleet on fleetdispatch
    sendHalf.addEventListener('click', (e) => {
      if (hasMoved) { hasMoved = false; return; }
      e.stopPropagation();

      // Abandon mode — show info only (abandon is on scan half)
      if (abandonInfo) return;

      const isFleet = location.search.includes('component=fleetdispatch');
      const isColMission = location.search.includes('mission=7');

      if (isFleet && isColMission) {
        // Stale-retry branch: checkTarget reported the position is reserved /
        // no longer colonizable. Navigate to the galaxy view of that system so
        // the game's fetchGalaxyContent refreshes our DB for the whole system.
        // User inspects visually + clicks Scan or Send next.
        if (staleRetryActive) {
          navigateToStaleSystem();
          return;
        }
        // On fleetdispatch with mission=7 — check min gap then dispatch via Enter
        dispatchColonizeWithGapCheck();
        return;
      }

      if (pendingColLink) {
        // Have a pending found link — go to it (user already saw "Found! Go").
        // Mark verify-pending so the post-redirect checkTarget hook knows this
        // navigation came from OUR Send Col flow (vs user typing into form).
        const link = pendingColLink;
        pendingColLink = null;
        const m = link.match(/galaxy=(\d+)&system=(\d+)&position=(\d+)/);
        if (m) setColVerifyState(+m[1], +m[2], +m[3]);
        location.href = link;
        return;
      }

      // No pending — search DB for next colonize target (target positions only)
      findNextColonizeTarget((target) => {
        if (target) {
          pendingColLink = target.link;
          sendHalf.style.background = 'rgba(0, 200, 0, 0.85)';
          sendHalf.textContent = 'Found! Go';
        } else {
          sendHalf.textContent = 'None available';
          // Fallback: if not on galaxy, jump there so user can scan
          if (!location.search.includes('component=galaxy')) {
            const base = location.href.split('?')[0];
            location.href = base + '?page=ingame&component=galaxy';
          }
        }
      });
    });

    // SCAN half click — pick next system to scan (or abandon colony in abandon mode)
    scanHalf.addEventListener('click', (e) => {
      if (hasMoved) { hasMoved = false; return; }
      e.stopPropagation();

      // Abandon mode — single-shot AJAX flow (3 HTTP requests, no popup interactions)
      if (abandonInfo) {
        abandonPlanet();
        return;
      }

      pendingColLink = null;
      getNextScanSystem((next) => {
        if (!next) {
          scanHalf.textContent = 'All scanned!';
          return;
        }
        const isGalaxy = location.search.includes('component=galaxy');
        if (isGalaxy && navigateToSystem(next.galaxy, next.system)) {
          // In-page navigation in galaxy view triggers fetchGalaxyContent → scan auto-saved
          return;
        }
        // Not on galaxy view — full navigate (game will fetch + our hook captures)
        const base = location.href.split('?')[0];
        location.href = base + '?page=ingame&component=galaxy&galaxy=' + next.galaxy + '&system=' + next.system;
      });
    });

    document.body.appendChild(btn);
    setupBtnFocusPersist(sendHalf, 'col-send');
    setupBtnFocusPersist(scanHalf, 'col-scan');
  };

  const hideColonizeButton = () => {
    const btn = document.getElementById('oge-mobile-col');
    if (btn) btn.remove();
    safeLS.remove(COL_POS_KEY);
  };

  // ── Boot ──

  const isColEnabled = () => safeLS.bool(COL_STORAGE_KEY);

  const boot = () => {
    injectStyles();
    if (isEnabled()) showEnterButton();
    if (isColEnabled()) showColonizeButton();
    document.addEventListener('oge:mobileToggle', () => showEnterButton());
    document.addEventListener('oge:colonizeToggle', (e) => {
      if (e.detail) showColonizeButton();
      else hideColonizeButton();
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
