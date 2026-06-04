// Shared "OGame-native" visual chrome for the three floating draggable
// buttons: sendExp (`#oge-send-exp`), sendCol (`#oge-send-col`) and
// fsCollect (`#oge-fs-unified`).
//
// Each button sets its OWN per-state background colour inline
// (idle / ready / stale / error …). This module adds the decorative
// layer that is identical for all three and that inline styles on a
// split (two-zone) element cannot express: a pseudo-element overlay
// (`::after`) carrying the OGame look —
//
//   • a thin light rim                       ("obwódka")
//   • an inset edge-vignette (darkened rim)  ("przyciemnienia na krawędziach")
//   • a soft top sheen for a glassy bevel
//
// painted ABOVE the (possibly split) coloured zones, so the per-state
// paint logic in each feature stays untouched. A single
// `<style id="oge-btn-chrome">` is injected once and is idempotent.
//
// Lives in features/shared/ because it injects into `document`; the CSS
// itself is a pure exported constant so the rules can be asserted in a
// test without measuring rendered pixels. The ids/classes referenced
// here are OG-E's OWN injected surface (NOT the game's fragile DOM
// contract — see CLAUDE.md), so the design lives next to the buttons
// that emit it rather than in `lib/gameDom.js`.
//
// @see ./draggableButton.js — drag/focus wiring for the same buttons.

/** @ts-check */

/** Id of the singleton <style> element this module injects. */
export const CHROME_STYLE_ID = 'oge-btn-chrome';

/**
 * The OGame-style decorative CSS shared by all three floating buttons.
 * Exported as a pure string so a test can assert it targets the three
 * button ids and carries the rim / vignette / sheen overlay.
 *
 * The `::after` overlay is `pointer-events:none` so taps fall through to
 * the underlying button / zones, and is clipped to the circle by the
 * wrapper's own `border-radius:50%` (+ `overflow:hidden` on the split
 * buttons). It paints on top of the non-positioned flex zones, giving
 * every button the same rim and edge-darkening regardless of which
 * per-state colour the feature painted underneath.
 */
export const BUTTON_CHROME_CSS = [
  '#oge-send-exp::after,#oge-send-col::after,#oge-fs-unified::after{',
  'content:"";position:absolute;inset:0;border-radius:50%;',
  'pointer-events:none;z-index:2;',
  'box-shadow:',
  'inset 0 0 0 1px rgba(196,224,247,0.40),', // crisp light rim
  'inset 0 0 16px 3px rgba(0,0,0,0.55),', // edge vignette
  'inset 0 2px 4px rgba(255,255,255,0.20);', // top bevel highlight
  'background:radial-gradient(circle at 50% 26%,',
  'rgba(255,255,255,0.16),rgba(255,255,255,0) 58%);', // glassy sheen
  '}',
  // Suppress the default focus ring: the buttons auto-restore focus on
  // load (see draggableButton.js), so a native outline would otherwise
  // sit permanently on one of them. The rim above is identity enough.
  '#oge-send-exp:focus,#oge-send-col button:focus,#oge-fs-unified button:focus',
  '{outline:none;}',
].join('');

/**
 * Inject the shared button chrome stylesheet exactly once. Idempotent:
 * a second call (e.g. another feature mounting) is a no-op once the
 * `<style id="oge-btn-chrome">` element exists.
 *
 * @returns {void}
 */
export const installButtonChrome = () => {
  if (document.getElementById(CHROME_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = CHROME_STYLE_ID;
  style.textContent = BUTTON_CHROME_CSS;
  (document.head || document.documentElement).appendChild(style);
};
