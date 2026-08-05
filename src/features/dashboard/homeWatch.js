// @ts-check

// Spyglass → Home watch card — the dashboard face of the defensive mode
// (domain/homeWatch). Every other Spyglass surface answers "who can I hit?";
// this one answers "who can hit ME, from inside my own system?".
//
// Four reads, in the order a defender needs them:
//
//   1. WHAT CHANGED — strangers who appeared in one of our systems since the
//      previous look, worst Danger first, with the fleet-save consequence
//      spelled out (not hidden in a tooltip: on touch there are none).
//   2. WHO IS ENTANGLED WITH US — one row per NEIGHBOUR (not per system), so the
//      escalation shows: colour = their Danger, `×N` = how many of OUR systems
//      they sit in. One account in three of our systems can run a moon
//      destruction on its own, in three places, with no travel time to plan
//      around — a per-system list buried that fact.
//   3. COALITIONS — alliances whose members TOGETHER reach more of our systems
//      than any of them reaches alone. Two of them in one system of ours is not
//      that: the in-system capability is already bought by either one. Four of
//      our systems covered by three accounts that each hold one or two IS.
//   4. THE QUIET REST — systems with no neighbour, and look coverage, as one
//      foot line. Being alone is the expected state; it belongs in a count.
//
// Pure DOM builder over plain data — every input arrives as an argument (the
// index.js repaint computes them from the per-universe loads), no storage reads
// here. Mirrors the patrol.js / cards.js decomposition.

import { rankHomeNeighbours, findHomeCoalitions } from '../../domain/homeWatch.js';
import { dangerColor } from '../../lib/dangerColor.js';

/**
 * Danger from which an arrival is treated as a fleet-save problem rather than
 * just a new face. Mirrors the dossier's own reading of the D scale: below this
 * a neighbour is a neighbour, above it they are somebody whose reach you plan
 * around.
 */
const FS_WARN_DANGER = 0.5;

/**
 * Colour for a 0..1 danger fraction — `lib/dangerColor` works in the 0..100 the
 * rest of the app rounds to, and handing it the raw fraction painted D 0.91 the
 * same safe green as D 0.02 (every neighbour looked harmless). One conversion,
 * in one place.
 * @param {number | null | undefined} d  Danger 0..1.
 * @param {string} [unknown]  Colour when we hold no profile.
 * @returns {string}
 */
const dangerHue = (d, unknown = '#cfd6dd') => (
  typeof d === 'number' && Number.isFinite(d) ? dangerColor(Math.round(d * 100)) : unknown
);

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
 * An alliance's short label — its tag, or its name when the feed carries no tag.
 * Empty when the alliance is unknown to the cached alliances feed (it refreshes
 * on the same daily cadence as the player list, so a cold cache is normal).
 * @param {string | undefined} allianceId
 * @param {Record<string, { name?: string, tag?: string }>} [alliances]
 * @returns {string}
 */
const allianceTag = (allianceId, alliances) => {
  if (!allianceId) return '';
  const a = alliances ? alliances[allianceId] : undefined;
  return (a && (a.tag || a.name)) || '';
};

/**
 * The Danger pill for a player (or nothing when we hold no profile — an unknown
 * D is not a zero D, and painting it as one would read as "harmless").
 * @param {import('../../domain/dangerScore.js').DangerProfile | undefined} prof
 * @returns {HTMLElement | null}
 */
