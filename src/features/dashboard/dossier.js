// @ts-check

// Per-player DOSSIER row (dashboard, Spyglass "Watchlist Workbench"). The Etap-B
// drill-down that replaces the old thin expand-row: one dark panel stacking the
// raid verdict (the jack-point), the honest danger + mobile-fleet INTERVAL bar
// (finally rendering mobileLo..mobileHi, not just a point figure), the WHY
// reasons, the hidden-fleet arithmetic, and the responsive per-planet scan grid
// (reused verbatim from targets.js `detailRow`, incl. a ⭐ hoard flag on the
// planet holding the most visible fleet).
//
// Self-contained by design: the small compact()/formatAge()/ageMs() helpers are
// copied here (NOT imported from targets.js) so the sibling feature file has no
// intra-feature dependency. Pure DOM — no timers, no storage, no chrome.*.
// Read-only: it renders intel, it never sends (the in-game scan FAB does that).

import { scanStatus, rescanAtFor } from '../../domain/spyScan.js';
import { DANGER_LABELS } from '../../domain/dangerScore.js';
import { dangerColor } from '../../lib/dangerColor.js';

/**
 * @typedef {import('../../domain/targets.js').PlanetPos} PlanetPos
 * @typedef {{ ts: number, defPts: number, fleetPts: number }} PlanetReport
 */

// ── Local self-contained formatting helpers (copies of targets.js's) ──────────

/**
 * Compact magnitude ("4.57B" / "47.9M" / "880K"), '—' when absent.
 * @param {number|undefined} n
 * @returns {string}
 */
function compact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

/**
 * Compact human age ("3h" / "2d" / "5w") for a millisecond span, '' if unknown.
 * @param {number} ms
 * @returns {string}
 */
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = ms / 3600000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * Milliseconds since a report timestamp (epoch SECONDS), or NaN if unknown.
 * @param {number|undefined} tsSeconds
 * @param {number} nowMs
 * @returns {number}
 */
function ageMs(tsSeconds, nowMs) {
  return typeof tsSeconds === 'number' && tsSeconds > 0 ? nowMs - tsSeconds * 1000 : NaN;
}

// ── Section builders ──────────────────────────────────────────────────────────

/**
 * 1) HEADER: name · danger-label + optional "⚔ in range" chip. Muted.
 * @param {string} name
 * @param {import('../../domain/dangerScore.js').DangerProfile | undefined} profile
 * @param {boolean} inBand
 * @returns {HTMLDivElement}
 */
function headerLine(name, profile, inBand) {
  const div = document.createElement('div');
  div.style.cssText = 'font-size:13px;color:#8b95a0;margin-bottom:8px;display:flex;'
    + 'align-items:baseline;gap:8px;flex-wrap:wrap;';
  const txt = document.createElement('span');
  txt.textContent = name + (profile ? ` · ${DANGER_LABELS[profile.label]}` : '');
  div.appendChild(txt);
  if (inBand) {
    const chip = document.createElement('span');
    chip.textContent = '⚔ in range';
    chip.style.cssText =
      'font-size:11px;border-radius:11px;padding:1px 8px;background:#16352a;'
      + 'border:1px solid #2f6f4f;color:#7fd6a8;white-space:nowrap;';
    chip.title = 'Inside your legal attack band';
    div.appendChild(chip);
  }
  return div;
}

/**
 * 2) RAID VERDICT banner — the visually strongest line (the jack-point). Colour
 * by kind; append loot + confidence/age tail.
 * @param {import('../../domain/raidVerdict.js').RaidVerdict} verdict
 * @returns {HTMLDivElement}
 */
