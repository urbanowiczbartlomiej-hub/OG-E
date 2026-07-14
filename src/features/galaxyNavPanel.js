// @ts-check

// Galaxy touch nav — a finger-sized mirror of the galaxy header's controls,
// mounted BELOW the system table (right under the "N planets colonized"
// footer row).
//
// # Problem
//
// OGame's galaxy page is a fixed desktop layout; on a phone the header's
// galaxy/system inputs, prev/next arrows and the Start / phalanx / spy /
// discovery buttons render ~16 px tall — unusable without zooming to the very
// top of the page, navigating, then panning back down to the rows you were
// watching. Watching a system on mobile means constant pinch-and-pan between
// the table and the tiny header.
//
// # Solution
//
// Mirror the header controls in an OG-E panel directly below the table, with
// ~50 px touch targets:
//
//   row 1  [Phalanx]  [Spy]  [Discovery]
//   row 2  Galaxy [−][input][+]   [Start]   System [−][input][+]
//
// The [−]/[+] steppers are the workhorse controls (one-tap system hops), so
// they get the tallest targets and the row's edges (thumb-reachable); [Start]
// is the rarer jump-to-typed-coords action — deliberately smaller, centered
// in the leftover space between the steppers.
//
// The panel PROXIES the game's own controls instead of re-implementing them:
//
//   • [−]/[+] first push any pending panel edits into the native inputs, then
//     click the game's own arrow spans (the siblings of `#galaxy_input` /
//     `#system_input`), so system wrap-around, galaxy-switch deuterium costs
//     and every other game rule stay the game's. If the arrows are ever
//     missing, a fallback does ±1 via `navigateGalaxyInPage` (clamped).
//   • [Start] = `navigateGalaxyInPage(panel values)` — the shared helper that
//     fills the native inputs and clicks the native submit. Enter in either
//     panel input does the same.
//   • [Phalanx] / [Spy] / [Discovery] click the native header buttons
//     (`.phalanxlink`, `.spysystemlink`, `#discoverSystemBtn` or AGR's
//     `#ago_discovery` — whichever is visible). Their `disabled` attribute is
//     mirrored onto the panel buttons, so "phalanx unavailable on this body"
//     reads the same at the bottom as at the top.
//
// Every panel button also STOPS the trusted click's propagation: the game
// closes all open jQuery-UI overlays on any click that bubbles to <html>
// outside a dialog (initHideElements), so only the NESTED click we dispatch
// on the native control — which replays the native chain, its propagation
// stops included — may reach the page. Without this, the trusted click
// resumed bubbling after the nested one opened the phalanx dialog and
// instantly closed it, orphaning the game's one-shot overlay token (see
// mkButton for the full failure chain).
//
// A MutationObserver on `#galaxyContent` (the node the game AJAX-rerenders on
// every navigation) re-syncs the panel inputs + button states after each
// system change; `input`/`change` listeners on the native header inputs cover
// typing up top. Sync never clobbers a panel input the user is focused in.
// The panel itself lives OUTSIDE `#galaxyContent` (inserted after it), so a
// re-render can't wipe it and the observer can't see our own writes — but if
// some aggressive update DOES detach it, the sync pass re-inserts it.
//
// While the panel is mounted, the ORIGINAL `#galaxyHeader` form is hidden —
// two nav bars for one table is clutter. Its controls stay in the DOM and
// keep working: hidden elements still dispatch/handle click events and hold
// the input values the game reads and writes, so every proxy above is
// unaffected. The hide rule lives in the panel's own stylesheet, so
// unmounting (toggle off / dispose) restores the native bar in the same
// stroke.
//
// The stylesheet also PINS ROW 16's height (the expedition-debris slot):
// AGR's stacked debris readout made that row ~50px taller on systems with
// expo debris, so the whole table — and this panel under it — jumped between
// taps while stepping through systems. See the CSS block for the layout
// rebuild (one-line debris strip + constant min-height). The strip's labels
// are additionally compacted in JS ("Metal: 1.388.400" → "M 1.388.400" —
// see compactDebrisReadout), because CSS cannot shorten text and AGR's full
// locale labels are what overflowed the column in the first place.
//
// Row pins alone can't cover every source of per-system height variance
// (galaxy rows are min-height only — long player/alliance names wrap, debris
// cells appear, an event-planet row may exist), so the sync pass also
// RATCHETS `#galaxyContent`'s min-height up to the tallest layout seen this
// page load. After the first taller-than-before system the panel's position
// is frozen for good; the reserve resets on window resize (wrap points move)
// and clears on unmount.
//
// # Toggle
//
// Gated on `settings.readabilityBoost` — the same "Readability" tile that
// covers the event box + fleet movement link (this is the third mobile
// readability fix under that umbrella). Toggling off removes the panel and
// its stylesheet immediately; on re-mounts. Galaxy pages only (the component
// can't change without a full page load, so the URL is checked once at
// install).

