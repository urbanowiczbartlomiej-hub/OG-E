// @ts-check

// Spyglass → Home watch card — the dashboard face of the defensive mode
// (domain/homeWatch). Every other Spyglass surface answers "who can I hit?";
// this one answers "who can hit ME, from inside my own system?".
//
// Three reads, in the order a defender needs them:
//
//   1. NEW NEIGHBOURS — strangers who appeared in one of our systems since the
//      previous look, worst Danger first, with the fleet-save consequence
//      spelled out (not hidden in a tooltip: on touch there are none).
//   2. THE STANDING PICTURE — every system we live in and who else is in it, so
//      "no new arrivals" is visibly different from "no data yet".
//   3. COVERAGE — how many of our systems have a fresh look at all. Home watch
//      can only report what we have browsed; the summary says how much that is.
//
// Pure DOM builder over plain data — every input arrives as an argument (the
// index.js repaint computes them from the per-universe loads), no storage reads
// here. Mirrors the patrol.js / cards.js decomposition.

import { DANGER_LABELS } from '../../domain/dangerScore.js';
import { dangerColor } from '../../lib/dangerColor.js';

/**
 * Danger from which an arrival is treated as a fleet-save problem rather than
 * just a new face. Mirrors the dossier's own reading of the D scale: below this
 * a neighbour is a neighbour, above it they are somebody whose reach you plan
 * around.
 */
const FS_WARN_DANGER = 0.5;

/** Compact age like the patrol card's ("3m", "2h", "1d"). @param {number} ms */
const formatAge = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

/**
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
 * A galaxy deep-link element for a "g:s" or "g:s:p" coord (plain span without
 * an origin).
 * @param {string} coord
 * @param {string} [linkBase]
 * @param {string} [css]
 * @returns {HTMLElement}
 */
const coordEl = (coord, linkBase, css = 'color:#9fd0f0;text-decoration:none;') => {
  const [g, s, p] = coord.split(':');
  const el = mk(linkBase ? 'a' : 'span', css, coord);
  if (linkBase) {
    const a = /** @type {HTMLAnchorElement} */ (el);
    a.href = `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${g}&system=${s}`
      + (p ? `&position=${p}` : '');
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = 'Open this system in the galaxy view';
  }
  return el;
};

/**
 * The Danger pill for a player (or nothing when we hold no profile — an unknown
 * D is not a zero D, and painting it as one would read as "harmless").
 * @param {import('../../domain/dangerScore.js').DangerProfile | undefined} prof
 * @returns {HTMLElement | null}
 */
const dangerPill = (prof) => {
  if (!prof || typeof prof.danger !== 'number') return null;
  const col = dangerColor(prof.danger);
  const pill = mk('span',
    `font-size:11px;color:${col};border:1px solid ${col}59;background:${col}1a;`
    + 'border-radius:999px;padding:0 7px;white-space:nowrap;',
    `D ${prof.danger.toFixed(2)} · ${DANGER_LABELS[prof.label] ?? prof.label ?? ''}`.trim());
  if (prof.reasons && prof.reasons.length) pill.title = prof.reasons.join('\n');
  return pill;
};

/**
 * Render the Home watch card. The caller owns visibility (hidden while the mode
 * is off or the body inventory hasn't landed).
 *
 * @param {object} args
 * @param {HTMLElement | null} args.summaryEl  Head summary span.
 * @param {HTMLElement | null} args.hostEl     Body container.
 * @param {Set<string>} args.systems           Our systems ("g:s").
 * @param {Record<string, Array<{playerId: string, position: number}>>} args.occupants
 *   Foreign slots per home system (patrolOccupants over the home set).
 * @param {import('../../domain/homeWatch.js').HomeArrival[]} args.arrivals
 *   UNACKNOWLEDGED arrivals (state/homeWatch.openHomeArrivals), newest first.
 * @param {Record<string, { name?: string }>} args.names  API player meta.
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [args.danger]
 * @param {Record<string, { scannedAt?: number }>} args.scans
 * @param {number} args.staleMs   Galaxy-look cadence (ms).
 * @param {number} args.nowMs
 * @param {string} [args.linkBase]
 * @param {(() => void)} [args.onDismiss]  "Seen it" — silences the alerts.
 * @param {((pid: string) => void)} [args.onOpenPlayer]  Jump to their dossier.
 * @returns {void}
 */