function verdictBanner(verdict) {
  const div = document.createElement('div');
  // Colour + weight by kind.
  let color = '#6b7782';
  let bold = false;
  switch (verdict.kind) {
    case 'raid': color = '#7fd6a8'; bold = true; break;
    case 'loaded-risky': color = '#e0b020'; break;
    case 'empty':
    case 'scan': color = '#8b95a0'; break;
    case 'cant-hit':
    case 'friendly':
    default: color = '#6b7782'; break;
  }
  let text = verdict.label;
  if (typeof verdict.lootNow === 'number' && verdict.lootNow > 0) {
    text += ` · loot ~${compact(verdict.lootNow)} 💰`;
  }
  const tier = verdict.tier;
  if (typeof verdict.ageMs === 'number' && Number.isFinite(verdict.ageMs)) {
    text += ` (${tier}, ${formatAge(verdict.ageMs)} old)`;
  } else {
    text += ` (${tier})`;
  }
  div.textContent = text;
  div.style.cssText = `font-size:15px;margin-bottom:10px;color:${color};`
    + (bold ? 'font-weight:700;' : 'font-weight:600;');
  if (verdict.lootCoord) div.title = `best loot at ${verdict.lootCoord}`;
  return div;
}

/**
 * 3) DANGER + interval bar. Label line "DANGER n/100" + a horizontal track with
 * the mobileLo..mobileHi band tinted by dangerColor and a mobileMil marker, then
 * a tiny lo ── hi · provenance line. Finally renders the honest lo bound.
 * @param {import('../../domain/dangerScore.js').DangerProfile} profile
 * @returns {HTMLDivElement}
 */
function dangerBlock(profile) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;';

  const d = Math.round(profile.danger * 100);
  const col = dangerColor(d);

  const label = document.createElement('div');
  label.textContent = `DANGER ${d}/100`;
  label.style.cssText = `font-size:12px;font-weight:600;color:${col};margin-bottom:5px;`;
  wrap.appendChild(label);

  // Interval bar: a fixed ~180px track scaled to [0, mobileHi]; fill the
  // lo..hi band, tint it dangerColor, and drop a thin marker at mobileMil.
  const TRACK = 180;
  const H = 10;
  const hi = Number.isFinite(profile.mobileHi) ? Math.max(0, profile.mobileHi) : 0;
  const lo = Number.isFinite(profile.mobileLo) ? Math.max(0, profile.mobileLo) : 0;
  const mid = Number.isFinite(profile.mobileMil) ? Math.max(0, profile.mobileMil) : 0;
  // Scale factor; when hi is 0 the whole band collapses to the left edge.
  const scale = hi > 0 ? TRACK / hi : 0;
  const clampPx = (/** @type {number} */ px) => Math.max(0, Math.min(TRACK, px));
  const loPx = clampPx(lo * scale);
  const hiPx = clampPx(hi * scale);
  const midPx = clampPx(mid * scale);
  const bandLeft = Math.min(loPx, hiPx);
  const bandWidth = Math.max(1, Math.abs(hiPx - loPx));

  const track = document.createElement('div');
  track.style.cssText = `position:relative;width:${TRACK}px;height:${H}px;`
    + 'background:#1a2028;border-radius:5px;overflow:hidden;';

  const band = document.createElement('div');
  band.style.cssText = `position:absolute;top:0;left:${bandLeft}px;width:${bandWidth}px;`
    + `height:${H}px;background:${col};opacity:0.55;`;
  track.appendChild(band);

  const marker = document.createElement('div');
  marker.style.cssText = `position:absolute;top:0;left:${Math.max(0, midPx - 1)}px;`
    + `width:2px;height:${H}px;background:${col};`;
  marker.title = `estimate ~${compact(mid)}`;
  track.appendChild(marker);
  wrap.appendChild(track);

  const provenanceText = profile.provenance === 'spied'
    ? 'spied — exact'
    : profile.provenance === 'ships'
      ? 'ships-bounded'
      : 'estimated';
  const sub = document.createElement('div');
  sub.textContent = `${compact(profile.mobileLo)} ── ${compact(profile.mobileHi)} · ${provenanceText}`;
  sub.style.cssText = 'font-size:10px;color:#7c8893;margin-top:4px;';
  wrap.appendChild(sub);

  return wrap;
}

/**
 * 4) WHY — compact bulleted reasons list.
 * @param {string[]} reasons
 * @returns {HTMLUListElement}
 */
function whyList(reasons) {
  const ul = document.createElement('ul');
  ul.style.cssText = 'margin:0 0 10px;padding-left:16px;list-style:disc;'
    + 'font-size:11px;color:#8b95a0;line-height:1.5;';
  for (const r of reasons) {
    const li = document.createElement('li');
    li.textContent = r;
    ul.appendChild(li);
  }
  return ul;
}

