// @ts-check

// Contrast boost for two chronically low-visibility AGR/OGame elements.
//
// # Why
//
// On dark themes (and especially on mobile in daylight) two specific
// DOM surfaces are painful to read:
//
//   1. `#eventboxFilled` — the fleet-event box at the top of the page.
//      AGR paints its text in faded greys on a near-black background;
//      at small font sizes it degenerates into noise.
//   2. `a.ago_movement.tooltip.ago_color_lightgreen` — AGR's "light
//      green" fleet-movement link. The shade is close enough to the
//      page background that the link all but disappears for users with
//      reduced colour sensitivity.
//
// Neither surface has a settings toggle on AGR's side and both are
// rendered into HTML that ships inline `style` / high-specificity CSS,
// so the only reliable way to override them is a stylesheet with
// `!important` declarations. The overrides here are deliberate and
// minimal — white bold text for the event box, a brighter green and a
// bump in size for the movement link — tuned to preserve AGR's palette
// semantics while clearing the contrast floor.
//
// # What
//
// Inject a single `<style id="oge5-readability-boost">` node at
// `document_start` with three rule blocks. The element is idempotent:
// re-installs dedupe on the stable id and return the existing dispose
// without rewriting the stylesheet.
//
// ## Event box (`#eventboxFilled`)
//
// Earlier revisions slammed `color: #fff !important` onto every
// descendant (`#eventboxFilled *`). That flattened AGR's resource
// colour coding (metal / crystal / deut tints) and ate the status
// glyphs. The current rule applies the white only to the root; CSS
// inheritance carries the lift to plain-text children while spans
// with their own explicit `color` keep it. Bold is still forced on
// every descendant (no cascade issue — it stacks additively with no
// visual cost).
//
// ## Movement link (`.ago_movement.tooltip.ago_color_lightgreen`)
//
// Colour override stays but `font-size: larger` and `font-weight: bold`
// are now applied only to the anchor itself, not `*`. `larger` is
// relative to the parent — recursing through `*` would compound the
// bump at every nesting level and blow up deeply nested tooltips.
//
// Mirrors the shape of {@link ../features/blackBg.js} — both are
// CSS-only, run before the parser has produced `<body>`, and fall back
// to `document.documentElement` when `document.head` is still null at
// the install instant.

/** Stable id so repeated installs collapse to a no-op. */
const STYLE_ID = 'oge5-readability-boost';

/**
 * The override rules. Kept as a module-level constant so tests can
 * assert on the exact selectors + `!important` presence without
 * reaching into internals.
 */
const CSS = `/* OG-E: contrast boost for low-visibility elements */
/* Event box — root-only colour so game-coloured spans keep their tint;
   bold is forced on every descendant (inheritance alone skips bold on
   anchors / table cells with lighter UA defaults). */
#eventboxFilled {
  color: #fff !important;
}
#eventboxFilled * {
  font-weight: bold !important;
}
/* Movement link — colour on the whole subtree, size/weight only on the
   anchor itself to avoid compounding "larger" through nested spans. */
a.ago_movement.tooltip.ago_color_lightgreen,
a.ago_movement.tooltip.ago_color_lightgreen * {
  color: #a0ff60 !important;
}
a.ago_movement.tooltip.ago_color_lightgreen {
  font-size: larger !important;
  font-weight: bold !important;
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