const dangerPill = (prof) => {
  if (!prof || typeof prof.danger !== 'number') return null;
  const col = dangerHue(prof.danger);
  const pill = mk('span',
    `font-size:11px;color:${col};border:1px solid ${col}59;background:${col}1a;`
    + 'border-radius:999px;padding:0 7px;white-space:nowrap;',
    `D ${prof.danger.toFixed(2)}`);
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
 * @param {Record<string, { name?: string, alliance?: string }>} args.names
 *   API player meta (players.xml rows) — the nickname AND the alliance id the
 *   coalition read is built from.
 * @param {Record<string, { name?: string, tag?: string }>} [args.alliances]
 *   alliances.xml (id → {name, tag}) — the `[TAG]` chip on a neighbour row.
 * @param {Map<number, import('../../domain/dangerScore.js').DangerProfile>} [args.danger]
 * @param {Record<string, { scannedAt?: number }>} args.scans
 * @param {number} args.staleMs   Galaxy-look cadence (ms).
 * @param {number} args.nowMs
 * @param {string} [args.linkBase]
 * @param {((pid: string) => void)} [args.onOpenPlayer]  Jump to their dossier.
 * @returns {void}
 */
export function renderHomeWatchCard({
  summaryEl, hostEl, systems, occupants, arrivals, names, alliances, danger,
  scans, staleMs, nowMs, linkBase, onOpenPlayer,
}) {
  /** @param {string} pid */
  const nameOf = (pid) => (names && names[pid] && names[pid].name) || `#${pid}`;
  /** @param {string} pid */
  const profOf = (pid) => danger?.get(Number(pid));

  // Look coverage — how much of the picture is current. Home watch can only
  // report what we have browsed, so this qualifies every "quiet" it ever says.
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

  // ── The bar's state word ─────────────────────────────────────────────────
  // Two words at most: this is what the FOLDED card says, and folded is the
  // normal state (quiet neighbourhoods have nothing to read). News first —
  // otherwise the honest quiet reading, qualified by look coverage so "quiet"
  // can never mean "we have not looked".
  if (summaryEl) {
    summaryEl.textContent = arrivals.length
      ? `${arrivals.length} new`
      : `quiet · ${fresh}/${systems.size} fresh`;
    summaryEl.classList.toggle('hot', arrivals.length > 0);
  }

  if (!hostEl) return;
  hostEl.textContent = '';

  // ── 1. New neighbours ───────────────────────────────────────────────────
  if (arrivals.length) {
    const head = mk('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
      + 'margin:8px 0 4px;');
    head.appendChild(mk('span', 'color:#e06c5f;font-weight:600;font-size:12px;',
      `Moved in (${arrivals.length})`));
    // No "clear" button: reading this block IS the acknowledgement, and the flag
    // expires by itself a day later (state/homeWatch.markHomeArrivalsShown). A
    // button here would only ask the user to maintain our bookkeeping.
    head.appendChild(mk('span', 'margin-left:auto;font-size:11px;color:#66788a;',
      'NEW clears itself a day after you read it'));
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
      // Danger-coloured, exactly like the neighbour rows below: ONE colour
      // language across the card (hue = Danger) instead of two.
      const who = mk('span',
        `color:${dangerHue(prof?.danger, '#cfe6f5')};font-weight:600;`
        + 'cursor:pointer;text-decoration:underline dotted;', nameOf(pid));
      who.title = 'Open this player in the Players list below';
      if (onOpenPlayer) who.addEventListener('click', () => onOpenPlayer(pid));
      row.appendChild(who);
      const pill = dangerPill(prof);
      if (pill) row.appendChild(pill);
      else row.appendChild(mk('span', 'color:#8a97a3;', 'Danger unknown'));
      row.appendChild(mk('span', 'color:#9fb4c4;', `seen ${formatAge(nowMs - (a.atMs || nowMs))} ago`));
      hostEl.appendChild(row);
    }

    // The consequence, in one line. This is the reason the feature exists: a
    // hunter in your own system is not a statistic, it is a fleet-save you can
    // no longer fly the way you have been flying it. Keyword, who, then the
    // action — the old three-line paragraph said the same thing at length.
    const risky = sorted.filter((a) => (profOf(String(a.playerId))?.danger ?? 0) >= FS_WARN_DANGER);
    if (risky.length) {
      const warn = mk('div',
        'margin-top:6px;padding:6px 8px;border:1px solid #5c2f2c;background:#2a1614;'
        + 'border-radius:6px;color:#f0b8b0;font-size:12px;line-height:1.45;');
      const list = risky
        .map((a) => `${nameOf(String(a.playerId))} (${a.system})`)
        .join(', ');
      warn.textContent = `Fleet-save — ${list}: minutes from your moons there. `
        + 'Move the overnight save.';
      hostEl.appendChild(warn);
    }
  }

  // ── 2. Who is entangled with us — one row per NEIGHBOUR ─────────────────
  const list = mk('div', arrivals.length ? 'margin-top:10px;' : '');
  if (!systems.size) {
    list.appendChild(mk('div', 'color:#8a97a3;font-size:12px;',
      'No own bodies known yet — open the game once so OG-E can read your planet bar.'));
  }
  /** @type {Record<string, number>} */
  const dangerByPlayer = {};
  /** @type {Record<string, string>} */
  const allianceByPlayer = {};
  for (const slots of Object.values(occupants || {})) {
    for (const s of slots || []) {
      const pid = String(s.playerId);
      const d = profOf(pid)?.danger;
      if (typeof d === 'number') dangerByPlayer[pid] = d;
      const ally = names?.[pid]?.alliance;
      if (ally) allianceByPlayer[pid] = String(ally);
    }
  }
  const neighbours = rankHomeNeighbours({
    occupants,
    dangerByPlayer,
    allianceByPlayer,
    newKeys: new Set(arrivals.map((a) => `${a.system}|${a.playerId}`)),
  });
  const coalitions = findHomeCoalitions({ occupants, allianceByPlayer });
  /**
   * Alliances that reach further together than any member does alone — the only
   * ones whose tag chip lights up. A tag lighting for "two of them are simply in
   * one of my systems" would train the eye to ignore it.
   */
  const coalitionAllies = new Set(coalitions.map((c) => c.allianceId));

  for (const n of neighbours) {
    const col = dangerHue(n.danger);
    // The row's left rule IS the Danger read — a column of colour you scan in one
    // pass, with no text added. The exact D stays a tap away (the name opens the
    // dossier, which carries the number and the reasons).
    const row = mk('div', 'display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;'
      + `padding:4px 0 4px 8px;border-top:1px solid #16212c;border-left:3px solid ${col};`
      + 'font-size:12px;');
    if (n.isNew) row.appendChild(mk('span', 'color:#e06c5f;font-weight:600;', 'NEW'));
    const who = mk('span', `color:${col};font-weight:600;`
      + (onOpenPlayer ? 'cursor:pointer;text-decoration:underline dotted;' : ''), nameOf(n.playerId));
    const prof = profOf(n.playerId);
    who.title = prof
      ? `Danger ${prof.danger.toFixed(2)}${prof.reasons?.length ? `\n${prof.reasons.join('\n')}` : ''}`
        + '\nClick for the full dossier.'
      : 'Danger unknown — no public-statistics profile yet. Click for the dossier.';
    if (onOpenPlayer) who.addEventListener('click', () => onOpenPlayer(n.playerId));
    row.appendChild(who);
    // Alliance tag: dim on its own, LIT when this alliance fields two or more
    // members among our systems (see the coalition lines below).
    if (n.allianceId) {
      const tag = allianceTag(n.allianceId, alliances);
      if (tag) {
        const inCoalition = coalitionAllies.has(n.allianceId);
        row.appendChild(mk('span',
          `font-size:10px;letter-spacing:.03em;border-radius:3px;padding:0 4px;`
          + (inCoalition
            ? 'color:#e0b45f;border:1px solid #e0b45f66;background:#e0b45f14;'
            : 'color:#7f8ea0;border:1px solid #2a3542;'),
          tag));
      }
    }
    // Reach — how many of OUR systems they are inside. Only shown past one,
    // where it stops being ordinary and starts being the story.
    if (n.systems.length > 1) {
      const reach = mk('span',
        `font-size:11px;font-weight:700;color:${col};border:1px solid ${col}66;`
        + `background:${col}1a;border-radius:999px;padding:0 6px;`,
        `×${n.systems.length}`);
      reach.title = `Inside ${n.systems.length} of your systems — their fleet is already `
        + 'in range of a moon of yours in each of them.';
      row.appendChild(reach);
    }
    const where = mk('span', 'display:inline-flex;gap:6px;flex-wrap:wrap;min-width:0;');
    n.systems.forEach((s, i) => {
      if (i) where.appendChild(mk('span', 'color:#5d6b78;', '·'));
      where.appendChild(coordEl(s, linkBase));
    });
    row.appendChild(where);
    list.appendChild(row);
  }
  hostEl.appendChild(list);

  // ── 3. Coalitions — the reach nobody there has on their own ─────────────
  // The escalation is REACH, not headcount: two members in one system of ours are
  // worth no more than one (the in-system capability is already bought), so the
  // domain only returns alliances whose union covers MORE of our systems than
  // their best member covers alone, and the line states exactly that gap.
  const COALITIONS_SHOWN = 3;
  for (const c of coalitions.slice(0, COALITIONS_SHOWN)) {
    const tag = allianceTag(c.allianceId, alliances) || `alliance ${c.allianceId}`;
    const who = c.playerIds.map((pid) => nameOf(pid)).join(', ');
    // Weight follows the size of the jump. "×2 together where one has ×1" is
    // common and mild; painting it as loudly as "×4 where the best has ×2" would
    // flatten the difference and train the eye past both.
    if (c.systems.length >= 3 || c.lift >= 2) {
      const box = mk('div',
        'margin-top:6px;padding:5px 8px;border-radius:6px;font-size:12px;line-height:1.5;'
        + 'border:1px solid #5c4a2c;background:#241d12;color:#e8c68d;');
      box.appendChild(mk('div', 'font-weight:600;',
        `Together — ${tag} reaches ×${c.systems.length} of your systems, `
        + `×${c.soloBest} for its best member alone.`));
      box.appendChild(mk('div', 'font-size:11px;color:#c0a882;',
        `${c.systems.join(' · ')} — ${who}`));
      hostEl.appendChild(box);
    } else {
      hostEl.appendChild(mk('div', 'margin-top:4px;font-size:11px;color:#9a8a6a;',
        `${tag} — ×${c.systems.length} together, ×${c.soloBest} alone · `
        + `${c.systems.join(' · ')} — ${who}`));
    }
  }
  const coalitionsHidden = Math.max(0, coalitions.length - COALITIONS_SHOWN);
  if (coalitionsHidden) {
    hostEl.appendChild(mk('div', 'margin-top:4px;font-size:11px;color:#66788a;',
      `+${coalitionsHidden} more alliance${coalitionsHidden === 1 ? '' : 's'} `
      + 'whose members reach further together than alone.'));
  }

  // ── 4. The quiet rest + look coverage + the legend, in the foot ─────────
  // Everything that is NOT news, compressed: how many systems you have to
  // yourself, and how current the picture is (Home watch can only report what
  // has been browsed, so "quiet" without this would be a claim it can't back).
  if (systems.size) {
    const withNeighbour = new Set(neighbours.flatMap((n) => n.systems)).size;
    const bits = [`${systems.size} own system${systems.size === 1 ? '' : 's'}`];
    const alone = systems.size - withNeighbour;
    if (alone > 0) bits.push(`${alone} with no neighbour`);
    if (stale) bits.push(`${stale} look${stale === 1 ? '' : 's'} stale`);
    if (never) bits.push(`${never} never looked`);
    hostEl.appendChild(mk('div', 'margin-top:8px;font-size:11px;color:#66788a;',
      bits.join(' · ')));
    // The legend names the two visual codes once, in words, so neither depends on
    // a hover to be understood.
    if (neighbours.length) {
      hostEl.appendChild(mk('div', 'margin-top:2px;font-size:11px;color:#66788a;',
        'edge colour = Danger · ×N = in N of your systems · lit tag = their alliance '
        + 'reaches further together than alone'));
    }
  }
}
