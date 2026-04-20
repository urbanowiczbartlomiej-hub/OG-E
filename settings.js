// OG-E: Settings panel injected into AGR (AntiGameReborn) options menu.
// Adds an "OG-E Settings" tab at the bottom of the AGR settings panel with
// toggles, sliders and text inputs for all OG-E preferences. Values are
// stored in localStorage (read by other OG-E scripts via safeLS).
//
// Selected keys (see CROSS_CONTEXT_KEYS) are also mirrored to
// chrome.storage.local so that the histogram extension page — which runs
// on a different origin (moz-extension://…) and therefore has its own
// localStorage — can read them too.
(() => {
  // Resolve histogram URL once at load (content script has access to runtime API)
  let ogeHistogramUrl = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      ogeHistogramUrl = chrome.runtime.getURL('histogram.html');
    } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
      ogeHistogramUrl = browser.runtime.getURL('histogram.html');
    }
  } catch {}

  const SETTINGS = [
    {
      section: 'Expeditions',
      options: [
        {
          id: 'oge_mobileMode', label: 'Send Exp button (floating)', type: 'checkbox', defaultVal: false,
          onchange: (on) => {
            const existing = document.getElementById('oge-mobile-enter');
            if (on && !existing) {
              document.dispatchEvent(new CustomEvent('oge:mobileToggle', { detail: on }));
            } else if (!on && existing) {
              existing.remove();
            }
          },
        },
        {
          id: 'oge_enterBtnSize', label: 'Send Exp button size', type: 'range',
          min: 40, max: 560, step: 10, defaultVal: 560, unit: 'px',
          onchange: (val) => {
            const btn = document.getElementById('oge-mobile-enter');
            if (btn) {
              btn.style.width = val + 'px';
              btn.style.height = val + 'px';
              btn.style.fontSize = Math.round(val * 0.23) + 'px';
            }
          },
        },
        {
          id: 'oge_expeditionBadges', label: 'Expedition badges on planets', type: 'checkbox', defaultVal: true,
          onchange: () => document.dispatchEvent(new CustomEvent('oge:badgesToggle')),
        },
        { id: 'oge_autoRedirectExpedition', label: 'After sending expedition, open the next planet (client-side redirect)', type: 'checkbox', defaultVal: true },
        { id: 'oge_maxExpPerPlanet', label: 'Max expeditions per planet', type: 'text', defaultVal: '1', placeholder: 'e.g. 1' },
      ],
    },
    {
      section: 'Colonization',
      options: [
        {
          id: 'oge_colonizeMode', label: 'Send Col button (floating)', type: 'checkbox', defaultVal: false,
          onchange: (on) => {
            document.dispatchEvent(new CustomEvent('oge:colonizeToggle', { detail: on }));
          },
        },
        {
          id: 'oge_colBtnSize', label: 'Send Col button size', type: 'range',
          min: 40, max: 560, step: 10, defaultVal: 336, unit: 'px',
          onchange: (val) => {
            const btn = document.getElementById('oge-mobile-col');
            if (btn) {
              btn.style.width = val + 'px';
              btn.style.height = val + 'px';
              btn.style.fontSize = Math.round(val * 0.2) + 'px';
            }
          },
        },
        {
          id: 'oge_colPositions', label: 'Required target positions (only these will be colonized)', type: 'text', defaultVal: '8',
          placeholder: 'e.g. 8,9,7,10,6',
        },
        {
          id: 'oge_colPreferOtherGalaxies', label: 'Prefer neighbouring galaxies first (more predictable arrival times)', type: 'checkbox', defaultVal: false,
        },
        {
          id: 'oge_colMinGap', label: 'Min gap between arrivals (sec)', type: 'text', defaultVal: '20',
          placeholder: 'e.g. 20',
        },
        {
          id: 'oge_colMinFields', label: 'Min fields to keep colony', type: 'text', defaultVal: '200',
          placeholder: 'e.g. 200',
        },
        {
          id: 'oge_colPassword', label: 'Account password (for abandon)', type: 'password', defaultVal: '',
          placeholder: 'stored locally only',
        },
        {
          id: 'oge_showHistogram', label: 'Colony size histogram', type: 'button',
          buttonText: 'Open',
          onclick: () => {
            window.open(ogeHistogramUrl, '_blank');
          },
        },
      ],
    },
    {
      section: 'Sync (GitHub Gist)',
      options: [
        {
          id: 'oge_cloudSync', label: 'Enable cloud sync', type: 'checkbox', defaultVal: false,
        },
        {
          id: 'oge_gistToken', label: 'GitHub Personal Access Token (gist scope)', type: 'password', defaultVal: '',
          placeholder: 'ghp_… or github_pat_…',
        },
        {
          id: 'oge_syncForce', label: 'Force sync now', type: 'button',
          buttonText: 'Sync',
          onclick: () => {
            document.dispatchEvent(new CustomEvent('oge:syncForce'));
            const status = document.getElementById('oge_sync_status');
            if (status) status.textContent = 'Syncing…';
            setTimeout(refreshSyncStatus, 4000);
          },
        },
        {
          id: 'oge_syncStatus', label: 'Status', type: 'static',
        },
      ],
    },
  ];

  const getVal = (key, defaultVal) => {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return defaultVal;
      if (typeof defaultVal === 'boolean') return v === 'true';
      if (typeof defaultVal === 'string') return v;
      return isNaN(Number(v)) ? defaultVal : Number(v);
    } catch { return defaultVal; }
  };

  // Settings that need to be readable from cross-origin contexts (e.g. the
  // histogram extension page, which has its own moz-extension:// localStorage
  // separate from the OGame origin localStorage). Mirrored to chrome.storage.local
  // so other contexts can read + react via storage.onChanged.
  const CROSS_CONTEXT_KEYS = new Set(['oge_colPositions']);
  const getExtStorage = () => {
    if (typeof browser !== 'undefined' && browser.storage) return browser.storage.local;
    if (typeof chrome !== 'undefined' && chrome.storage) return chrome.storage.local;
    return null;
  };

  const setVal = (key, val) => {
    try { localStorage.setItem(key, String(val)); }
    catch {}
    if (CROSS_CONTEXT_KEYS.has(key)) {
      const store = getExtStorage();
      if (store) store.set({ [key]: String(val) });
    }
  };

  /**
   * On boot, mirror cross-context keys from localStorage → chrome.storage.local
   * for keys that haven't been mirrored yet. Handles users upgrading from
   * versions where the mirror didn't exist.
   *
   * Why mirror at all: histogram (extension origin moz-extension://…) cannot
   * read localStorage of ogame.gameforge.com. Selected keys (CROSS_CONTEXT_KEYS)
   * must therefore be mirrored to chrome.storage.local where both contexts can
   * see them.
   *
   * Currently mirrored: oge_colPositions (used by histogram filter).
   */
  (() => {
    const store = getExtStorage();
    if (!store) return;
    for (const key of CROSS_CONTEXT_KEYS) {
      const local = localStorage.getItem(key);
      if (local === null) continue;
      store.get(key, (data) => {
        if (data && data[key] !== undefined) return; // already mirrored
        store.set({ [key]: local });
      });
    }
  })();

  /**
   * Compose the multi-line read-only Status field for the Sync section.
   * Pulls last-upload / last-download / last-error timestamps from
   * localStorage (written by sync.js). Returns three '\n'-joined lines (no
   * trailing line if no error). Span renders with `white-space:pre-line`.
   *
   * Format:
   *   ↑ <upload local-time>
   *   ↓ <download local-time>
   *   ⚠ <error message>          (only if oge_lastSyncErr set)
   *
   * @returns {string}  multi-line status text
   */
  const formatSyncStatus = () => {
    const fmt = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleString();
    };
    const up = getVal('oge_lastSyncAt', '');
    const down = getVal('oge_lastDownAt', '');
    const err = getVal('oge_lastSyncErr', '');
    const lines = ['↑ ' + fmt(up), '↓ ' + fmt(down)];
    if (err) lines.push('⚠ ' + err);
    return lines.join('\n');
  };

  const refreshSyncStatus = () => {
    const el = document.getElementById('oge_sync_status');
    if (el) el.textContent = formatSyncStatus();
  };

  const buildRow = (opt) => {
    const tr = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.className = 'ago_menu_label_bullet';
    tdLabel.textContent = opt.label;
    const tdInput = document.createElement('td');

    if (opt.type === 'range') {
      const wrapper = document.createElement('span');
      wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;width:100%';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = 'oge_set_' + opt.id;
      slider.min = opt.min;
      slider.max = opt.max;
      slider.step = opt.step;
      slider.value = getVal(opt.id, opt.defaultVal);
      slider.style.cssText = 'flex:1;cursor:pointer;';

      const display = document.createElement('span');
      display.style.cssText = 'min-width:50px;text-align:right;font-size:11px;color:#848484;';
      display.textContent = slider.value + (opt.unit || '');

      slider.addEventListener('input', () => {
        const val = Number(slider.value);
        display.textContent = val + (opt.unit || '');
        setVal(opt.id, val);
        if (opt.onchange) opt.onchange(val);
      });

      wrapper.appendChild(slider);
      wrapper.appendChild(display);
      tdInput.appendChild(wrapper);
    } else if (opt.type === 'button') {
      const btn = document.createElement('button');
      btn.textContent = opt.buttonText || opt.label;
      btn.style.cssText = 'padding:4px 14px;background:#1a2a3a;border:1px solid #2a4a5a;color:#4a9eff;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
      btn.addEventListener('click', () => { if (opt.onclick) opt.onclick(); });
      tdInput.appendChild(btn);
    } else if (opt.type === 'static') {
      const span = document.createElement('span');
      // For oge_syncStatus we use a stable id that other code references directly
      if (opt.id === 'oge_syncStatus') span.id = 'oge_sync_status';
      else span.id = 'oge_static_' + opt.id;
      span.style.cssText = 'font-size:11px;color:#888;white-space:pre-line;';
      span.textContent = opt.id === 'oge_syncStatus' ? formatSyncStatus() : '';
      tdInput.appendChild(span);
    } else if (opt.type === 'text' || opt.type === 'password') {
      const input = document.createElement('input');
      input.type = opt.type;
      input.id = 'oge_set_' + opt.id;
      input.value = getVal(opt.id, opt.defaultVal);
      input.placeholder = opt.placeholder || '';
      input.addEventListener('change', () => {
        setVal(opt.id, input.value);
        if (opt.onchange) opt.onchange(input.value);
      });
      tdInput.appendChild(input);
    } else {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = 'oge_set_' + opt.id;
      cb.checked = getVal(opt.id, opt.defaultVal);
      cb.addEventListener('change', () => {
        setVal(opt.id, cb.checked);
        if (opt.onchange) opt.onchange(cb.checked);
      });
      tdInput.appendChild(cb);
    }

    tr.appendChild(tdLabel);
    tr.appendChild(tdInput);
    return tr;
  };

  const buildTab = () => {
    const tab = document.createElement('div');
    tab.id = 'ago_menu_OGE';
    tab.className = 'ago_menu_tab';

    const header = document.createElement('div');
    header.className = 'ago_menu_tab_header';
    header.id = 'oge_tab_header';
    header.setAttribute('ago-data', '{"role":"Tab","action":"toggle","id":"OGE"}');
    const arrowClose = document.createElement('span');
    arrowClose.className = 'ago_menu_tab_arrow_close';
    arrowClose.textContent = '▼';
    const arrowOpen = document.createElement('span');
    arrowOpen.className = 'ago_menu_tab_arrow_open';
    arrowOpen.textContent = '▲';
    header.appendChild(arrowClose);
    header.appendChild(arrowOpen);
    header.appendChild(document.createTextNode('OG-E Settings'));
    tab.appendChild(header);

    for (const sec of SETTINGS) {
      const table = document.createElement('table');
      table.className = 'ago_menu_section';
      table.style.tableLayout = 'fixed';

      const colgroup = document.createElement('colgroup');
      const col1 = document.createElement('col');
      col1.style.width = '434px';
      const col2 = document.createElement('col');
      col2.style.width = '220px';
      colgroup.appendChild(col1);
      colgroup.appendChild(col2);
      table.appendChild(colgroup);

      const headerRow = document.createElement('tr');
      headerRow.className = 'ago_menu_section_header';
      const th1 = document.createElement('th');
      th1.className = 'ago_menu_section_title';
      th1.textContent = sec.section;
      const th2 = document.createElement('th');
      headerRow.appendChild(th1);
      headerRow.appendChild(th2);
      table.appendChild(headerRow);

      for (const opt of sec.options) {
        table.appendChild(buildRow(opt));
      }

      tab.appendChild(table);
    }

    return tab;
  };

  const inject = () => {
    if (document.getElementById('ago_menu_OGE')) return;
    const container = document.getElementById('ago_menu_content');
    if (!container) return;
    container.appendChild(buildTab());
  };

  const observe = () => {
    const observer = new MutationObserver(() => inject());
    observer.observe(document.body, { childList: true, subtree: true });
    inject();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe, { once: true });
  } else {
    observe();
  }
})();
