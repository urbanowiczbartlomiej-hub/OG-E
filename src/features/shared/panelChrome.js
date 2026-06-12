// Shared "OGame-native" visual chrome for OG-E's rectangular surfaces:
// the abandon overlay (`#oge-abandon-overlay`), the fresh-planet banner
// (`#oge-fresh-planet-banner`) and the proxy action buttons injected
// into the game's abandon popups.
//
// This is the rectangular sibling of `buttonChrome.js`: the same design
// tokens (dark `--surface` core, state colour in `--rim`, rim thread +
// outer glow + deep drop shadows, `oge-alert`-style pulse cadences) so
// every OG-E surface reads as one HUD family — but without the circle
// specifics (50% radius, ring SVG, ripple) that make no sense on a
// panel. Kept separate so neither stylesheet carries dead rules for the
// other shape.
//
//   1. installPanelChrome() — injects ONE `<style id="oge-panel-chrome">`
//      (idempotent) with the `.oge-panel` ruleset: tinted radial surface,
//      rim thread, glow, hover/active feedback and the `data-flag`
//      pulse animations (`error` fast, `wait` slow — same cadences as
//      the buttons).
//
//   2. Callers add `oge-panel` to their element, set `--rim` (and
//      optionally `data-flag`) inline, and keep ONLY their layout
//      styles (position, size, padding) inline. State colour and
//      elevation live here, in one place.
//
// The classes are OG-E's OWN injected surface (NOT the game's fragile
// DOM contract — see CLAUDE.md). The CSS is a pure exported constant so
// the rules can be asserted in a test without measuring pixels.
//
// @see ./buttonChrome.js — the circular counterpart these tokens mirror.

/** @ts-check */

/** Id of the singleton <style> element this module injects. */
export const PANEL_CHROME_STYLE_ID = 'oge-panel-chrome';

/** Class callers put on a panel-shaped surface. */
export const PANEL_CLASS = 'oge-panel';

/**
 * The HUD panel CSS. State colour lives in `--rim` (set per element via
 * inline style); the translucent dark `--surface` keeps the game art
 * faintly visible underneath (the abandon overlay sits on the planet
 * image on purpose). Exported as a pure string so a test can assert it
 * carries the right class selectors.
 */
export const PANEL_CHROME_CSS = [
  // ── Surface: dark tinted core, rim thread, glow, elevation ──────────────
  '.oge-panel{',
  '--surface:rgb(11 18 32/.94);--rim:#38bdf8;--glow:1;--label:#f8fafc;',
  'color:var(--label);',
  'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Verdana,sans-serif;',
  'font-weight:700;border:none;border-radius:14px;',
  'background:radial-gradient(140% 130% at 50% 0%,',
  'color-mix(in oklab,var(--rim) 24%,var(--surface)) 0%,',
  'var(--surface) 68%);',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.07),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 55%,transparent),',
  '0 0 calc(24px * var(--glow)) -6px var(--rim),',
  '0 18px 36px -12px rgba(0,0,0,.72),',
  '0 4px 12px -2px rgba(0,0,0,.5);',
  'text-shadow:0 1px 2px rgba(0,0,6,.45);',
  '-webkit-user-select:none;user-select:none;',
  'transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .2s ease,filter .12s ease;}',

  // ── Hover / active (panels are tap targets, same feedback as buttons) ───
  '.oge-panel:hover{filter:brightness(1.08);',
  'box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.09),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 70%,transparent),',
  '0 0 calc(30px * var(--glow)) -4px var(--rim),',
  '0 22px 40px -12px rgba(0,0,0,.74),',
  '0 4px 12px -2px rgba(0,0,0,.5);}',
  '.oge-panel:active{transform:scale(.985);}',

  // ── Typography helpers (shared so panels agree on hierarchy) ────────────
  // Title: small caps-style header tinted toward the rim, like ring titles.
  '.oge-panel .oge-panel-title{',
  'text-transform:uppercase;letter-spacing:2px;',
  'color:color-mix(in oklab,var(--rim) 70%,#f8fafc);}',
  // Hint: quiet slate footer line ("click to …").
  '.oge-panel .oge-panel-hint{',
  'text-transform:uppercase;letter-spacing:1px;font-weight:600;',
  'color:#94a3b8;text-shadow:none;}',

  // ── State flag pulse (same cadences as the buttons' oge-alert) ──────────
  '.oge-panel[data-flag~="error"]{animation:oge-panel-alert 1.6s ease-in-out infinite;}',
  '.oge-panel[data-flag~="wait"]{animation:oge-panel-alert 2.4s ease-in-out infinite;}',
  '@keyframes oge-panel-alert{',
  '0%,100%{box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.07),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 55%,transparent),',
  '0 0 22px -8px var(--rim),0 18px 36px -12px rgba(0,0,0,.72),0 4px 12px -2px rgba(0,0,0,.5);}',
  '50%{box-shadow:',
  'inset 0 1px 0 rgba(255,255,255,.1),',
  'inset 0 0 0 1.5px color-mix(in oklab,var(--rim) 80%,transparent),',
  '0 0 34px -2px var(--rim),0 18px 36px -12px rgba(0,0,0,.72),0 4px 12px -2px rgba(0,0,0,.5);}}',

  // ── Reduced motion ───────────────────────────────────────────────────────
  '@media (prefers-reduced-motion:reduce){',
  '.oge-panel{transition:none;}',
  '.oge-panel[data-flag]{animation:none;}}',
].join('');

/**
 * Inject the shared panel chrome stylesheet exactly once. Idempotent.
 *
 * @returns {void}
 */
export const installPanelChrome = () => {
  if (document.getElementById(PANEL_CHROME_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PANEL_CHROME_STYLE_ID;
  style.textContent = PANEL_CHROME_CSS;
  (document.head || document.documentElement).appendChild(style);
};
