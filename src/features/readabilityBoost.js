// @ts-check

// Contrast + legibility boost for two chronically painful AGR / OGame
// surfaces: the fleet-event box at the top of the page and the
// "light green" fleet-movement link in the fleetdispatch header.
//
// # Event box (`#eventboxFilled`)
//
// Out of the box the event row renders three pieces of information
// ("17 Misje:", mission-type + target, and a countdown) but pads them
// with verbose labels ("Misje:", "Następna:", "Rodzaj:") that eat more
// space than the payload itself. We paint the box black, nudge it up
// slightly to close the gap under AGR's header, then collapse every
// label's font-size to 0 so only the compact payload bits remain:
//   - `.undermark` → the "17 x własna" chip (first row)
//   - `.countdown` → the yellow time-to-next-event
//   - `.friendly` / `.hostile` / `.neutral` → the mission-type name
// Game's own layout does the rest — no flex, no positioning hacks.
//
// # Movement link (`a.ago_movement.tooltip.ago_color_lightgreen`)
//
// The link is a mixed-coloured status row: "Floty: 18/37" (green) +
// inline `<span class="ago_color_palered">Ekspedycje: 14/14</span>`
// (red when full). Earlier revisions of this module forced the green
// onto every descendant via `a.xxx *`, which destroyed the native red
// "max reached" indicator. The new rule applies the green to the anchor
// ONLY (text nodes inherit, explicit `ago_color_palered` child keeps
// its red). We also reshape the anchor as a column flex container so
// the two status lines stack vertically, left-aligned, and bump the
// font to 15 px so small-screen users can read them at a glance.
//
// # Why a single stylesheet
//
// Both concerns are CSS-only, run at `document_start` before `<body>`,
// and must beat inline styles + game rules. One injected
// `<style id="oge-readability-boost">` with `!important` declarations
// is the simplest way — re-installs dedupe on the stable id and return
// the existing dispose without rewriting the stylesheet. Mirrors the
// shape of {@link ../features/blackBg.js}.

/** Stable id so repeated installs collapse to a no-op. */
const STYLE_ID = 'oge-readability-boost';

/**
 * The override rules. Kept as a module-level constant so tests can
 * assert on the exact selectors + `!important` presence without
 * reaching into internals.
 */
const CSS = `/* OG-E: readability boost — event box + fleet movement link */

/* ===== Event box container =====
   Keep the game's default layout, just paint the background black and
   nudge it up to fit tighter under AGR's header. Every OGame skin
   looks fine against solid black, unlike the lighter defaults that
   interact badly with AGR's dark theme. */
#eventboxFilled {
  margin-top: -5px !important;
  background: black !important;
}

/* Hide the verbose "N Misje:" prefix — the compact "N x type" span
   (.undermark) carries the same information at half the width. */
#eventboxFilled > p.event_list:first-child {
  font-size: 0 !important;
}
#eventboxFilled > p.event_list:first-child .undermark {
  font-size: 13px !important;
  font-weight: 700 !important;
  color: #7ecfff !important;
}

/* Both status rows ("Następna: <countdown>" and "Rodzaj: <type>") use
   the same .next_event wrapper. Collapse the parent's font-size to 0
   so the "Następna:" / "Rodzaj:" literal text vanishes, then re-show
   the nested payload (countdown digits, mission-type name) with an
   explicit size. */
#eventboxFilled .next_event {
  font-size: 0 !important;
}
#eventboxFilled .next_event .countdown,
#eventboxFilled .next_event .friendly,
#eventboxFilled .next_event .hostile,
#eventboxFilled .next_event .neutral {
  font-size: 14px !important;
  font-weight: bold !important;
}

/* Mission-type semantic colours — AGR palette, preserved. */
#eventboxFilled .friendly { color: #55e87a !important; }
#eventboxFilled .hostile  { color: #ff4d4d !important; }
#eventboxFilled .neutral  { color: #ffaa33 !important; }

/* Yellow countdown so it wins attention against black background. */
#eventboxFilled .countdown {
  color: #ffe04b !important;
}

/* AGR's expand/collapse toggles are irrelevant to the compact view. */
#eventboxFilled #js_eventDetailsClosed,
#eventboxFilled #js_eventDetailsOpen {
  display: none !important;
}

/* ===== Movement link (fleetdispatch header) =====
   Stack "Floty: X/Y" on top of "Ekspedycje: X/Y" left-aligned. Colour
   the anchor only (not every descendant) so the child
   .ago_color_palered keeps its native red "max reached" tint.
   height:auto cancels any inline workaround the user might have left
   behind. */
a.ago_movement.tooltip.ago_color_lightgreen {
  color: #a0ff60 !important;
  font-size: 15px !important;
  font-weight: bold !important;
  display: inline-flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  line-height: 1.2 !important;
  height: auto !important;
  padding: 2px 0 !important;
  gap: 1px !important;
}
`;

/**
 * Active install handle, or `null` when not installed. Held at module
 * scope so a second call to {@link installReadabilityBoost} collapses
 * to a no-op returning the same dispose.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Inject the contrast-boost stylesheet. Safe to call synchronously
 * from the content-script entry at `document_start` — the parent
 * resolution falls back to `document.documentElement` when the browser
 * hasn't produced `<head>` yet.
 *
 * Idempotent per document: the stable `STYLE_ID` guards against
 * duplicate `<style>` nodes even if this module is imported twice.
 *
 * @returns {() => void} Dispose fn that removes the `<style>` element.
 */
export const installReadabilityBoost = () => {
  if (installed) return installed.dispose;

  // Happy-dom strips `document` in some edge-case test environments.
  // Bail out cleanly rather than throwing on module import.
  if (typeof document === 'undefined' || !document) {
    return () => {};
  }

  // Defensive: another install might have run in a previous page load
  // (e.g. dev-reload) and left the node behind. Reuse it.
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    installed = {
      dispose: () => {
        existing.remove();
        installed = null;
      },
    };
    return installed.dispose;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;

  // At `document_start` both `document.head` and `document.body` may
  // be null; `document.documentElement` exists from the moment the
  // Document node is constructed, so it's the only reliably-available
  // mount point for injection pre-parse.
  const parent = document.head || document.documentElement;
  parent.appendChild(style);

  installed = {
    dispose: () => {
      style.remove();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope install sentinel. Production
 * code never needs this — the leading underscore is a hard signal.
 *
 * @returns {void}
 */
export const _resetReadabilityBoostForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