export function renderHomeWatchCard({
  summaryEl, hostEl, systems, occupants, arrivals, names, danger,
  scans, staleMs, nowMs, linkBase, onDismiss, onOpenPlayer,
}) {
  /** @param {string} pid */
  const nameOf = (pid) => (names && names[pid] && names[pid].name) || `#${pid}`;
  /** @param {string} pid */
  const profOf = (pid) => danger?.get(Number(pid));

  // ── Head summary: how many systems, how well looked-at, how much is new ──
  if (summaryEl) {
    let fresh = 0;
    let stale = 0;
    let never = 0;
    for (const key of systems) {
      const sc = scans ? scans[key] : undefined;
      const seen = sc ? Number(sc.scannedAt) : 0;
      if (!(Number.isFinite(seen) && seen > 0)) never += 1;
      else if (nowMs - seen <= staleMs) fresh += 1;
      else stale += 1;
    }
    summaryEl.textContent =
      `${systems.size} own system${systems.size === 1 ? '' : 's'} · `
      + `looks: ${fresh} fresh · ${stale} stale · ${never} never`
      + (arrivals.length ? ` · ${arrivals.length} new neighbour${arrivals.length === 1 ? '' : 's'}` : '');
  }

  if (!hostEl) return;
  hostEl.textContent = '';

  // ── 1. New neighbours ───────────────────────────────────────────────────
  if (arrivals.length) {
    const head = mk('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;');
    head.appendChild(mk('span', 'color:#e06c5f;font-weight:600;font-size:12px;',
      `New in your systems (${arrivals.length})`));
    if (onDismiss) {
      const seen = /** @type {HTMLButtonElement} */ (mk('button',
        'margin-left:auto;font-size:11px;color:#9fb4c4;background:#12202e;border:1px solid #2b3a4d;'
        + 'border-radius:999px;padding:1px 9px;cursor:pointer;', 'seen it'));
      seen.type = 'button';
      seen.title = 'Stop flagging these as new. The neighbours stay listed below — '
        + 'only the alert is silenced.';
      seen.addEventListener('click', () => onDismiss());
      head.appendChild(seen);
    }
    hostEl.appendChild(head);

    // Worst first: an arrival you must plan around outranks a fresh one you
    // don't. Unknown D sorts below any known one (see dangerPill).
    const sorted = [...arrivals].sort((a, b) =>
      (profOf(String(b.playerId))?.danger ?? -1) - (profOf(String(a.playerId))?.danger ?? -1)
      || (b.atMs || 0) - (a.atMs || 0));

    for (const a of sorted) {
      const pid = String(a.playerId);
      const prof = profOf(pid);
      const row = mk('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
        + 'padding:4px 0;border-top:1px solid #1c2a3a;font-size:12px;');
      row.appendChild(mk('span', 'color:#e06c5f;font-weight:600;', 'NEW'));
      row.appendChild(coordEl(a.coord, linkBase, 'color:#f0c89a;text-decoration:none;'));
      const who = mk('span', 'color:#cfe6f5;cursor:pointer;text-decoration:underline dotted;', nameOf(pid));
      who.title = 'Open this player in the Players list below';
      if (onOpenPlayer) who.addEventListener('click', () => onOpenPlayer(pid));
      row.appendChild(who);
      const pill = dangerPill(prof);
      if (pill) row.appendChild(pill);
      else row.appendChild(mk('span', 'color:#8a97a3;', 'Danger unknown'));
      row.appendChild(mk('span', 'color:#9fb4c4;', `seen ${formatAge(nowMs - (a.atMs || nowMs))} ago`));
      hostEl.appendChild(row);
    }

    // The consequence, spelled out. This is the reason the feature exists: a
    // hunter in your own system is not a statistic, it is a fleet-save you can
    // no longer fly the way you have been flying it.
    const risky = sorted.filter((a) => (profOf(String(a.playerId))?.danger ?? 0) >= FS_WARN_DANGER);
    if (risky.length) {
      const warn = mk('div',
        'margin-top:6px;padding:6px 8px;border:1px solid #5c2f2c;background:#2a1614;'
        + 'border-radius:6px;color:#f0b8b0;font-size:12px;line-height:1.45;');
      const list = risky
        .map((a) => `${nameOf(String(a.playerId))} in ${a.system}`)
        .join(', ');
      warn.textContent =
        `Fleet-save warning — ${list}. A neighbour with this Danger sees your bodies in the `
        + 'galaxy view and reaches them in minutes: move the overnight fleet-save away from '
        + 'the moons in those systems, and expect to be probed.';
      hostEl.appendChild(warn);
    }
  }

  // ── 2. The standing picture: every own system and who shares it ─────────
  const list = mk('div', arrivals.length ? 'margin-top:10px;' : '');
  const keys = [...systems].sort((a, b) => {
    const [ag, as] = a.split(':').map(Number);
    const [bg, bs] = b.split(':').map(Number);
    return ag - bg || as - bs;
  });
  if (!keys.length) {
    list.appendChild(mk('div', 'color:#8a97a3;font-size:12px;',
      'No own bodies known yet — open the game once so OG-E can read your planet bar.'));
  }
  const newBySystem = new Set(arrivals.map((a) => a.system));
  for (const key of keys) {
    const slots = occupants ? occupants[key] || [] : [];
    const row = mk('div', 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;'
      + 'padding:3px 0;border-top:1px solid #16212c;font-size:12px;');
    row.appendChild(coordEl(key, linkBase));
    const sc = scans ? scans[key] : undefined;
    const seen = sc ? Number(sc.scannedAt) : 0;
    const lookTxt = Number.isFinite(seen) && seen > 0
      ? `looked ${formatAge(nowMs - seen)} ago`
      : 'never looked';
    row.appendChild(mk('span',
      `color:${Number.isFinite(seen) && seen > 0 && nowMs - seen <= staleMs ? '#7fb2e0' : '#8a97a3'};`,
      lookTxt));
    if (newBySystem.has(key)) row.appendChild(mk('span', 'color:#e06c5f;font-weight:600;', 'NEW'));
    if (!slots.length) {
      row.appendChild(mk('span', 'color:#7fd6a8;', 'alone in the system'));
    } else {
      const who = mk('span', 'color:#cfd6dd;');
      const uniq = [...new Set(slots.map((s) => s.playerId))];
      uniq.forEach((pid, i) => {
        if (i) who.appendChild(mk('span', 'color:#5d6b78;', ' · '));
        const prof = profOf(pid);
        const col = typeof prof?.danger === 'number' ? dangerColor(prof.danger) : '#cfd6dd';
        const nameSpan = mk('span', `color:${col};`, nameOf(pid));
        if (prof) {
          nameSpan.title = `Danger ${prof.danger.toFixed(2)}`
            + (prof.reasons?.length ? `\n${prof.reasons.join('\n')}` : '');
        }
        who.appendChild(nameSpan);
      });
      row.appendChild(who);
      row.appendChild(mk('span', 'color:#8a97a3;',
        `${slots.length} ${slots.length === 1 ? 'body' : 'bodies'}`));
    }
    list.appendChild(row);
  }
  hostEl.appendChild(list);
}