import { injectStyle } from '../lib/dom.js';
import { createVisibilityObserver } from '../lib/visibilityObserver.js';
import { debounce } from '../lib/debounce.js';
import { settingsStore } from '../state/settings.js';
import { GAME } from '../lib/gameDom.js';
import { navigateGalaxyInPage } from './shared/galaxyNav.js';

/** Panel root id (OG-E's own surface, not a game contract). */
export const GNAV_PANEL_ID = 'oge-gnav';
/** Id of the singleton <style> element this module injects. */
const STYLE_ID = 'oge-gnav-style';

// Game selectors read by THIS feature only — kept local per the gameDom.js
// rule (only 2+-feature selectors are centralized). `#galaxy_input` /
// `#system_input` / the submit button ARE shared and come from GAME.*.
/** The container the game AJAX-rerenders on every system navigation. */
const GALAXY_CONTENT_ID = 'galaxyContent';
/** System-wide phalanx button in the galaxy header (alliance-class gated). */
const PHALANX_LINK = '#galaxyHeader .phalanxlink';
/** System-wide espionage button in the galaxy header (alliance-class gated). */
const SPY_SYSTEM_LINK = '#galaxyHeader .spysystemlink';
/**
 * The two shells of the "Discovery" (system-wide lifeform discovery) button:
 * the game's own and AGR's replacement. Exactly one is visible at a time —
 * the click resolver picks the displayed one.
 */
const DISCOVERY_IDS = ['discoverSystemBtn', 'ago_discovery'];
/** Native arrow spans flanking the header inputs carry this class. */
const ARROW_CLASS = 'galaxy_icons';

// Fallback clamps, used ONLY when the native arrows are missing (the game
// knows the universe's real maxima; we don't — they live in MAIN-world vars).
const GALAXY_MAX = 9;
const SYSTEM_MAX = 499;

/** Observer debounce — one sync per AJAX re-render burst. */
const SYNC_DEBOUNCE_MS = 100;

/**
 * Panel stylesheet. OG-E's own dark surface (same palette as the readability
 * event-box card: near-black panel, #272b36 border, teal accent), with the
 * cross-device Roboto/Arial font pin the other readability fixes use. Touch
 * specifics: ≥44 px targets, `touch-action: manipulation` (no double-tap-zoom
 * delay on a pinch-zoomable page), no number-input spinners (the big −/+
 * buttons replace them).
 */
