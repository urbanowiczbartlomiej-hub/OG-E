// @ts-check

// Who's-spying-on-you panel — an OG-E table injected at the TOP of the messages
// page's spy-report tab (`?page=ingame&component=messages`, the "Szpieguj"
// sub-tab), right above AntiGame's own spy-report overview (`#agoSpyReportOverview`).
// It is the DEFENSIVE mirror of AGR's OFFENSIVE list: AGR summarises the farms
// YOU scanned; this summarises WHO has been probing YOU.
//
// # Why the messages page (this used to live in the AGR sidebar)
//
// The sidebar tab was cramped and easy to miss. The messages page is where you
// actually review espionage — the incoming "Obca flota … dostrzeżona w pobliżu
// Twojej planety" alerts that feed this panel LIVE in this very tab — and there's
// full page width for a scannable table. So we moved it here and reshaped the
// narrow stacked cards into a compact table that blends with AGR's overview
// directly below it.
//
// # Data (unchanged — fair-play GREEN)
//
// Reads `state/proximityReports.js` (the per-universe log of proximity alerts the
// player OPENED, captured by `features/targetsIngest`) and aggregates it with the
// pure `domain/proximityDigest.js` into one row per prober — newest and closest
// first, same-system (RIP-range) probers flagged 💀. Purely presentational: no new
// data is captured here.
//
// # Anchor + lifecycle (two-tier)
//
// The insertion slot is resolved per refresh, best-first:
//
//   1. Above AGR's `#agoSpyReportOverview` (the 1.39.0 placement) — AGR builds
//      it only in the spy-report tab, so it doubles as the tab signal. Newer
//      AGR builds STOPPED injecting it (observed in the wild 2026-07, confirmed
//      by a live console check), which used to make this panel silently vanish.
//   2. GAME-owned fallback: the top of `.messagesHolder` — the game's own
//      message-list container — while the espionage sub-tab is the active one
//      (`.innerTabItem.active[data-subtab-id="20"]`; the numeric sub-tab id is
//      a game constant, so the check is locale-independent). Verified against
//      a live 2026-07 messages-page dump. Works even when the tab holds no
//      messages at all.
//
// A `MutationObserver` on <body> keeps the table mounted at the slot —
// surviving OGame's AJAX sub-tab re-renders (each switch rebuilds the messages
// DOM; a holder re-render also drops our panel, and the observer simply
// re-inserts it). When no slot resolves (other sub-tab / not the messages
// page) or there are no probers, the table is removed (no clutter when
// there's nothing to show). A `proximityReportsStore` subscription repaints on
// a new alert; a slow clock poll refreshes the relative ages. A cheap render
// signature skips the rebuild when nothing changed, so the frequent <body>
// mutations OGame emits stay free.
//
// Idempotent install: a second call returns the same dispose fn.

import { proximityReportsStore } from '../state/proximityReports.js';
import { digestProximityReports } from '../domain/proximityDigest.js';
import { settingsStore } from '../state/settings.js';
import { bodiesStore } from '../state/bodies.js';
import { bodyNameIndex, bodyNameFor, nearestBodyDistance } from '../domain/bodies.js';
import { injectStyle, parseSvg } from '../lib/dom.js';
import { dangerColor01 } from '../lib/dangerColor.js';
import { readApiCache } from '../state/apiCache.js';
import { EYE_GLYPH } from './shared/buttonGlyphs.js';
import { navigateGalaxyInPage } from './shared/galaxyNav.js';
import { ingameComponentUrl } from '../domain/ogameUrl.js';
import { safeLS } from '../lib/storage.js';
import { clock } from '../lib/clock.js';
import { parseUniverseId } from '../lib/universeId.js';
import { getApiContext } from './shared/apiContextStore.js';

/**
 * AGR's spy-report overview on the messages page — the PREFERRED slot when
 * present (see the header: newer AGR builds no longer inject it, hence the
 * game-owned fallback below). AGR-owned, single feature ⇒ kept local rather
 * than hoisted to gameDom.js.
 */
const SPY_OVERVIEW_SEL = '#agoSpyReportOverview';
/**
 * The game's ACTIVE espionage sub-tab header on the messages page. Game-owned
 * DOM contract (single feature ⇒ local, per the gameDom.js rule): sub-tab ids
 * are numeric game constants — 20 espionage, 21 combat, 22 expeditions,
 * 23 unions/transport, 24 other — so this never depends on the locale label.
 */
const SPY_SUBTAB_ACTIVE_SEL = '.innerTabItem.active[data-subtab-id="20"]';
/** The game's message-list container (direct parent of every `.msg`). */
const MESSAGES_HOLDER_SEL = '.messagesHolder';
/**
 * The game's sortable column-header strip ("Data/godzina · Ranking · Nazwa
 * gracza · …") that sits directly ABOVE `.messagesHolder`. We mount above IT,
 * not at the top of the holder: injected between the headers and the first
 * `.msg` row, our table pushed the rows ~200 px down and the column labels no
 * longer lined up with anything the user was reading.
 */
const MESSAGES_HEADERS_SEL = '#filteredHeadersRow';

/**
 * Resolve where the panel mounts: insert into `parent` before `before`
 * (`before: null` = append — an empty holder). `null` when the spy tab isn't
 * open (as far as we can tell). Tier 1: right above AGR's overview. Tier 2:
 * above the game's own column-header strip while the espionage sub-tab is
 * active. Tier 3 (no header strip in this build): the top of the message list.
 * `before` never resolves to the panel itself, so the caller's "already glued"
 * check stays a cheap identity comparison.
 * @returns {{ parent: Element, before: Element | null } | null}
 */
