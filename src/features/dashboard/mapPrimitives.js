// @ts-check

// Shared map primitives for the dashboard's TWO map-bearing sub-tabs — the
// Galaxy Viewer (`freeStreak.js`) and the Spyglass watchlist map (Etap E). Both
// are sub-tabs of the SAME dashboard feature, so this crosses no import zone.
//
// The rule here is STRICT: this module holds only PURE compute (composite +
// score field) and PURE-DOM builders (the system card + its danger badge). It
// owns NO module-local mutable state — no caches, no selection, no highlight.
// Memoisation stays with each caller (GV and Spyglass keep their OWN identity
// caches), so the two sub-tabs can never stomp a shared cache. DOM inputs
// (offline-window / farm-reach sliders) are passed in as plain numbers, not read
// from a specific tab's controls. See SPYGLASS-REDESIGN.md §6.9.

import { buildScanMapFromIndex } from '../../domain/apiOccupancy.js';
import { buildThreatFarmField } from '../../domain/heatField.js';
import { occupantStrength, honorRank } from '../../domain/players.js';
import { DANGER_LABELS } from '../../domain/dangerScore.js';
import { dangerColor } from '../../lib/dangerColor.js';
import {
  STATUS_COLORS, STATUS_LABELS, STRENGTH_COLORS, STRENGTH_LABELS,
  HONOR_COLORS, HONOR_TIER_LABELS,
} from './palette.js';

/**
 * @typedef {import('../../state/scans.js').GalaxyScans} GalaxyScans
 * @typedef {import('../../domain/dangerScore.js').DangerProfile} DangerProfile
 * @typedef {import('../../domain/heatField.js').ThreatFarmField} ThreatFarmField
 * @typedef {{ galaxies?: number, systems?: number, donutGalaxy?: boolean, donutSystem?: boolean, domain?: string }} ApiBounds
 */

/**
 * The live-scan overlay for the API composite: only systems whose positions
 * were actually observed (this session). Excludes lf-only entries — after §5
 * the persisted scans blob keeps only lifeform markers (empty `positions`), so
 * a naive spread would clobber the API occupancy for those systems with blanks.
 *
 * When `bounds` is known it also drops entries OUTSIDE the server's real grid.
 * The persisted blob can carry junk keys beyond it (an old import / another
 * server's leftovers); serverData.xml's galaxies×systems is authoritative, and
 * a phantom galaxy has no planets in universe.xml, so its systems would read
 * "fully free" and top every colonization ranking (the "worth colonizing in
 * galaxy 8/9 on a 7-galaxy server" artifact).
 *
 * @param {GalaxyScans} s
 * @param {{ galaxies?: number, systems?: number }} [bounds]
 * @returns {GalaxyScans}
 */
export const liveOverlay = (s, bounds) => {
  const gMax = bounds && Number.isFinite(bounds.galaxies) ? Number(bounds.galaxies) : Infinity;
  const sMax = bounds && Number.isFinite(bounds.systems) ? Number(bounds.systems) : Infinity;
  /** @type {GalaxyScans} */
  const out = {};
  for (const k of /** @type {(keyof GalaxyScans)[]} */ (Object.keys(s))) {
    const v = s[k];
    if (!(v && v.positions && Object.keys(v.positions).length > 0)) continue;
    const colon = String(k).indexOf(':');
    const g = parseInt(String(k).slice(0, colon), 10);
    const sys = parseInt(String(k).slice(colon + 1), 10);
    if (Number.isFinite(g) && (g < 1 || g > gMax)) continue;
    if (Number.isFinite(sys) && (sys < 1 || sys > sMax)) continue;
    out[k] = v;
  }
  return out;
};

/**
 * Composite the API breadth layer (whole-server occupancy) with the live scan
 * map — live wins per system (fresher, carries honor rankClass / empty_sent).
 * When there's no cached API data the composite is just the live scans. PURE:
 * the caller owns the identity cache (see `freeStreak`/`index.js` wrappers).
 *
 * @param {{ apiIndex: import('../../domain/apiOccupancy.js').OccupancyIndex | null, apiBounds: ApiBounds, scans: GalaxyScans, positions: number[] }} input
 * @returns {GalaxyScans}
 */
