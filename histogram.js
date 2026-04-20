// OG-E: local data visualization page. Reads only chrome.storage.local and
// renders two views:
//   - Colony size histogram (bar chart of field sizes from planets the user
//     has personally visited — data was recorded when they opened the
//     planet's overview page).
//   - Galaxy observations (per-system visualization of positions the user
//     has navigated past in the in-game galaxy view — filtered by the user's
//     target positions list so the visualization reflects colonization
//     opportunity, not raw position counts).
// This page does not make any HTTP requests. It only reads locally stored
// data and provides Export / Import / Clear / Refresh actions.
(() => {
  // ── Storage helper (works on Chrome, Firefox desktop & mobile) ──
  const getStorage = () => {
    const ns = (typeof browser !== 'undefined' && browser.storage) ? browser
             : (typeof chrome !== 'undefined' && chrome.storage) ? chrome
             : null;
    if (!ns) return null;
    return {
      local: ns.storage.local,
      sync: ns.storage.sync,
      onChanged: ns.storage.onChanged,
      lastError: () => ns.runtime?.lastError,
    };
  };

  const STORAGE_KEY = 'oge_colonyHistory';
  const EXPANDED_KEY = 'oge_expandedGalaxies';
  const storage = getStorage();
  const storageApi = storage?.local || null;

  // ── safeLS for accordion expanded state persistence ──
  const safeLS = {
    getJSON: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    setJSON: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ── Export / Import ──

  const setStatus = (msg) => {
    const el = document.getElementById('importStatus');
    if (el) el.textContent = msg;
  };

  const exportData = () => {
    if (!storageApi) return;
    storageApi.get(['oge_colonyHistory', 'oge_galaxyScans'], (result) => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        colonyHistory: result.oge_colonyHistory || [],
        galaxyScans: result.oge_galaxyScans || {},
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'oge-data-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Exported ' + (result.oge_colonyHistory || []).length + ' colonies, ' + Object.keys(result.oge_galaxyScans || {}).length + ' scans');
    });
  };

  const importData = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (!imported || imported.version !== 1) {
          setStatus('Invalid file format');
          return;
        }
        if (!storageApi) return;

        storageApi.get(['oge_colonyHistory', 'oge_galaxyScans'], (result) => {
          const toSave = {};

          // Merge colony history — union by cp, keep existing (local) if duplicate
          if (imported.colonyHistory && imported.colonyHistory.length) {
            const local = result.oge_colonyHistory || [];
            const byCp = new Map();
            for (const h of local) byCp.set(h.cp, h);
            let added = 0;
            for (const h of imported.colonyHistory) {
              if (!byCp.has(h.cp)) { byCp.set(h.cp, h); added++; }
            }
            toSave.oge_colonyHistory = [...byCp.values()];
            setStatus('Colonies: +' + added + ' new (total ' + toSave.oge_colonyHistory.length + ')');
          }

          // Merge galaxy scans — per system, newer timestamp wins
          if (imported.galaxyScans && Object.keys(imported.galaxyScans).length) {
            const local = result.oge_galaxyScans || {};
            const merged = { ...local };
            let updated = 0;
            for (const [key, val] of Object.entries(imported.galaxyScans)) {
              const existing = merged[key];
              if (!existing || (val.ts || 0) > (existing.ts || 0)) {
                merged[key] = val;
                updated++;
              }
            }
            toSave.oge_galaxyScans = merged;
            const prev = document.getElementById('importStatus')?.textContent || '';
            setStatus(prev + ' | Scans: +' + updated + ' updated (total ' + Object.keys(merged).length + ')');
          }

          if (Object.keys(toSave).length) storageApi.set(toSave);
        });
      } catch (err) {
        setStatus('Error: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  document.getElementById('exportBtn')?.addEventListener('click', exportData);
  document.getElementById('importBtn')?.addEventListener('click', () => {
    document.getElementById('importFile')?.click();
  });
  document.getElementById('importFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importData(file);
    e.target.value = '';
  });

  // ── Colony histogram ──

  const getData = (cb) => {
    if (!storageApi) { cb([]); return; }
    storageApi.get(STORAGE_KEY, (result) => cb(result[STORAGE_KEY] || []));
  };

  const render = () => getData((all) => {
    const filter = document.getElementById('posFilter').value;
    const data = filter === 'all' ? all : all.filter(d => d.position === parseInt(filter, 10));

    document.getElementById('countInfo').textContent = data.length + ' colonies recorded' + (filter !== 'all' ? ' (pos ' + filter + ')' : '');

    const statsEl = document.getElementById('statsContainer');
    const chartEl = document.getElementById('chart');
    statsEl.textContent = '';
    chartEl.textContent = '';

    if (!data.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No colony data recorded yet. Visit a newly colonized planet (named "Kolonia") to start collecting.';
      chartEl.appendChild(empty);
      return;
    }

    const fields = data.map(d => d.fields).sort((a, b) => a - b);
    const min = fields[0];
    const max = fields[fields.length - 1];
    const avg = Math.round(fields.reduce((s, v) => s + v, 0) / fields.length);
    const median = fields.length % 2 === 0
      ? Math.round((fields[fields.length / 2 - 1] + fields[fields.length / 2]) / 2)
      : fields[Math.floor(fields.length / 2)];

    for (const [label, value] of [['Count', data.length], ['Min', min], ['Max', max], ['Average', avg], ['Median', median]]) {
      const card = document.createElement('div');
      card.className = 'stat-card';
      const valEl = document.createElement('div');
      valEl.className = 'stat-value';
      valEl.textContent = value;
      const labEl = document.createElement('div');
      labEl.className = 'stat-label';
      labEl.textContent = label;
      card.appendChild(valEl);
      card.appendChild(labEl);
      statsEl.appendChild(card);
    }

    // Histogram bars — compute bar height in pixels to avoid flex-chain
    // percentage-height issues (`height:X%` on bar was resolving against the
    // bar-group's content height, not the chart's 300px, making bars invisible).
    const buckets = {};
    for (const f of fields) buckets[f] = (buckets[f] || 0) + 1;
    const sortedKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    const maxCount = Math.max(...Object.values(buckets));

    // Chart is 300px tall; reserve ~55px for bar-count (~12px) + bar-label (~40px + margin)
    const BAR_AREA_PX = 240;
    const MIN_BAR_PX = 3;

    for (const key of sortedKeys) {
      const count = buckets[key];
      const barHeightPx = Math.max(Math.round((count / maxCount) * BAR_AREA_PX), MIN_BAR_PX);

      const group = document.createElement('div');
      group.className = 'bar-group';

      const countLabel = document.createElement('div');
      countLabel.className = 'bar-count';
      countLabel.textContent = count;
      group.appendChild(countLabel);

      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = barHeightPx + 'px';
      bar.title = key + ' fields: ' + count + 'x';
      group.appendChild(bar);

      const label = document.createElement('div');
      label.className = 'bar-label';
      label.textContent = key;
      group.appendChild(label);

      chartEl.appendChild(group);
    }
  });

  // CSV export — wired once, works on all data regardless of filter
  document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    getData((all) => {
      const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp);
      const header = 'CP,Coords,Position,Fields,Date\n';
      const rows = sorted.map(d =>
        d.cp + ',' + d.coords + ',' + d.position + ',' + d.fields + ',' + new Date(d.timestamp).toISOString()
      ).join('\n');
      const blob = new Blob([header + rows], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'oge_colony_history.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  const populateFilter = () => getData((all) => {
    const positions = [...new Set(all.map(d => d.position))].sort((a, b) => a - b);
    const select = document.getElementById('posFilter');
    while (select.options.length > 1) select.remove(1);
    for (const p of positions) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = 'Position ' + p;
      select.appendChild(opt);
    }
  });

  // Trigger sync via tombstone — sync.js running in any open OGame tab will see
  // this storage write and run a download+upload cycle. Storage onChanged then
  // re-renders this view with fresh data automatically.
  const requestSync = () => {
    if (!storageApi) return;
    storageApi.set({ oge_syncRequestAt: Date.now() });
  };

  document.getElementById('posFilter').addEventListener('change', render);
  document.getElementById('refreshBtn').addEventListener('click', () => {
    requestSync();
    populateFilter();
    render();
  });
  populateFilter();
  render();

  // ── Galaxy Scans tab ──

  const MAX_GAL = 7, MAX_SYS = 499;

  // Schema v2 statuses (per position) — color + label for legend, stats, pixel map
  const STATUS_COLORS = {
    empty:         '#0c0',     // green: colonizable
    empty_sent:    '#4a9eff',  // blue: our fleet in flight
    abandoned:     '#fa0',     // orange: destroyed planet (incl. ours)
    reserved:      '#a060c0',  // violet: slot reserved for planet-move by another player
    inactive:      '#dd4',     // yellow: i (7-28d)
    long_inactive: '#a855f7',  // purple: I (28+d)
    vacation:      '#888',     // light gray
    banned:        '#822',     // dark red
    admin:         '#e08fb3',  // pink
    occupied:      '#555',     // gray: active player
    mine:          '#37a',     // dim blue: our colony
  };
  const STATUS_LABELS = {
    empty:         'Empty',
    empty_sent:    'Sent',
    abandoned:     'Abandoned',
    reserved:      'Reserved',
    inactive:      'Inactive (i)',
    long_inactive: 'Inactive (I)',
    vacation:      'Vacation',
    banned:        'Banned',
    admin:         'Admin',
    occupied:      'Occupied',
    mine:          'Mine',
  };
  // Best-status priority for the system-level color in pixel map: most actionable first
  const STATUS_PRIORITY = [
    'empty', 'empty_sent', 'abandoned', 'reserved', 'long_inactive', 'inactive',
    'vacation', 'banned', 'mine', 'admin', 'occupied'
  ];

  /**
   * Parse `oge_colPositions`-style string into a Set of 1..15 ints.
   * Counterpart to `mobile.js:parsePositions` but returns a Set (only
   * needed for membership testing here, not ordering).
   *
   * Why filter at all: a typical system has 14 empty positions and 1
   * occupied, but the user only cares whether THEIR target (e.g. pos 8) is
   * colonizable. Without this filter the chart was 95% green noise.
   *
   * Source value mirrored from `settings.js` → `chrome.storage.local` so
   * histogram (extension origin) can read it across origins.
   *
   * @param {string} str
   * @returns {Set<number>}
   */
  const parseTargetPositions = (str) => {
    const out = new Set();
    for (const part of (str || '8').split(',')) {
      const trimmed = part.trim();
      const range = trimmed.match(/^(\d+)-(\d+)$/);
      if (range) {
        const from = +range[1], to = +range[2];
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
          if (i >= 1 && i <= 15) out.add(i);
        }
      } else {
        const n = +trimmed;
        if (n >= 1 && n <= 15) out.add(n);
      }
    }
    return out;
  };

  let targetPositions = parseTargetPositions('8'); // default until chrome.storage loads

  /**
   * Reduce a system's per-position scan map down to a single "best" status
   * across the user's target positions (`targetPositions` Set). Used to colour
   * the per-system pixel in the galaxy view.
   *
   * "Best" means highest priority in `STATUS_PRIORITY` — typically empty wins
   * over abandoned wins over inactive wins over occupied, etc.
   *
   * @param {object} positions  positions map (1..15 → Position)
   * @returns {string|null}  status string, or null if no target position has any data
   */
  const bestStatusInSystem = (positions) => {
    if (!positions) return null;
    for (const status of STATUS_PRIORITY) {
      for (const pos of targetPositions) {
        if (positions[pos]?.status === status) return status;
      }
    }
    return null;
  };

  // Format target positions list for display (e.g. "8" or "8, 9, 7")
  const formatTargetPositions = () => [...targetPositions].sort((a, b) => a - b).join(', ');

  const scansContainer = document.getElementById('scansContainer');
  if (scansContainer) {
    // Track which galaxies are expanded — survives both re-renders and page refreshes
    const expandedGalaxies = new Set(safeLS.getJSON(EXPANDED_KEY, []));
    const persistExpanded = () => safeLS.setJSON(EXPANDED_KEY, [...expandedGalaxies]);

    const getScans = (cb) => {
      if (!storageApi) { cb({}); return; }
      storageApi.get('oge_galaxyScans', (result) => cb(result.oge_galaxyScans || {}));
    };

    const renderScans = () => getScans((scans) => {
      scansContainer.textContent = '';
      // Filter out v1 entries (no `positions` field) — they're stale/legacy
      const entries = Object.entries(scans).filter(([, v]) => v && v.positions);

      if (!entries.length) {
        const msg = document.createElement('div');
        msg.className = 'empty';
        msg.textContent = 'No galaxy observations recorded yet. Open the galaxy view in the game and navigate through systems yourself — data is recorded as the game shows you each system.';
        scansContainer.appendChild(msg);
        return;
      }

      // Filter indicator: which target positions are we counting?
      const filterBar = document.createElement('div');
      filterBar.style.cssText = 'margin-bottom:12px;padding:8px 12px;background:#111820;border:1px solid #2a4a5a;border-radius:6px;font-size:12px;color:#888;';
      const filterLabel = document.createElement('span');
      filterLabel.textContent = 'Filtering by target positions: ';
      const filterValue = document.createElement('span');
      filterValue.style.cssText = 'color:#4a9eff;font-weight:bold;';
      filterValue.textContent = formatTargetPositions();
      const filterHint = document.createElement('span');
      filterHint.style.cssText = 'color:#666;margin-left:8px;';
      filterHint.textContent = '(change in OG-E Settings → Required target positions)';

      // Rescan policy tooltip: small ⓘ icon with native title. Hover reveals
      // the table of per-status thresholds so user knows when each system
      // will next be eligible for automatic re-scan from Scan button.
      const rescanHelp = document.createElement('span');
      rescanHelp.textContent = ' ⓘ Rescan policy';
      rescanHelp.style.cssText = 'margin-left:12px;cursor:help;color:#4a9eff;border-bottom:1px dotted #4a9eff;';
      rescanHelp.title = [
        'Re-scan policy (when Scan will revisit a system with this status):',
        '',
        '  empty                    — never (stable, awaits Send)',
        '  empty_sent (our fleet)   — 4 hours after send',
        '  abandoned (debris)       — 24 hours',
        '  reserved (planet-move)   — 24 hours',
        '  inactive (i) 7-28d       — 5 days',
        '  inactive (I) 28+d        — 5 days',
        '  vacation                 — 30 days',
        '  banned                   — 30 days',
        '  occupied (active player) — 30 days',
        '  mine                     — never (we know the state)',
        '  admin                    — never (untouchable)',
        '  not scanned              — highest priority, immediate',
        '',
        'A system is eligible for re-scan as soon as ANY of its 15 positions',
        'has exceeded its threshold. Scan advances sequentially +1 from the',
        'current galaxy view (or home if not on galaxy).',
      ].join('\n');

      filterBar.appendChild(filterLabel);
      filterBar.appendChild(filterValue);
      filterBar.appendChild(filterHint);
      filterBar.appendChild(rescanHelp);
      scansContainer.appendChild(filterBar);

      // Global stats — count ONLY positions in the user's target list. With
      // 14 of 15 positions empty in a typical occupied system, counting all
      // positions made the chart 95% green and useless for assessing actual
      // colonization opportunity.
      const globalStats = { total: 0 };
      for (const s of Object.keys(STATUS_LABELS)) globalStats[s] = 0;
      for (const [, v] of entries) {
        const pos = v.positions || {};
        for (const targetPos of targetPositions) {
          const p = pos[targetPos];
          if (!p) continue;
          globalStats.total++;
          if (p.status && globalStats[p.status] !== undefined) globalStats[p.status]++;
        }
      }

      const statsRow = document.createElement('div');
      statsRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;';
      for (const [key, label] of [['total', 'Target positions scanned'], ...Object.entries(STATUS_LABELS)]) {
        if (key !== 'total' && !globalStats[key]) continue; // hide zero-counts to keep stats compact
        const card = document.createElement('div');
        card.className = 'stat-card';
        const valEl = document.createElement('div');
        valEl.className = 'stat-value';
        valEl.style.color = STATUS_COLORS[key] || '#4a9eff';
        valEl.textContent = globalStats[key] || 0;
        const labEl = document.createElement('div');
        labEl.className = 'stat-label';
        labEl.textContent = label;
        card.appendChild(valEl);
        card.appendChild(labEl);
        statsRow.appendChild(card);
      }
      scansContainer.appendChild(statsRow);

      // Legend — only show statuses that actually appear in the data
      const legend = document.createElement('div');
      legend.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;font-size:11px;';
      for (const status of STATUS_PRIORITY) {
        if (!globalStats[status]) continue;
        const item = document.createElement('span');
        item.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const dot = document.createElement('span');
        dot.style.cssText = 'width:10px;height:10px;border-radius:2px;background:' + STATUS_COLORS[status] + ';display:inline-block;';
        const txt = document.createElement('span');
        txt.style.color = '#888';
        txt.textContent = STATUS_LABELS[status];
        item.appendChild(dot);
        item.appendChild(txt);
        legend.appendChild(item);
      }
      const unscannedItem = document.createElement('span');
      unscannedItem.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const unscannedDot = document.createElement('span');
      unscannedDot.style.cssText = 'width:10px;height:10px;border-radius:2px;background:#1a1a2a;border:1px solid #333;display:inline-block;';
      const unscannedTxt = document.createElement('span');
      unscannedTxt.style.color = '#888';
      unscannedTxt.textContent = 'Not scanned';
      unscannedItem.appendChild(unscannedDot);
      unscannedItem.appendChild(unscannedTxt);
      legend.appendChild(unscannedItem);
      scansContainer.appendChild(legend);

      // Group by galaxy
      const byGalaxy = {};
      for (const [key, v] of entries) {
        const [g] = key.split(':').map(Number);
        if (!byGalaxy[g]) byGalaxy[g] = {};
        byGalaxy[g][key] = v;
      }

      // Per-galaxy sections
      for (let g = 1; g <= MAX_GAL; g++) {
        const galScans = byGalaxy[g] || {};
        const galCount = Object.keys(galScans).length;
        if (galCount === 0) continue;

        // Per-galaxy stats: count ONLY target positions in this galaxy's systems
        const galStats = {};
        for (const s of Object.keys(STATUS_LABELS)) galStats[s] = 0;
        let galTotalPositions = 0;
        for (const sys of Object.values(galScans)) {
          const pos = sys.positions || {};
          for (const targetPos of targetPositions) {
            const p = pos[targetPos];
            if (!p) continue;
            galTotalPositions++;
            if (p.status && galStats[p.status] !== undefined) galStats[p.status]++;
          }
        }

        // Galaxy header
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:12px;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background:#1a2a3a;border:1px solid #2a4a5a;border-radius:6px;cursor:pointer;user-select:none;';

        const title = document.createElement('span');
        title.style.cssText = 'font-weight:bold;color:#4a9eff;font-size:14px;min-width:80px;';
        title.textContent = 'Galaxy ' + g;
        header.appendChild(title);

        // Progress bar segments — proportional to actually-counted positions in this galaxy
        const progressWrap = document.createElement('div');
        progressWrap.style.cssText = 'flex:1;height:12px;background:#111;border-radius:6px;overflow:hidden;display:flex;';
        if (galTotalPositions > 0) {
          for (const status of STATUS_PRIORITY) {
            if (!galStats[status]) continue;
            const seg = document.createElement('div');
            seg.style.cssText = 'height:100%;background:' + STATUS_COLORS[status] + ';';
            seg.style.width = (galStats[status] / galTotalPositions * 100) + '%';
            seg.title = STATUS_LABELS[status] + ': ' + galStats[status];
            progressWrap.appendChild(seg);
          }
        }
        header.appendChild(progressWrap);

        // Count label — systems in this galaxy / max possible
        const countLabel = document.createElement('span');
        countLabel.style.cssText = 'font-size:12px;color:#888;min-width:70px;text-align:right;';
        countLabel.textContent = galCount + '/' + MAX_SYS;
        header.appendChild(countLabel);

        // Mini stats — quick highlights for actionable statuses
        const miniStats = document.createElement('span');
        miniStats.style.cssText = 'font-size:11px;color:#666;';
        const parts = [];
        if (galStats.empty) parts.push(galStats.empty + ' empty');
        if (galStats.empty_sent) parts.push(galStats.empty_sent + ' sent');
        if (galStats.abandoned) parts.push(galStats.abandoned + ' aband');
        miniStats.textContent = parts.join(', ');
        header.appendChild(miniStats);

        // Reset button — wipes all systems for this galaxy locally, sync.js
        // mirrors the change to the gist on next upload (orphan cleanup).
        const resetBtn = document.createElement('button');
        resetBtn.textContent = '✕';
        resetBtn.title = 'Reset all scans for Galaxy ' + g;
        resetBtn.style.cssText = 'background:#4a2a2a;border:1px solid #6a3a3a;color:#ff8888;padding:2px 8px;border-radius:4px;font-size:12px;cursor:pointer;font-weight:bold;';
        resetBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); // don't toggle accordion
          if (!confirm('Reset all observation data for Galaxy ' + g + '?\n\nThis removes ' + galCount + ' recorded systems from this galaxy locally AND from your cloud sync.')) return;
          if (!storageApi) return;
          storageApi.get('oge_galaxyScans', (result) => {
            const all = result.oge_galaxyScans || {};
            for (const k of Object.keys(all)) {
              if (k.startsWith(g + ':')) delete all[k];
            }
            storageApi.set({ oge_galaxyScans: all }, () => {
              renderScans();
              // Trigger gist sync so remote mirrors the wipe
              storageApi.set({ oge_syncRequestAt: Date.now() });
            });
          });
        });
        header.appendChild(resetBtn);

        section.appendChild(header);

        // System pixel map (collapsible) — pixel = system, color = best-status
        const mapWrap = document.createElement('div');
        const isExpanded = expandedGalaxies.has(g);
        mapWrap.style.cssText = 'padding:8px 0;display:' + (isExpanded ? 'block' : 'none') + ';';

        const pixelMap = document.createElement('div');
        pixelMap.style.cssText = 'display:flex;flex-wrap:wrap;gap:1px;padding:4px;';

        for (let s = 1; s <= MAX_SYS; s++) {
          const key = g + ':' + s;
          const scan = galScans[key];
          const px = document.createElement('div');
          px.style.cssText = 'width:8px;height:8px;border-radius:1px;cursor:pointer;';
          if (scan && scan.positions) {
            const best = bestStatusInSystem(scan.positions);
            px.style.background = best ? STATUS_COLORS[best] : '#1a1a2a';
            // Tooltip: full per-position breakdown
            const lines = ['[' + g + ':' + s + '] scanned ' + new Date(scan.scannedAt).toLocaleString()];
            for (let pos = 1; pos <= 15; pos++) {
              const p = scan.positions[pos];
              if (!p) continue;
              const flagStr = p.flags
                ? ' (' + Object.keys(p.flags).filter(f => p.flags[f]).join(',') + ')'
                : '';
              const playerStr = p.player ? ' [' + p.player.name + ']' : '';
              lines.push('  ' + String(pos).padStart(2, ' ') + ': ' + p.status + flagStr + playerStr);
            }
            px.title = lines.join('\n');
          } else {
            px.style.background = '#1a1a2a';
            px.style.border = '1px solid #222';
            px.title = '[' + g + ':' + s + '] not scanned';
          }
          pixelMap.appendChild(px);
        }
        mapWrap.appendChild(pixelMap);
        section.appendChild(mapWrap);

        // Toggle: update both DOM and persisted state
        header.addEventListener('click', () => {
          const open = mapWrap.style.display === 'none';
          mapWrap.style.display = open ? 'block' : 'none';
          if (open) expandedGalaxies.add(g); else expandedGalaxies.delete(g);
          persistExpanded();
        });

        scansContainer.appendChild(section);
      }
    });

    document.getElementById('refreshScansBtn')?.addEventListener('click', () => {
      requestSync();
      renderScans();
    });
    document.getElementById('clearScansBtn')?.addEventListener('click', () => {
      if (!confirm('Clear all galaxy observation data?\n\nThis removes data from this device AND your cloud sync (so it does not come back on the next page load).')) return;
      if (!storageApi) return;

      // Wipe local, then write a tombstone so any open OGame tab's sync.js
      // wipes the gist too (merge alone cannot distinguish "cleared" from
      // "this device has not seen these scans yet").
      storageApi.remove('oge_galaxyScans', () => {
        renderScans();
        storageApi.set({ oge_clearRemoteAt: Date.now() });
      });
    });

    // Initial load: read target positions from chrome.storage (mirrored by
    // settings.js) before first render so stats reflect current target list.
    if (storageApi) {
      storageApi.get('oge_colPositions', (data) => {
        if (data && data.oge_colPositions) {
          targetPositions = parseTargetPositions(data.oge_colPositions);
        }
        renderScans();
      });
    } else {
      renderScans();
    }

    // Auto-refresh on storage change (accordion state preserved via expandedGalaxies set)
    if (storage?.onChanged) {
      storage.onChanged.addListener((changes) => {
        if (changes.oge_galaxyScans) renderScans();
        if (changes.oge_colonyHistory) { populateFilter(); render(); }
        if (changes.oge_colPositions) {
          targetPositions = parseTargetPositions(changes.oge_colPositions.newValue);
          renderScans();
        }
      });
    }
  }
})();