const resolveSlot = () => {
  const agr = document.querySelector(SPY_OVERVIEW_SEL);
  if (agr && agr.parentElement) return { parent: agr.parentElement, before: agr };

  if (!document.querySelector(SPY_SUBTAB_ACTIVE_SEL)) return null;
  const headers = document.querySelector(MESSAGES_HEADERS_SEL);
  if (headers && headers.parentElement) return { parent: headers.parentElement, before: headers };
  const holder = document.querySelector(MESSAGES_HOLDER_SEL);
  if (!holder) return null;
  let first = holder.firstElementChild;
  if (first && first.id === PANEL_ID) first = first.nextElementSibling;
  return { parent: holder, before: first };
};
/** Our table wrapper id (OG-E's own surface). */
const PANEL_ID = 'oge-spyback';
/** Singleton style element id. */
const STYLE_ID = 'oge-spyback-style';
/** Max prober rows rendered (the log itself keeps ~3 months of alerts — see
 *  state/proximityReports.trimProximityLog — so the list needs its own bound). */
const MAX_ROWS = 8;
/** Age-refresh cadence for the relative timestamps. */
const POLL_MS = 60000;
/** Device-local coords↔names toggle for the "Near you" column — show OUR
 *  planet/moon names instead of raw coordinates. Persists per device. */
const NAMES_KEY = 'oge_spybackNames';
/** True ⇒ render the "Near you" column as our body names, not coordinates. */
let showNames = safeLS.get(NAMES_KEY) === '1';

/**
 * Date-range filter for the prober list — a radio chip beside the names toggle.
 * Each value is a look-back window in SECONDS; only alerts newer than
 * `now − window` (plus any ts-less alert, which can't be aged) reach the digest.
 * The chosen value lives in `settingsStore.spyRange` (default `'1m'`) so it is
 * SHARED with the dashboard strip and syncs across devices — unlike the
 * device-local Names toggle. `'1m'` matches the strip's prior 30-day cutoff.
 * @type {Array<[value: string, label: string, seconds: number]>}
 */
const RANGES = [
  ['1d', '1d', 86400],
  ['7d', '7d', 604800],
  ['1m', '1m', 2592000],
  ['3m', '3m', 7776000],
];
/** Current range from settings, guarded to a known value (legacy/blank → '1m'). */
const currentRange = () => {
  const r = settingsStore.get().spyRange;
  return RANGES.some(([v]) => v === r) ? r : '1m';
};

