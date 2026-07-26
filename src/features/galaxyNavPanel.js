// @ts-check

// Galaxy touch nav — a finger-sized mirror of the galaxy header's controls,
// mounted BELOW the system table. (The native "N planets colonised" footer
// row that used to sit here is folded away — see the footer-fold note below.)
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
//   row 1  [pos] [Phalanx] [Spy] [Discovery]   ← collapsible (the ▴/▾ lid)
//   row 2  Galaxy [−][input][+]   [▴ / Start]   System [−][input][+]
//
// The [−]/[+] steppers are the workhorse controls (one-tap system hops), so
// they get the tallest targets and the row's edges (thumb-reachable); [Start]
// is the rarer jump-to-typed-coords action — deliberately smaller, centered
// in the leftover space between the steppers, with a narrow collapse lid
// stacked above it (the two together match one stepper key's height). That lid
// folds row 1 away — the game actions are occasional, so on a phone the panel
// can sit as just the coord steppers until you need them. Group captions float
// down onto the input tops (compact "labels-in-field" look).
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
// ROW 16 (the expedition-debris slot) gets a different treatment. Instead of
// restyling AGR's live box in place (a CSS specificity war that broke on the
// 1.13 layout change), we HIDE the native box and render our OWN compact box
// right after it (see renderExpoProxy). Every control on it PROXIES the native
// one — a click / change is replayed on the hidden original — so all game +
// AGR logic runs untouched while the presentation is entirely ours. AGR's full
// locale debris labels are compacted to the M/K/D/PF shorthand on the way in
// (shortenDebrisLabel).
//
// The native FOOTER row (`.ctGalaxyFooter`: "N planets colonised" + the icon
// legend) is folded away the same way (see foldGalaxyFooter): the legend's
// info-icon is ADOPTED into the stats cell (`.span11`, beside SS/REC/IPM/…) to
// keep its game-wired tooltip, and the row — colonised count and all — is
// hidden. It reclaims the dead strip between the table and our panel and drops
// a count that duplicates what the dashboard already tracks. Reverted on unmount.
//
// The galaxy table is left to size to its ACTUAL content: we neutralise AGR's
// event-planet `min-height` reservation (see CSS) and inject no min-height of
// our own. Per-system height varies (wrapping names, debris cells, an
// event-planet row), so the panel below shifts a little between systems — the
// deliberate trade for never leaving a dead reserved strip after a tall system.
//
// # Arrow-key nav rescue (panel-independent)
//
// A jQuery-UI dialog (phalanx / spy / discovery) steals focus and its trap
// swallows the arrow keys, so OGame's native ←/→ system and ↑/↓ galaxy
// stepping goes dead until the popup is closed. A document keydown listener
// (installed on every galaxy page, NOT gated on the toggle below — it's a
// general fix) rescues this: when focus is inside a dialog and an unmodified
// arrow is pressed (and the user isn't typing), it closes the popup and
// performs the hop via `keyStep` (native arrows → the game's own rules). With
// no dialog trapping focus it does nothing, leaving the native nav untouched.
//
// # Toggle
//
// The PANEL is gated on `settings.readabilityBoost` — the same "Readability"
// tile that covers the event box + fleet movement link (this is the third
// mobile readability fix under that umbrella). Toggling off removes the panel
// and its stylesheet immediately; on re-mounts. (The arrow-key rescue above is
// separate — it stays active on galaxy pages regardless of the toggle.) Galaxy
// pages only (the component can't change without a full page load, so the URL
// is checked once at install).

import { injectStyle } from '../lib/dom.js';
import { createVisibilityObserver } from '../lib/visibilityObserver.js';
import { debounce } from '../lib/debounce.js';
import { settingsStore } from '../state/settings.js';
import { safeLS } from '../lib/storage.js';
import { GAME } from '../lib/gameDom.js';
import { navigateGalaxyInPage } from './shared/galaxyNav.js';

/** Panel root id (OG-E's own surface, not a game contract). */
export const GNAV_PANEL_ID = 'oge-gnav';
/** Id of the singleton <style> element this module injects. */
const STYLE_ID = 'oge-gnav-style';

/** OG-E compact proxy that stands in for the native row-16 expo-debris box. */
const EXPO_PROXY_ID = 'oge-gnav-expo';
/** Marker class added to the NATIVE box so our stylesheet hides it. */
const EXPO_HIDDEN_CLASS = 'oge-expo-hidden';
/** The native expedition-debris slot box (position 16), scoped to the galaxy table. */
const EXPO_BOX_SEL = '#galaxyContent .expeditionDebrisSlotBox';
/** The game's OWN hidden debris tooltip inside the box — the native fallback
 * source for the debris figures + reduce link once AGR's `.ago_expo_df` rewrite
 * broke on the new galaxy version. */
const NATIVE_DEBRIS_SEL = '#debris16';
/** AGR's reduce/reap link (preferred while AGR works). */
const AGR_RECYCLE_SEL = '.ago_expo_df li a';
/** The game's native reduce link ("Mine"/"Zredukuj") inside the debris tooltip;
 * an `<a>` when actionable, a `span.inactiveLink` (no `<a>`) when you lack the
 * pathfinders — so `querySelector('a')` naturally yields the enabled link only. */
const NATIVE_RECYCLE_SEL = '#debris16 .ListLinks li a';

// ── Footer fold (legend adoption + footer hide) ──────────────────────────
/** Native galaxy footer row (colonised count + legend), last block of the table. */
const GALAXY_FOOTER_SEL = '#galaxyContent .ctGalaxyFooter';
/** Native galaxy stats cell (SS/REC/IPM/slots/discoveries) — the legend's new home. */
const GALAXY_STATS_SEL = '#galaxyContent .galaxyCell.span11';
/** Marker class hiding the folded-away footer (kept off the body gate — see CSS). */
const FOOTER_HIDDEN_CLASS = 'oge-gnav-footer-hidden';
/** Marker class on the legend info-icon once adopted into the stats cell. */
const LEGEND_MOVED_CLASS = 'oge-gnav-legend';