/**
 * 5) HIDDEN FLEET — the arithmetic line + coverage line. Muted.
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate} est
 * @returns {HTMLDivElement}
 */
function hiddenFleetBlock(est) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.5;';

  const arith = document.createElement('div');
  arith.textContent =
    `military ${compact(est.militaryPoints)} − defence ${compact(est.defensePoints)} `
    + `− visible ${compact(est.visibleFleetPoints)} = ~${compact(est.hiddenFleetPoints)} hidden`;
  wrap.appendChild(arith);

  const cov = document.createElement('div');
  cov.style.color = '#7c8893';
  cov.textContent =
    `coverage ${est.spiedCount}/${est.planetCount ?? '?'}`
    + (est.provisional ? ' (provisional)' : '')
    + ' · (moons not counted)';
  wrap.appendChild(cov);

  return wrap;
}

/**
 * 5b) CIVIL BASELINE (Etap C): economy → expected civil ships, and the combat-
 * ship surplus over that baseline. A WEAK prior — shown as an upper bound with a
 * contamination caveat, never asserted as exact and never fed into the D score.
 * @param {import('../../domain/civilBaseline.js').CivilProfile} civ
 * @returns {HTMLDivElement}
 */
function civilBlock(civ) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.5;';

  const title = document.createElement('div');
  title.textContent = 'CIVIL BASELINE';
  title.style.cssText = 'font-size:10px;letter-spacing:0.5px;color:#6b7782;margin-bottom:2px;';
  wrap.appendChild(title);

  const line = document.createElement('div');
  line.textContent =
    `Economy ${compact(civ.economyScore)} → expected ~${compact(civ.expectedCivil)} civil ships. `
    + `Has ${compact(civ.ships)} → ~${compact(civ.combatShips)} look like combat fleet.`;
  wrap.appendChild(line);

  const bandColor = civ.band === 'fleet-holder' ? '#e2726a'
    : civ.band === 'elevated' ? '#e0b020' : '#7fd6a8';
  const bandLabel = civ.band === 'fleet-holder' ? 'combat-fleet holder'
    : civ.band === 'elevated' ? 'elevated — some combat fleet' : '≈ builder baseline';
  const verdict = document.createElement('div');
  verdict.textContent = `${bandLabel} · ${civ.confidence} confidence`;
  verdict.style.color = bandColor;
  wrap.appendChild(verdict);

  const caveat = document.createElement('div');
  caveat.textContent =
    'upper bound — probe swarms dilute, lifeform economy inflates; spy to confirm';
  caveat.style.cssText = 'color:#5f6b76;font-size:10px;';
  wrap.appendChild(caveat);

  return wrap;
}

/**
 * 6) PLANETS grid — reuses detailRow's exact responsive grid + per-planet scan
 * status / re-scan link / "D · F" line, plus a ⭐ hoard flag on the single planet
 * holding the most visible fleet.
 * @param {object} a
 * @param {string} a.playerId
 * @param {PlanetPos[]} a.planets
 * @param {Record<string, PlanetReport> | undefined} a.reports
 * @param {*} a.rescan
 * @param {number} a.nowMs
 * @param {(coord: string) => void} [a.onRescan]
 * @returns {HTMLDivElement}
 */