const CSS = `/* OG-E: galaxy touch nav (bottom mirror of the header controls) */
#${GNAV_PANEL_ID} {
  box-sizing: border-box;
  margin: 10px 0 16px;
  padding: 10px 10px 12px;
  background: rgba(15, 20, 26, 0.62);
  border: 1px solid rgb(39, 43, 54);
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(1, 1, 1, 0.8);
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: Roboto, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
#${GNAV_PANEL_ID} * { box-sizing: border-box; }
#${GNAV_PANEL_ID} .oge-gnav-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
/* Nav row: steppers pinned to the edges, Start floating between them —
   space-between soaks up the leftover width instead of a dead right gutter. */
#${GNAV_PANEL_ID} .oge-gnav-nav { justify-content: space-between; }
#${GNAV_PANEL_ID} .oge-gnav-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
#${GNAV_PANEL_ID} .oge-gnav-cap {
  color: #8fa3b8;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  text-align: center;
}
#${GNAV_PANEL_ID} .oge-gnav-stepper { display: flex; gap: 6px; }
#${GNAV_PANEL_ID} .oge-gnav-btn {
  appearance: none;
  border: 1px solid #38414f;
  border-radius: 5px;
  background: linear-gradient(180deg, #222a36, #141922);
  color: #cfd8e3;
  font: 700 18px/1 Roboto, Arial, sans-serif;
  height: 54px;
  min-width: 56px;
  padding: 0 10px;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
#${GNAV_PANEL_ID} .oge-gnav-btn:active { filter: brightness(1.45); }
#${GNAV_PANEL_ID} .oge-gnav-btn:focus-visible {
  outline: 2px solid #40c4c1;
  outline-offset: 1px;
}
#${GNAV_PANEL_ID} .oge-gnav-btn:disabled { opacity: 0.35; cursor: default; }
#${GNAV_PANEL_ID} .oge-gnav-step { font-size: 28px; padding: 0; }
#${GNAV_PANEL_ID} .oge-gnav-input {
  appearance: textfield;
  -moz-appearance: textfield;
  width: 82px;
  height: 54px;
  border: 1px solid #38414f;
  border-radius: 5px;
  background: #0a0e13;
  color: #fff;
  font: 700 22px/1 Roboto, Arial, sans-serif;
  text-align: center;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}
#${GNAV_PANEL_ID} .oge-gnav-input::-webkit-outer-spin-button,
#${GNAV_PANEL_ID} .oge-gnav-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
#${GNAV_PANEL_ID} .oge-gnav-input:focus-visible {
  outline: 2px solid #40c4c1;
  outline-offset: 1px;
}
#${GNAV_PANEL_ID} .oge-gnav-start {
  flex: 0 0 auto;
  height: 46px;
  padding: 0 14px;
  font-size: 15px;
  border-color: #2f7c79;
  background: linear-gradient(180deg, #123c3b, #0b2827);
  color: #40c4c1;
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
#${GNAV_PANEL_ID} .oge-gnav-action {
  flex: 1 1 0;
  height: 50px;
  font-size: 15px;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: #9fb3c8;
  padding: 0 6px;
  white-space: nowrap;
}
/* The panel replaces the native header form outright — hide it while the
   panel is up. The hidden controls keep WORKING (our buttons proxy-click
   them; hidden elements still handle click events and hold the input values
   the game reads/writes). This stylesheet is removed on unmount, which
   brings the native bar back. */
#galaxyHeader { display: none !important; }

/* ===== Row 16 (expedition debris slot): pin the height + OG-E restyle =====
   The game lays the slot box out as [title 38%][debris 9%, column][actions
   53%] with min-height 41px; AGR stacks the expo-debris readout (Metal /
   Kryształ / Pioniery / Zredukuj) as a 4-line column inside that narrow 9%
   cell, so the row grows ~50px on systems that HAVE expedition debris — and
   this panel below the table jumps under the finger while stepping through
   systems. Rebuild the slot into two fixed bands: title + expedition
   controls on band one, the debris readout as a full-width ONE-LINE strip
   on band two (nothing hidden — every figure stays inline), and a constant
   box min-height so the row measures the same with or without debris.
   While at it, dress the slot in the panel's own chrome: caps-label title,
   the panel's button look on Ekspedycja / Wyślij / Zredukuj (proper touch
   targets), muted readout typography. AGR's inline background tint (its
   red/green expo-slot state signal) is deliberately NOT overridden.
   Selectors mirror the game's own id+class chains so the overrides outrank
   them. */
#galaxyContent .expeditionDebrisSlotBox {
  flex-wrap: wrap !important;
  min-height: 84px !important;
  align-items: center !important;
  border-radius: 6px !important;
  font-family: Roboto, Arial, sans-serif !important;
}
/* Title wrapper + heading: drop the fixed 38%/205px widths (they forced the
   template button's label to wrap mid-word) and render the heading as the
   panel's caps label instead of the glowing game-blue h3. */
#galaxyContent .expeditionDebrisSlotBox > div:first-child {
  width: auto !important;
  flex: 0 0 auto !important;
}
#galaxyContent .expeditionDebrisSlotBox .title {
  width: auto !important;
  margin: 0 !important;
  padding: 0 4px !important;
  color: #8fa3b8 !important;
  font: 700 11px/1.3 Roboto, Arial, sans-serif !important;
  text-transform: uppercase !important;
  letter-spacing: 0.8px !important;
  text-shadow: none !important;
}
/* Expedition controls: right-aligned band, no mid-word wraps. */
#galaxyContent .expeditionDebrisSlotBox > div#expeditionDebrisSlotActions {
  width: auto !important;
  flex: 1 1 auto !important;
  justify-content: flex-end !important;
  align-items: center !important;
  gap: 8px !important;
}
#galaxyContent #galaxyExpeditionFleetTemplateContainer,
#galaxyContent #expeditionFleetTemplateBtn {
  white-space: nowrap;
}
#galaxyContent #expeditionbutton,
#galaxyContent #sendExpeditionFleetTemplateFleet {
  box-sizing: border-box !important;
  /* NO !important on display: the game swaps Ekspedycja <-> Wyślij via an
     inline display:none (template select change), and forcing display here
     would show BOTH buttons at once. jQuery's .show() clears the inline
     value, so the visible one still picks up this flex display from the
     stylesheet. */
  display: inline-flex;
  align-items: center !important;
  justify-content: center !important;
  /* Fixed width: the game swaps Ekspedycja <-> Wyślij in place, and letting
     each size to its label made the whole actions band shift on every
     template-select change. Sized to the longer PL label with headroom.
     Hard-pinned (!important, border-box) to stay pixel-identical with the
     Zredukuj chip docked right below. */
  width: 132px !important;
  height: 34px;
  padding: 0 !important;
  /* Same slate chrome as the Zredukuj chip below — one quiet button family
     for the whole slot instead of a teal accent competing with the panel's
     Start. */
  border: 1px solid #38414f !important;
  border-radius: 5px !important;
  background: linear-gradient(180deg, #222a36, #141922) !important;
  color: #9fb3c8 !important;
  font: 700 13px/1 Roboto, Arial, sans-serif !important;
  text-transform: uppercase !important;
  letter-spacing: 0.8px !important;
  touch-action: manipulation;
}
/* Both buttons carry a sprite icon as an absolutely-positioned ::before
   (a cursor glyph / ship icon); inside the restyled fixed-width button it
   floats over the centered label. Decorative glyphs are against the OG-E
   wording rules anyway — drop them, the labels carry the meaning. */
#galaxyContent #expeditionbutton::before,
#galaxyContent #sendExpeditionFleetTemplateFleet::before {
  content: none !important;
}
/* Debris strip: full-width one-liner under the controls. */
#galaxyContent .expeditionDebrisSlotBox > div#expeditionDebrisSlotDebrisContainer {
  flex-direction: row !important;
  width: 100% !important;
  order: 3;
  justify-content: flex-start !important;
  align-items: center !important;
  min-height: 34px;
}
#galaxyContent .expeditionDebrisSlotBox #expeditionDebris {
  display: flex !important;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  float: none !important;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
}
/* The readout fits the column OUTRIGHT — no scroll container here (an
   earlier overflow-x attempt clipped vertically and painted a scrollbar
   across the chip) and no wrap in practice: compactDebrisReadout() shortens
   AGR's locale labels in JS (Metal → M …), which is what actually makes
   14px text fit with room to spare. flex-wrap stays as a pathological
   fallback only — if some exotic system still overflowed, it wraps cleanly
   (the chip's li is in normal flow) and the height ratchet absorbs it. */
#galaxyContent .expeditionDebrisSlotBox .ago_expo_df {
  display: flex !important;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 12px;
  margin: 0 !important;
  padding: 0 !important;
  list-style: none;
  /* Kill any AGR grid sizing (fixed ul/li column widths) — items take
     their natural width. */
  width: auto !important;
  max-width: none !important;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  color: #cfd8e3;
  font-variant-numeric: tabular-nums;
}
#galaxyContent .expeditionDebrisSlotBox .ago_expo_df li {
  margin: 0 !important;
  padding: 0 !important;
  white-space: nowrap;
  width: auto !important;
  /* Sizing must sit ON the li: AGR styles the items directly, and a direct
     rule beats anything inherited from our ul-level font bump. */
  font-size: 14px !important;
  line-height: 1.3 !important;
  color: #cfd8e3 !important;
  font-variant-numeric: tabular-nums;
}
/* Steady columns: reserve a constant slot per readout item so value-length
   differences between systems don't shuffle the strip horizontally. The
   action li (last) is exempt — it docks right. */
#galaxyContent .expeditionDebrisSlotBox .ago_expo_df > li:not(:last-child) {
  min-width: 104px;
}
/* The action chip docks at the RIGHT edge of the strip, directly under the
   Ekspedycja button above it. AGR appends its li last, so a margin-left:auto
   flexbox push does the job without touching AGR's DOM. The li is itself a
   flex box: as an inline-level box on the li's text baseline the 28px chip
   painted a few px BELOW the line box (and so past the slot's bottom edge) —
   flex layout takes the anchor out of the baseline game entirely. */
#galaxyContent .expeditionDebrisSlotBox .ago_expo_df li:last-child {
  margin-left: auto !important;
  display: inline-flex;
  align-items: center;
}
/* "Zredukuj" is a real fleet action — give it the panel's slate button
   chrome and a tappable box instead of an 11px text link. */
#galaxyContent .expeditionDebrisSlotBox .ago_expo_df li a {
  display: inline-flex;
  align-items: center;
  /* AGR floats/positions this link — that collapsed its li's line height and
     let wrapped text render THROUGH the chip. Back into normal flow. */
  float: none !important;
  position: static !important;
  vertical-align: middle;
  height: 28px;
  /* Same fixed width as Ekspedycja/Wyślij right above — the two right-docked
     buttons read as one aligned column. Hard-pinned like its sibling so no
     AGR width/box-model rule can stretch it wider. */
  width: 132px !important;
  justify-content: center;
  padding: 0 !important;
  box-sizing: border-box !important;
  border: 1px solid #38414f;
  border-radius: 5px;
  background: linear-gradient(180deg, #222a36, #141922);
  color: #9fb3c8 !important;
  font: 700 12px/1 Roboto, Arial, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  text-decoration: none !important;
  touch-action: manipulation;
}
`;