/**
 * Panel-placement preference (per device). Three states cycled by the panel's
 * small position toggle, remembered in localStorage:
 *   - 'bottom' — our panel below the table, native header hidden (default).
 *   - 'top'    — our panel in the header's own place (above the table), native hidden.
 *   - 'both'   — our panel below the table AND the native header shown too.
 * The native header is hidden via {@link HIDE_NATIVE_CLASS} on `<body>`, so it's
 * a one-class toggle (off only in 'both').
 */
const GNAV_POS_KEY = 'oge-gnav-pos';
const GNAV_POS_STATES = /** @type {ReadonlyArray<'bottom' | 'top' | 'both'>} */ (['bottom', 'top', 'both']);
const HIDE_NATIVE_CLASS = 'oge-gnav-hide-native';
/** Compact toggle labels, one per {@link GNAV_POS_STATES} value. */
const GNAV_POS_LABEL = { bottom: 'BTM', top: 'TOP', both: 'BOTH' };

/**
 * Per-device memory ('1' = collapsed) of whether the actions row (position +
 * phalanx/spy/discovery) is folded away. Local only — a UI preference, not
 * game state, so it is deliberately NOT synced.
 */
const GNAV_ACTIONS_KEY = 'oge-gnav-actions';

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
/* The caption floats DOWN onto the top of the input (negative margin pulls the
   stepper up under it; z-index + relative keep it painted above; pointer-events
   off so a tap on the label still reaches the input). The input's top padding
   (below) drops the digits clear of the label. */
#${GNAV_PANEL_ID} .oge-gnav-cap {
  position: relative;
  z-index: 2;
  margin-bottom: -18px;
  pointer-events: none;
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
  /* Top pad drops the digits below the caption now floating over the top. */
  padding: 15px 4px 0;
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
/* Start now lives in a vertical stack under the collapse toggle; it FILLS the
   stack's leftover height (toggle + gap + Start == one stepper key), so the
   middle column stays level with the −/+ keys either side. */
#${GNAV_PANEL_ID} .oge-gnav-startstack {
  flex: 0 0 auto;
  align-self: flex-end;
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 54px;
}
#${GNAV_PANEL_ID} .oge-gnav-start {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  padding: 0 14px;
  font-size: 14px;
  border-color: #2f7c79;
  background: linear-gradient(180deg, #123c3b, #0b2827);
  color: #40c4c1;
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
/* Collapse toggle — narrow grey lid over Start, same width, all but joined. */
#${GNAV_PANEL_ID} .oge-gnav-collapse {
  flex: 0 0 auto;
  height: 16px;
  min-width: 0;
  padding: 0;
  font: 700 11px/1 Roboto, Arial, sans-serif;
  color: #8fa3b8;
  background: linear-gradient(180deg, #2a3038, #171c24);
  border-color: #38414f;
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
/* The panel replaces the native header form — hide it while the panel is up,
   UNLESS the player picked the 'both' position (then the class is off <body>
   and the native bar shows too). The hidden controls keep WORKING (our buttons
   proxy-click them; hidden elements still handle click events and hold the input
   values the game reads/writes). Removed on unmount → native bar back. */
body.${HIDE_NATIVE_CLASS} #galaxyHeader { display: none !important; }
/* Position toggle — the actions row's FIRST (leftmost), deliberately quiet
   member: same height as its neighbours (one clean row), but narrow, muted and
   dashed so it reads as panel plumbing rather than a fourth game action. */
#${GNAV_PANEL_ID} .oge-gnav-pos {
  flex: 0 0 auto;
  height: 50px;
  min-width: 54px;
  padding: 0 8px;
  font-size: 11px;
  color: #7e93a8;
  letter-spacing: 0.8px;
  border-style: dashed;
}

/* ===== Galaxy footer fold =====
   The native footer row (colonised count + legend) is dead space between the
   table and our panel: we ADOPT the legend info-icon into the stats cell
   (span11, beside SS/REC/IPM/slots/discoveries) and HIDE the row, dropping the
   redundant "N planets colonised" line. Marker classes rather than the body
   hide-gate, so the fold is independent of the BTM/TOP/BOTH position. */
#galaxyContent .ctGalaxyFooter.${FOOTER_HIDDEN_CLASS} { display: none !important; }
#galaxyContent .galaxyCell.span11 > #legend.${LEGEND_MOVED_CLASS} { margin-top: 2px; }
/* Neutralise AGR's event-planet min-height reservation on the galaxy table
   (AGR's .ago_shrink_1 / .ago_improve rules on .ago_has_eventplanet reserve
   661/676px). Paired with dropping our own #galaxyContent height ratchet: with
   the footer folded and both reservations gone, the table sizes to its real
   content — no dead strip left over after leaving a tall event-planet system.
   Only while the panel is mounted (this stylesheet is removed on unmount). */
#galaxyContent .galaxyTable.ago_has_eventplanet { min-height: 0 !important; }

/* ===== Row 16 (expedition-debris slot): OG-E compact PROXY =====
   We HIDE the native box (class added in JS) and render our OWN compact box
   right after it. Every control on our box proxies the native one, so this is
   pure presentation on our own class names — no fight with AGR/game rules. */
/* Hide the native box but keep it RENDERED (not display:none): its controls
   still open the game's overlays, which a display:none trigger can't. Pulled
   out of flow + clipped so it takes no space and can't be seen/clicked. */
#galaxyContent .expeditionDebrisSlotBox.${EXPO_HIDDEN_CLASS} {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
  opacity: 0 !important;
  pointer-events: none !important;
}

