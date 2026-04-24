// @ts-check

// Contrast + legibility boost for two chronically painful AGR / OGame
// surfaces: the fleet-event box at the top of the page and the
// "light green" fleet-movement link in the fleetdispatch header.
//
// # Event box (`#eventboxFilled`)
//
// Out of the box the event row squishes three pieces of information
// ("15 Misje: …", mission type + target, and a countdown) into a
// single dense line at tiny text, and its parent chain
// (`#messages_collapsed` → `#message-wrapper` → `#notificationbarcomponent`)
// clips anything that dares stick out. We reshape the box into a
// two-line flex column with a gradient background, a bold coloured
// mission-type line, and a big absolute-positioned countdown chip on
// the right. Parent overflow/z-index is relaxed so the countdown chip
// can sit proudly above the page. Because the countdown escapes its
// parent via `position: absolute`, every ancestor that would otherwise
// clip it gets a targeted `overflow: visible; z-index: 9999` override.
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
// `<style id="oge5-readability-boost">` with `!important` declarations
// is the simplest way — re-installs dedupe on the stable id and return
// the existing dispose without rewriting the stylesheet. Mirrors the
// shape of {@link ../features/blackBg.js}.

/** Stable id so repeated installs collapse to a no-op. */
const STYLE_ID = 'oge5-readability-boost';

/**
 * The override rules. Kept as a module-level constant so tests can
 * assert on the exact selectors + `!important` presence without
 * reaching into internals.
 */
const CSS = `/* OG-E: readability boost — event box + fleet movement link */

/* ===== Parent chain fixes =====
   #eventboxFilled's countdown chip uses position: absolute to float on
   the right; its ancestors clip any child by default. Lift overflow +
   z-index on the three levels we actually inject into. */
#messages_collapsed,
#message-wrapper,
#notificationbarcomponent {
  overflow: visible !important;
  position: relative !important;
  z-index: 9999 !important;
}

/* ===== Event box container ===== */
#eventboxFilled {
  position: relative !important;
  display: flex !important;
  flex-direction: column !important;
  justify-content: center !important;
  gap: 2px !important;
  padding: 5px 160px 5px 14px !important;
  min-height: 44px !important;
  margin-top: -15px !important;
  background: linear-gradient(160deg, #081828 0%, #0d2a45 100%) !important;
  border: 1px solid #1e5080 !important;
  border-top: 3px solid #4da6ff !important;
  box-shadow: 0 4px 18px rgba(0, 80, 180, 0.5) !important;
  z-index: 10000 !important;
}

/* Row 1: hide the "X Misje:" prefix, keep the compact "X × type" span. */
#eventboxFilled > p.event_list:first-child {
  font-size: 0 !important;
  margin: 0 !important;
  white-space: nowrap !important;
}
#eventboxFilled > p.event_list:first-child .undermark {
  font-size: 13px !important;
  font-weight: 700 !important;
  color: #7ecfff !important;
  display: inline-block !important;
}

/* Row 2: mission-type line + (absolute) countdown. */
#eventboxFilled > p.event_list:nth-child(2) {
  margin: 0 !important;
}

/* Hide the "Następna:" label — countdown stays visible via the chip
   rule below (position: absolute escapes font-size: 0). */
#eventboxFilled .next_event:has(.countdown) {
  font-size: 0 !important;
  color: transparent !important;
}

/* Mission-type line (when there's no countdown inside — this is the
   row with the mission label + target coords). */
#eventboxFilled .next_event:not(:has(.countdown)) {
  font-size: 12px !important;
  color: #99bbdd !important;
  display: inline-flex !important;
  align-items: center !important;
  white-space: nowrap !important;
}
#eventboxFilled .next_event:not(:has(.countdown)) > span {
  margin-left: -233px !important;
  font-size: x-large !important;
  font-weight: 700 !important;
}

/* Mission-type colour semantics (AGR palette). */
#eventboxFilled .friendly { color: #55e87a !important; }
#eventboxFilled .hostile  { color: #ff4d4d !important; }
#eventboxFilled .neutral  { color: #ffaa33 !important; }

/* Countdown chip — big, yellow, sits on the right. */
#eventboxFilled .countdown {
  position: absolute !important;
  right: 5px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  font-size: 20px !important;
  font-weight: 900 !important;
  color: #ffe04b !important;
  background: rgba(255, 210, 50, 0.1) !important;
  border: 2px solid rgba(255, 210, 50, 0.5) !important;
  border-radius: 6px !important;
  padding: 5px 12px !important;
  letter-spacing: 0.5px !important;
  white-space: nowrap !important;
  display: block !important;
  line-height: 1.2 !important;
}

/* AGR's expand/collapse toggles are irrelevant to our compact layout. */
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