function planetsBlock({ playerId, planets, reports, rescan, nowMs, onRescan }) {
  const box = document.createElement('div');

  if (!planets.length) {
    const note = document.createElement('div');
    note.style.cssText = 'color:#888;font-size:12px;';
    note.textContent = 'No planets in the cached universe snapshot for this player.';
    box.appendChild(note);
    return box;
  }

  const coordStr = (/** @type {PlanetPos} */ p) => `${p.galaxy}:${p.system}:${p.position}`;
  const spied = planets.filter((p) => reports && reports[coordStr(p)]).length;

  // Which coord holds the most visible fleet? (the collection/fleet planet.)
  /** @type {string|undefined} */ let hoardCoord;
  let hoardFleet = -Infinity;
  if (reports) {
    for (const p of planets) {
      const r = reports[coordStr(p)];
      if (r && typeof r.fleetPts === 'number' && r.fleetPts > hoardFleet) {
        hoardFleet = r.fleetPts;
        hoardCoord = coordStr(p);
      }
    }
  }
  // Only flag when there is actually a positive fleet to hoard.
  if (!(hoardFleet > 0)) hoardCoord = undefined;

  const head = document.createElement('div');
  head.style.cssText = 'font-size:11px;color:#7c8893;margin-bottom:8px;';
  const need = planets.length - spied;
  head.textContent = `${spied} of ${planets.length} planets scanned`
    + (need > 0 ? ` · ${need} need a scan` : '');
  box.appendChild(head);

  // Responsive grid — a player can own 20+ planets, so auto-fill packs them into
  // as many ~190px columns as the width allows (verbatim from detailRow).
  const grid = document.createElement('div');
  grid.style.cssText =
    'display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:7px 18px;';

  for (const p of planets) {
    const coord = coordStr(p);
    const r = reports ? reports[coord] : undefined;
    const status = scanStatus({
      reportTsSec: r ? r.ts : undefined,
      nowMs,
      rescanAtMs: rescanAtFor(rescan, playerId, coord),
    });
    const item = document.createElement('div');
    item.style.cssText = 'font-size:11px;line-height:1.4;';

    // Line 1: coords (+ ⭐ hoard flag) · status · (re-scan ↻ to the right).
    const l1 = document.createElement('div');
    l1.style.cssText = 'display:flex;align-items:baseline;gap:6px;white-space:nowrap;';
    const coordEl = document.createElement('span');
    coordEl.textContent = coord;
    coordEl.style.color = status === 'none' ? '#8b95a0' : '#cfd6dd';
    l1.appendChild(coordEl);

    if (coord === hoardCoord) {
      const star = document.createElement('span');
      star.textContent = '⭐';
      star.style.fontSize = '10px';
      star.title = 'holds the most visible fleet';
      l1.appendChild(star);
    }

    const age = formatAge(ageMs(r?.ts, nowMs));
    const st = document.createElement('span');
    st.style.fontSize = '10px';
    if (status === 'none') { st.textContent = '○ needs scan'; st.style.color = '#7c8893'; }
    else if (status === 'fresh') { st.textContent = age; st.style.color = '#5a8f5a'; }
    else if (status === 'stale') { st.textContent = `${age} stale`; st.style.color = '#e0a020'; }
    else { st.textContent = `${age} re-scan`; st.style.color = '#e0a020'; }
    l1.appendChild(st);

    if ((status === 'fresh' || status === 'stale') && onRescan) {
      const link = document.createElement('span');
      link.textContent = '↻';
      link.style.cssText = 'color:#6b97c4;cursor:pointer;user-select:none;margin-left:auto;';
      link.title = 'Flag this planet for re-scan';
      link.addEventListener('click', () => onRescan(coord));
      l1.appendChild(link);
    }
    item.appendChild(l1);

    // Line 2: defense + visible fleet (only meaningful once scanned).
    const l2 = document.createElement('div');
    l2.style.color = '#6b7782';
    l2.textContent = r
      ? `D ${compact(Math.round(r.defPts))} · F ${compact(Math.round(r.fleetPts))}`
      : ' ';
    item.appendChild(l2);

    grid.appendChild(item);
  }
  box.appendChild(grid);
  return box;
}

/**
 * Relationship tag selector (Etap F redesign) — enemy / friend / neutral, the tag
 * that drives the Spyglass map marker colour (enemy red, friend green, neutral
 * grey). Device-local; neutral = untagged. A click stops propagation so it never
 * collapses the dossier.
 * @param {string} playerId
 * @param {import('../../state/watchList.js').Relationship} current
 * @param {(pid: string, rel: import('../../state/watchList.js').Relationship) => void} onSet
 * @returns {HTMLDivElement}
 */