/** @returns {boolean} True on the galaxy component (checked once — the component can't change without a full page load). */
const isGalaxyPage = () => location.search.includes('component=galaxy');

/**
 * @param {string} raw
 * @returns {number | null} Base-10 integer, or null when unparseable.
 */
const readInt = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const clampInt = (n, min, max) => Math.min(max, Math.max(min, n));

/** @returns {HTMLInputElement | null} */
const nativeGalaxyInput = () =>
  /** @type {HTMLInputElement | null} */ (document.querySelector(GAME.GALAXY_INPUT));

/** @returns {HTMLInputElement | null} */
const nativeSystemInput = () =>
  /** @type {HTMLInputElement | null} */ (document.querySelector(GAME.SYSTEM_INPUT));

/**
 * The game's own prev/next arrow span for a header input — they flank the
 * input directly (`<span class="galaxy_icons prev"><input><span … next>`),
 * so sibling position IS the direction. Locale- and handler-agnostic: we
 * never parse the inline onclick, just click what the user would.
 *
 * @param {HTMLInputElement | null} input
 * @param {-1 | 1} dir
 * @returns {HTMLElement | null}
 */
const nativeArrow = (input, dir) => {
  const el = dir < 0 ? input?.previousElementSibling : input?.nextElementSibling;
  return el instanceof HTMLElement && el.classList.contains(ARROW_CLASS) ? el : null;
};