#${EXPO_PROXY_ID} {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  width: 100%;
  margin: 1px 0;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(15, 20, 26, 0.55);
  font-family: Roboto, Arial, sans-serif;
  color: #cfd8e3;
}
#${EXPO_PROXY_ID} * { box-sizing: border-box; }
#${EXPO_PROXY_ID} .oge-expo-title {
  flex: 0 0 auto;
  color: #8fa3b8;
  font: 700 11px/1.2 Roboto, Arial, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
#${EXPO_PROXY_ID} .oge-expo-readout {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  /* Tight leading so three stacked lines stay compact WITHOUT shrinking the
     (already small) 12px text. */
  font: 700 12px/1.08 Roboto, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  color: #cfd8e3;
}
#${EXPO_PROXY_ID} .miss { color: #ff5d5d; margin-left: 4px; }
#${EXPO_PROXY_ID} .oge-expo-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
}
#${EXPO_PROXY_ID} select.oge-expo-tpl {
  height: 30px;
  max-width: 120px;
  border: 1px solid #38414f;
  border-radius: 5px;
  background: #0a0e13;
  color: #cfd8e3;
  font: 700 12px/1 Roboto, Arial, sans-serif;
  touch-action: manipulation;
}
#${EXPO_PROXY_ID} button.oge-expo-btn {
  appearance: none;
  height: 30px;
  min-width: 84px;
  padding: 0 8px;
  border: 1px solid #38414f;
  border-radius: 5px;
  background: linear-gradient(180deg, #222a36, #141922);
  color: #9fb3c8;
  font: 700 12px/1 Roboto, Arial, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  cursor: pointer;
  touch-action: manipulation;
}
#${EXPO_PROXY_ID} button.oge-expo-btn:active { filter: brightness(1.45); }
#${EXPO_PROXY_ID} button.oge-expo-btn:disabled { opacity: 0.4; cursor: default; }
/* Adopted native template-editor anchor (#expeditionFleetTemplateBtn) — the
   REAL game control moved into our slot (trusted clicks = the overlay opens
   natively), faced as a TINY square gear button beside the select (explicit
   user choice — a config affordance, so the gear glyph is functional, not
   decorative; the native wording stays reachable via the mirrored title).
   Two-id selector outranks the game's own #-rules. */
#${EXPO_PROXY_ID} .oge-expo-tplslot { display: inline-flex; }
#${EXPO_PROXY_ID} #expeditionFleetTemplateBtn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  float: none;
  border: 1px solid #38414f;
  border-radius: 5px;
  background: linear-gradient(180deg, #222a36, #141922);
  text-decoration: none !important;
  overflow: visible;
  /* href-less anchor defaults to the text cursor — force the hand. */
  cursor: pointer;
}
/* Icon-only face: hide the game's sprite + long label; the gear ::after (an
   inline data-URI SVG — self-contained, no network) is the whole face. */
#${EXPO_PROXY_ID} #expeditionFleetTemplateBtn .icon_combatunits,
#${EXPO_PROXY_ID} #expeditionFleetTemplateBtn .expedtionFleetTemplateBtnTitle { display: none; }
#${EXPO_PROXY_ID} #expeditionFleetTemplateBtn::after {
  content: "";
  width: 16px;
  height: 16px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%239fb3c8'%3E%3Cpath d='M19.4 13a7.6 7.6 0 0 0 .1-1 7.6 7.6 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.5 11a7.6 7.6 0 0 0-.1 1 7.6 7.6 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.6c0 .2.3.4.5.4h4c.3 0 .5-.2.5-.4l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z'/%3E%3C/svg%3E") center / contain no-repeat;
}
/* The game's under-attack warning triangle keeps working — pinned to the
   button's corner so it doesn't fight the gear for the 30px face. */
#${EXPO_PROXY_ID} #expeditionFleetTemplateBtn .icon_warning_triangle_red {
  position: absolute;
  top: -5px;
  right: -5px;
}
#${EXPO_PROXY_ID} .oge-expo-tpl[hidden],
#${EXPO_PROXY_ID} button.oge-expo-btn[hidden] { display: none; }
/* Recycle is a two-line button: native label on top, pathfinders below. */
#${EXPO_PROXY_ID} button.oge-expo-recycle {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0;
  line-height: 1.05;
  padding: 1px 8px;
}
#${EXPO_PROXY_ID} .oge-expo-recycle .oge-expo-l2 {
  font-size: 10px;
  font-weight: 700;
  color: #8fa3b8;
  text-transform: none;
  letter-spacing: 0;
}
`;

/** @returns {boolean} True on the galaxy component (checked once — the component can't change without a full page load). */
const isGalaxyPage = () => location.search.includes('component=galaxy');

/** @returns {'bottom' | 'top' | 'both'} The stored panel position, defaulting to 'bottom'. */
const readGnavPos = () => {
  const v = safeLS.get(GNAV_POS_KEY);
  return GNAV_POS_STATES.includes(/** @type {any} */ (v))
    ? /** @type {'bottom' | 'top' | 'both'} */ (v)
    : 'bottom';
};

/** @param {'bottom' | 'top' | 'both'} pos @returns {void} */
const writeGnavPos = (pos) => safeLS.set(GNAV_POS_KEY, pos);

/** @returns {boolean} Whether the actions row is folded away (default: shown). */
const readActionsCollapsed = () => safeLS.get(GNAV_ACTIONS_KEY) === '1';

/** @param {boolean} collapsed @returns {void} */
const writeActionsCollapsed = (collapsed) => safeLS.set(GNAV_ACTIONS_KEY, collapsed ? '1' : '0');

/**
 * Place the panel per the stored preference: above the table ('top') or below
 * it ('bottom'/'both'), and hide the native header unless in 'both'.
 *
 * @param {HTMLElement} panel
 * @param {'bottom' | 'top' | 'both'} pos
 * @param {Element} content The `#galaxyContent` table container.
 * @returns {void}
 */
