// @ts-check

// Watchlist cards — the Spyglass LANDING strip (Etap H4; design §6.1/§6.3 of
// SPYGLASS-REDESIGN.md, the piece v3 shipped without). One card per watched
// player, each answering the tab's one question in words — raid or skip, and
// when — before any table is read: verdict + loot, the headline fleet number,
// the hour-of-day activity sparkline (when sampled), intel age. Clicking a
// card opens the player's dossier via the caller's deep-link (it never
// mutates the watchlist — navigation must not change membership).
//
// Renders from the SAME per-repaint data the table/dossier read (verdicts,
// estimates, danger profiles, routines) — no data of its own, so a card can
// never disagree with the dossier behind it.

import { RELATIONSHIP_COLORS } from './mapPrimitives.js';
import { sparkline } from './dossier.js';
import { compact } from './format.js';
import { dangerColor } from '../../lib/dangerColor.js';
import { estimateCombatShare } from '../../domain/threatModel.js';
import { pointsToResources } from '../../domain/unitCosts.js';

// ── Local formatting helpers (compact magnitude → shared ./format.js) ─────────

/**
 * Compact age ("<1h" / "3h" / "2d" / "5w"), '' for junk.
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

/** Verdict-kind → text colour (the verdictBanner palette, dossier.js). */
const VERDICT_COLORS = /** @type {Record<string, string>} */ ({
  raid: '#7fd6a8',
  'loaded-risky': '#e0b020',
  empty: '#8b95a0',
  scan: '#8b95a0',
});

// OGame ALLIANCE-highscore deep link (category=2, points). `searchRelId` jumps
// straight to a given alliance's page. Local to this feature — the only place
// that links there (cf. gameDom's single-consumer rule). Empty base → no link.
const ALLY_HIGHSCORE_PATH = '/game/index.php?page=highscore&category=2&type=0';
const allyRankingUrl = (/** @type {string|undefined} */ base, /** @type {string|undefined} */ id = '') =>
  base ? `${base}${ALLY_HIGHSCORE_PATH}${id ? `&searchRelId=${id}` : ''}` : '';

/**
 * Render the watchlist card strip into `hostEl` (label + responsive grid).
 * Empty watchlist → a ghost onboarding card, never a blank gap.
 *
 * @param {object} a
 * @param {HTMLElement | null} a.hostEl
 * @param {Set<string>} a.watchedIds
 * @param {import('../../domain/targets.js').TargetCandidate[]} a.candidates
 * @param {Record<string, import('../../domain/raidVerdict.js').RaidVerdict>} a.verdicts
 * @param {Record<string, import('../../domain/threatModel.js').HiddenFleetEstimate>} a.estimates
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} a.danger
 * @param {Record<string, import('../../domain/routine.js').RoutineSummary>} a.routines
 * @param {Record<string, import('../../state/watchList.js').Relationship>} a.relationships
 * @param {Record<string, Record<string, {ts: number}>>} a.reportsByPlayer
 * @param {Record<string, boolean|undefined>} a.inBand
 * @param {number} a.nowMs
 * @param {string} [a.linkBase]  Game origin for the selected universe (e.g.
 *   `https://s163-pl.ogame.gameforge.com`) — builds the "open the alliance
 *   ranking" deep link that captures a missing alliance class. Absent → the
 *   unknown-class nudge shows as plain text (no link).
 * @param {(pid: string) => void} a.onOpen
 * @param {(pid: string) => void} [a.onToggleWatch]  Stop watching this player.
 * @returns {void}
 */