function relationshipSelector(playerId, current, onSet) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;display:flex;align-items:center;gap:6px;font-size:11px;';
  const label = document.createElement('span');
  label.textContent = 'Relationship:';
  label.style.color = '#6b7782';
  wrap.appendChild(label);
  /** @type {Array<[import('../../state/watchList.js').Relationship, string, string]>} */
  const opts = [['enemy', 'Enemy', '#e2726a'], ['friend', 'Friend', '#7fd6a8'], ['neutral', 'Neutral', '#9aa7b3']];
  for (const [rel, text, color] of opts) {
    const on = (current || 'neutral') === rel;
    // Chip-pill look (Etap H6, matches .chip-group) with the relationship hue
    // carried by the active chip's border + text — not a filled swatch.
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = 'padding:2px 10px;border-radius:999px;font-size:11px;cursor:pointer;'
      + `border:1px solid ${on ? color : '#2b3a4d'};background:${on ? '#12253c' : '#18222e'};`
      + `color:${on ? color : '#9fb4c4'};font-weight:${on ? '600' : '400'};`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onSet(playerId, rel); });
    wrap.appendChild(btn);
  }
  return wrap;
}

/** Sparkline block glyphs, empty → full. */
const SPARK_BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A monospace sparkline for a small histogram (each bar scaled to the max).
 * Exported for the watchlist cards (same feature, same visual language).
 * @param {number[]} bins
 * @returns {string}
 */
export function sparkline(bins) {
  const max = Math.max(1, ...bins);
  return bins.map((v) => SPARK_BLOCKS[Math.min(8, Math.round((v / max) * 8))]).join('');
}

/**
 * 7) ROUTINE (Etap F) — the honest, sample-gated summary of what the player's
 * spy history shows: hour-of-day activity, weekday resources, the collection
 * planet, a recent timeline. Built ENTIRELY from reports the user opened while
 * playing; every line names its sample count (coverage), and "activity" is the
 * last INTERACTION with a body — never asserted as the player being "online"
 * (SPYGLASS-REDESIGN.md §6.6/§6.6bis). Hollow until the history fills.
 * @param {import('../../domain/routine.js').RoutineSummary} routine
 * @returns {HTMLDivElement}
 */
function routineBlock(routine) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.5;';

  const title = document.createElement('div');
  title.textContent = 'ROUTINE';
  title.style.cssText = 'font-size:10px;letter-spacing:0.5px;color:#6b7782;margin-bottom:2px;';
  wrap.appendChild(title);

  if (!routine || routine.observations === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No history yet — this fills from the spy reports you open over time.';
    empty.style.color = '#5f6b76';
    wrap.appendChild(empty);
    return wrap;
  }

  const act = routine.activity;
  if (act.gate !== 'none') {
    const line = document.createElement('div');
    const spark = document.createElement('span');
    spark.style.cssText = 'font-family:monospace;color:#9fc6e8;';
    spark.textContent = sparkline(act.bins);
    line.append('activity by hour ', spark);
    if (act.label && (act.gate === 'pattern' || act.gate === 'strong')) line.append(` — ${act.label}`);
    wrap.appendChild(line);
    const cov = document.createElement('div');
    cov.style.cssText = 'color:#5f6b76;font-size:10px;';
    cov.textContent = `hours 0–23 · from ${act.samples} report${act.samples === 1 ? '' : 's'} you opened`
      + `${act.gate === 'hint' ? ' (thin — a hint, not a pattern)' : ''} · "activity" = last interaction, not "online"`;
    wrap.appendChild(cov);
  }

  const wk = routine.weekday;
  if (wk.gate !== 'none') {
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let best = -1;
    let bestVal = -1;
    wk.medians.forEach((m, i) => { if (m != null && m > bestVal) { bestVal = m; best = i; } });
    if (best >= 0) {
      const line = document.createElement('div');
      line.textContent = `richest ${DAYS[best]} (~${compact(bestVal)} res, n=${wk.samples[best]})`;
      wrap.appendChild(line);
    }
  }

  if (routine.collection) {
    const c = routine.collection;
    const line = document.createElement('div');
    line.textContent = `gathers onto ${c.coord} (richest of ${c.ofBodies}, median ~${compact(c.medianRes)}, n=${c.samples})`;
    wrap.appendChild(line);
  }

  if (routine.timeline.length) {
    const tl = document.createElement('div');
    tl.style.cssText = 'margin-top:3px;color:#7c8893;font-size:10px;';
    tl.textContent = 'recent: ' + routine.timeline.slice(0, 5).map((t) => {
      const parts = [t.coord];
      if (typeof t.defenseValue === 'number') parts.push(`def ${compact(t.defenseValue)}`);
      if (typeof t.fleetValue === 'number') parts.push(`f ${compact(t.fleetValue)}`);
      return parts.join(' ');
    }).join(' · ');
    wrap.appendChild(tl);
  }

  return wrap;
}

