// @ts-check

// Per-player DOSSIER row (dashboard, Spyglass "Watchlist Workbench"). The Etap-B
// drill-down that replaces the old thin expand-row: one dark panel stacking the
// raid verdict (the jack-point), the honest danger + mobile-fleet INTERVAL bar
// (finally rendering mobileLo..mobileHi, not just a point figure), the WHY
// reasons, the hidden-fleet arithmetic, and the responsive per-planet scan grid
// (reused verbatim from targets.js `detailRow`, incl. a ⭐ hoard flag on the
// planet holding the most visible fleet).
//
// Mostly self-contained: the small formatAge()/ageMs() helpers are local, and
// compact() comes from the shared ./format.js leaf (NOT a sibling RENDERER
// file) so there is no intra-feature file coupling. Pure DOM — no timers, no
// storage, no chrome.*.
// Read-only: it renders intel, it never sends (the in-game scan FAB does that).

import { scanStatus, rescanAtFor } from '../../domain/spyScan.js';
import { motherPlanetOf } from '../../domain/lootRhythm.js';
import { dangerColor } from '../../lib/dangerColor.js';
import { effectiveScan, ringKeyFor } from '../../domain/scanMode.js';
import { FRESH_LOOK_MS } from '../../domain/fleetLanding.js';
import { bodyActivityReadout } from '../../domain/galaxyWatch.js';
import { mergeActivityObs } from '../../domain/activityObs.js';
import { compact } from './format.js';
import { estimateCombatShare } from '../../domain/threatModel.js';
import { pointsToResources } from '../../domain/unitCosts.js';

/**
 * @typedef {import('../../domain/targets.js').PlanetPos} PlanetPos
 * @typedef {{ ts: number, defPts: number, fleetPts: number, avgLoot?: number, maxLoot?: number, lastLoot?: number, lootSamples?: number, act?: import('../../domain/activityObs.js').ActivityObs[] }} PlanetReport
 */

// ── Local formatting helpers (compact magnitude → shared ./format.js) ─────────

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
 * 2) RAID VERDICT banner — the visually strongest line (the jack-point). Colour
 * by kind; append loot + confidence/age tail.
 * @param {import('../../domain/raidVerdict.js').RaidVerdict} verdict
 * @returns {HTMLDivElement}
 */
function verdictBanner(verdict) {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '10px';
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
  // Plain, no emoji: label · loot · scan age. The confidence TIER was dropped — it
  // was just a restatement of the age ("high" ⇔ "<1h old") and read as a threat score.
  let text = verdict.label;
  if (typeof verdict.lootNow === 'number' && verdict.lootNow > 0) {
    text += ` · loot ~${compact(verdict.lootNow)}`;
  }
  if (typeof verdict.ageMs === 'number' && Number.isFinite(verdict.ageMs)) {
    text += ` · scan ${formatAge(verdict.ageMs)} old`;
  }
  div.textContent = text;
  div.style.cssText = `font-size:15px;color:${color};` + (bold ? 'font-weight:700;' : 'font-weight:600;');
  if (verdict.lootCoord) div.title = `best loot at ${verdict.lootCoord}`;
  wrap.appendChild(div);
  // Spell out the WHY (so "fleet risk" isn't an unexplained tag).
  if (verdict.reasons && verdict.reasons.length) {
    const why = document.createElement('div');
    why.textContent = verdict.reasons[0];
    why.style.cssText = 'font-size:11px;color:#6b7782;margin-top:2px;';
    wrap.appendChild(why);
  }
  return wrap;
}

/**
 * 3) DANGER line — "DANGER n/100" followed inline by the ACTIVE apex tells as
 * compact danger-tinted pills (the terse "why it's apex", right beside the
 * number). Only fired tells show — no N/6, no missing chips.
 * @param {import('../../domain/dangerScore.js').DangerProfile} profile
 * @returns {HTMLDivElement}
 */
function dangerBlock(profile) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

  const d = Math.round(profile.danger * 100);
  const col = dangerColor(d);

  const label = document.createElement('span');
  label.textContent = `DANGER ${d}/100`;
  label.style.cssText = `font-size:12px;font-weight:600;color:${col};`;
  wrap.appendChild(label);

  // Active apex tells inline (capability first, then aggression). The lo/hi
  // mobile-fleet interval that used to render here was dropped long ago (it
  // duplicated the Fleet column + the reasons below).
  if (profile.apex) {
    for (const t of [...profile.apex.capability, ...profile.apex.aggression]) {
      if (t.fired) wrap.appendChild(apexChip(t.label, col));
    }
  }

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
 * One active apex tell, rendered as a compact danger-tinted pill inline beside
 * the DANGER number (see {@link dangerBlock}). Only FIRED tells are shown — the
 * dossier no longer spells out the N/6 or the missing signals.
 * @param {string} label  Short keyword (e.g. `res/ship`, `reach`).
 * @param {string} col    Danger colour (hex #RRGGBB — alpha appended for the tint).
 * @returns {HTMLSpanElement}
 */
function apexChip(label, col) {
  const c = document.createElement('span');
  c.textContent = label;
  c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:9px;'
    + `background:${col}24;color:${col};border:0.5px solid ${col}66;`;
  return c;
}

/**
 * 5) HIDDEN FLEET — the arithmetic line. Muted. No coverage line any more:
 * the same N/M is already in the WHY list ("spied 34/34 — exact fleet") AND
 * split per body kind in the evidence column's coverage line — a third copy
 * was pure noise. `provisional` stays as a tail on the arithmetic itself.
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate} est
 * @param {import('../../domain/dangerScore.js').DangerProfile} [profile]  Supplies the
 *   composition prior (combatShare) for the points → resources conversion.
 * @returns {HTMLDivElement}
 */
function hiddenFleetBlock(est, profile) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.5;';

  // One arithmetic line, but the two halves the reader acts on are TINTED:
  // `visible` (parked fleet the scans actually SAW — hard evidence, blue) and
  // `hidden` (the computed remainder, amber — it SWINGS with scan timing: a
  // fleet caught home reads ~0 hidden, exactly when it sits catchable).
  //
  // The identity lives in MILITARY POINTS, where civil ships count half — so
  // the amber remainder gets a RESOURCE conversion appended: the number the
  // player can actually compare with a report's fleet value. (The pentagon
  // lesson: "~14.5M hidden" was a real 23.6G-resource cargo fleet.)
  const arith = document.createElement('div');
  arith.appendChild(document.createTextNode(
    `military ${compact(est.militaryPoints)} − defence ${compact(est.defensePoints)} − `));
  const vis = document.createElement('span');
  vis.textContent = `visible ${compact(est.visibleFleetPoints)}`;
  vis.style.color = '#7ca6de';
  arith.appendChild(vis);
  arith.appendChild(document.createTextNode(' = '));
  const hid = document.createElement('span');
  hid.textContent = `~${compact(est.hiddenFleetPoints)} hidden`;
  hid.style.color = '#e0b020';
  arith.appendChild(hid);
  const share = typeof profile?.combatShare === 'number'
    ? profile.combatShare
    : estimateCombatShare({ visibleCombatShare: est.visibleCombatShare });
  const hiddenRes = pointsToResources(est.hiddenFleetPoints, share);
  if (hiddenRes >= 1000) {
    const res = document.createElement('span');
    res.textContent = ` ≈ ${compact(hiddenRes)} res`;
    res.style.color = '#e0b020';
    res.title = 'Points → resources: the military score counts civil ships (transporters, '
      + 'recyclers, probes) at 50%, so the resource value depends on composition — assumed '
      + `${Math.round(share * 100)}% combat by value (spied composition + aggression tells).`;
    arith.appendChild(res);
  }
  if (est.provisional) arith.appendChild(document.createTextNode(' (provisional)'));
  arith.title = 'Visible = parked fleet your scans saw (stable evidence). Hidden = the remainder '
    + 'in military points (civil ships count half there); it swings with scan timing — a fleet '
    + 'caught home reads ~0 hidden.';
  wrap.appendChild(arith);

  return wrap;
}