const CSS = [
  // --sp-accent = the Spyglass gold (sendSpy's BG_SPY_IDLE) — one spy identity
  // across the FAB, this panel and the dashboard tab it deep-links to.
  `#${PANEL_ID}{--sp-accent:#e6c054;--sp-danger:#e2726a;margin:0 0 10px;`,
  // The Spyglass gold rides the panel's TOP edge, level with its header — the
  // same move the dashboard's cards made. Down the whole left side it was a long
  // saturated rule beside rows that already carry their own Danger colours.
  'background:#0d151d;border:1px solid #26323f;border-top:3px solid var(--sp-accent);',
  'border-radius:6px;overflow:hidden;color:#93a3b3;',
  'font-family:Verdana,"Segoe UI",Tahoma,sans-serif;}',
  // FOLD: quiet is the normal state and it is one line, so the panel keeps its
  // body closed and speaks through the header. A NEW alert (newer than the one
  // this panel last showed you) turns the edge alarm-red and opens it by itself;
  // reading it puts the edge back to the spy gold.
  `#${PANEL_ID}.hot{border-top-color:var(--sp-danger);}`,
  `#${PANEL_ID}:not(.open) table{display:none;}`,
  `#${PANEL_ID}:not(.open) .oge-sb-foot{display:none!important;}`,
  `#${PANEL_ID} .oge-sb-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;`,
  'background:linear-gradient(90deg,#141d27,transparent);border-bottom:1px solid #1b2732;',
  'cursor:pointer;user-select:none;}',
  `#${PANEL_ID}:not(.open) .oge-sb-hdr{border-bottom:0;}`,
  `#${PANEL_ID} .oge-sb-hdr:hover{background:linear-gradient(90deg,#1a2534,transparent);}`,
  // CSS caret — right when folded, down when open (same language as the
  // dashboard's disclosure cards; no glyph font involved).
  `#${PANEL_ID} .oge-sb-caret{flex:0 0 auto;width:6px;height:6px;margin-right:2px;`,
  'border-right:2px solid #7f8ea0;border-bottom:2px solid #7f8ea0;',
  'transform:rotate(-45deg);transition:transform .15s ease;}',
  `#${PANEL_ID}.open .oge-sb-caret{transform:rotate(45deg);margin-top:-3px;}`,
  // The Spyglass eye — our own SVG glyph (sendSpy's watermark), tinted to the
  // gold accent so the panel wears the one spy identity (was a 👁 emoji).
  `#${PANEL_ID} .oge-sb-eye{display:inline-flex;color:var(--sp-accent);}`,
  `#${PANEL_ID} .oge-sb-eye svg{width:16px;height:16px;display:block;}`,
  `#${PANEL_ID} .oge-sb-title{font-size:12.5px;font-weight:700;color:#d8e6f4;letter-spacing:.02em;}`,
  `#${PANEL_ID} .oge-sb-sum{margin-left:auto;font:11px/1 monospace;color:#6b7987;}`,
  `#${PANEL_ID} .oge-sb-sum b{color:#c6d4e2;font-weight:700;}`,
  `#${PANEL_ID} .oge-sb-sum .hot{color:var(--sp-danger);font-weight:700;}`,
  `#${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:12px;}`,
  `#${PANEL_ID} thead th{text-align:left;font:700 10px/1 Verdana,sans-serif;`,
  'letter-spacing:.05em;text-transform:uppercase;color:#5f6b76;padding:6px 10px;',
  'border-bottom:1px solid #1b2732;white-space:nowrap;}',
  `#${PANEL_ID} th.num,#${PANEL_ID} td.num{text-align:right;}`,
  `#${PANEL_ID} tbody td{padding:6px 10px;border-top:1px solid #16212c;vertical-align:middle;}`,
  `#${PANEL_ID} tbody tr.hot{background:linear-gradient(90deg,#2a1512,transparent 70%);`,
  'box-shadow:inset 3px 0 0 var(--sp-danger);}',
  // The nick wears the prober's DANGER colour, set per row from `--d` (see
  // buildRow) — the dashboard strip's central move, and the reason the two
  // surfaces now read the same. Colour means Danger EVERYWHERE in the Spyglass;
  // the row's left rule is the same value, so a list scans in one pass.
  `#${PANEL_ID} .oge-sb-name{font-weight:700;color:var(--d,#d8e6f4);`,
  'cursor:pointer;text-decoration:underline dotted;}',
  `#${PANEL_ID} tbody tr{box-shadow:inset 3px 0 0 var(--d,#26323f);}`,
  // Same-system stays RED on both counts: the rule says how dangerous they are,
  // the tint says they are already inside one of your systems.
  `#${PANEL_ID} tbody tr.hot .oge-sb-name{color:#f4b4ad;}`,
  // Alliance tag — dim by default, LIT when this alliance has more than one
  // prober on you in the window: not "somebody is watching me" but "their
  // alliance is". Dim otherwise, so the lit state keeps its meaning.
  //
  // Metrics and colours copied from the dashboard's shared `allianceTagChip`
  // (features/dashboard/chips.js): a SQUARE 3px chip in amber, not a rounded
  // gold pill. Same element on both surfaces or the parity is only skin-deep.
  `#${PANEL_ID} .oge-sb-tag{margin-left:6px;padding:0 4px;border-radius:3px;`,
  'font:10px Verdana,sans-serif;letter-spacing:.03em;border:1px solid #2a3542;',
  'color:#7f8ea0;white-space:nowrap;}',
  `#${PANEL_ID} .oge-sb-tag.lit{border-color:#e0b45f66;color:#e0b45f;`,
  'background:#e0b45f14;}',
  // The undigested per-alert log, for when the exact sequence matters.
  `#${PANEL_ID} .oge-sb-raw{padding:4px 12px 8px;}`,
  `#${PANEL_ID} .oge-sb-raw summary{cursor:pointer;color:#5f6b76;font-size:11px;`,
  'list-style:none;}',
  `#${PANEL_ID} .oge-sb-raw summary::-webkit-details-marker{display:none;}`,
  `#${PANEL_ID} .oge-sb-raw .body{max-height:320px;overflow-y:auto;}`,
  `#${PANEL_ID} .oge-sb-raw .line{font-size:11px;color:#788;margin-top:3px;`,
  'line-height:1.4;}',
  `#${PANEL_ID}:not(.open) .oge-sb-raw{display:none;}`,
  `#${PANEL_ID} .oge-sb-skull{margin-right:5px;cursor:help;}`,
  `#${PANEL_ID} .oge-sb-age{font:11px/1 monospace;color:#6b7987;white-space:nowrap;}`,
  `#${PANEL_ID} .coord{color:#a9c4de;font:11px/1 monospace;}`,
  // Lunar tint — a MOON body's coords (planet and moon share "g:s:p"; the
  // colour + tooltip is what tells them apart). Same hex as the dashboard's
  // proximity strip.
  `#${PANEL_ID} .coord.moon{color:#c9a9e8;cursor:help;}`,
  `#${PANEL_ID} .muted{color:#4c5763;}`,
  `#${PANEL_ID} .oge-sb-acts{display:flex;gap:6px;justify-content:flex-end;}`,
  `#${PANEL_ID} .oge-sb-btn{font:11px Verdana,sans-serif;color:#93a3b3;cursor:pointer;`,
  'background:#16212c;border:1px solid #26323f;border-radius:5px;padding:3px 9px;white-space:nowrap;}',
  `#${PANEL_ID} .oge-sb-btn:hover{border-color:var(--sp-accent);color:#d8e6f4;background:#1a2534;}`,
  `#${PANEL_ID} .oge-sb-foot{padding:5px 12px;border-top:1px solid #1b2732;font-size:10px;color:#5f6b76;}`,
  `#${PANEL_ID} .oge-sb-foot .k{color:var(--sp-danger);}`,
  // Header coords/names toggle + per-prober distance line (under the name).
  `#${PANEL_ID} .oge-sb-namebtn{margin-left:8px;font:10px Verdana,sans-serif;color:#93a3b3;`,
  'cursor:pointer;background:#16212c;border:1px solid #26323f;border-radius:5px;padding:2px 8px;white-space:nowrap;}',
  `#${PANEL_ID} .oge-sb-namebtn:hover{border-color:var(--sp-accent);color:#d8e6f4;}`,
  // Date-range radio (1d/7d/1m/3m) — a segmented rectangular chip group beside
  // the names toggle. Selected pill wears the gold accent (matches the
  // dashboard's `.chip-group.seg button.on`).
  `#${PANEL_ID} .oge-sb-range{display:inline-flex;margin-left:8px;`,
  'border:1px solid #26323f;border-radius:5px;overflow:hidden;}',
  `#${PANEL_ID} .oge-sb-range button{font:10px Verdana,sans-serif;color:#93a3b3;cursor:pointer;`,
  'background:#16212c;border:0;border-left:1px solid #26323f;padding:2px 7px;white-space:nowrap;}',
  `#${PANEL_ID} .oge-sb-range button:first-child{border-left:0;}`,
  `#${PANEL_ID} .oge-sb-range button:hover{color:#d8e6f4;background:#1a2534;}`,
  `#${PANEL_ID} .oge-sb-range button.on{background:var(--sp-accent);color:#141d27;font-weight:700;}`,
  // Clickable "From" coords — jump to the scanner's system in the galaxy view.
  `#${PANEL_ID} .oge-sb-jump{cursor:pointer;text-decoration:underline dotted transparent;}`,
  `#${PANEL_ID} .oge-sb-jump:hover{color:#d8e6f4;text-decoration-color:var(--sp-accent);}`,
  `#${PANEL_ID} .oge-sb-dist{display:block;margin-top:2px;font:11px/1 monospace;color:#6b7987;}`,
  `#${PANEL_ID} .oge-sb-dist.near{color:#e0b45f;}`,
  `#${PANEL_ID} .oge-sb-dist.hot{color:var(--sp-danger);}`,
].join('');