const applyGnavPos = (panel, pos, content) => {
  content.insertAdjacentElement(pos === 'top' ? 'beforebegin' : 'afterend', panel);
  document.body.classList.toggle(HIDE_NATIVE_CLASS, pos !== 'both');
};

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
 * The live native control inside the (hidden) row-16 box, resolved fresh each
 * call — the game rebuilds the box on every navigation, so a captured node goes
 * stale. `sel` is matched WITHIN the current box (the same ids also exist on the
 * fleetdispatch page, so global lookups would be ambiguous).
 *
 * @param {string} sel
 * @returns {HTMLElement | null}
 */
const inExpoBox = (sel) => {
  const box = document.querySelector(EXPO_BOX_SEL);
  const el = box ? box.querySelector(sel) : null;
  return el instanceof HTMLElement ? el : null;
};

/** @param {Element | null} el @returns {boolean} the element's own computed display ≠ none. */
const expoVisible = (el) => el instanceof HTMLElement && getComputedStyle(el).display !== 'none';

/**
 * Click a native row-16 control if present and enabled. No propagation guard —
 * for callers not driven by a trusted click (e.g. the select-change route).
 *
 * @param {HTMLElement | null} native
 * @returns {void}
 */
const clickNative = (native) => {
  if (native && !native.hasAttribute('disabled')) native.click();
};

/**
 * Proxy a trusted click onto a native row-16 control: stop OUR click from
 * bubbling to the game's overlay-closer (see mkButton), then replay it on the
 * native element so its (and AGR's) handlers run untouched.
 *
 * @param {Event} e
 * @param {HTMLElement | null} native
 * @returns {void}
 */
const proxyExpoClick = (e, native) => {
  e.stopPropagation();
  clickNative(native);
};

/**
 * Last recycle-action label seen (locale-constant, e.g. "Mine" / "Zredukuj").
 * The game OMITS the recycle link on systems where you lack the pathfinders to
 * mine, so we cache it to keep our always-rendered (then greyed) button reading
 * right. Seeds to English; overwritten by the first real link on any system.
 */
let lastRecycleLabel = 'Mine';

/**
 * @typedef {{ main: string, miss: string }} ExpoRow
 *   `main` = compact "M 398.400", `miss` = AGR's red "(-41)" delta (PF only).
 */

/**
 * Read AGR's expo-debris readout (`ul.ago_expo_df`) into compact rows, split
 * into the RESOURCE lines (metal / crystal / deuterium) and the PATHFINDER
 * line (kept apart so it can ride on the recycle button). The action li (the
 * recycle link) is skipped — it is mirrored as a button, not a readout figure.
 * Labels are shortened via {@link shortenDebrisLabel}, values kept verbatim.
 *
 * @param {Element} box
 * @returns {{ resources: ExpoRow[], pf: ExpoRow | null }}
 */
const readExpoReadout = (box) => {
  /** @type {ExpoRow[]} */
  const resources = [];
  /** @type {ExpoRow | null} */
  let pf = null;
  for (const li of box.querySelectorAll('.ago_expo_df > li')) {
    if (li.querySelector('a')) continue;
    const first = li.firstChild;
    const raw = first && first.nodeType === Node.TEXT_NODE ? (first.textContent ?? '') : '';
    if (!raw.includes(':')) continue;
    /** @type {string | undefined} */
    let short;
    for (const cls of li.classList) {
      if (DEBRIS_SHORT_BY_CLASS[cls]) { short = DEBRIS_SHORT_BY_CLASS[cls]; break; }
    }
    const miss = li.querySelector('.ago_missing_pf')?.textContent?.trim() ?? '';
    const row = { main: shortenDebrisLabel(raw, short), miss };
    if (li.classList.contains('pfcount')) pf = row;
    else resources.push(row);
  }
  return { resources, pf };
};

/**
 * NATIVE fallback for {@link readExpoReadout}. The new game version changed the
 * galaxy selectors, which broke AGR's `ul.ago_expo_df` rewrite — so when that
 * list is empty we read the debris figures straight from the game's OWN hidden
 * `#debris16` tooltip instead (the resource/pathfinder lines the game always
 * renders there), keeping the same compact `{ resources, pf }` shape. Resource
 * shorthand is by position (Metal/Crystal/Deuterium → M/K/D — the OGame-wide
 * trade shorthand, locale-proof), and a zero-value line (deuterium is always 0
 * on expedition debris) is dropped to keep the strip tight. No `miss` delta —
 * that is an AGR-only annotation with no native source.
 *
 * @param {Element} box
 * @returns {{ resources: ExpoRow[], pf: ExpoRow | null }}
 */
const readExpoReadoutNative = (box) => {
  /** @type {ExpoRow[]} */
  const resources = [];
  /** @type {ExpoRow | null} */
  let pf = null;
  const tip = box.querySelector(NATIVE_DEBRIS_SEL);
  if (!tip) return { resources, pf };
  const RES_SHORT = ['M', 'K', 'D'];
  let i = 0;
  for (const li of tip.querySelectorAll('.debris-content')) {
    const raw = li.textContent?.trim() ?? '';
    const short = RES_SHORT[i] ?? undefined;
    i += 1;
    if (!raw.includes(':')) continue;
    // Skip a zero line (expedition debris always has Deuterium: 0) — noise.
    if (/^0+$/.test(raw.replace(/^[^:]*:/, '').replace(/\D/g, ''))) continue;
    resources.push({ main: shortenDebrisLabel(raw, short), miss: '' });
  }
  const pfLi = tip.querySelector('.debris-recyclers');
  const pfRaw = pfLi?.textContent?.trim() ?? '';
  if (pfRaw.includes(':')) pf = { main: shortenDebrisLabel(pfRaw, 'PF'), miss: '' };
  return { resources, pf };
};