/**
 * Build the per-player dossier detail row: a dark panel stacking the header,
 * raid verdict, danger interval bar, WHY reasons, hidden-fleet arithmetic, and
 * the per-planet scan grid. Each section is skipped cleanly when its data is
 * absent. Hidden unless `open`. Pure DOM — no timers/storage.
 *
 * @param {object} a
 * @param {string} a.playerId
 * @param {string} a.name
 * @param {import('../../state/watchList.js').Relationship} [a.relationship]  Current tag.
 * @param {(pid: string, rel: import('../../state/watchList.js').Relationship) => void} [a.onSetRelationship]
 * @param {import('../../domain/dangerScore.js').DangerProfile} [a.profile]
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate} [a.estimate]
 * @param {import('../../domain/raidVerdict.js').RaidVerdict} [a.verdict]
 * @param {boolean} [a.inBand]
 * @param {import('../../domain/civilBaseline.js').CivilProfile} [a.civilProfile]
 * @param {import('../../domain/routine.js').RoutineSummary} [a.routine]
 * @param {import('../../domain/targets.js').PlanetPos[]} a.planets
 * @param {Record<string, {ts:number, defPts:number, fleetPts:number}>} [a.reports]  keyed by "g:s:p"
 * @param {*} a.rescan
 * @param {number} a.nowMs
 * @param {(coord:string)=>void} [a.onRescan]
 * @param {number} a.colspan
 * @param {boolean} a.open
 * @returns {HTMLTableRowElement}
 */
export function buildDossier(a) {
  const tr = document.createElement('tr');
  tr.dataset.detailFor = a.playerId;
  tr.style.display = a.open ? '' : 'none';

  const td = document.createElement('td');
  td.colSpan = a.colspan;
  td.style.padding = '8px 8px 12px 28px';
  td.style.borderBottom = '1px solid #222';
  td.style.background = '#0b1118';
  tr.appendChild(td);

  // 1) Header (always).
  td.appendChild(headerLine(a.name, a.profile, !!a.inBand));

  // 1b) Relationship tag selector — drives the Spyglass map marker colour.
  if (a.onSetRelationship) {
    td.appendChild(relationshipSelector(a.playerId, a.relationship || 'neutral', a.onSetRelationship));
  }

  // 2) Raid verdict banner (the jack-point).
  if (a.verdict) td.appendChild(verdictBanner(a.verdict));

  // Below the full-width header/verdict, the rest splits into two columns on
  // wide viewports (Etap H6, `.dossier-grid` in dashboard.html): the JUDGEMENT
  // stack (danger / why / hidden math / civil) beside the EVIDENCE stack
  // (planets / routine) instead of one long scroll. Content is untouched —
  // this is layout only.
  const grid = document.createElement('div');
  grid.className = 'dossier-grid';
  const judgement = document.createElement('div');
  const evidence = document.createElement('div');
  grid.append(judgement, evidence);
  td.appendChild(grid);

  // 3) Danger + interval bar.
  if (a.profile) judgement.appendChild(dangerBlock(a.profile));

  // 4) WHY reasons.
  if (a.profile && a.profile.reasons && a.profile.reasons.length) {
    judgement.appendChild(whyList(a.profile.reasons));
  }

  // 5) Hidden-fleet arithmetic.
  if (a.estimate) judgement.appendChild(hiddenFleetBlock(a.estimate));

  // 5b) Civil-fleet baseline (Etap C).
  if (a.civilProfile) judgement.appendChild(civilBlock(a.civilProfile));

  // 6) Planets grid (renders its own "no planets" note when empty).
  evidence.appendChild(planetsBlock({
    playerId: a.playerId,
    planets: a.planets,
    reports: a.reports,
    rescan: a.rescan,
    nowMs: a.nowMs,
    onRescan: a.onRescan,
  }));

  // 7) Routine (Etap F) — activity/weekday/collection/timeline from spy history.
  if (a.routine) evidence.appendChild(routineBlock(a.routine));

  return tr;
}