/**
 * Small createElement helper.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/**
 * Relative age of an epoch-SECONDS timestamp ("12 min ago" / "2 h ago" /
 * "3 d ago"). Empty string when absent.
 * @param {number | null} tsSec
 * @returns {string}
 */
const ageStr = (tsSec) => {
  if (!tsSec) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/**
 * The dashboard's extension URL, resolved once via `browser/chrome.runtime`.
 * Empty string when the WebExtension runtime isn't present (test envs) —
 * {@link openSpyglass} no-ops then. Kept local (a feature must not import
 * another feature); mirrors the resolver in features/dailyRun.
 * @type {string}
 */
const DASHBOARD_URL = (() => {
  try {
    const g = /** @type {any} */ (/** @type {unknown} */ (globalThis));
    const ns = g.browser ?? g.chrome;
    const url = ns?.runtime?.getURL?.('dashboard.html');
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
})();

/**
 * Open the OG-E dashboard on the Spyglass tab, deep-linked to this prober's
 * dossier (`?spy=<pid>` — the dashboard expands + scrolls to the player) and
 * pre-selecting the current universe (`?host=`). A deliberate user tap → one
 * new tab. No-op when the runtime URL is unavailable.
 * @param {number} pid
 * @returns {void}
 */
const openSpyglass = (pid) => {
  if (!DASHBOARD_URL) return;
  const universeId = parseUniverseId(location.host);
  const url = DASHBOARD_URL
    + `?${universeId ? `host=${encodeURIComponent(universeId)}&` : ''}tab=spyglass&spy=${pid}`;
  window.open(url, '_blank');
};

/**
 * Parse a `"g:s:p"` coordinate string into its parts, or null when malformed.
 * @param {string | null | undefined} coords
 * @returns {{ galaxy: number, system: number, position: number } | null}
 */
const parseCoords = (coords) => {
  const m = /^\s*(\d+):(\d+):(\d+)\s*$/.exec(coords ?? '');
  return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null;
};

/**
 * Hover for a prober's nick: the Danger score and the reasons behind it.
 *
 * Deliberately the same sentence the dashboard's `playerHoverTitle` produces —
 * the two surfaces answer the same question and a user who learned one reading
 * should not have to learn a second. Not imported from there because that lives
 * in `features/dashboard/`, and a feature may not import another feature; the
 * wording is the contract, the duplication is four lines.
 *
 * @param {import('../domain/dangerScore.js').DangerProfile | undefined} prof
 * @returns {string}
 */
const dangerHoverTitle = (prof) => {
  if (!prof || typeof prof.danger !== 'number' || !Number.isFinite(prof.danger)) {
    return 'Danger unknown — no public-statistics profile yet.\nClick for the full profile.';
  }
  const reasons = prof.reasons?.length ? `\n${prof.reasons.join('\n')}` : '';
  return `Danger ${prof.danger.toFixed(2)}${reasons}\nClick for the full profile.`;
};

/**
 * Format an epoch-SECONDS scan time as a compact local `YYYY-MM-DD HH:MM`.
 * @param {number} tsSec
 * @returns {string}
 */
const fmtScanTime = (tsSec) => {
  const d = new Date(tsSec * 1000);
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Tooltip for one of OUR scanned bodies: its scan history as newest-first
 * datetimes (one per line). Replaces the old "Moon" label — the lunar tint
 * already marks a moon, so the hover is free to carry the timeline instead.
 * Falls back to the raw coords when no timestamped scan is on record.
 * @param {{ coords: string, scans: number[] }} b
 * @returns {string}
 */
const scanHistoryTitle = (b) =>
  b.scans.length ? b.scans.map(fmtScanTime).join('\n') : b.coords;

/**
 * Jump to `coords`' system in the in-game galaxy view: fast in-page nav when
 * the galaxy form is present, else a full navigation to the galaxy URL. No-op
 * for a malformed coord.
 * @param {string} coords
 * @returns {void}
 */
const jumpToGalaxy = (coords) => {
  const c = parseCoords(coords);
  if (!c) return;
  if (!navigateGalaxyInPage(c.galaxy, c.system)) {
    location.href = ingameComponentUrl(location.href, 'galaxy', {
      galaxy: c.galaxy,
      system: c.system,
      position: c.position,
    });
  }
};

/**
 * The scanner's origin coords as a clickable jump to its system in the galaxy
 * view (same gesture the dashboard dossier offers on a body's coords).
 * @param {string} coords
 * @param {boolean} moon
 * @returns {HTMLElement}
 */
const fromBodyEl = (coords, moon) => {
  const s = el('span', `coord oge-sb-jump${moon ? ' moon' : ''}`, coords);
  s.title = 'Open this system in the galaxy view';
  s.addEventListener('click', () => jumpToGalaxy(coords));
  return s;
};

/**
 * One coord span for our scanned body. Its hover carries the scan history
 * (newest first); the lunar tint alone marks a moon.
 * @param {{ coords: string, moon: boolean, scans: number[] }} b
 * @returns {HTMLElement}
 */
const bodyEl = (b) => {
  const s = el('span', b.moon ? 'coord moon' : 'coord', b.coords);
  s.title = scanHistoryTitle(b);
  return s;
};

/**
 * @typedef {object} RenderCtx
 * @property {boolean} showNames
 * @property {string} range  Active date-range chip value.
 * @property {(coords: string, moon: boolean) => string | null} nameFor
 * @property {(fromCoords: string | null) => { label: string, cls: string } | null} distFor
 * @property {(pid: string) => import('../domain/dangerScore.js').DangerProfile | undefined} profFor
 *   The prober's Danger profile (apiContext handoff, the same join the dashboard
 *   uses). `undefined` before the handoff lands or for a player with no public
 *   statistics — an unknown D is NOT a zero D, so the row falls back to neutral
 *   rather than painting them harmless.
 * @property {(pid: string) => { tag: string, lit: boolean } | null} allyFor
 *   Alliance label for the row, and whether this alliance fielded MORE THAN ONE
 *   prober in the current window.
 */

/**
 * Render one "Near you" body. When the header toggle is on and we own a
 * matching body, show its NAME; otherwise fall back to the coordinate span.
 * Lunar tint either way, and the scan-history hover in both cases.
 * @param {{ coords: string, moon: boolean, scans: number[] }} b
 * @param {RenderCtx} ctx
 * @returns {HTMLElement}
 */
const nearBodyEl = (b, ctx) => {
  if (ctx.showNames) {
    const name = ctx.nameFor(b.coords, b.moon);
    if (name) {
      const s = el('span', b.moon ? 'coord moon' : 'coord', name);
      s.title = scanHistoryTitle(b);
      return s;
    }
  }
  return bodyEl(b);
};

/**
 * Build one prober `<tr>` from a digest entry.
 * @param {import('../domain/proximityDigest.js').ProximityDigestEntry} p
 * @param {RenderCtx} ctx
 * @returns {HTMLElement}
 */
const buildRow = (p, ctx) => {
  const tr = el('tr', p.sameSystem ? 'hot' : undefined);
  const pid = String(p.byPlayerId);
  const prof = ctx.profFor(pid);
  // `--d` drives BOTH the nick colour and the row's left rule (see CSS), so the
  // two can never drift apart. The fallback is the panel's neutral text colour.
  tr.style.setProperty('--d', dangerColor01(prof?.danger, '#d8e6f4'));

  const nameTd = el('td');
  if (p.sameSystem) {
    const skull = el('span', 'oge-sb-skull', '💀');
    skull.title = 'In your system — can strike at moon/RIP speed';
    nameTd.appendChild(skull);
  }
  // The nick is the action here too — it opens the dossier, same as every
  // clickable nick on the dashboard's Spyglass tab. The Spyglass BUTTON in the
  // actions cell stays: on touch a dotted underline is not an obvious target.
  const who = el('span', 'oge-sb-name', p.name || `#${pid}`);
  who.title = dangerHoverTitle(prof);
  who.addEventListener('click', () => openSpyglass(p.byPlayerId));
  nameTd.appendChild(who);
  const ally = ctx.allyFor(pid);
  if (ally && ally.tag) {
    const chip = el('span', `oge-sb-tag${ally.lit ? ' lit' : ''}`, ally.tag);
    chip.title = ally.lit
      ? 'More than one player from this alliance probed you in this window'
      : 'Alliance';
    nameTd.appendChild(chip);
  }
  // Distance from this prober's origin to our nearest body — its OWN line under
  // the name (0 sys = in-empire strike range; the colour carries the severity).
  const dist = ctx.distFor(p.fromCoords);
  if (dist) nameTd.appendChild(el('div', `oge-sb-dist${dist.cls ? ` ${dist.cls}` : ''}`, dist.label));
  tr.appendChild(nameTd);

  tr.appendChild(el('td', 'oge-sb-age', ageStr(p.lastTs) || '—'));
  tr.appendChild(el('td', 'num', String(p.count)));

  const fromTd = el('td');
  fromTd.appendChild(
    p.fromCoords ? fromBodyEl(p.fromCoords, p.fromMoon) : el('span', 'muted', '—'));
  tr.appendChild(fromTd);

  const nearTd = el('td');
  if (p.atBodies.length) {
    p.atBodies.forEach((b, i) => {
      if (i) nearTd.appendChild(el('span', 'coord', ', '));
      nearTd.appendChild(nearBodyEl(b, ctx));
    });
  } else {
    nearTd.appendChild(el('span', 'muted', '—'));
  }
  tr.appendChild(nearTd);

  // One action: jump to this prober's full dossier in the dashboard's Spyglass
  // tab (which owns the watch/scan tooling — no point duplicating a
  // thinner copy of it here).
  const actTd = el('td');
  const acts = el('div', 'oge-sb-acts');
  // Deliberately NO watch toggle here. Starring somebody changes what the
  // Spyglass FAB proposes and what the dashboard's tables hold — none of which
  // is on screen on the messages page, so the button's effect would be
  // invisible at the moment of pressing it. The one action this panel offers is
  // the jump to the dossier, which is also where watching belongs.
  const dossierBtn = el('button', 'oge-sb-btn', 'Spyglass');
  dossierBtn.title = "Open this player's profile in the OG-E dashboard (Spyglass tab)";
  dossierBtn.addEventListener('click', () => openSpyglass(p.byPlayerId));
  acts.appendChild(dossierBtn);
  actTd.appendChild(acts);
  tr.appendChild(actTd);

  return tr;
};

/**
 * Build the empty panel shell (header strip + table skeleton + footnote slot).
 * `renderInto` fills it.
 * @param {() => void} onToggleNames  Header coords↔names toggle handler.
 * @param {(value: string) => void} onRange  Date-range chip handler.
 * @returns {HTMLElement}
 */
const buildShell = (onToggleNames, onRange) => {
  const panel = el('div');
  panel.id = PANEL_ID;

  const hdr = el('div', 'oge-sb-hdr');
  // The whole header strip is the fold toggle. The two control clusters inside it
  // (Coords/Names, the range chips) stop propagation so using them never folds
  // the panel under the user's finger.
  hdr.title = 'Click to fold / unfold';
  hdr.addEventListener('click', () => {
    panel.classList.toggle('open');
    // Unfolding is reading: mark the newest alert on screen as seen, so the edge
    // drops back to gold and stays there until something genuinely newer lands.
    if (panel.classList.contains('open')) markSeen(panel);
  });
  hdr.appendChild(el('span', 'oge-sb-caret'));
  const eye = el('span', 'oge-sb-eye');
  eye.setAttribute('aria-hidden', 'true');
  eye.appendChild(parseSvg(
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false">${EYE_GLYPH}</svg>`));
  hdr.appendChild(eye);
  hdr.appendChild(el('span', 'oge-sb-title', "Who's spying on you"));
  const nameBtn = el('button', 'oge-sb-namebtn');
  nameBtn.setAttribute('type', 'button');
  nameBtn.title = 'Coords / names';
  nameBtn.addEventListener('click', (ev) => { ev.stopPropagation(); onToggleNames(); });
  hdr.appendChild(nameBtn);
  // Date-range radio chips (1d/7d/1m/3m) — filter probers by how recently they
  // last scanned you. `renderInto` marks the active one.
  const rangeGroup = el('div', 'oge-sb-range');
  rangeGroup.title = 'Show probers seen within this window';
  rangeGroup.addEventListener('click', (ev) => ev.stopPropagation());
  for (const [value, label] of RANGES) {
    const b = el('button', undefined, label);
    b.setAttribute('type', 'button');
    b.dataset.range = value;
    b.addEventListener('click', () => onRange(value));
    rangeGroup.appendChild(b);
  }
  hdr.appendChild(rangeGroup);
  hdr.appendChild(el('span', 'oge-sb-sum'));
  panel.appendChild(hdr);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = el('tr');
  /** @type {Array<[string, string]>} label + optional class */
  const cols = [
    ['Prober', ''], ['Seen', ''], ['Alerts', 'num'], ['From', ''], ['Near you', ''], ['', ''],
  ];
  for (const [label, cls] of cols) {
    const th = document.createElement('th');
    if (cls) th.className = cls;
    th.textContent = label;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  table.appendChild(document.createElement('tbody'));
  panel.appendChild(table);

  panel.appendChild(el('div', 'oge-sb-foot'));
  // The undigested per-alert log — the dashboard strip's `show raw log` details,
  // for when the exact sequence matters rather than the per-prober rollup.
  // Collapsed by default and hidden entirely while the panel is folded.
  const raw = document.createElement('details');
  raw.className = 'oge-sb-raw';
  raw.appendChild(document.createElement('summary'));
  raw.appendChild(el('div', 'body'));
  panel.appendChild(raw);
  return panel;
};

/**
 * Remember the newest alert the panel currently holds as SEEN — the read-marker
 * behind the fold's red/gold edge (settings.spySeenTs). Stamped when the user
 * unfolds the panel, which is the moment the news is actually on screen.
 * @param {HTMLElement} panel
 * @returns {void}
 */
const markSeen = (panel) => {
  const ts = Number(panel.dataset.lastTs) || 0;
  if (ts > (settingsStore.get().spySeenTs || 0)) {
    settingsStore.set({ ...settingsStore.get(), spySeenTs: ts });
  }
};

/**
 * Paint the summary line, rows, footnote and raw log from a digest.
 * @param {HTMLElement} panel
 * @param {ReturnType<typeof digestProximityReports>} digest
 * @param {RenderCtx} ctx
 * @param {import('../domain/espionageReport.js').ProximityReport[]} reports
 *   The SAME window-filtered list the digest was built from — the raw log must
 *   never disagree with the rollup above it.
 * @returns {void}
 */
const renderInto = (panel, digest, ctx, reports) => {
  // Fold state. "New" = an alert newer than the one this panel last showed
  // (settings.spySeenTs): red edge + unfolded, so the user reads it and the edge
  // returns to the spy gold. Nothing new = folded, gold, one header line. A
  // manual fold is never overridden — `open` is only ever ADDED here.
  const lastTs = Number(digest.lastTs) || 0;
  panel.dataset.lastTs = String(lastTs);
  if (lastTs > 0 && lastTs > (settingsStore.get().spySeenTs || 0)) {
    // Stamp the marker straight away so the panel never re-nags on a later visit,
    // but latch the RED on this panel instance: the messages page repaints on its
    // own churn, and an edge that flicked back to gold mid-visit would hide the
    // very alert it just announced. A page load builds a new panel → new latch.
    panel.dataset.wasNew = '1';
    panel.classList.add('open');
    markSeen(panel);
  }
  panel.classList.toggle('hot', panel.dataset.wasNew === '1');
  const nb = panel.querySelector('.oge-sb-namebtn');
  if (nb) nb.textContent = ctx.showNames ? 'Names' : 'Coords';
  for (const b of panel.querySelectorAll('.oge-sb-range button')) {
    b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.range === ctx.range);
  }
  const sum = panel.querySelector('.oge-sb-sum');
  if (sum) {
    sum.textContent = '';
    const pc = el('b', undefined, String(digest.playerCount));
    sum.appendChild(pc);
    sum.appendChild(document.createTextNode(` prober${digest.playerCount === 1 ? '' : 's'} · `));
    sum.appendChild(el('b', undefined, String(digest.totalReports)));
    sum.appendChild(document.createTextNode(` alert${digest.totalReports === 1 ? '' : 's'}`));
    if (digest.sameSystemCount > 0) {
      sum.appendChild(document.createTextNode(' · '));
      sum.appendChild(el('span', 'hot', `${digest.sameSystemCount} in your system`));
    }
  }

  const tbody = panel.querySelector('tbody');
  if (tbody) {
    tbody.textContent = '';
    for (const p of digest.players.slice(0, MAX_ROWS)) tbody.appendChild(buildRow(p, ctx));
  }

  // Footnote only when there's actually a 💀 to explain — no same-system prober
  // ⇒ no legend (a legend for a glyph that isn't on screen is pure clutter).
  const foot = /** @type {HTMLElement | null} */ (panel.querySelector('.oge-sb-foot'));
  if (foot) {
    foot.textContent = '';
    if (digest.sameSystemCount > 0) {
      foot.appendChild(el('span', 'k', '💀'));
      foot.appendChild(document.createTextNode(
        ' = a scout with a body in your system — can strike at moon/RIP speed. From alerts you opened.'));
      foot.style.display = '';
    } else {
      foot.style.display = 'none';
    }
  }

  // Raw log — one line per alert, newest first, exactly the dashboard's wording:
  // `<prober> · near <our body> · <age> ago · from <their body>`.
  //
  // `near` is one of OUR bodies, so it follows the Coords/Names switch like every
  // other own-body coord in the panel — it used to render raw coordinates always,
  // which left the log speaking a different language than the table above it the
  // moment the switch said Names. `from` is THEIR body: we hold no name for it,
  // so it stays a coordinate in both modes.
  const raw = /** @type {HTMLElement | null} */ (panel.querySelector('.oge-sb-raw'));
  const rawSum = raw?.querySelector('summary');
  const rawBody = raw?.querySelector('.body');
  if (raw && rawSum && rawBody) {
    const n = digest.totalReports;
    rawSum.textContent = `show raw log (${n} ${n === 1 ? 'alert' : 'alerts'}) ▸`;
    rawBody.textContent = '';
    for (const r of reports) {
      const line = el('div', 'line');
      line.appendChild(document.createTextNode(`${r.byPlayerName || `#${r.byPlayerId}`} · near `));
      line.appendChild(nearBodyEl({ coords: r.atCoords, moon: r.atPlanetType === 3, scans: [] }, ctx));
      const age = ageStr(r.ts ?? null);
      if (age) line.appendChild(document.createTextNode(` · ${age}`));
      if (r.fromCoords) {
        line.appendChild(document.createTextNode(' · from '));
        line.appendChild(bodyEl({ coords: r.fromCoords, moon: r.fromPlanetType === 3, scans: [] }));
      }
      rawBody.appendChild(line);
    }
    raw.style.display = n > 0 ? '' : 'none';
  }
};

/** Last painted render signature — skips no-op rebuilds on idle <body> churn. */
let lastSig = '';

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Install the Who's-spying-on-you table. Idempotent — a second call returns the
 * same dispose fn. No-op until the messages page's spy-report tab is open (the
 * observer picks up AGR's `#agoSpyReportOverview` when it appears).
 * @returns {() => void}
 */
export const installWhosSpyingPanel = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);

  /**
   * alliances.xml rows (id → {name, tag}) from the device cache, for the row's
   * `[TAG]` chip. Read ONCE per install, asynchronously: the feed refreshes on a
   * daily cadence, so a value cached at mount is as current as anything we could
   * re-read per repaint, and this keeps the render path synchronous. Empty until
   * the read lands (and on a cold cache) — the chip is simply not drawn then.
   * @type {Record<string, { name?: string, tag?: string }>}
   */
  let alliancesById = {};
  void readApiCache().then((cache) => {
    if (!installed) return;
    alliancesById = cache?.alliances?.alliances ?? {};
    refresh({ force: true });
  });

  /**
   * Mount/remove + repaint the table to match the current tab + digest. Cheap
   * on the common "nothing to do / unchanged" paths so it's safe on every
   * <body> mutation: bails immediately off the spy tab, and a render signature
   * skips the rebuild when the digest hasn't moved.
   * @param {{ force?: boolean }} [opts] force ⇒ repaint even if unchanged (age refresh).
   * @returns {void}
   */
  const refresh = ({ force = false } = {}) => {
    let panel = document.getElementById(PANEL_ID);
    // Display opt-out — the panel is ON by default but can be hidden from the
    // in-game "Display" settings section; a flip lands here via the settings
    // subscription below and removes the table.
    if (!settingsStore.get().showWhosSpying) {
      if (panel) panel.remove();
      lastSig = '';
      return;
    }
    const reports = proximityReportsStore.get();
    // Empty log first — a cheap store read before any DOM queries.
    if (reports.length === 0) {
      if (panel) panel.remove();
      lastSig = '';
      return;
    }
    const slot = resolveSlot();
    if (!slot) {
      if (panel) panel.remove();
      lastSig = '';
      return;
    }
    // Date-range filter: keep alerts within the selected window (ts-less alerts
    // can't be aged, so they stay). Applied before the digest so the counts,
    // sort and scan-history hover all reflect the chosen window.
    const range = currentRange();
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = RANGES.find(([v]) => v === range)?.[2] ?? 0;
    const filtered = windowSec
      ? reports.filter((r) => !r.ts || r.ts >= nowSec - windowSec)
      : reports;
    const digest = digestProximityReports(filtered);
    if (!panel) {
      panel = buildShell(onToggleNames, onRange);
      lastSig = '';
    }
    // Keep it glued in the slot — AGR may have re-injected its overview, and a
    // holder re-render both drops our panel and mints a new first message (the
    // observer lands here again either way).
    if (panel.parentNode !== slot.parent || panel.nextElementSibling !== slot.before) {
      slot.parent.insertBefore(panel, slot.before);
    }
    // Our owned bodies feed the names toggle + distance chips; capturedAt goes
    // into the render signature so a fresh planet-bar capture repaints.
    const inv = bodiesStore.get();
    const nameMap = bodyNameIndex(inv.bodies);
    // Danger profiles ride the apiContext handoff — the SAME join the dashboard
    // reads, so the two surfaces cannot disagree about a player's D.
    const dangerMap = getApiContext()?.danger;
    /** @param {string} pid */
    const profFor = (pid) => dangerMap?.get(Number(pid));
    // Alliances fielding TWO OR MORE distinct probers in this window: one member
    // scanning you is a player looking at you; three members of one tag is that
    // ALLIANCE looking at you, and that changes who you expect over the horizon.
    // Counted per PLAYER — one prober flying twenty probes is still one player.
    /** @type {Map<string, number>} allianceId → distinct prober count */
    const allyCounts = new Map();
    for (const p of digest.players) {
      const aid = profFor(String(p.byPlayerId))?.allianceId;
      if (aid) allyCounts.set(aid, (allyCounts.get(aid) ?? 0) + 1);
    }
    /** @type {RenderCtx} */
    const ctx = {
      showNames,
      range,
      nameFor: (coords, moon) => bodyNameFor(nameMap, coords, moon),
      distFor: (fromCoords) =>
        nearestBodyDistance(fromCoords, inv.bodies, getApiContext()?.server ?? {}),
      profFor,
      allyFor: (pid) => {
        const aid = profFor(pid)?.allianceId;
        if (!aid) return null;
        // `alliancesById` is filled asynchronously from the device cache; before
        // it lands we simply render no chip rather than a placeholder.
        const a = alliancesById[aid];
        const tag = (a && (a.tag || a.name)) || '';
        return tag ? { tag, lit: (allyCounts.get(aid) ?? 0) > 1 } : null;
      },
    };
    const shown = digest.players.slice(0, MAX_ROWS);
    const sig = `${digest.playerCount}|${digest.totalReports}|${digest.sameSystemCount}`
      + `|${showNames ? 'n' : 'c'}|${range}|${inv.capturedAt}|`
      + shown.map((p) => `${p.byPlayerId}:${p.count}:${p.lastTs}`).join(',');
    if (force || sig !== lastSig) {
      renderInto(panel, digest, ctx, filtered);
      lastSig = sig;
    }
  };

  /**
   * Header toggle: flip the "Near you" column between coordinates and our body
   * names, persist the choice per device, and force a repaint.
   * @returns {void}
   */
  const onToggleNames = () => {
    showNames = !showNames;
    safeLS.set(NAMES_KEY, showNames ? '1' : '0');
    refresh({ force: true });
  };

  /**
   * Date-range chip: narrow the prober list to alerts within `value`'s window.
   * Writes `settingsStore.spyRange` — shared with the dashboard strip and synced
   * across devices; the settings subscription below repaints. Re-selecting the
   * active chip is a no-op.
   * @param {string} value
   * @returns {void}
   */
  const onRange = (value) => {
    if (value === currentRange() || !RANGES.some(([v]) => v === value)) return;
    settingsStore.set({ ...settingsStore.get(), spyRange: value });
  };

  refresh();

  const observer = new MutationObserver(() => refresh());
  observer.observe(document.body, { childList: true, subtree: true });

  // A landed alert repaints the digest; the slow poll refreshes relative ages
  // (and re-mounts as a backstop if a mutation was missed). A Display-settings
  // flip shows/hides the whole panel; a fresh planet-bar capture refreshes the
  // names + distance chips.
  const unsub = proximityReportsStore.subscribe(() => refresh());
  const unsubPoll = clock.subscribe(() => refresh({ force: true }), { everyMs: POLL_MS });
  const unsubSettings = settingsStore.subscribe(() => refresh());
  const unsubBodies = bodiesStore.subscribe(() => refresh());

  installed = {
    dispose: () => {
      observer.disconnect();
      unsub();
      unsubPoll();
      unsubSettings();
      unsubBodies();
      const live = document.getElementById(PANEL_ID);
      if (live) live.remove();
      const style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
      lastSig = '';
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset.
 * @returns {void}
 */
export const _resetWhosSpyingPanelForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
  lastSig = '';
};