/**
 * A proxy button whose CLICK is forwarded to a native control (`sel`, matched
 * within the hidden box). Text is set later by {@link updateExpoProxy} from the
 * native control, so our labels always match the game's own wording + locale.
 *
 * @param {string} cls @param {string} sel @returns {HTMLButtonElement}
 */
const mkProxyBtn = (cls, sel) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `oge-expo-btn ${cls}`;
  b.addEventListener('click', (e) => proxyExpoClick(e, inExpoBox(sel)));
  return b;
};

/**
 * Build our compact proxy box. Layout: title + a stacked resource readout on
 * the left, then the action cluster docked right in the player's chosen order —
 * Recycle · Templates · quick-select · Expedition/Send. Every label is mirrored
 * live from the native control (no hard-coded locale strings). Static skeleton;
 * {@link updateExpoProxy} fills the text + state each sync.
 *
 * @returns {HTMLElement}
 */
const buildExpoProxy = () => {
  const box = document.createElement('div');
  box.id = EXPO_PROXY_ID;

  const title = document.createElement('span');
  title.className = 'oge-expo-title';
  box.appendChild(title);

  const readout = document.createElement('div');
  readout.className = 'oge-expo-readout';
  box.appendChild(readout);

  const actions = document.createElement('div');
  actions.className = 'oge-expo-actions';

  // 1) Recycle — a two-line button: native label on top, pathfinders below.
  //    Click resolves AGR's link first, else the game's own reduce link (the
  //    native fallback for the broken-AGR / new-galaxy-version case).
  const recycle = document.createElement('button');
  recycle.type = 'button';
  recycle.className = 'oge-expo-btn oge-expo-recycle';
  recycle.addEventListener('click', (e) =>
    proxyExpoClick(e, inExpoBox(AGR_RECYCLE_SEL) || inExpoBox(NATIVE_RECYCLE_SEL)));
  const l1 = document.createElement('span');
  l1.className = 'oge-expo-l1';
  const l2 = document.createElement('span');
  l2.className = 'oge-expo-l2';
  recycle.append(l1, l2);
  actions.appendChild(recycle);

  // 2) Template editor — the NATIVE #expeditionFleetTemplateBtn anchor, ADOPTED
  //    into this slot by updateExpoProxy and restyled by our CSS. We adopt the
  //    real element instead of proxy-clicking a hidden one: a synthetic click
  //    proved unreliable for the game's jQuery overlay, while a trusted click on
  //    the genuine anchor runs the native handler chain unmodified.
  const tplSlot = document.createElement('span');
  tplSlot.className = 'oge-expo-tplslot';
  actions.appendChild(tplSlot);

  // 3) Template quick-select — proxied to the native select.
  const tpl = document.createElement('select');
  tpl.className = 'oge-expo-tpl';
  tpl.setAttribute('aria-label', 'Expedition fleet template');
  tpl.addEventListener('change', () => {
    const nativeSel = inExpoBox('#expeditionFleetTemplateSelect');
    if (!(nativeSel instanceof HTMLSelectElement)) return;
    nativeSel.value = tpl.value;
    nativeSel.dispatchEvent(new Event('change', { bubbles: true }));
    // The game swaps Expedition→Send via an inline display flip — an ATTRIBUTE
    // mutation our childList observer never sees — so refresh the proxy now.
    renderExpoProxy();
  });
  actions.appendChild(tpl);

  // 4) Expedition / Send (mutually exclusive; the game shows exactly one).
  actions.appendChild(mkProxyBtn('oge-expo-exp', '#expeditionbutton'));
  actions.appendChild(mkProxyBtn('oge-expo-send', '#sendExpeditionFleetTemplateFleet'));

  box.appendChild(actions);
  return box;
};

/**
 * Fill our proxy from the native box. Guarded by a signature stamped on the
 * proxy: an unchanged native slot makes the pass a no-op, which is also what
 * stops our own DOM writes (inside the observed #galaxyContent) from looping
 * the MutationObserver.
 *
 * @param {HTMLElement} proxy
 * @param {HTMLElement} box
 * @returns {void}
 */