/**
 * The ACTIVE discovery button — the game's own or AGR's replacement (AGR
 * hides one and shows the other). Visibility is judged on the element's OWN
 * computed display, not `offsetParent`: the panel hides the whole
 * `#galaxyHeader`, so every header child has a null offsetParent, while the
 * element's own display still tells the native-vs-AGR story (an ancestor's
 * `display:none` does not change a child's computed `display`). Falls back
 * to the first that exists so a click still lands if both are momentarily
 * hidden mid-AGR-boot.
 *
 * @returns {HTMLElement | null}
 */
const visibleDiscovery = () => {
  /** @type {HTMLElement | null} */
  let firstExisting = null;
  for (const id of DISCOVERY_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (getComputedStyle(el).display !== 'none') return el;
    firstExisting = firstExisting ?? el;
  }
  return firstExisting;
};

/**
 * Fixed short labels for AGR's expo-debris readout items, keyed by AGR's own
 * li CLASS NAMES. The classes are code constants — identical in every one of
 * the game's ~20 locales; only the visible label text is translated — so the
 * mapping is locale-proof by construction ("Kryształ:", "Crystal:" and
 * "Kristall:" all carry class "crystal"). Fixed letters rather than "first
 * letter of the localized label" because first letters can collide (Czech:
 * Kov / Krystal → K / K); M/K/D is the OGame-wide trade shorthand. Both
 * plausible AGR spellings of the deuterium class are listed. An item whose
 * class we don't know falls back to the first letter of its own label.
 *
 * @type {Record<string, string>}
 */
const DEBRIS_SHORT_BY_CLASS = {
  metal: 'M',
  crystal: 'K',
  deuterium: 'D',
  deut: 'D',
  pfcount: 'PF',
};

/**
 * Compact one AGR expo-debris readout item ("Metal: 1.388.400" →
 * "M 1.388.400", "Pathfinders needed: 17" → "PF 17"). AGR's full locale
 * labels are what made the row-16 strip wider than the ~630px column, and
 * no CSS can shorten text — so, like the readabilityBoost movement-link
 * relabeller, we rewrite the label and keep the value VERBATIM (locale
 * number formatting included). Text without a "label:" prefix passes
 * through untouched — which is also the idempotency guard, so re-running on
 * our own output never mutates (and never loops the observer).
 *
 * Exported so tests can pin the transform without mounting a DOM.
 *
 * @param {string} text
 * @param {string} [short]
 *   Explicit short label (from {@link DEBRIS_SHORT_BY_CLASS});
 *   default = first letter of the existing localized label.
 * @returns {string}
 */
export const shortenDebrisLabel = (text, short) => {
  const m = text.match(/^\s*([^:]+):\s*(.*)$/);
  if (!m) return text;
  const label = short ?? m[1].trim().charAt(0).toUpperCase();
  return `${label} ${m[2]}`;
};

/**
 * Rewrite every readout item of the row-16 expo-debris strip to its compact
 * form, resolving each item's short label from its AGR class. Only the li's
 * FIRST text node is touched: AGR's red "(-N)" pathfinder-delta span (a
 * later child) survives verbatim, and the action li (the one holding the
 * Zredukuj link) is skipped entirely. Guarded writes — safe on every sync
 * pass.
 *
 * @returns {void}
 */