/**
 * 5b) CIVIL BASELINE (Etap C): economy → expected civil ships, and the combat-
 * ship surplus over that baseline. A WEAK prior — shown as an upper bound with a
 * contamination caveat, never asserted as exact and never fed into the D score.
 * @param {import('../../domain/civilBaseline.js').CivilProfile} civ
 * @param {import('../../domain/dangerScore.js').DangerProfile} [profile]  The Danger
 *   profile — its fleet- and spy-aware combat quality OVERRIDES this count-only prior.
 * @returns {HTMLDivElement}
 */
function civilBlock(civ, profile) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.5;';

  // The Danger model measures res/ship on the FLEET (defence excluded, tightened by
  // any scan); when THAT reads cheap hulls (low combat quality), it overrides this
  // count-only prior — a defensive farmer's TOTAL res/ship looks combat, but the
  // fleet itself is transporters (the pentagon case: 38M of 54.6M was defence). So
  // demote the "combat" verdict rather than let the two blocks contradict.
  const q = profile && typeof profile.combatQuality === 'number' ? profile.combatQuality : undefined;
  const fleetRps = profile && typeof profile.resPerShip === 'number' ? profile.resPerShip : undefined;
  const demoted = q !== undefined && q < 0.5 && (civ.band === 'elevated' || civ.band === 'fleet-holder');

  // One tight line: how many of the player's ships look like combat fleet over
  // the economy-implied civil baseline, tinted by band. The caveat (upper bound /
  // contamination) lives only in the tooltip now — the visible line stays lean.
  // Demoted and cheap-swarm are REASSURING verdicts ("not combat") — paint them
  // green like the builder band, not neutral grey (the user reads colour first).
  const bandColor = demoted || civ.band === 'cheap-swarm' ? '#7fd6a8'
    : civ.band === 'fleet-holder' ? '#e2726a'
    : civ.band === 'elevated' ? '#e0b020' : '#7fd6a8';
  const bandLabel = civ.band === 'fleet-holder' ? 'combat-fleet holder'
    : civ.band === 'elevated' ? 'elevated'
    : civ.band === 'cheap-swarm' ? 'transporter/probe swarm' : '≈ builder';
  const line = document.createElement('div');
  const label = document.createElement('span');
  label.textContent = 'Civil baseline: ';
  label.style.color = '#6b7782';
  const val = document.createElement('span');
  // Demoted: the fleet-aware Danger model contradicts the count surplus (defence /
  // logistics). Cheap-swarm: a big COUNT surplus at low res/ship is logistics, not
  // combat (the Qbaba case). Otherwise the usual surplus phrasing. Game language:
  // name the ship kinds ("transporters/probes"), never "cheap hulls".
  val.textContent = demoted
    ? `${compact(civ.ships)} ships, but the fleet is transporters/probes${fleetRps ? ` (≈${compact(fleetRps)} res/ship)` : ''}`
    : civ.band === 'cheap-swarm'
      ? `${compact(civ.ships)} ships at ≈${compact(civ.resPerShip ?? 0)} res/ship · ${bandLabel}`
      : `~${compact(civ.combatShips)} of ${compact(civ.ships)} ships look combat · ${bandLabel}`;
  val.style.color = bandColor;
  line.append(label, val);
  line.title =
    `Economy ${compact(civ.economyScore)} → expected ~${compact(civ.expectedCivil)} civil ships; `
    + `${civ.confidence} confidence. Upper bound — probe swarms dilute, lifeform economy inflates; spy to confirm.`;
  wrap.appendChild(line);

  return wrap;
}

/**
 * The at-a-glance coverage line — "🪐 17/17 · 🌙 12/17 · to scan: 5 moons":
 * one count per body kind (planets / moons — a moon is a SEPARATE spiable
 * body, hidden fleet parks there), green when complete, amber while short,
 * with a plain-words tail saying exactly what's left. Rendered on the dossier
 * HEADER line (beside the relationship / Watch-via chips): stacked above the
 * table it used to push the evidence down a full line, leaving a dead band
 * under the header. `null` when the snapshot has no planets.
 * @param {PlanetPos[]} planets
 * @param {Record<string, PlanetReport> | undefined} reports
 * @param {Record<string, PlanetReport> | undefined} moons
 * @returns {HTMLDivElement | null}
 */
function coverageLine(planets, reports, moons) {
  if (!planets.length) return null;
  const coordStr = (/** @type {PlanetPos} */ p) => `${p.galaxy}:${p.system}:${p.position}`;
  const spied = planets.filter((p) => reports && reports[coordStr(p)]).length;
  const moonsTotal = planets.reduce((n, p) => n + (p.hasMoon ? 1 : 0), 0);
  const moonsSpied = moons
    ? planets.reduce((n, p) => n + (p.hasMoon && moons[coordStr(p)] ? 1 : 0), 0)
    : 0;

  const head = document.createElement('div');
  head.style.cssText = 'font-size:11px;color:#7c8893;'
    + 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;';

  /**
   * One "🪐 17/17" count — green complete / amber short.
   * @param {string} glyph
   * @param {number} done
   * @param {number} total
   * @param {string} tip
   * @returns {HTMLSpanElement}
   */
  const covPart = (glyph, done, total, tip) => {
    const s = document.createElement('span');
    s.title = tip;
    s.style.whiteSpace = 'nowrap';
    s.appendChild(document.createTextNode(`${glyph} `));
    const b = document.createElement('b');
    b.textContent = `${done}/${total}`;
    b.style.cssText = `color:${total > 0 && done >= total ? '#7fd6a8' : '#e0b45f'};`
      + 'font-variant-numeric:tabular-nums;';
    s.appendChild(b);
    return s;
  };
  head.appendChild(covPart('🪐', spied, planets.length,
    'Planets you hold a spy report for / planets this player owns (universe snapshot)'));
  if (moonsTotal > 0) {
    head.appendChild(covPart('🌙', moonsSpied, moonsTotal,
      'Moons you hold a spy report for / moons this player owns — a moon is a '
      + 'separate spiable body, and fleet often hides there'));
  }
  const needP = planets.length - spied;
  const needM = moonsTotal - moonsSpied;
  const tail = document.createElement('span');
  if (needP <= 0 && needM <= 0) {
    tail.textContent = '✓ all scanned';
    tail.style.color = '#7fd6a8';
  } else {
    const parts = [];
    if (needP > 0) parts.push(`${needP} planet${needP === 1 ? '' : 's'}`);
    if (needM > 0) parts.push(`${needM} moon${needM === 1 ? '' : 's'}`);
    tail.textContent = `to scan: ${parts.join(' + ')}`;
    tail.style.color = '#b08a3e';
  }
  head.appendChild(tail);
  return head;
}