const updateExpoProxy = (proxy, box) => {
  const title = box.querySelector('.title')?.textContent?.trim() ?? '';
  // AGR readout first; when its `.ago_expo_df` list is empty (broken on the new
  // galaxy version), fall back to the game's own `#debris16` tooltip so the
  // debris figures + reduce button still render.
  let { resources, pf } = readExpoReadout(box);
  if (resources.length === 0 && pf === null) ({ resources, pf } = readExpoReadoutNative(box));

  const nativeSel = box.querySelector('#expeditionFleetTemplateSelect');
  const optPairs = nativeSel instanceof HTMLSelectElement
    ? Array.from(nativeSel.options).map((o) => ({ value: o.value, text: o.textContent?.trim() ?? '' }))
    : [];
  const tplValue = nativeSel instanceof HTMLSelectElement ? nativeSel.value : '';

  // Native controls — labels mirrored so our buttons read exactly like the
  // game's (right wording, right locale), state mirrored so ours track theirs.
  const expNative = box.querySelector('#expeditionbutton');
  const sendNative = box.querySelector('#sendExpeditionFleetTemplateFleet');
  const recycleNative = box.querySelector(AGR_RECYCLE_SEL) || box.querySelector(NATIVE_RECYCLE_SEL);
  const expLabel = expNative?.textContent?.trim() ?? '';
  const sendLabel = sendNative?.textContent?.trim() ?? '';
  const recycleLabel = recycleNative?.textContent?.trim() ?? '';
  if (recycleLabel) lastRecycleLabel = recycleLabel;
  const recycleText = recycleLabel || lastRecycleLabel;
  const expVis = expoVisible(expNative);
  const sendVis = expoVisible(sendNative);
  const hasRecycle = !!recycleNative;

  // Adopt the native template-editor anchor into our slot. Runs BEFORE the
  // signature gate: a game re-render mints a FRESH anchor while the readout
  // signature may be unchanged. appendChild MOVES the live node (handlers
  // survive); a stale anchor left from a replaced box is dropped first. Once
  // adopted, the box query returns null on later passes — the held anchor
  // stays put.
  const tplSlot = proxy.querySelector('.oge-expo-tplslot');
  if (tplSlot) {
    const freshTplBtn = box.querySelector('#expeditionFleetTemplateBtn');
    if (freshTplBtn && tplSlot.firstElementChild !== freshTplBtn) {
      // Icon-only face (see CSS) — mirror the native label into a title so
      // the game's own wording stays reachable on hover / long-press.
      const lbl = freshTplBtn
        .querySelector('.expedtionFleetTemplateBtnTitle')?.textContent?.trim();
      if (lbl) /** @type {HTMLElement} */ (freshTplBtn).title = lbl;
      tplSlot.textContent = '';
      tplSlot.appendChild(freshTplBtn);
    }
  }
  // AGR tints the whole slot via an inline background-color (its config-state
  // signal, e.g. rgba(212,54,53,.66) for a big/urgent debris field). We hid the
  // native box, so carry that tint onto ours; '' falls back to our card colour.
  const agrBg = box.style.backgroundColor || '';

  // Signature form only (a '|' collision merely forces a harmless extra rebuild).
  const opts = optPairs.map((o) => o.value + '|' + o.text);
  const sig = JSON.stringify([
    title, resources, pf, opts, tplValue,
    expLabel, sendLabel, recycleText,
    expVis, sendVis, hasRecycle, agrBg,
  ]);
  if (proxy.dataset.sig === sig) return;
  proxy.dataset.sig = sig;
  proxy.style.backgroundColor = agrBg;

  /** @param {string} sel @param {string} text */
  const setText = (sel, text) => {
    const el = proxy.querySelector(sel);
    if (el) el.textContent = text;
  };
  setText('.oge-expo-title', title);
  setText('.oge-expo-exp', expLabel);
  setText('.oge-expo-send', sendLabel);

  /** @param {Element} host @param {ExpoRow} row @returns {void} — value line + red delta. */
  const paintRow = (host, row) => {
    host.textContent = row.main;
    if (row.miss) {
      const m = document.createElement('span');
      m.className = 'miss';
      m.textContent = row.miss;
      host.appendChild(m);
    }
  };

  // Readout — resource lines stacked (the pathfinder line rides on the recycle
  // button below, so it's never duplicated here).
  const readout = proxy.querySelector('.oge-expo-readout');
  if (readout) {
    readout.textContent = '';
    for (const r of resources) {
      const line = document.createElement('span');
      paintRow(line, r);
      readout.appendChild(line);
    }
  }

  // Recycle button — line 1 = label, line 2 = pathfinders. Always rendered while
  // there's debris (so it doesn't vanish on systems where the game omits the
  // link for want of pathfinders); DISABLED (greyed) when the native link is
  // absent, so "you can't mine this" still reads at a glance.
  const recycleBtn = proxy.querySelector('.oge-expo-recycle');
  if (recycleBtn instanceof HTMLButtonElement) recycleBtn.disabled = !hasRecycle;
  const l1 = proxy.querySelector('.oge-expo-recycle .oge-expo-l1');
  if (l1) l1.textContent = recycleText;
  const l2 = proxy.querySelector('.oge-expo-recycle .oge-expo-l2');
  if (l2) {
    l2.textContent = '';
    if (pf) paintRow(l2, pf);
  }

  const tpl = proxy.querySelector('select.oge-expo-tpl');
  if (tpl instanceof HTMLSelectElement) {
    tpl.textContent = '';
    for (const o of optPairs) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.text;
      tpl.appendChild(opt);
    }
    tpl.value = tplValue;
  }

  /** @param {string} cls @param {boolean} show */
  const toggle = (cls, show) => {
    const b = proxy.querySelector(`.${cls}`);
    if (b instanceof HTMLElement) b.hidden = !show;
  };
  toggle('oge-expo-exp', expVis);
  toggle('oge-expo-send', sendVis);
  // Show the recycle button whenever there IS debris (link present, or just a
  // pathfinder line) — greying handles the "can't mine" case.
  toggle('oge-expo-recycle', hasRecycle || pf !== null);
};

/**
 * Hide the native row-16 box and stand our compact proxy in its place, then
 * sync it. The game rebuilds the box on every navigation, so we re-hide +
 * re-proxy on each sync. No-op (and removes a stale proxy) when the box is
 * absent — vacation-mode galaxy, or a system with no expedition slot.
 *
 * @returns {void}
 */