const compactDebrisReadout = () => {
  const items = document.querySelectorAll(
    '#galaxyContent .expeditionDebrisSlotBox .ago_expo_df > li',
  );
  for (const li of items) {
    if (li.querySelector('a')) continue; // the Zredukuj action li
    const first = li.firstChild;
    if (!first || first.nodeType !== Node.TEXT_NODE) continue;
    const raw = first.textContent ?? '';
    /** @type {string | undefined} */
    let short;
    for (const cls of li.classList) {
      if (DEBRIS_SHORT_BY_CLASS[cls]) {
        short = DEBRIS_SHORT_BY_CLASS[cls];
        break;
      }
    }
    const next = shortenDebrisLabel(raw, short);
    if (next !== raw) first.textContent = next;
  }
};

/**
 * The three mirrored system-action buttons. `resolve` returns the native
 * control (used for both the click proxy and the disabled mirror).
 */
const ACTIONS = [
  {
    label: 'Phalanx',
    resolve: () =>
      /** @type {HTMLElement | null} */ (document.querySelector(PHALANX_LINK)),
  },
  {
    label: 'Spy',
    resolve: () =>
      /** @type {HTMLElement | null} */ (document.querySelector(SPY_SYSTEM_LINK)),
  },
  {
    label: 'Discovery',
    resolve: visibleDiscovery,
  },
];

/**
 * Live mounted-panel handle, or null while unmounted (toggle off / not the
 * galaxy page / native form absent).
 *
 * @type {{
 *   panel: HTMLElement,
 *   galInput: HTMLInputElement,
 *   sysInput: HTMLInputElement,
 *   actionBtns: HTMLButtonElement[],
 *   observer: import('../lib/visibilityObserver.js').VisibilityObserver,
 *   offNativeInputs: () => void,
 *   offResize: () => void,
 *   ratchetPx: number,
 * } | null}
 */
let mounted = null;

/**
 * @param {string} label
 * @param {string} [extraClass]
 * @returns {HTMLButtonElement}
 */
const mkButton = (label, extraClass) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = extraClass ? `oge-gnav-btn ${extraClass}` : 'oge-gnav-btn';
  b.textContent = label;
  // The game closes EVERY open jQuery-UI overlay on any click that bubbles to
  // <html> with a target outside a dialog (initHideElements' delegated
  // `click.hideElem`). The native controls survive their own clicks only
  // because their handlers stop propagation (`return false` in the game's
  // `.overlay` delegate, an explicit stopPropagation() in the spy-system
  // handler). Our buttons dispatch a NESTED click on the native control —
  // that nested event replays the full native chain — but without this the
  // ORIGINAL trusted click would then resume bubbling from OUR button and
  // hit hideElem, instantly closing the overlay the nested click just opened.
  // That killed the phalanx dialog: its content XHR then appended into a
  // detached node, jQuery skipped the embedded token-rotation <script>, and
  // every later open sent an already-consumed token ("An error has
  // occured!"). Stopping the trusted event makes the nested event the ONLY
  // one the page sees — exactly the native behaviour. (Same-node listeners
  // added after this one still run; stopPropagation only cuts other nodes.)
  b.addEventListener('click', (e) => e.stopPropagation());
  return b;
};

/**
 * @param {string} ariaLabel
 * @returns {HTMLInputElement}
 */
const mkNumberInput = (ariaLabel) => {
  const input = document.createElement('input');
  input.className = 'oge-gnav-input';
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = '1';
  input.setAttribute('pattern', '[0-9]*');
  input.autocomplete = 'off';
  input.setAttribute('aria-label', ariaLabel);
  // Mirror the header inputs' tap-to-retype ergonomics (select, don't clear —
  // the old value stays visible until the first digit lands).
  input.addEventListener('focus', () => input.select());
  return input;
};

/**
 * Push the panel's (valid) values into the native header inputs, so a
 * subsequent native-arrow click or submit steps from the value the user SEES
 * in the panel — not from a stale header value.
 *
 * @returns {void}
 */
const pushPanelValues = () => {
  if (!mounted) return;
  const galN = nativeGalaxyInput();
  const sysN = nativeSystemInput();
  const g = readInt(mounted.galInput.value);
  const s = readInt(mounted.sysInput.value);
  if (galN && g !== null) galN.value = String(clampInt(g, 1, GALAXY_MAX));
  if (sysN && s !== null) sysN.value = String(clampInt(s, 1, SYSTEM_MAX));
};

/**
 * Navigate to the panel's current values via the shared in-page navigator
 * (fills the native inputs, clicks the native submit — the game's AJAX
 * loader does the rest). Unparseable input snaps back to the game's value
 * instead of navigating.
 *
 * @returns {void}
 */
const doStart = () => {
  if (!mounted) return;
  const g = readInt(mounted.galInput.value);
  const s = readInt(mounted.sysInput.value);
  if (g === null || s === null) {
    syncFromGame();
    return;
  }
  navigateGalaxyInPage(clampInt(g, 1, GALAXY_MAX), clampInt(s, 1, SYSTEM_MAX));
};