/**
 * 6) PLANETS grid — responsive per-planet grid with scan status / re-scan link,
 * labelled def/fleet/loot stat lines (plain words, no glyph soup), a per-slot
 * 🌙 moon row with the moon's OWN scan state, plus a ⭐ hoard flag on the single
 * planet holding the most visible fleet. (Its coverage summary — 🪐/🌙 counts —
 * renders on the dossier header line via {@link coverageLine}, not here.)
 * @param {object} a
 * @param {string} a.playerId
 * @param {PlanetPos[]} a.planets
 * @param {Record<string, PlanetReport> | undefined} a.reports
 * @param {Record<string, PlanetReport> | undefined} [a.moons]
 *   MOON reports keyed by the moon's planet "g:s:p" coord (their own map).
 * @param {*} a.rescan
 * @param {number} a.nowMs
 * @param {Record<string, import('../../domain/scanMode.js').ScanMode>} [a.scanMode]
 *   Scan-mode map (player id / body override key → 'on'|'off') — drives the
 *   per-body Scan toggle. Galaxy activity is NOT gated (always on).
 * @param {(key: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void} [a.onSetScanMode]
 *   Set a body scan override (key = "g:s:p"/"g:s:p:3"); present → the toggle renders.
 * @param {Record<string, import('../../domain/activityObs.js').ActivityObs[]>} [a.rings]
 *   THIS player's galaxy-activity rings (ringKey "g:s:p:type" → ring) — the
 *   Activity column source.
 * @param {'planets'|'moons'|'both'} [a.scanBodies]  Which body TYPES the probe
 *   plan includes; gates the per-body Scan toggle (a toggle on a filtered-out
 *   type would be a dead switch).
 * @param {string} [a.linkBase]  Game origin (e.g. `https://s163-pl.ogame.gameforge.com`);
 *   present → the `body` coords become links to the in-game galaxy view.
 * @returns {HTMLDivElement}
 */