export function renderWatchlistCards(a) {
  if (!a.hostEl) return;
  a.hostEl.textContent = '';

  const ids = [...a.watchedIds];
  // gv-card-head/-title: the host sits inside a Spyglass gv-card zone now, so
  // the label speaks the same card-title language as the Galaxy Viewer's cards.
  const head = document.createElement('div');
  head.className = 'gv-card-head';
  const label = document.createElement('span');
  label.className = 'gv-card-title';
  label.textContent = ids.length ? `Watchlist (${ids.length})` : 'Watchlist';
  head.appendChild(label);
  a.hostEl.appendChild(head);

  // Unknown-alliance-class nudge (Etap: warrior-alliance source). A watched
  // player whose alliance class we've never harvested has the warrior-alliance
  // apex tell dark — the ONLY tell not derivable from the public API. Flag it so
  // the user can light it by opening the (spy-free) alliance ranking. Own-alliance
  // players are `friendly` (class irrelevant); players with no alliance can't be
  // looked up. Class 'none' counts as KNOWN (allianceClass is set) → not flagged.
  const unknownClass = (/** @type {string} */ pid) => {
    const p = a.danger.get(Number(pid));
    return !!(p && !p.friendly && p.allianceId && !p.allianceClass);
  };
  const unknownIds = ids.filter(unknownClass);
  if (unknownIds.length) {
    const banner = document.createElement('div');
    banner.style.cssText = 'margin:0 0 8px;padding:6px 9px;border-radius:5px;font-size:11.5px;'
      + 'background:#241d0e;border:1px solid #4a3c17;color:#d9b45a;';
    banner.appendChild(document.createTextNode(
      `⚠ ${unknownIds.length} watched ${unknownIds.length === 1 ? 'player' : 'players'} with unknown alliance class — `));
    const url = allyRankingUrl(a.linkBase);
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'open the alliance ranking';
      link.style.cssText = 'color:#eac25c;text-decoration:underline;font-weight:600;';
      banner.appendChild(link);
      banner.appendChild(document.createTextNode(' to light the warrior-alliance signal.'));
    } else {
      banner.appendChild(document.createTextNode(
        'open the in-game alliance ranking to light the warrior-alliance signal.'));
    }
    a.hostEl.appendChild(banner);
  }

  const grid = document.createElement('div');
  grid.className = 'watch-cards-grid';
  a.hostEl.appendChild(grid);

  if (!ids.length) {
    const ghost = document.createElement('div');
    ghost.className = 'watch-card';
    ghost.style.cssText = 'border-style:dashed;cursor:default;color:#66788a;font-size:12px;';
    ghost.textContent = 'Nobody watched yet — “+ watch” a player below.';
    grid.appendChild(ghost);
    return;
  }

  /** @type {Map<string, import('../../domain/targets.js').TargetCandidate>} */
  const byId = new Map(a.candidates.map((c) => [c.id, c]));
  // Attention-first: highest danger up front, name as the tiebreak.
  const dangerOf = (/** @type {string} */ pid) => a.danger.get(Number(pid))?.danger ?? -1;
  ids.sort((x, y) => dangerOf(y) - dangerOf(x)
    || (byId.get(x)?.name || '').localeCompare(byId.get(y)?.name || ''));

  for (const pid of ids) {
    const c = byId.get(pid);
    const prof = a.danger.get(Number(pid));
    const verdict = a.verdicts[pid];
    const est = a.estimates[pid];
    const routine = a.routines[pid];
    const rel = a.relationships[pid] || 'neutral';

    const card = document.createElement('div');
    card.className = 'watch-card';
    card.addEventListener('click', () => a.onOpen(pid));

    // Row 1 — relationship dot · name · danger badge.
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
    const dot = document.createElement('span');
    dot.style.cssText = `width:8px;height:8px;border-radius:999px;flex:0 0 auto;background:${RELATIONSHIP_COLORS[rel]};`;
    const nm = document.createElement('span');
    nm.textContent = c?.name || `#${pid}`;
    nm.style.cssText = 'font-weight:600;font-size:13.5px;color:#cfd6dd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const badge = document.createElement('span');
    if (prof) {
      const d = Math.round(prof.danger * 100);
      badge.textContent = prof.friendly ? 'friendly' : `D ${d}`;
      badge.style.cssText = `margin-left:auto;font-weight:700;font-size:12px;color:${prof.friendly ? '#6b7782' : dangerColor(d)};`;
    } else {
      badge.textContent = '—';
      badge.style.cssText = 'margin-left:auto;color:#5f6b75;font-size:12px;';
    }
    // Inline action: stop-watching ✕, right of the badge. No separate "open"
    // affordance — the whole card is already click-to-open (line above), so a ▸
    // would just duplicate it.
    const acts = document.createElement('span');
    acts.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:6px;flex:0 0 auto;';
    if (a.onToggleWatch) {
      // Red ✕, NOT a star: on the card this action DELETES the card (removes the
      // player from the watchlist and the tile vanishes) — a destructive, easy-to-
      // misfire click, so it must read "remove", unlike the reversible toggles
      // elsewhere where the row stays put.
      const watch = document.createElement('span');
      watch.textContent = '✕';
      watch.title = 'Remove from watchlist — deletes this card';
      watch.style.cssText = 'cursor:pointer;font-size:12px;color:#e06c5f;font-weight:700;';
      watch.addEventListener('click', (ev) => { ev.stopPropagation(); a.onToggleWatch?.(pid); });
      acts.appendChild(watch);
    }
    top.append(dot, nm, badge, acts);
    card.appendChild(top);

    // Row 2 — the verdict, in words (same palette as the dossier banner).
    if (verdict) {
      const v = document.createElement('div');
      let text = verdict.label;
      if (typeof verdict.lootNow === 'number' && verdict.lootNow > 0) {
        text += ` · loot ~${compact(verdict.lootNow)}`;
      }
      v.textContent = text;
      v.style.cssText = `font-size:12.5px;margin-bottom:3px;color:${VERDICT_COLORS[verdict.kind] || '#6b7782'};`
        + `font-weight:${verdict.kind === 'raid' ? '700' : '600'};`;
      if (verdict.reasons && verdict.reasons.length) v.title = verdict.reasons.join(' · ');
      card.appendChild(v);
    }

    // Row 3 — the headline fleet number (same units as the table's Fleet col).
    const head = document.createElement('div');
    head.style.cssText = 'font-size:11.5px;color:#8b99a8;margin-bottom:6px;';
    if (c && c.ships === 0) {
      head.textContent = '0 ships 🛡 pure defense';
      head.style.color = '#7fd6a8';
    } else if (est && typeof est.hiddenFleetPoints === 'number' && Number.isFinite(est.hiddenFleetPoints)) {
      // Visible (parked, scan-confirmed — the stable half) BESIDE hidden (the
      // computed remainder, which SWINGS with scan timing): hidden alone read
      // "~0" right after a fleet-home scan — exactly when the fleet sits
      // catchable and the card must not read as "safe".
      //
      // Both halves in RESOURCES (the units a spy report shows), not military
      // points — the score weighs civil ships at half, so points understate a
      // cargo fleet by up to 2× (the pentagon lesson). Visible is exact (the
      // spied fleet value); hidden converts through the composition prior.
      const share = prof && typeof prof.combatShare === 'number'
        ? prof.combatShare
        : estimateCombatShare({ visibleCombatShare: est.visibleCombatShare });
      const hiddenRes = pointsToResources(est.hiddenFleetPoints, share);
      head.textContent = `visible ${compact(est.visibleFleetRes)} · hidden ~${compact(hiddenRes)} res`;
      head.title = 'In resources (what a spy report shows). Visible = parked fleet your scans saw. '
        + 'Hidden = military − defence − visible, converted from points assuming '
        + `${Math.round(share * 100)}% combat by value; it swings with scan timing — a fleet `
        + 'caught home reads ~0 hidden.';
    } else if (prof && !prof.friendly) {
      head.textContent = `fleet ≤ ${compact(prof.mobileHi)}`;
    } else {
      head.textContent = '—';
    }
    card.appendChild(head);

    // Row 4 — hour-of-day activity sparkline (only when actually sampled;
    // hollow bars would just look broken).
    if (routine && routine.activity && routine.activity.samples > 0 && routine.activity.gate !== 'none') {
      const act = document.createElement('div');
      act.style.cssText = 'font-size:11px;color:#66788a;margin-bottom:6px;display:flex;gap:8px;align-items:baseline;';
      const spark = document.createElement('span');
      spark.textContent = sparkline(routine.activity.bins);
      spark.style.cssText = 'font-family:monospace;color:#4a9eff;letter-spacing:1px;';
      act.appendChild(spark);
      if (routine.activity.label) act.appendChild(document.createTextNode(routine.activity.label));
      act.title = `From ${routine.observations} report(s) you opened — "activity" means a body was interacted with.`;
      card.appendChild(act);
    }

    // Row 4b — unknown-alliance-class nudge (see banner above). Deep-links to
    // this player's alliance in the ranking; one open captures its class and
    // lights the warrior tell — no spying. stopPropagation so the link doesn't
    // also trigger the card's click-to-open-dossier.
    if (unknownClass(pid) && prof) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:11px;color:#c79a3a;margin-bottom:6px;';
      const url = allyRankingUrl(a.linkBase, prof.allianceId);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '⚠ alliance class unknown';
        link.title = 'Open this alliance in the ranking to capture its class (warrior / trader / …) — no spying needed.';
        link.style.cssText = 'color:#c79a3a;text-decoration:underline;';
        link.addEventListener('click', (ev) => ev.stopPropagation());
        warn.appendChild(link);
      } else {
        warn.textContent = '⚠ alliance class unknown';
      }
      card.appendChild(warn);
    }

    // Row 5 — intel age + band flag.
    const foot = document.createElement('div');
    foot.style.cssText = 'font-size:11px;color:#66788a;';
    const reports = a.reportsByPlayer[pid];
    let newest = 0;
    if (reports) for (const coord of Object.keys(reports)) {
      const ts = reports[coord].ts;
      if (ts > newest) newest = ts;
    }
    const parts = [];
    parts.push(newest > 0 ? `spied ${formatAge(a.nowMs - newest * 1000)} ago` : 'never scanned');
    if (a.inBand[pid]) parts.push('⚔ in band');
    foot.textContent = parts.join(' · ');
    card.appendChild(foot);

    grid.appendChild(card);
  }
}