/**
 * One prev/next step. Prefers the game's own arrow control (wrap-around,
 * galaxy-switch deuterium costs and any future game rule included); falls
 * back to a clamped ±1 through the shared navigator when the arrow span is
 * missing.
 *
 * @param {'g' | 's'} which
 * @param {-1 | 1} dir
 * @returns {void}
 */
const step = (which, dir) => {
  if (!mounted) return;
  pushPanelValues();
  const target = which === 'g' ? nativeGalaxyInput() : nativeSystemInput();
  const arrow = nativeArrow(target, dir);
  if (arrow) {
    arrow.click();
    return;
  }
  const g = readInt(mounted.galInput.value) ?? 1;
  const s = readInt(mounted.sysInput.value) ?? 1;
  navigateGalaxyInPage(
    clampInt(which === 'g' ? g + dir : g, 1, GALAXY_MAX),
    clampInt(which === 's' ? s + dir : s, 1, SYSTEM_MAX),
  );
};

/**
 * Reconcile the panel with the game: copy the native header inputs' values
 * into the panel (skipping an input the user is typing in) and mirror the
 * native action buttons' disabled state. Also re-inserts the panel if an
 * aggressive re-render detached it. Idempotent — safe on every observer tick.
 *
 * @returns {void}
 */
const syncFromGame = () => {
  if (!mounted) return;
  const content = document.getElementById(GALAXY_CONTENT_ID);
  if (!mounted.panel.isConnected && content) {
    content.insertAdjacentElement('afterend', mounted.panel);
  }
  // Height ratchet (see header): pin the content box to the tallest layout
  // seen so far, so leftover per-system variance can't move the panel below.
  // offsetHeight already includes any min-height set on a previous pass, so
  // the guard fires only on real growth — no write loop (and the inline
  // style write is an attribute mutation the childList observer ignores).
  if (content) {
    const h = content.offsetHeight;
    if (h > mounted.ratchetPx) {
      mounted.ratchetPx = h;
      content.style.minHeight = `${h}px`;
    }
  }
  const galN = nativeGalaxyInput();
  const sysN = nativeSystemInput();
  const active = document.activeElement;
  if (galN && active !== mounted.galInput && mounted.galInput.value !== galN.value) {
    mounted.galInput.value = galN.value;
  }
  if (sysN && active !== mounted.sysInput && mounted.sysInput.value !== sysN.value) {
    mounted.sysInput.value = sysN.value;
  }
  ACTIONS.forEach((action, i) => {
    const btn = mounted?.actionBtns[i];
    if (!btn) return;
    const native = action.resolve();
    btn.disabled = !native || native.hasAttribute('disabled');
  });
  compactDebrisReadout();
};

/**
 * Build + insert the panel after `#galaxyContent`. No-op when already
 * mounted, off the galaxy page, or when the native form is absent (e.g. the
 * vacation-mode galaxy block) — there is nothing to mirror then.
 *
 * @returns {void}
 */