function planetsBlock({
  playerId, planets, reports, moons, rescan, nowMs, scanMode, onSetScanMode,
  rings, scanBodies = 'planets', linkBase,
}) {
  const box = document.createElement('div');

  if (!planets.length) {
    const note = document.createElement('div');
    note.style.cssText = 'color:#888;font-size:12px;';
    note.textContent = 'No planets in the cached universe snapshot for this player.';
    box.appendChild(note);
    return box;
  }

  const coordStr = (/** @type {PlanetPos} */ p) => `${p.galaxy}:${p.system}:${p.position}`;
  // In-game galaxy deep link for a body — same shape the Galaxy Viewer / free
  // maps use (`component=galaxy&galaxy=&system=`), plus `position` to land on the
  // exact planet's row. Empty when the game origin is unknown → plain text.
  const galaxyHref = (/** @type {PlanetPos} */ p) => (linkBase
    ? `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${p.galaxy}&system=${p.system}&position=${p.position}`
    : '');

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

  // The loot HOARD ("mother") planet: the body whose peak loot towers over the
  // empire — a collector farmer's accumulation point (🏦), distinct from ⭐ (most
  // parked fleet); they often, but not always, coincide.
  const motherCoord = motherPlanetOf(reports || {});

  // ── Per-BODY table — one row per planet plus an indented 🌙 row for its
  // moon, so def / fleet / loot line up in real columns and an empire reads
  // like a sheet (the per-planet mini-cards made cross-planet comparison pure
  // eye work; the user ANALYSES scans). Moon rows share the def/fleet columns,
  // so fleet parked on moons — what a moon scan is for — reads straight down
  // the fleet column.
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;'
    + 'line-height:1.6;font-variant-numeric:tabular-nums;';

  const thr = document.createElement('tr');
  /** @type {Array<[string, string, string]>} */
  const cols = [
    ['body', 'left', ''],
    ['scan', 'left', 'Age of your newest espionage report (probe intel) — click the toggle to stop/resume probing this body'],
    ['activity', 'left', 'When this body was last active — from your galaxy sightings AND your spy reports’ activity marker. ">Nh" = quiet at every look for that long. "Activity" = any interaction, not "online".'],
    ['def', 'right', 'Defence on the body — resource points, newest report'],
    ['fleet', 'right', 'Visible (parked) fleet on the body — resource points, newest report'],
    ['loot avg', 'right', 'Average on-body resources across your reports (the loot rhythm)'],
    ['peak', 'right', 'Highest on-body resources you have ever seen'],
  ];
  for (const [txt, align, tip] of cols) {
    const th = document.createElement('th');
    th.textContent = txt;
    if (tip) th.title = tip;
    th.style.cssText = `text-align:${align};font-size:11px;font-weight:400;color:#5f6b76;`
      + 'padding:0 0 3px;border-bottom:1px solid #2a3d52;'
      + (align === 'right' ? 'padding-left:14px;' : '');
    thr.appendChild(th);
  }
  table.appendChild(thr);

  /**
   * One table cell with text + inline css.
   * @param {string} text
   * @param {string} css
   * @returns {HTMLTableCellElement}
   */
  const cellEl = (text, css) => {
    const td = document.createElement('td');
    td.textContent = text;
    td.style.cssText = css;
    return td;
  };
  /** Right-aligned numeric cell base. */
  const NUM = 'text-align:right;padding:2px 0 2px 14px;white-space:nowrap;';
  /** Colour of an absent value ("—"). */
  const DASH = '#4c5763';
  // Probe scanning is per-body toggleable, but only for the body TYPES the scan
  // filter includes (planets/moons/both) — a toggle on a filtered-out type would
  // be a dead switch. With the whole player's probes OFF (Watch via) the column
  // goes fully inert: raw report age if one exists, '—' otherwise — no per-body
  // toggles (player-'off' dominates in effectiveScan, so they'd be dead too).
  const scannablePlanets = scanBodies !== 'moons';
  const scannableMoons = scanBodies !== 'planets';
  const playerProbesOff = !!(scanMode && scanMode[playerId] === 'off');

  /**
   * The Scan cell for one body: probe-report freshness + an integrated on/off
   * toggle (no separate action column). Per-body scan-off shows a muted "off";
   * a body type outside the scan filter shows an inert "—"; the whole player
   * probes-off (Watch via) shows only the raw age / '—', nothing clickable.
   * @param {string} key         override key: "g:s:p" / "g:s:p:3".
   * @param {'none'|'fresh'|'stale'|'rescan'} status
   * @param {number|undefined} reportTs
   * @param {boolean} scannable  is this body's TYPE in the scan filter?
   * @param {boolean} small      moon-row font sizing.
   * @returns {HTMLTableCellElement}
   */
  const scanCell = (key, status, reportTs, scannable, small) => {
    const pad = small ? 'padding:0 0 3px 12px;' : 'padding:2px 0 2px 12px;';
    const td = document.createElement('td');
    td.style.cssText = `${pad}font-size:11px;white-space:nowrap;`;
    if (!scannable) {
      td.textContent = '—';
      td.style.color = DASH;
      td.title = 'Outside the current scan filter (planets / moons / both)';
      return td;
    }
    if (playerProbesOff) {
      // Watch via → probes OFF: raw data only, no rescan/toggle affordances.
      const age = formatAge(ageMs(reportTs, nowMs));
      td.textContent = age || '—';
      td.style.color = age ? '#7c8893' : DASH;
      td.title = 'Probes are off for this player (Watch via) — showing the last report’s age only';
      return td;
    }
    const on = effectiveScan(scanMode, playerId, key) === 'on';
    const txtEl = document.createElement('span');
    if (!on) {
      txtEl.textContent = 'off';
      txtEl.style.color = '#5a646f';
    } else {
      const age = formatAge(ageMs(reportTs, nowMs));
      if (status === 'none') { txtEl.textContent = '—'; txtEl.style.color = DASH; td.title = 'No espionage report for this body yet'; }
      else if (status === 'fresh') { txtEl.textContent = age; txtEl.style.color = '#5a8f5a'; }
      else if (status === 'stale') { txtEl.textContent = `${age} stale`; txtEl.style.color = '#e0a020'; }
      else { txtEl.textContent = `${age} re-scan`; txtEl.style.color = '#e0a020'; }
    }
    td.appendChild(txtEl);
    // Integrated toggle — one small glyph, no separate column. .hit-pad
    // grows its touch hit-box to ≥36px (coarse pointers only, see
    // dashboard.html); inline-block so the pad has a box to centre on.
    if (onSetScanMode) {
      const tog = document.createElement('span');
      tog.textContent = on ? ' ⊘' : ' ⟳';
      tog.className = 'hit-pad';
      tog.style.cssText = 'color:#54626f;cursor:pointer;user-select:none;margin-left:5px;display:inline-block;';
      tog.title = on
        ? 'Stop probing this body (keep tracking its galaxy activity)'
        : 'Resume probing this body';
      tog.addEventListener('click', (e) => { e.stopPropagation(); onSetScanMode(key, on ? 'off' : 'on'); });
      td.appendChild(tog);
    }
    return td;
  };

  /**
   * The Activity cell for one body — HONEST last-active merged from BOTH
   * sources: the galaxy ring AND the body's spy reports (every report is also
   * a look — its activity marker), so a probed-but-never-browsed body still
   * reads here. The time since the last positive marker; when every look was
   * quiet, a ">Nh" bound counted from the FIRST quiet look (each look proves
   * ≥1 h idle; activity between looks can't be ruled out) that keeps aging as
   * time passes — a new quiet look carries the same information, so it never
   * resets the readout; a new positive marker updates it. Colour warms with
   * recent activity (target likely around) and cools with long silence (a
   * better strike window).
   * @param {string} ringKey  "g:s:p:1" / "g:s:p:3"
   * @param {import('../../domain/activityObs.js').ActivityObs[] | undefined} probeAct
   *   The body's spy-report looks (projected in repaintTargets).
   * @param {boolean} small
   * @returns {HTMLTableCellElement}
   */
  const activityCell = (ringKey, probeAct, small) => {
    const pad = small ? 'padding:0 0 3px 12px;' : 'padding:2px 0 2px 12px;';
    const td = document.createElement('td');
    td.style.cssText = `${pad}font-size:11px;white-space:nowrap;`;
    const ro = bodyActivityReadout(mergeActivityObs(rings ? rings[ringKey] : undefined, probeAct));
    if (ro.looks === 0) {
      td.textContent = '—';
      td.style.color = DASH;
      td.title = 'No sighting yet — browse this system in the galaxy or scan the body to start tracking activity';
      return td;
    }
    if (ro.lastActiveSec == null) {
      // Only quiet looks — never caught activity. Show the honest aging bound:
      // quiet since the first look, +1 h (a quiet marker proves ≥1 h idle).
      const sinceMs = ageMs(ro.quietSinceSec ?? ro.lastLookSec, nowMs) + 3600_000;
      const lookAge = ro.lastLookSec ? formatAge(ageMs(ro.lastLookSec, nowMs)) : '';
      td.textContent = `>${formatAge(sinceMs)}`;
      td.style.color = '#6f97b0';
      td.title = `No activity seen in ${ro.looks} look${ro.looks === 1 ? '' : 's'} — quiet every `
        + `time since the first one (each proves ≥1 h idle; activity between looks can’t be `
        + `ruled out). Last checked ${lookAge || '—'} ago.`;
      return td;
    }
    const activeMs = ageMs(ro.lastActiveSec, nowMs);
    const age = formatAge(activeMs);
    const lookAge = ro.lastLookSec ? formatAge(ageMs(ro.lastLookSec, nowMs)) : '';
    // Warm = active recently (around now), cool = long quiet (strike window).
    td.style.color = activeMs < 3600_000 ? '#e0a86a' : activeMs < 12 * 3600_000 ? '#c8b06a' : '#6f97b0';
    td.textContent = `${age} ago${ro.quietNow ? ' · quiet' : ''}`;
    td.title = `Last interaction ~${age} ago (from ${ro.hits} activity marker`
      + `${ro.hits === 1 ? '' : 's'} in ${ro.looks} look${ro.looks === 1 ? '' : 's'}; `
      + `last looked ${lookAge} ago). "Activity" = any interaction with the body, not "online".`;
    return td;
  };

  let firstRow = true;
  for (const p of planets) {
    const coord = coordStr(p);
    const r = reports ? reports[coord] : undefined;
    const status = scanStatus({
      reportTsSec: r ? r.ts : undefined,
      nowMs,
      rescanAtMs: rescanAtFor(rescan, playerId, coord),
    });
    const isMother = coord === motherCoord;

    const row = document.createElement('tr');
    // Hairline between body GROUPS (a planet + its moon); none above the first.
    if (!firstRow) row.style.borderTop = '1px solid rgba(66,92,120,.22)';
    firstRow = false;

    // body: coords + ⭐ (most parked fleet) + 🏦 (loot hoard).
    const body = document.createElement('td');
    body.style.cssText = 'padding:2px 0;white-space:nowrap;';
    // Coords link to the in-game galaxy view when we know the origin; otherwise
    // plain text. stopPropagation so the click opens the game (new tab) without
    // also toggling the dossier row it lives in.
    const href = galaxyHref(p);
    const coordEl = document.createElement(href ? 'a' : 'span');
    coordEl.textContent = coord;
    coordEl.style.color = status === 'none' ? '#8b95a0' : '#cfd6dd';
    if (href) {
      const link = /** @type {HTMLAnchorElement} */ (coordEl);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Open this system in the in-game galaxy view';
      link.style.textDecoration = 'none';
      link.style.cursor = 'pointer';
      link.addEventListener('click', (ev) => ev.stopPropagation());
    }
    body.appendChild(coordEl);
    if (coord === hoardCoord) {
      const star = document.createElement('span');
      star.textContent = ' ⭐';
      star.style.fontSize = '10px';
      star.title = 'holds the most visible fleet';
      body.appendChild(star);
    }
    if (isMother) {
      const bank = document.createElement('span');
      bank.textContent = ' 🏦';
      bank.style.fontSize = '10px';
      bank.title = 'hoard / mother planet — loot peak towers over the empire (collection point)';
      body.appendChild(bank);
    }
    row.appendChild(body);

    // Scan (probe freshness + toggle) then Activity (galaxy looks + probe looks).
    row.appendChild(scanCell(coord, status, r?.ts, scannablePlanets, false));
    row.appendChild(activityCell(ringKeyFor(coord, 1), r?.act, false));

    if (r) {
      row.appendChild(cellEl(compact(Math.round(r.defPts)), `${NUM}color:#9fb0c0;`));
      row.appendChild(cellEl(compact(Math.round(r.fleetPts)), `${NUM}color:#9fb0c0;`));
      // Loot rhythm — gold on the 🏦 hoard/mother planet, whose peak towers
      // over the empire.
      const hasLoot = typeof r.maxLoot === 'number';
      const lootColor = hasLoot ? (isMother ? '#e0b45f' : '#9fb0c0') : DASH;
      row.appendChild(cellEl(hasLoot ? compact(Math.round(r.avgLoot ?? 0)) : '—',
        `${NUM}color:${lootColor};`));
      row.appendChild(cellEl(hasLoot ? compact(Math.round(r.maxLoot ?? 0)) : '—',
        `${NUM}color:${lootColor};font-weight:${isMother ? '700' : '400'};`));
    } else {
      for (let i = 0; i < 4; i++) row.appendChild(cellEl('—', `${NUM}color:${DASH};`));
    }
    table.appendChild(row);

    // Moon row — the slot's SECOND spiable body, with its OWN scan state (a
    // planet scan says nothing about the moon) and its own toggle/ring
    // (keyed "g:s:p:3", so it never drags the planet along).
    if (p.hasMoon) {
      const m = moons ? moons[coord] : undefined;
      const moonKey = `${coord}:3`;
      const mStatus = scanStatus({
        reportTsSec: m ? m.ts : undefined,
        nowMs,
        rescanAtMs: rescanAtFor(rescan, playerId, moonKey),
      });
      const mrow = document.createElement('tr');
      const mbody = cellEl('🌙 moon',
        `padding:0 0 3px 14px;white-space:nowrap;font-size:11px;color:#8b95a0;${m ? '' : 'opacity:.55;'}`);
      mbody.title = 'This slot has a moon — a separate spiable body';
      mrow.appendChild(mbody);
      // Scan + Activity, same helpers as the planet row (moon keys/rings).
      mrow.appendChild(scanCell(moonKey, mStatus, m ? m.ts : undefined, scannableMoons, true));
      mrow.appendChild(activityCell(ringKeyFor(coord, 3), m?.act, true));
      if (m) {
        mrow.appendChild(cellEl(compact(Math.round(m.defPts)), `${NUM}font-size:11px;color:#8fa0b0;`));
        // Fleet parked on a spied moon is the headline find — flag it gold.
        const parked = m.fleetPts > 0;
        const fleetCell = cellEl(compact(Math.round(m.fleetPts)),
          `${NUM}font-size:11px;color:${parked ? '#e0b45f' : '#8fa0b0'};font-weight:${parked ? '700' : '400'};`);
        if (parked) fleetCell.title = 'Fleet parked on the moon — exactly what a moon scan reveals';
        mrow.appendChild(fleetCell);
        mrow.appendChild(cellEl('', NUM));
        mrow.appendChild(cellEl('', NUM));
      } else {
        for (let i = 0; i < 4; i++) mrow.appendChild(cellEl('—', `${NUM}font-size:11px;color:${DASH};`));
      }
      table.appendChild(mrow);
    }
  }
  // Horizontal-scroll containment (shared .table-scroll idiom): 7 nowrap
  // columns overflow a phone — the table scrolls inside its own wrapper,
  // never the page.
  const tableScroller = document.createElement('div');
  tableScroller.className = 'table-scroll';
  tableScroller.appendChild(table);
  box.appendChild(tableScroller);

  // Relocation hint: bodies we hold intel on (a report or moon report) whose
  // coords are NO LONGER in the player's current universe.xml occupancy — the
  // player moved or the body was destroyed. Pure derivation of existing data
  // (no new collection). Guarded on planets.length so an unloaded occupancy
  // snapshot (0 planets) never paints every known body as "gone".
  if (planets.length > 0 && (reports || moons)) {
    const present = new Set(planets.map(coordStr));
    /** @type {Record<string, number>} coord → newest known intel ts (epoch s). */
    const ghosts = {};
    /** @param {Record<string, {ts:number}>|undefined} map @returns {void} */
    const scanGhosts = (map) => {
      if (!map) return;
      for (const coord of Object.keys(map)) {
        if (present.has(coord)) continue;
        const ts = map[coord] ? map[coord].ts : 0;
        if (!ghosts[coord] || (ts && ts > ghosts[coord])) ghosts[coord] = ts || 0;
      }
    };
    scanGhosts(reports);
    scanGhosts(moons);
    const ghostCoords = Object.keys(ghosts);
    if (ghostCoords.length) {
      ghostCoords.sort();
      const note = document.createElement('div');
      note.style.cssText = 'margin-top:6px;font-size:11px;color:#8a7f5f;line-height:1.5;';
      const lead = document.createElement('span');
      lead.textContent = '🚚 no longer here — moved or destroyed: ';
      note.appendChild(lead);
      ghostCoords.forEach((coord, i) => {
        if (i) note.appendChild(document.createTextNode(' · '));
        const parts = coord.split(':');
        const href = linkBase
          ? `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${parts[0]}&system=${parts[1]}&position=${parts[2]}`
          : '';
        const el = document.createElement(href ? 'a' : 'span');
        const age = formatAge(ageMs(ghosts[coord] || undefined, nowMs));
        el.textContent = coord + (age ? ` (${age} old)` : '');
        el.style.color = '#b0a072';
        if (href) {
          const link = /** @type {HTMLAnchorElement} */ (el);
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener';
          link.style.textDecoration = 'none';
          link.title = 'Open this system in the galaxy view to confirm';
          link.addEventListener('click', (ev) => ev.stopPropagation());
        }
        note.appendChild(el);
      });
      note.appendChild(document.createTextNode(
        ' — intel on file, but the player isn’t at these coords now.',
      ));
      box.appendChild(note);
    }
  }
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
  // No "Relationship:" label — the three chips explain themselves. Sits inline
  // on the header line (pushed to the right).
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;';
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

/**
 * Whole-player "Watch via" selector: a togglable galaxy chip (mutes the
 * galaxy-LOOK plan for this player — passive sighting RECORDING continues
 * regardless) plus a togglable probe-scan default. Both can be "on" at once —
 * that's the point. Each toggle sets/clears its player-id key ('off' explicit
 * / clear back to the 'on' default). A click stops propagation (never
 * collapses the dossier).
 *
 * While probes are ON, a ↻ sits right after the probes chip — the whole-player
 * re-scan flag (it feeds the probe scan plan, so it lives with the toggle it
 * belongs to and hides when probes are off: a flag for a plan that never runs
 * would be a dead switch).
 * @param {string} playerId
 * @param {boolean} scanOn     is the player's probe-scan default on?
 * @param {boolean} galaxyOn   is the player's galaxy-look plan on?
 * @param {(key: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void} onSetScan
 * @param {((pid: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void) | undefined} onSetGalaxy
 * @param {((key: string) => void) | undefined} onRescan
 * @returns {HTMLDivElement}
 */
function watchViaSelector(playerId, scanOn, galaxyOn, onSetScan, onSetGalaxy, onRescan) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;';
  const lbl = document.createElement('span');
  lbl.textContent = 'Watch via';
  lbl.style.cssText = 'color:#6b7887;';
  wrap.appendChild(lbl);

  /**
   * One togglable Watch-via chip (shared look; the hue names the channel).
   * @param {string} text
   * @param {boolean} on
   * @param {string} onBorder  border colour while on
   * @param {string} onBg      background while on
   * @param {string} onColor   text colour while on
   * @param {string} title
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  const chip = (text, on, onBorder, onBg, onColor, title, onClick) => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.title = title;
    btn.style.cssText = 'padding:2px 10px;border-radius:999px;font-size:11px;cursor:pointer;'
      + `border:1px solid ${on ? onBorder : '#2b3a4d'};background:${on ? onBg : '#18222e'};`
      + `color:${on ? onColor : '#7c8893'};font-weight:${on ? '600' : '400'};`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  };

  // Galaxy — mutes/unmutes the look plan (recording is never gated).
  if (onSetGalaxy) {
    wrap.appendChild(chip('galaxy', galaxyOn, '#2f5140', '#13251c', '#7fb389',
      galaxyOn
        ? 'Galaxy watch ON — the Look plan proposes browsing this player’s systems (passive, the target never sees it). Click to stop proposing looks; sightings you browse past still record.'
        : 'Galaxy watch OFF — no galaxy-look proposals for this player (sightings you browse past still record). Click to resume.',
      () => onSetGalaxy(playerId, galaxyOn ? 'off' : null)));
  }

  // Probe — the togglable default.
  wrap.appendChild(chip('probes', scanOn, '#3f6ea5', '#12253c', '#8fb8e0',
    scanOn
      ? 'Probe scanning ON by default — click to make this player galaxy-only (no probes; the target stops seeing scans)'
      : 'Probe scanning OFF — galaxy-only. Click to resume proposing probes for this player.',
    () => onSetScan(playerId, scanOn ? 'off' : null)));

  // ↻ whole-player re-scan flag — probes-on only (it only feeds the probe plan).
  if (scanOn && onRescan) {
    const rescan = document.createElement('button');
    rescan.textContent = '↻';
    rescan.className = 'hit-pad';
    rescan.title = 'Flag this player for re-scan (data may have changed) — every body re-enters the probe scan plan';
    rescan.style.cssText = 'border:none;background:none;color:#6b97c4;cursor:pointer;'
      + 'font-size:13px;line-height:1;padding:0 2px;';
    rescan.addEventListener('click', (e) => { e.stopPropagation(); onRescan(playerId); });
    wrap.appendChild(rescan);
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
  title.style.cssText = 'font-size:11px;letter-spacing:0.5px;color:#6b7782;margin-bottom:2px;';
  wrap.appendChild(title);

  if (!routine || routine.observations === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No history yet — this fills from the spy reports you open'
      + ' and the galaxy views you browse over time.';
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
    cov.style.cssText = 'color:#5f6b76;font-size:11px;';
    // Coverage row (§6.6/§8): name each source's sample count so the strip
    // visibly only knows what the user gathered; name the self-induced
    // discount so a probe-heavy day can't be mistaken for target activity.
    const src = act.sources;
    const fromParts = [];
    if (src.reports) fromParts.push(`${src.reports} report${src.reports === 1 ? '' : 's'} you opened`);
    if (src.galaxy) fromParts.push(`${src.galaxy} galaxy sighting${src.galaxy === 1 ? '' : 's'} you browsed`);
    cov.textContent = `hours 0–23 · from ${fromParts.join(' + ') || 'no samples'}`
      + `${act.discounted ? ` · ${act.discounted} self-caused marker${act.discounted === 1 ? '' : 's'} excluded` : ''}`
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
    tl.style.cssText = 'margin-top:3px;color:#7c8893;font-size:11px;';
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
 * STRIKE banner — a moon-strike candidate (domain/fleetLanding). Activity
 * concentrated on a moon while the player is (or has since gone) away:
 * likely a returning fleet-save landed and the owner isn't there to move it.
 * Copy follows the signal's TIER so the claim never outruns the evidence —
 * 'lone'/'newest' say "player otherwise quiet/older"; 'any' says outright
 * that the owner may be around. Honest framing ("possible", "spy to
 * confirm") + the coverage basis; never asserts the fleet is there.
 * @param {import('../../domain/fleetLanding.js').FleetLandingSignal} landing
 * @param {string} [linkBase]
 * @returns {HTMLDivElement}
 */
function landingBanner(landing, linkBase) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;padding:7px 10px;border-radius:8px;'
    + 'border:1px solid #7a4420;background:#2a1a10;color:#e8b591;font-size:12px;line-height:1.5;';
  const strong = landing.confidence === 'strong';
  const head = document.createElement('div');
  head.style.cssText = 'font-weight:500;color:#f0a869;';
  head.textContent = landing.tier === 'any'
    ? '🎯 Moon lit (owner may be around)'
    : `🎯 Possible ${landing.tier === 'newest' && landing.freshAgeMs > FRESH_LOOK_MS ? 'parked' : 'fresh'} fleet${strong ? '' : ' (partial coverage)'}`;
  wrap.appendChild(head);

  const body = document.createElement('div');
  const parts = landing.coord.split(':');
  const href = linkBase
    ? `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${parts[0]}&system=${parts[1]}&position=${parts[2]}`
    : '';
  const coordEl = document.createElement(href ? 'a' : 'span');
  coordEl.textContent = `🌙 ${landing.coord}`;
  coordEl.style.color = '#f0c89a';
  if (href) {
    const link = /** @type {HTMLAnchorElement} */ (coordEl);
    link.href = href; link.target = '_blank'; link.rel = 'noopener';
    link.style.textDecoration = 'none';
    link.title = 'Open this system in the galaxy view';
    link.addEventListener('click', (ev) => ev.stopPropagation());
  }
  // 'newest' qualifiers: co-lit moons (co-candidates — probing this one
  // rotates the flag to the next), fresh-but-older planets, or plain silence.
  const coMoons = landing.coMoons || 0;
  const newestDetail =
    ` active ${formatAge(landing.freshAgeMs)} ago — the account's newest mark`
    + (coMoons ? `; ${coMoons + 1} moons lit, this one newest` : '')
    + (landing.concurrent
      ? '; planets show only older activity'
      : coMoons ? '' : ', only silence observed since')
    + ` (${landing.quiet}/${landing.total} bodies corroborated).`;
  const detail = landing.tier === 'any'
    ? ` active ${formatAge(landing.freshAgeMs)} ago — other bodies are lit too,`
      + ` so this may just be the owner playing (${landing.quiet}/${landing.total} bodies quiet).`
    : landing.tier === 'newest'
      ? newestDetail
      : ` active ${formatAge(landing.freshAgeMs)} ago, player`
        + ` otherwise quiet (${landing.quiet}/${landing.total} bodies checked).`;
  body.append(coordEl, document.createTextNode(detail));
  wrap.appendChild(body);

  const tail = document.createElement('div');
  tail.style.cssText = 'color:#c69a76;font-size:11px;margin-top:2px;';
  tail.textContent = 'Could be a landed fleet-save — the Spy FAB proposes this moon first. '
    + 'Spy to confirm (the marker also fires for a foreign attack or a brief login).';
  wrap.appendChild(tail);
  return wrap;
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Presence-temperature colour ramp: blue (offline) → grey → red (online),
 * interpolated in RGB (percept-safe). @param {number} p 0..1 @returns {string}
 */
function presenceRamp(p) {
  /** @type {Array<[number, [number, number, number]]>} */
  const stops = [
    [0, [37, 99, 235]], [0.3, [124, 166, 222]], [0.5, [150, 160, 175]],
    [0.7, [239, 159, 80]], [1, [220, 60, 55]],
  ];
  const t = Math.max(0, Math.min(1, p));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const f = (t - a) / (b - a);
      const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

/**
 * 8) PRESENCE (SPYGLASS-PASSIVE-PLAN §4) — the offline-window heatmap. Colour =
 * P(online | phase), opacity = coverage (blank = "not observed", NOT "offline").
 * A framed block marks the best attack window (well-covered + quiet); the basis
 * line names the look count so the tool never claims certainty it lacks.
 * "Activity" is an interaction with a body, never asserted as the owner "online".
 * @param {ReturnType<typeof import('../../domain/presence.js').summarizePresence>} presence
 * @returns {HTMLDivElement}
 */
function presenceBlock(presence) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.5;';

  const title = document.createElement('div');
  title.textContent = 'PRESENCE — offline windows';
  title.style.cssText = 'font-size:11px;letter-spacing:0.5px;color:#6b7782;margin-bottom:3px;';
  wrap.appendChild(title);

  if (!presence || presence.samples === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No coverage yet — browse this player’s galaxy systems and this'
      + ' fills with when they’re reliably offline (activity is tracked passively).';
    empty.style.color = '#5f6b76';
    wrap.appendChild(empty);
    return wrap;
  }

  // Player-level "last active anywhere" — the honest headline (max over all
  // bodies), so the reader sees at a glance how long the WHOLE player has been
  // quiet, not just one planet.
  const la = document.createElement('div');
  la.style.cssText = 'margin-bottom:4px;';
  if (presence.lastActiveSec) {
    const laAge = formatAge(ageMs(presence.lastActiveSec, Date.now()));
    la.textContent = `Last active (any body): ${laAge} ago`;
    la.style.color = '#9fb0c0';
  } else {
    la.textContent = `Last active (any body): none caught in ${presence.samples} looks`;
    la.style.color = '#8a7f5f';
  }
  wrap.appendChild(la);

  if (presence.scale === 'occasional' || !presence.grid) {
    const note = document.createElement('div');
    note.textContent = `Too few / scattered samples for a routine (${presence.online} online`
      + ` of ${presence.samples} looks). No reliable window yet — keep sighting.`;
    note.style.color = '#8a7f5f';
    wrap.appendChild(note);
    return wrap;
  }

  const grid = presence.grid;
  const win = presence.window;

  // Heatmap: one row per weekday (week) or a single hour strip (day). Left gutter
  // labels the row; a sparse hour axis sits above.
  const table = document.createElement('div');
  const gutter = grid.scale === 'week' ? 30 : 42;
  // min-width floors the 24 hour-columns at ~12px each; below that the
  // .table-scroll wrapper (appended below) scrolls instead of letting the
  // cells crush into unreadable slivers on a phone.
  table.style.cssText = `display:grid;grid-template-columns:${gutter}px repeat(24, 1fr);`
    + 'gap:1px;background:#20303f;padding:1px;border-radius:6px;max-width:420px;min-width:340px;';

  // Hour axis.
  const corner = document.createElement('div');
  corner.style.background = 'transparent';
  table.appendChild(corner);
  for (let h = 0; h < 24; h++) {
    const hx = document.createElement('div');
    hx.textContent = h % 6 === 0 ? String(h) : '';
    hx.style.cssText = 'font-size:10px;color:#5f6b76;text-align:center;background:transparent;';
    table.appendChild(hx);
  }

  for (let r = 0; r < grid.rows; r++) {
    const lbl = document.createElement('div');
    lbl.textContent = grid.scale === 'week' ? DOW_LABELS[r] : 'all days';
    lbl.style.cssText = 'font-size:11px;color:#8b95a0;display:flex;align-items:center;'
      + 'justify-content:flex-end;padding-right:5px;background:transparent;white-space:nowrap;';
    table.appendChild(lbl);
    for (let h = 0; h < 24; h++) {
      const c = grid.cells[r][h];
      const cell = document.createElement('div');
      const inWin = !!win && win.row === r && h >= win.startH && h <= win.endH;
      const alpha = (0.06 + 0.94 * c.conf).toFixed(2);
      cell.style.cssText = `min-height:${grid.scale === 'week' ? 13 : 22}px;`
        + `background:${presenceRamp(c.p)};opacity:${alpha};`
        + (inWin ? 'box-shadow:inset 0 0 0 2px #eaeff4;' : '');
      const pct = Math.round(c.p * 100);
      cell.title = `${grid.scale === 'week' ? DOW_LABELS[r] + ' ' : ''}`
        + `${String(h).padStart(2, '0')}:00 · ${c.looks} look${c.looks === 1 ? '' : 's'}`
        + ` · ${c.hits} with activity · P(online)=${pct}%`;
      table.appendChild(cell);
    }
  }
  const heatScroller = document.createElement('div');
  heatScroller.className = 'table-scroll';
  heatScroller.appendChild(table);
  wrap.appendChild(heatScroller);

  // Legend + basis.
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;gap:12px;align-items:center;margin-top:5px;font-size:11px;color:#6b7782;flex-wrap:wrap;';
  const bar = document.createElement('span');
  bar.style.cssText = 'display:inline-block;width:70px;height:9px;border-radius:5px;vertical-align:-1px;'
    + 'background:linear-gradient(90deg,rgb(37,99,235),rgb(150,160,175),rgb(220,60,55));';
  legend.append('offline ', bar, ' online · faint = little data');
  wrap.appendChild(legend);

  const basis = document.createElement('div');
  basis.style.cssText = 'margin-top:4px;font-size:11px;';
  if (win) {
    const dayPart = grid.scale === 'week' ? `${DOW_LABELS[win.row]} ` : '';
    basis.style.color = '#7fb389';
    basis.textContent = `⌖ best window: ${dayPart}`
      + `${String(win.startH).padStart(2, '0')}:00–${String((win.endH + 1) % 24).padStart(2, '0')}:00`
      + ` — ${win.looks} look${win.looks === 1 ? '' : 's'}, no activity seen`
      + (win.exceptions > 0 ? ` · ${win.exceptions} one-off blip noted` : '');
  } else {
    basis.style.color = '#8a7f5f';
    basis.textContent = `${presence.online} online of ${presence.samples} looks · no window`
      + ' clears the coverage bar yet — sight more to be sure.';
  }
  wrap.appendChild(basis);

  return wrap;
}

/**
 * 8b) FS WINDOWS (IDEAS #1 — fleet-save window bracketing) — the bracketed
 * fleet departures/returns from domain/fsBracket.js. Every line is an honest
 * INTERVAL between two observations, never an instant; the `likely` sub-range
 * appears only when a single activity marker pinned the moment. Flag words
 * (`relocated?`, `gate?`, `siblings unchecked`) carry the gates' doubts.
 * @param {import('../../domain/fsBracket.js').FsArc[]} arcs
 * @param {number} nowMs
 * @returns {HTMLDivElement}
 */
function fsArcsBlock(arcs, nowMs) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:10px;font-size:11px;color:#8b95a0;line-height:1.6;';

  const title = document.createElement('div');
  title.textContent = 'FS WINDOWS — fleet departures & returns';
  title.style.cssText = 'font-size:11px;letter-spacing:0.5px;color:#6b7782;margin-bottom:3px;';
  wrap.appendChild(title);

  /** Window bound → "Tue 21:40" (short, local). @param {number} sec */
  const fmtT = (sec) => new Date(sec * 1000).toLocaleString(undefined, {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  /** Time-only "22:05" for the narrowed sub-range. @param {number} sec */
  const fmtHM = (sec) => new Date(sec * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });

  for (const arc of arcs) {
    const row = document.createElement('div');

    // Kind word wears the colour: departures the spy gold (the strike-timing
    // signal), returns the calm blue.
    const kind = document.createElement('span');
    kind.textContent = arc.kind === 'departure' ? 'left' : 'back';
    kind.style.cssText = `font-weight:700;color:${arc.kind === 'departure' ? '#e6c054' : '#7ca6de'};`;
    row.appendChild(kind);

    const body = document.createElement('span');
    body.textContent = ` ${arc.coord}${arc.bodyType === 3 ? ' moon' : ''}`;
    body.style.color = arc.bodyType === 3 ? '#c9a9e8' : '#a9c4de';
    row.appendChild(body);

    row.appendChild(document.createTextNode(
      ` · ${fmtT(arc.loSec)} → ${fmtT(arc.hiSec)} · ${formatAge(ageMs(arc.hiSec, nowMs))} ago`
      + ` · ${compact(arc.valueBefore)} → ${compact(arc.valueAfter)}`,
    ));

    if (arc.narrowed) {
      const n = document.createElement('span');
      n.textContent = ` · likely ~${fmtHM(arc.narrowed.lo)}–${fmtHM(arc.narrowed.hi)}`;
      n.style.color = '#9fb0c0';
      n.title = 'A single activity marker inside the window pins the likely moment.';
      row.appendChild(n);
    }

    // Gate doubts as short flag words — colour carries the caution.
    /** @param {string} word @param {string} tip */
    const flag = (word, tip) => {
      const f = document.createElement('span');
      f.textContent = ` · ${word}`;
      f.style.cssText = 'color:#8a7f5f;cursor:help;';
      f.title = tip;
      row.appendChild(f);
    };
    if (arc.relocation === 'possible') {
      flag('relocated?', 'A sibling body’s fleet rose by about the dropped value around this window — the fleet may have just moved next door, not saved.');
    } else if (arc.relocation === 'unchecked') {
      flag('siblings unchecked', 'Not every other body of this player has fleet observations around this window — a move next door can’t be ruled out.');
    }
    if (arc.moonGate) {
      flag('gate?', 'Departure from a moon while the player holds 2+ moons — could be a jump-gate hop (instant, invisible), not a fleet-save.');
    }

    wrap.appendChild(row);
  }

  const basis = document.createElement('div');
  basis.textContent = 'From your own spy reports + galaxy looks — windows are gaps between observations, not exact times.';
  basis.style.cssText = 'color:#5f6b76;font-size:11px;margin-top:2px;';
  wrap.appendChild(basis);

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
 * @param {string} a.name  Accepted for callers' convenience; NOT rendered —
 *   the clicked table row (dossier-open) is the panel's header, name included.
 * @param {import('../../state/watchList.js').Relationship} [a.relationship]  Current tag.
 * @param {(pid: string, rel: import('../../state/watchList.js').Relationship) => void} [a.onSetRelationship]
 * @param {import('../../domain/dangerScore.js').DangerProfile} [a.profile]
 * @param {import('../../domain/threatModel.js').HiddenFleetEstimate} [a.estimate]
 * @param {import('../../domain/raidVerdict.js').RaidVerdict} [a.verdict]
 * @param {boolean} [a.inBand]
 * @param {import('../../domain/civilBaseline.js').CivilProfile} [a.civilProfile]
 * @param {import('../../domain/routine.js').RoutineSummary} [a.routine]
 * @param {ReturnType<typeof import('../../domain/presence.js').summarizePresence>} [a.presence]
 *   Per-player presence summary — the offline-window heatmap under the routine.
 * @param {import('../../domain/fsBracket.js').FsArc[]} [a.fsArcs]
 *   Bracketed fleet departures/returns — the FS-windows block under presence.
 * @param {import('../../domain/fleetLanding.js').FleetLandingSignal} [a.landing]
 *   Fresh fleet-landing signal — the strike banner atop the judgement column.
 * @param {import('../../domain/targets.js').PlanetPos[]} a.planets
 * @param {Record<string, PlanetReport>} [a.reports]  keyed by "g:s:p"
 * @param {Record<string, PlanetReport>} [a.moons]  MOON
 *   reports keyed by the moon's planet "g:s:p" (own map, never mixed with planets).
 * @param {*} a.rescan
 * @param {number} a.nowMs
 * @param {((key: string) => void) | undefined} [a.onRescan]  Flag the whole
 *   player for re-scan — the ↻ on the Watch-via row (shown only while the
 *   player's probes are on; per-body re-scan was dropped).
 * @param {Record<string, import('../../domain/scanMode.js').ScanMode>} [a.scanMode]
 *   Scan-mode map (player id / body override key → 'on'|'off').
 * @param {(key: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void} [a.onSetScanMode]
 *   Set a body scan override (key "g:s:p"/"g:s:p:3") or the whole-player default
 *   (key = player id); `null` clears the key back to inherited 'on'.
 * @param {Record<string, import('../../domain/scanMode.js').ScanMode>} [a.galaxyMode]
 *   Per-player galaxy-watch toggle (player id → 'on'|'off'; absent = on) —
 *   the "Watch via → galaxy" button state.
 * @param {(pid: string, mode: import('../../domain/scanMode.js').ScanMode | null) => void} [a.onSetGalaxyMode]
 *   Toggle the player's galaxy-look plan; `null` clears back to 'on'.
 * @param {Record<string, import('../../domain/activityObs.js').ActivityObs[]>} [a.rings]
 *   THIS player's galaxy-activity rings — the Activity column source.
 * @param {number} [a.galaxyLookMs]  (Unused now — the Activity column reads
 *   last-active, not look-coverage.) Accepted for caller convenience.
 * @param {'planets'|'moons'|'both'} [a.scanBodies]  Scan-chip value — gates the
 *   per-body Scan toggle to the included body types.
 * @param {string} [a.linkBase]  Game origin — makes the per-body coords in-game galaxy links.
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
  td.style.padding = '12px 14px 16px';
  td.style.borderBottom = '1px solid #223044';
  // GV-parity expanded row: a panel LIGHTER than the surrounding card plus the
  // blue inset bar — the same "opened detail" language as the Galaxy Viewer's
  // streak-detail rows (dashboard.html .streak-record / .streak-detail).
  td.style.background = '#1a2a3a';
  td.style.boxShadow = 'inset 3px 0 0 #4a9eff';
  tr.appendChild(td);

  // 1) Header: relationship chips · Watch-via toggles · (right) the scan
  //    coverage line. The clicked TABLE ROW wears the panel's background
  //    (targets.js `dossier-open`) and IS the header — repeating the name +
  //    archetype here just duplicated the row one line above. Coverage sits up
  //    here (not above the evidence table) so the table starts a line higher.
  const coverage = coverageLine(a.planets, a.reports, a.moons);
  if (a.onSetRelationship || a.onSetScanMode || coverage) {
    const header = document.createElement('div');
    header.style.cssText = 'margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;';
    if (a.onSetRelationship) {
      header.appendChild(relationshipSelector(a.playerId, a.relationship || 'neutral', a.onSetRelationship));
    }
    if (a.onSetScanMode) {
      // Whole-player watch: the galaxy-look plan and the probe-scan default,
      // each its own toggle. Per-body probe overrides live in the scan table
      // below (inert while the whole player's probes are off).
      const scanOn = !(a.scanMode && a.scanMode[a.playerId] === 'off');
      const galaxyOn = !(a.galaxyMode && a.galaxyMode[a.playerId] === 'off');
      header.appendChild(watchViaSelector(
        a.playerId, scanOn, galaxyOn, a.onSetScanMode, a.onSetGalaxyMode, a.onRescan,
      ));
    }
    if (coverage) {
      // Gravitates right — over the evidence column, whose table it describes.
      coverage.style.marginLeft = 'auto';
      header.appendChild(coverage);
    }
    td.appendChild(header);
  }

  // Below the header the rest splits into two top-aligned columns on wide
  // viewports (`.dossier-grid`): JUDGEMENT (verdict / danger / why / hidden /
  // civil / routine) beside EVIDENCE (the per-body scan table — its coverage
  // summary lives on the header line above).
  const grid = document.createElement('div');
  grid.className = 'dossier-grid';
  const judgement = document.createElement('div');
  const evidence = document.createElement('div');
  grid.append(judgement, evidence);
  td.appendChild(grid);

  // 1b) STRIKE banner — a fresh fleet-landing candidate. Leads the judgement
  // column (above the raid verdict): the most time-sensitive, most actionable
  // signal in the dossier.
  if (a.landing) judgement.appendChild(landingBanner(a.landing, a.linkBase));

  // 2) Raid verdict banner (the jack-point) — top of the judgement column.
  if (a.verdict) judgement.appendChild(verdictBanner(a.verdict));

  // 3) Danger.
  if (a.profile) judgement.appendChild(dangerBlock(a.profile));

  // 4) WHY reasons. The active apex tells now render inline on the DANGER line,
  // so drop the flat `apex signals N/6` bullet here — the terse tooltips
  // (cards/targets/map) render `reasons` raw and keep it.
  if (a.profile && a.profile.reasons && a.profile.reasons.length) {
    const reasons = a.profile.apex
      ? a.profile.reasons.filter((r) => !r.startsWith('apex signals'))
      : a.profile.reasons;
    if (reasons.length) judgement.appendChild(whyList(reasons));
  }

  // 5) Hidden-fleet arithmetic.
  if (a.estimate) judgement.appendChild(hiddenFleetBlock(a.estimate, a.profile));

  // 5b) Civil-fleet baseline (Etap C).
  if (a.civilProfile) judgement.appendChild(civilBlock(a.civilProfile, a.profile));

  // 5c) Routine (Etap F) — activity/weekday/collection/timeline from spy
  // history. Lives UNDER the civil baseline in the judgement column (user
  // pref), so the evidence column is the per-body table alone.
  if (a.routine) judgement.appendChild(routineBlock(a.routine));

  // 5d) Presence — the offline-window heatmap (the attack-timing readout).
  // Rendered whenever we have any presence data; hollow-states itself otherwise.
  if (a.presence) judgement.appendChild(presenceBlock(a.presence));

  // 5e) FS windows — bracketed fleet departures/returns (skipped when none
  // were caught; an empty brackets block would explain nothing).
  if (a.fsArcs && a.fsArcs.length) judgement.appendChild(fsArcsBlock(a.fsArcs, a.nowMs));

  // 6) Planets grid (renders its own "no planets" note when empty).
  evidence.appendChild(planetsBlock({
    playerId: a.playerId,
    planets: a.planets,
    reports: a.reports,
    moons: a.moons,
    rescan: a.rescan,
    nowMs: a.nowMs,
    scanMode: a.scanMode,
    onSetScanMode: a.onSetScanMode,
    rings: a.rings,
    scanBodies: a.scanBodies,
    linkBase: a.linkBase,
  }));

  return tr;
}