export const computeComposite = ({ apiIndex, apiBounds, scans, positions }) => {
  if (!(apiIndex && apiBounds.galaxies && apiBounds.systems)) return scans;
  return /** @type {GalaxyScans} */ ({
    ...buildScanMapFromIndex(apiIndex, {
      galaxies: apiBounds.galaxies,
      systems: apiBounds.systems,
      targets: positions,
    }),
    // Bounds-clamped: stale out-of-grid keys in the persisted blob must not
    // resurrect nonexistent galaxies in the analysis (see liveOverlay).
    ...liveOverlay(scans, { galaxies: apiBounds.galaxies, systems: apiBounds.systems }),
  });
};

/**
 * The threat/farm field at PER-SYSTEM resolution over a composite — the
 * analyzer's ranking substrate (the map paints its own coarser build). `null`
 * without API bounds; zone scoring then degrades gracefully. PURE: the physical
 * knobs (offline window, farm reach) arrive as numbers, not DOM reads, and the
 * caller owns the identity cache.
 *
 * @param {{ composite: GalaxyScans, apiBounds: ApiBounds, ownMilitary: number | undefined, danger: Map<number, DangerProfile>, windowH: number, farmReach: number }} input
 * @returns {ThreatFarmField | null}
 */
export const computeScoreField = ({ composite, apiBounds, ownMilitary, danger, windowH, farmReach }) => {
  if (!apiBounds.galaxies || !apiBounds.systems) return null;
  return buildThreatFarmField(composite, {
    galaxies: apiBounds.galaxies,
    systems: apiBounds.systems,
    donutGalaxy: apiBounds.donutGalaxy,
    donutSystem: apiBounds.donutSystem,
  }, { ownMilitary, danger, cols: apiBounds.systems, window: windowH, farmReach });
};

/**
 * Danger badge (v2) for one active occupant — the per-player `D` 0–100 with a
 * colour (green → amber → red) and a tooltip that spells out WHY (label +
 * reasons). This is the minimal explainability hook: it turns the new threat
 * colours from an assertion into something the user can interrogate in place.
 * `null` when the player has no danger profile (unknown / not active).
 *
 * @param {DangerProfile | undefined} prof
 * @returns {HTMLElement | null}
 */
export const dangerBadge = (prof) => {
  if (!prof) return null;
  const d = Math.round(prof.danger * 100);
  const badge = document.createElement('span');
  // Green (safe) → amber → red across 0..100. Friendly (D 0) reads green.
  const col = dangerColor(d);
  badge.style.cssText = `margin-left:6px;font-weight:700;color:${col};`;
  badge.textContent = prof.friendly ? 'D 0 friendly' : `D ${d}`;
  const why = [DANGER_LABELS[prof.label], ...prof.reasons].filter(Boolean).join(' · ');
  badge.title = `Danger ${d}/100 — ${why}`;
  return badge;
};

/**
 * Build the friendly hover/pin CARD for one system — a styled popover (à la the
 * in-game "?" help and the planet-badge legend) rather than a cramped one-liner.
 * Header coords + scan time, one coloured row per OCCUPIED slot (status · owner
 * · #rank · ally · flags · danger D), a "Free positions: …" line, and a pin hint. Pure DOM.
 *
 * @param {number} g
 * @param {number} s
 * @param {import('../../state/scans.js').SystemScan | null | undefined} scan
 * @param {boolean} pinned
 * @param {import('../../domain/regions.js').PlayerCache} [players]  Joined by
 *   occupant id to classify active owners into NoobProtection strength bands.
 * @param {string} [linkBase]  Game origin; when set, the card carries an
 *   explicit "Open in game" link (clickable once the card is PINNED — the
 *   hover-preview card is pointer-transparent by design).
 * @param {Map<number, DangerProfile>} [danger]
 *   Per-player danger profiles — joined by occupant id for the D badge.
 * @returns {HTMLElement}
 */
