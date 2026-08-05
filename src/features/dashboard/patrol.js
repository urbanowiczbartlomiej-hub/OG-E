// @ts-check

// Spyglass → Patrol card — the dashboard face of the territory mode
// (domain/patrol). Deliberately NOT a new tab: one gv-card on the Spyglass
// tab, rendered only while a patrol radius is configured (zero UI when off),
// answering exactly two questions:
//
//   1. Is anything CATCHABLE in my grounds right now? — the strike list
//      (same signals the in-game Spy FAB flags, so the two surfaces can
//      never disagree), each with a one-tap "+ watch" that promotes the
//      neighbour onto the watch-list (patrol spots → watch → snipe).
//   2. Is my patrol COVERAGE healthy? — the head summary: how many occupied
//      systems the territory holds and how many have a fresh / stale / no
//      look, so a glance says whether the grounds are actually being walked.
//
// Pure DOM builder over plain data — every input arrives as an argument
// (the index.js repaint computes them from the per-universe loads), no
// storage reads here. Mirrors the cards.js / targets.js decomposition.

import { watchChip } from './chips.js';

/** Tier → the honest claim keyword (mirrors the FAB's renderSpy wording). */
const TIER_CLAIM = {
  lone: 'fresh landing?',
  newest: 'parked fleet?',
  any: 'owner around?',
};

/** Compact age like the dossier's ("3m", "2h", "1d"). @param {number} ms */
const formatAge = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

/**
 * Make an element with inline CSS + optional text (the dashboard's tiny
 * builder idiom).
 * @param {string} tag @param {string} [css] @param {string} [text]
 * @returns {HTMLElement}
 */
const mk = (tag, css, text) => {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (text != null) el.textContent = text;
  return el;
};

/**
 * Render the Patrol card. The caller owns the card's visibility (hidden
 * while the radius is 0); this fills the summary line + the strike list.
 *
 * @param {object} args
 * @param {HTMLElement | null} args.summaryEl  Head summary span.
 * @param {HTMLElement | null} args.hostEl     Strike-list container.
 * @param {number} args.radius                 ± systems (already > 0).
 * @param {Set<string>} args.systems           Territory ("g:s" keys).
 * @param {Record<string, Array<{playerId: string, position: number}>>} args.occupants
 *   Occupied slots per territory system (own slots excluded).
 * @param {Record<string, import('../../domain/fleetLanding.js').FleetLandingSignal>} args.strikes
 *   Per-player strike signals over the territory's prey.
 * @param {Record<string, { name?: string }>} args.names  API player meta.
 * @param {Record<string, { scannedAt?: number }>} args.scans  Per-system scans.
 * @param {number} args.staleMs   Galaxy-look cadence (ms).
 * @param {number} args.nowMs
 * @param {string} [args.linkBase]  Game origin for galaxy deep-links.
 * @param {Set<string>} args.watchedIds
 * @param {(pid: string) => void} args.onToggleWatch
 * @returns {void}
 */
export function renderPatrolCard({
  summaryEl, hostEl, radius, systems, occupants, strikes, names,
  scans, staleMs, nowMs, linkBase, watchedIds, onToggleWatch,
}) {
  // ── Head summary: territory size + look coverage over OCCUPIED systems ──
  if (summaryEl) {
    let fresh = 0;
    let stale = 0;
    let never = 0;
    for (const key of Object.keys(occupants)) {
      const sc = scans ? scans[key] : undefined;
      const seen = sc ? Number(sc.scannedAt) : 0;
      if (!(Number.isFinite(seen) && seen > 0)) never += 1;
      else if (nowMs - seen <= staleMs) fresh += 1;
      else stale += 1;
    }
    const occupied = fresh + stale + never;
    summaryEl.textContent =
      `±${radius} · ${systems.size} systems · ${occupied} occupied · `
      + `looks: ${fresh} fresh · ${stale} stale · ${never} never`;
  }

  // ── Strike list ─────────────────────────────────────────────────────────
  if (!hostEl) return;
  hostEl.textContent = '';
  const sigs = Object.values(strikes || {});
  if (!sigs.length) {
    hostEl.appendChild(mk(
      'div',
      'color:#8a97a3;font-size:12px;padding:2px 0;',
      'No strikes in the grounds — walk the stale systems in game (the Spy button leads).',
    ));
    return;
  }
  // Strongest claim first (lone/newest before any), then the freshest trace.
  const rank = { lone: 0, newest: 0, any: 1 };
  sigs.sort((a, b) => (rank[a.tier] - rank[b.tier]) || (a.freshAgeMs - b.freshAgeMs));

  for (const sig of sigs) {
    const pid = sig.playerId != null ? String(sig.playerId) : '';
    const row = mk('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
      + 'padding:4px 0;border-top:1px solid #1c2a3a;font-size:12px;');

    const target = mk('span', 'color:#f0a869;font-weight:600;', '🎯');
    row.appendChild(target);

    // Coords deep-link → the galaxy view at the moon's system.
    const parts = sig.coord.split(':');
    const href = linkBase
      ? `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${parts[0]}&system=${parts[1]}&position=${parts[2]}`
      : '';
    const coordEl = /** @type {HTMLElement} */ (mk(href ? 'a' : 'span', 'color:#f0c89a;text-decoration:none;', `🌙 ${sig.coord}`));
    if (href) {
      const a = /** @type {HTMLAnchorElement} */ (coordEl);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = 'Open this system in the galaxy view';
    }
    row.appendChild(coordEl);

    const name = (pid && names && names[pid] && names[pid].name) || (pid ? `#${pid}` : '?');
    row.appendChild(mk('span', 'color:#cfe6f5;', name));

    row.appendChild(mk('span', 'color:#e8b591;', TIER_CLAIM[sig.tier] || 'spy to confirm'));
    row.appendChild(mk('span', 'color:#9fb4c4;',
      `${formatAge(sig.freshAgeMs)} ago · ${sig.quiet}/${sig.total} quiet`
      + (sig.coMoons ? ` · ${sig.coMoons + 1} moons lit` : '')));

    // The shared watch pill (chips.js) — this row used to carry its own copy
    // labelled `⭐ watch` / `✓ watched`, a different wording and a decorative
    // glyph for the action every other Spyglass surface calls `+ watch`.
    if (pid) {
      const watch = watchChip(pid, watchedIds.has(pid), onToggleWatch);
      watch.style.marginLeft = 'auto';
      row.appendChild(watch);
    }

    hostEl.appendChild(row);
  }
}