const renderExpoProxy = () => {
  const box = /** @type {HTMLElement | null} */ (document.querySelector(EXPO_BOX_SEL));
  const existing = document.getElementById(EXPO_PROXY_ID);
  if (!box) {
    existing?.remove();
    return;
  }
  box.classList.add(EXPO_HIDDEN_CLASS);
  let proxy = existing;
  if (!(proxy instanceof HTMLElement) || proxy.previousElementSibling !== box) {
    proxy?.remove();
    proxy = buildExpoProxy();
    box.insertAdjacentElement('afterend', proxy);
  }
  updateExpoProxy(proxy, box);
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
  // Keep the panel's buttons OUT of the tab order so Tab moves straight between
  // the Galaxy and System inputs (one tab, as on the native bar). They stay
  // fully usable by pointer/touch, and the inputs' Enter still submits.
  b.tabIndex = -1;
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
 * Keyboard sibling of {@link step}: one prev/next hop driven from the NATIVE
 * header inputs (not the panel's), so it works with or without the panel
 * mounted. Same rule preference as `step` — click the game's own arrow when
 * present (wrap-around + galaxy-switch deuterium costs preserved), else a
 * clamped ±1 through the shared navigator.
 *
 * @param {'g' | 's'} which
 * @param {-1 | 1} dir
 * @returns {void}
 */
const keyStep = (which, dir) => {
  const target = which === 'g' ? nativeGalaxyInput() : nativeSystemInput();
  const arrow = nativeArrow(target, dir);
  if (arrow) { arrow.click(); return; }
  const g = readInt(nativeGalaxyInput()?.value ?? '') ?? 1;
  const s = readInt(nativeSystemInput()?.value ?? '') ?? 1;
  navigateGalaxyInPage(
    clampInt(which === 'g' ? g + dir : g, 1, GALAXY_MAX),
    clampInt(which === 's' ? s + dir : s, 1, SYSTEM_MAX),
  );
};

/** Arrow-key → (axis, direction): ←/→ step the system, ↑/↓ the galaxy (↑ = +1). */
const KEY_STEP = /** @type {Record<string, ['g' | 's', -1 | 1]>} */ ({
  ArrowLeft: ['s', -1], ArrowRight: ['s', 1],
  ArrowUp: ['g', 1], ArrowDown: ['g', -1],
});

/** True when `el` is a field where arrow keys move the caret, not the galaxy. */
const isTextEntry = (/** @type {Element | null} */ el) =>
  el instanceof HTMLElement &&
  (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/**
 * Fold the native galaxy footer into the stats cell: MOVE the legend info-icon
 * (its tooltip is game-wired, so we adopt the real node — same trick as the
 * row-16 template button) into `.span11`, then hide the footer. That drops the
 * redundant "N planets colonised" line and reclaims the dead row above the
 * panel. No destination cell → leave the footer untouched, so the legend is
 * never stranded behind a hidden row.
 *
 * Re-applied every sync: the game rebuilds `#galaxyContent` (footer + stats
 * included) on each navigation, so the fresh footer's legend is re-adopted and
 * the fresh footer re-hidden. Idempotent — the parent guard skips a legend
 * already relocated, and re-adding the classes is a no-op.
 *
 * @returns {void}
 */
const foldGalaxyFooter = () => {
  const footer = document.querySelector(GALAXY_FOOTER_SEL);
  if (!footer) return;
  const stats = document.querySelector(GALAXY_STATS_SEL);
  if (!stats) return; // no home for the legend — don't hide the row, or it's lost
  const legend = footer.querySelector('#legend');
  if (legend && legend.parentElement !== stats) {
    // A PARTIAL re-render (fresh footer, same span11) would leave the
    // previously-adopted legend in the stats cell while a new one appears in
    // the footer — drop the stale copy so `#legend` stays unique before we
    // adopt the fresh node. (A full re-render rebuilds span11 too, so this is
    // a no-op then.)
    stats.querySelector('#legend')?.remove();
    legend.classList.add(LEGEND_MOVED_CLASS);
    stats.appendChild(legend);
  }
  footer.classList.add(FOOTER_HIDDEN_CLASS);
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
    applyGnavPos(mounted.panel, readGnavPos(), content);
  }
  foldGalaxyFooter();
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
  renderExpoProxy();
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

  // Collapse toggle — a narrow grey lid stacked ABOVE Start that folds the
  // whole actions row (position + phalanx/spy/discovery) away and back. The
  // arrow points the way the row moves: ▴ fold up (the row sits above), ▾
  // reveal. Remembered per device (no sync).
  const collapseBtn = mkButton('▴', 'oge-gnav-collapse');
  /** @param {boolean} collapsed @returns {void} */
  const applyActionsCollapsed = (collapsed) => {
    actionRow.style.display = collapsed ? 'none' : '';
    collapseBtn.textContent = collapsed ? '▾' : '▴';
    collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    collapseBtn.setAttribute('aria-label', collapsed ? 'Show system actions' : 'Hide system actions');
  };
  collapseBtn.title = 'Show / hide the system-action row';
  collapseBtn.addEventListener('click', () => {
    const next = !readActionsCollapsed();
    writeActionsCollapsed(next);
    applyActionsCollapsed(next);
  });
  const startStack = el('div', 'oge-gnav-startstack');
  startStack.append(collapseBtn, startBtn);

  navRow.appendChild(mkGroup('Galaxy', galInput, 'g'));
  navRow.appendChild(startStack);
  navRow.appendChild(mkGroup('System', sysInput, 's'));
  panel.appendChild(navRow);

  // Position toggle — FIRST slot of the actions row (quiet chrome; see CSS),
  // on the left so the game-action buttons keep their right-hand grouping.
  // Cycles bottom → top → both, remembered per device; placement + native-
  // header visibility are applied by applyGnavPos.
  const posBtn = mkButton(GNAV_POS_LABEL[readGnavPos()], 'oge-gnav-pos');
  posBtn.title = 'Panel position — tap to cycle: bottom / top / both';
  posBtn.addEventListener('click', () => {
    const next =
      GNAV_POS_STATES[(GNAV_POS_STATES.indexOf(readGnavPos()) + 1) % GNAV_POS_STATES.length];
    writeGnavPos(next);
    posBtn.textContent = GNAV_POS_LABEL[next];
    const c = document.getElementById(GALAXY_CONTENT_ID);
    if (c && mounted) applyGnavPos(mounted.panel, next, c);
  });
  actionRow.insertBefore(posBtn, actionRow.firstChild);

  // Now the actions row is complete (pos + game actions) — apply the remembered
  // fold state so a collapsed panel comes up collapsed.
  applyActionsCollapsed(readActionsCollapsed());

  applyGnavPos(panel, readGnavPos(), content);

  // Re-sync after every AJAX re-render of the system table (the game and AGR
  // both rewrite #galaxyContent's children on navigation), plus live while
  // the user types in the native header inputs. The panel sits OUTSIDE the
  // observed subtree, so our own writes never feed back into the observer.
  const scheduleSync = debounce(syncFromGame, SYNC_DEBOUNCE_MS);
  // The row-16 proxy AND the footer fold render SYNCHRONOUSLY in the observer
  // callback: MutationObserver callbacks are microtasks that fire before the
  // next paint, so AGR's freshly rendered native box is hidden / the fresh
  // footer folded before either reaches the screen. (Doing it only from the
  // debounced sync left the native box visible for ~100ms — a flash on every
  // system hop.) The signature guard makes the echo of our own DOM writes
  // settle in one extra no-op pass. Everything else stays debounced.
  const observer = createVisibilityObserver(() => {
    renderExpoProxy();
    foldGalaxyFooter();
    scheduleSync();
  });
  observer.observe(content, { childList: true, subtree: true });
  galN.addEventListener('input', scheduleSync);
  sysN.addEventListener('input', scheduleSync);
  const offNativeInputs = () => {
    galN.removeEventListener('input', scheduleSync);
    sysN.removeEventListener('input', scheduleSync);
  };

  mounted = {
    panel,
    galInput,
    sysInput,
    actionBtns,
    observer,
    offNativeInputs,
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
  mounted.panel.remove();
  // Return the adopted template-editor anchor to its native container, then
  // drop our row-16 proxy and un-hide the native expo-debris box.
  const adopted = document.querySelector(`#${EXPO_PROXY_ID} #expeditionFleetTemplateBtn`);
  const tplCont = document.getElementById('galaxyExpeditionFleetTemplateContainer');
  if (adopted && tplCont) tplCont.insertBefore(adopted, tplCont.firstChild);
  document.getElementById(EXPO_PROXY_ID)?.remove();
  document.querySelector(EXPO_BOX_SEL)?.classList.remove(EXPO_HIDDEN_CLASS);
  // Un-fold the galaxy footer: return the adopted legend to the footer (after
  // #colonized, its native order) and drop the hide class. When the footer is
  // gone (a re-render replaced it) the native tree is already fresh — nothing
  // to undo.
  const footer = document.querySelector(GALAXY_FOOTER_SEL);
  if (footer) {
    const movedLegend = document.querySelector(`${GALAXY_STATS_SEL} > #legend`);
    if (movedLegend) {
      movedLegend.classList.remove(LEGEND_MOVED_CLASS);
      footer.appendChild(movedLegend);
    }
    footer.classList.remove(FOOTER_HIDDEN_CLASS);
  }
  // Restore the native header (drop the hide-gate class).
  document.body.classList.remove(HIDE_NATIVE_CLASS);
  mounted = null;
  document.getElementById(STYLE_ID)?.remove();
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

  // Arrow-key nav rescue — INDEPENDENT of the panel/readabilityBoost (a general
  // galaxy-page fix). A jQuery-UI dialog (phalanx / spy / discovery) steals
  // focus and its trap swallows the arrow keys, killing the native
  // galaxy/system stepping. When focus sits inside such a dialog and an
  // unmodified arrow is pressed (and the user isn't typing), close the popup —
  // its data is for the system we're leaving — then hop ourselves. With no
  // dialog trapping focus we do nothing, so the game's own arrow nav is
  // untouched. Capture phase so we win before the dialog/game see the key.
  //
  // Why the LOCK: the game navigates on the arrow's `keyup` too (verified by
  // the double-hop bug). Our keydown `stopImmediatePropagation` can't touch a
  // separate keyup event, so once we've closed the dialog on keydown the game's
  // keyup handler no longer bails and hops a SECOND time (→ +2, a brief +3 on
  // the race). So after our hop we briefly SWALLOW every arrow key event
  // (the trailing keyup + any repeat) — the game can't add a second hop, and
  // exactly one lands per press.
  let arrowLockUntil = 0;
  /** @param {KeyboardEvent} e */
  const swallowArrow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    const map = KEY_STEP[e.key];
    if (!map) return;
    // A hop is in its cooldown — swallow the follow-up arrows (repeat / the
    // game's keyup) so no second hop can sneak in.
    if (Date.now() < arrowLockUntil) { swallowArrow(e); return; }
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const active = document.activeElement;
    if (isTextEntry(active)) return; // typing — arrows move the caret
    const dialog = active instanceof Element ? active.closest('.ui-dialog') : null;
    if (!dialog) return; // native nav is fine — stay out of the way
    swallowArrow(e);
    arrowLockUntil = Date.now() + 400;
    const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close');
    if (closeBtn instanceof HTMLElement) closeBtn.click();
    keyStep(map[0], map[1]);
  };
  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => {
    if (KEY_STEP[e.key] && Date.now() < arrowLockUntil) swallowArrow(e);
  };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  installed = {
    dispose: () => {
      unsubscribe();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
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