const mount = () => {
  if (mounted || !isGalaxyPage()) return;
  const content = document.getElementById(GALAXY_CONTENT_ID);
  const galN = nativeGalaxyInput();
  const sysN = nativeSystemInput();
  if (!content || !galN || !sysN) return;

  injectStyle(STYLE_ID, CSS);

  const panel = document.createElement('div');
  panel.id = GNAV_PANEL_ID;

  /**
   * @param {string} tag
   * @param {string} className
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /**
   * One labelled stepper group: caption over [−][input][+].
   *
   * @param {string} caption
   * @param {HTMLInputElement} input
   * @param {'g' | 's'} which
   * @returns {HTMLElement}
   */
  const mkGroup = (caption, input, which) => {
    const group = el('div', 'oge-gnav-group');
    group.appendChild(el('span', 'oge-gnav-cap', caption));
    const stepper = el('div', 'oge-gnav-stepper');
    const minus = mkButton('−', 'oge-gnav-step');
    minus.setAttribute('aria-label', `Previous ${caption.toLowerCase()}`);
    minus.addEventListener('click', () => step(which, -1));
    const plus = mkButton('+', 'oge-gnav-step');
    plus.setAttribute('aria-label', `Next ${caption.toLowerCase()}`);
    plus.addEventListener('click', () => step(which, 1));
    stepper.append(minus, input, plus);
    group.appendChild(stepper);
    return group;
  };

  const galInput = mkNumberInput('Galaxy');
  const sysInput = mkNumberInput('System');
  /** @param {KeyboardEvent} e */
  const onEnter = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    doStart();
  };
  galInput.addEventListener('keydown', onEnter);
  sysInput.addEventListener('keydown', onEnter);

  const actionRow = el('div', 'oge-gnav-row');
  const actionBtns = ACTIONS.map((action) => {
    const btn = mkButton(action.label, 'oge-gnav-action');
    btn.addEventListener('click', () => {
      const native = action.resolve();
      if (native && !native.hasAttribute('disabled')) native.click();
    });
    actionRow.appendChild(btn);
    return btn;
  });
  panel.appendChild(actionRow);

  const navRow = el('div', 'oge-gnav-row oge-gnav-nav');
  const startBtn = mkButton('Start', 'oge-gnav-start');
  startBtn.addEventListener('click', doStart);
  navRow.appendChild(mkGroup('Galaxy', galInput, 'g'));
  navRow.appendChild(startBtn);
  navRow.appendChild(mkGroup('System', sysInput, 's'));
  panel.appendChild(navRow);

  content.insertAdjacentElement('afterend', panel);

  // Re-sync after every AJAX re-render of the system table (the game and AGR
  // both rewrite #galaxyContent's children on navigation), plus live while
  // the user types in the native header inputs. The panel sits OUTSIDE the
  // observed subtree, so our own writes never feed back into the observer.
  const scheduleSync = debounce(syncFromGame, SYNC_DEBOUNCE_MS);
  // Debris-label compaction runs SYNCHRONOUSLY in the observer callback:
  // MutationObserver callbacks are microtasks that fire before the next
  // paint, so AGR's freshly rendered full-length labels never reach the
  // screen. (Compacting only from the debounced sync left them visible for
  // ~100ms — the readout visibly "jumped" long→short on every system hop.)
  // The rewrite is idempotent, so the echo of our own text mutation settles
  // in one extra no-op pass. Everything else stays debounced.
  const observer = createVisibilityObserver(() => {
    compactDebrisReadout();
    scheduleSync();
  });
  observer.observe(content, { childList: true, subtree: true });
  galN.addEventListener('input', scheduleSync);
  sysN.addEventListener('input', scheduleSync);
  const offNativeInputs = () => {
    galN.removeEventListener('input', scheduleSync);
    sysN.removeEventListener('input', scheduleSync);
  };

  // A resize moves the wrap points the ratchet was measured against, so the
  // reserved height may be wrong in either direction — drop it and let the
  // next sync re-measure from the new layout.
  const onResize = () => {
    if (!mounted) return;
    mounted.ratchetPx = 0;
    const c = document.getElementById(GALAXY_CONTENT_ID);
    if (c) c.style.minHeight = '';
    scheduleSync();
  };
  window.addEventListener('resize', onResize);
  const offResize = () => window.removeEventListener('resize', onResize);

  mounted = {
    panel,
    galInput,
    sysInput,
    actionBtns,
    observer,
    offNativeInputs,
    offResize,
    ratchetPx: 0,
  };
  syncFromGame();
};

/**
 * Remove the panel + stylesheet and stop observing. Safe when not mounted.
 *
 * @returns {void}
 */
const unmount = () => {
  if (!mounted) return;
  mounted.observer.disconnect();
  mounted.offNativeInputs();
  mounted.offResize();
  mounted.panel.remove();
  mounted = null;
  document.getElementById(STYLE_ID)?.remove();
  // Drop the height reserve — without the panel the native variable-height
  // layout is fine again.
  const content = document.getElementById(GALAXY_CONTENT_ID);
  if (content) content.style.minHeight = '';
};

/**
 * Module-scope install handle. Non-null between install and dispose.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the galaxy touch-nav panel. Idempotent — a second call returns the
 * same dispose fn. Runs from `installDomFeatures` (post-DOMContentLoaded, so
 * the server-rendered header + `#galaxyContent` exist and the settings store
 * is hydrated).
 *
 * @returns {() => void} Dispose handle.
 */
export const installGalaxyNavPanel = () => {
  if (installed) return installed.dispose;
  if (typeof document === 'undefined' || !document) return () => {};
  // The component can't change without a full page load — off the galaxy
  // page there is nothing to mount now or later, so skip the subscription
  // entirely (repeated calls stay cheap no-ops).
  if (!isGalaxyPage()) return () => {};

  if (settingsStore.get().readabilityBoost) mount();

  // React to settings changes — same diff-guarded pattern as readabilityBoost.
  let prev = settingsStore.get().readabilityBoost;
  const unsubscribe = settingsStore.subscribe((next) => {
    if (next.readabilityBoost === prev) return;
    prev = next.readabilityBoost;
    if (prev) mount();
    else unmount();
  });

  installed = {
    dispose: () => {
      unsubscribe();
      unmount();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset. Runs the current dispose (if any) so DOM is clean between
 * test cases.
 *
 * @returns {void}
 */
export const _resetGalaxyNavPanelForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