export const buildSystemCard = (g, s, scan, pinned, players, linkBase, danger) => {
  const card = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'rp-head';
  head.textContent = `[${g}:${s}]`;
  card.appendChild(head);

  if (!scan || !scan.positions) {
    const e = document.createElement('div');
    e.textContent = 'Not scanned.';
    card.appendChild(e);
  } else {
    if (scan.scannedAt) {
      const t = document.createElement('div');
      t.className = 'rp-time';
      t.textContent = 'scanned ' + new Date(scan.scannedAt).toLocaleString();
      card.appendChild(t);
    }
    /** @type {number[]} */
    const free = [];
    let occupants = 0;
    for (let pos = 1; pos <= 15; pos++) {
      const p = scan.positions[pos];
      if (!p) continue;
      if (p.status === 'empty') { free.push(pos); continue; }
      occupants++;
      const row = document.createElement('div');
      row.className = 'rp-row';
      // Strength band for an ACTIVE occupant, from the game's NoobProtection
      // flags in the player cache. Drives both the dot tint and the label so a
      // crowded system reads as who-you-can-fight, not a wall of grey "Occupied".
      // null (unflagged / never live-scanned) falls back to the plain status.
      const meta = p.player && players ? players[p.player.id] : undefined;
      const band = p.status === 'occupied' ? occupantStrength(meta) : null;
      const dot = document.createElement('span');
      dot.className = 'rp-dot';
      dot.style.background = band
        ? STRENGTH_COLORS[band]
        : STATUS_COLORS[/** @type {keyof typeof STATUS_COLORS} */ (p.status)] || '#888';
      row.appendChild(dot);
      // When the band label is already "Honorable", the per-slot `honorable`
      // flag is redundant — drop it to avoid "Honorable (honorable, hasMoon)".
      // Otherwise keep it (e.g. a "Strong" honorable target, or the cache-less
      // fallback) so the signal isn't lost.
      const flagKeys = p.flags
        ? Object.keys(p.flags).filter((f) =>
          (band !== 'honorable' || f !== 'honorable') && /** @type {Record<string, unknown>} */ (p.flags)[f])
        : [];
      const flags = flagKeys.length ? ` (${flagKeys.join(',')})` : '';
      // Name: prefer the per-slot scan name, fall back to the cached player name
      // (an API-derived slot often lacks it), then the bare id — never "undefined".
      const pname = p.player
        ? (p.player.name || meta?.name || (p.player.id != null ? `player ${p.player.id}` : 'unknown'))
        : '';
      // No raw alliance id after the rank — the API gives only the numeric id
      // (e.g. "501023"), which read as an unexplained number salad.
      const who = p.player
        ? ` — ${pname}${typeof p.player.rank === 'number' ? ' #' + p.player.rank : ''}`
        : '';
      const label = band
        ? STRENGTH_LABELS[band]
        : STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (p.status)] || p.status;
      const txt = document.createElement('span');
      txt.textContent = `${pos}: ${label}`;
      row.appendChild(txt);
      // Honour-rank chip (bandit / honoured + tier) — a SEPARATE axis from the
      // strength band: a player can be both "Strong" and a "Bandit King". A
      // banned owner is frozen, so their honour rank isn't a live danger.
      const honor = p.status !== 'banned' ? honorRank(p.player?.rankClass) : null;
      if (honor) {
        const chip = document.createElement('span');
        chip.style.cssText = `margin-left:6px;font-weight:700;color:${HONOR_COLORS[honor.kind]};`;
        // Visibility: the higher the rank, the more marks — red "!" for bandits
        // (the threat convention OG-E already uses), gold "⭐" for honoured.
        chip.textContent = honor.kind === 'bandit'
          ? `${'!'.repeat(honor.tier)} ${HONOR_TIER_LABELS.bandit[honor.tier] || 'Bandit'}`
          : `${'⭐'.repeat(honor.tier)} Honored`;
        chip.title = `${honor.kind === 'bandit' ? 'Bandit' : 'Honoured fighter'} — honour tier ${honor.tier}/3`;
        row.appendChild(chip);
      }
      const rest = document.createElement('span');
      rest.textContent = `${flags}${who}`;
      row.appendChild(rest);
      // Danger D badge — only for ACTIVE occupants (the profile is a fleet/
      // threat scalar; dormant/blocked statuses have no attack relevance).
      if (p.status === 'occupied' && danger && p.player && p.player.id != null) {
        const badge = dangerBadge(danger.get(p.player.id));
        if (badge) row.appendChild(badge);
      }
      card.appendChild(row);
    }
    if (!occupants) {
      const e = document.createElement('div');
      e.textContent = 'No occupants — quiet system.';
      card.appendChild(e);
    }
    if (free.length) {
      const f = document.createElement('div');
      f.className = 'rp-free';
      f.textContent = 'Free positions: ' + free.join(', ');
      card.appendChild(f);
    }
  }

  // Only a PINNED card renders the link row — the hover-preview card is
  // pointer-transparent by design (see .region-pop), so a link there would be
  // a false affordance. No pin/unpin instruction footers either: the pointer
  // cursor on the cells already advertises the click, and the hint rows just
  // ate a line of every card.
  if (linkBase && pinned) {
    const linkRow = document.createElement('div');
    linkRow.className = 'rp-foot';
    const a = document.createElement('a');
    a.href = `${linkBase}/game/index.php?page=ingame&component=galaxy&galaxy=${g}&system=${s}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open in game ↗';
    a.style.color = '#4a9eff';
    linkRow.appendChild(a);
    card.appendChild(linkRow);
  }
  return card;
};

/** Relationship → Spyglass map marker colour. Own planets render white. */
export const RELATIONSHIP_COLORS = {
  enemy: '#e2726a',
  friend: '#7fd6a8',
  neutral: '#9aa7b3',
  you: '#ffffff',
};

/**
 * @typedef {object} MapBody   One planet to plot on the Spyglass positions map.
 * @property {number} galaxy
 * @property {number} system
 * @property {number} position
 * @property {string} playerId
 * @property {string} name
 * @property {'enemy'|'friend'|'neutral'|'you'} relationship
 * @property {number} danger   0..100 — scales the marker size.
 * @property {number} [reachH]  RIP-speed flight hours from THIS body to the
 *   viewer's nearest planet (the inverted reach kernel — "who can reach me").
 *   Set only when the caller computed the overlay; drives the ring + title.
 * @property {boolean} [inReach]  reachH ≤ the caller's horizon → draw the ring.
 */

/** The "in reach" ring colour (amber — distinct from every relationship hue). */
export const REACH_RING_COLOR = '#ffb454';

/**
 * The Spyglass "positions" map — the attack-planning / player-tracking view. An
 * EMPTY galaxy×system grid with a marker only at each body you care about (your
 * planets + your watched players'), coloured by RELATIONSHIP and sized by danger.
 * Deliberately NOT the occupancy palette (threat/farm/empty/protected) — that is
 * the Galaxy Viewer's job; here you only want to see WHERE the players you track
 * are. Plain DOM markers (native hover/click), no canvas.
 * @param {{ hostEl: HTMLElement, galaxies?: number, systems?: number, bodies: MapBody[], onPlayerClick?: (playerId: string) => void }} o
 * @returns {void}
 */
export const renderPositionsMap = ({ hostEl, galaxies, systems, bodies, onPlayerClick }) => {
  hostEl.innerHTML = '';
  if (!galaxies || !systems) {
    const el = document.createElement('div');
    el.className = 'server-map-empty';
    el.textContent = 'No API data yet — open the galaxy view in-game to populate positions.';
    hostEl.appendChild(el);
    return;
  }
  const POS = 15;
  const posPx = 2;
  const gap = 6;
  const gutter = 26;
  const topPad = 2;
  const stride = POS * posPx + gap;
  const plotH = galaxies * stride - gap + topPad;
  const W = hostEl.clientWidth || 700;
  const cellW = (W - gutter) / systems;

  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;height:${plotH}px;`;

  // Galaxy bands + labels — the only "grid"; the field is otherwise empty.
  // The old 1px #141b24 edge lines were invisible on the card background, so
  // EVERY galaxy band gets the same faint fill — the dark 6px gap between
  // bands is what separates the galaxies (uniform bands, NOT zebra: an
  // alternating tint read as two kinds of galaxy). Band-edge lines
  // (positions 1 and 15) are drawn in a clearly visible tone. Bands are
  // appended before the markers and take no pointer events, so they never
  // block a marker's hover/click.
  for (let g = 1; g <= galaxies; g++) {
    const bandTop = topPad + (g - 1) * stride;
    const band = document.createElement('div');
    band.style.cssText = `position:absolute;left:${gutter}px;right:0;top:${bandTop}px;`
      + `height:${POS * posPx}px;background:rgba(122,160,200,.07);pointer-events:none;`;
    wrap.appendChild(band);
    const yMid = bandTop + (POS * posPx) / 2;
    const lab = document.createElement('div');
    lab.textContent = `G${g}`;
    lab.style.cssText = `position:absolute;left:0;top:${yMid - 6}px;font:10px monospace;color:#7a8894;`;
    wrap.appendChild(lab);
    for (const pos of [1, POS]) {
      const y = bandTop + (pos - 0.5) * posPx;
      const line = document.createElement('div');
      line.style.cssText = `position:absolute;left:${gutter}px;right:0;top:${y}px;height:1px;`
        + 'background:#2a3d52;pointer-events:none;';
      wrap.appendChild(line);
    }
  }

  if (!bodies.length) {
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;left:26px;top:2px;color:#5f6b76;font-size:12px;';
    hint.textContent = 'Watch a player to see them here.';
    wrap.appendChild(hint);
  }

  // Caption line under the map — the touch-parity carrier for what desktop
  // reads from the markers' title tooltips (name, coords, reach hours). On
  // touch the FIRST tap on a marker prints it here; the SECOND tap on the
  // same marker opens the player (a bare tap must not navigate blind).
  // Desktop keeps hover → caption + immediate click-through.
  const coarse = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  const CAPTION_HINT = coarse
    ? (onPlayerClick ? 'Tap a body for details; tap again to open the player.' : 'Tap a body for details.')
    : 'Hover a body for details.';
  const caption = document.createElement('div');
  caption.className = 'smap-info';
  caption.textContent = CAPTION_HINT;
  /** @type {string | null} The marker described by the current caption (tap 1 of 2). */
  let described = null;

  for (const b of bodies) {
    if (b.galaxy < 1 || b.galaxy > galaxies || b.system < 1 || b.system > systems) continue;
    const size = 4 + Math.round((Math.max(0, Math.min(100, b.danger)) / 100) * 6); // 4..10 by danger
    const col = RELATIONSHIP_COLORS[b.relationship] || RELATIONSHIP_COLORS.neutral;
    const x = gutter + (b.system - 0.5) * cellW;
    const y = topPad + (b.galaxy - 1) * stride + (b.position - 0.5) * posPx;
    const m = document.createElement(onPlayerClick ? 'button' : 'span');
    // "Who can reach me" overlay: an amber ring on a body close enough to hit
    // one of the viewer's planets inside the horizon (caller-computed).
    const ring = b.inReach && b.relationship !== 'you'
      ? `box-shadow:0 0 0 2px ${REACH_RING_COLOR}cc;`
      : '';
    m.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px;`
      + `margin:${-size / 2}px 0 0 ${-size / 2}px;border-radius:50%;background:${col};${ring}`
      + `border:1px solid #000a;padding:0;box-sizing:border-box;cursor:${onPlayerClick ? 'pointer' : 'default'};`;
    const desc = `${b.name} — ${b.galaxy}:${b.system}:${b.position}`
      + (b.relationship === 'you' ? ' · you' : b.relationship !== 'neutral' ? ` · ${b.relationship}` : '')
      + (typeof b.reachH === 'number' && b.relationship !== 'you'
        ? ` · ~${b.reachH < 10 ? b.reachH.toFixed(1) : Math.round(b.reachH)} h to your nearest planet (RIP-speed)`
        : '');
    m.title = desc;
    const key = `${b.galaxy}:${b.system}:${b.position}`;
    m.addEventListener('mouseenter', () => { caption.textContent = desc; });
    if (onPlayerClick) {
      m.addEventListener('click', (e) => {
        e.preventDefault();
        if (coarse && described !== key) { described = key; caption.textContent = desc; return; }
        onPlayerClick(b.playerId);
      });
    }
    wrap.appendChild(m);
  }
  // Desktop-only reset: on touch the compat mouse events replayed after a
  // tap include stray mouseleaves that would wipe the caption (and re-arm
  // the two-tap sequence) right after the first tap set it.
  if (!coarse) wrap.addEventListener('mouseleave', () => { caption.textContent = CAPTION_HINT; described = null; });
  hostEl.appendChild(wrap);
  hostEl.appendChild(caption);
};
