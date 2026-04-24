// Anti-flicker: inject a pure-black background as early as possible
// (document_start) and remove it ~300ms after window 'load'.
//
// OGame reloads the full page on nearly every action (click on planet,
// tab switch, mission dispatch, auto-refresh). The browser's default
// white paint between unload and first render produces a white flash
// that is painful on a dark-theme game — especially at night.
//
// The fix is simple:
//   1. Inject `<style>html,body { background:#000 !important }</style>`
//      before the browser paints anything.
//   2. Remove the style 300ms after `window.load` so the real page
//      background (game assets / AGR theme) wins once fully rendered.
//
// Zero dependencies. Safe to call once per document (guarded by an id
// on the injected <style>).

const STYLE_ID = 'oge-black-bg';
const CLEANUP_DELAY_MS = 300;

/**
 * Inject the anti-flicker style and schedule its cleanup.
 * Must be called synchronously from the content-script entry, BEFORE
 * anything else that might throw. Idempotent per document.
 */
export const installBlackBackground = () => {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = 'html, body { background: #000 !important; }';
  (document.head || document.documentElement).appendChild(style);

  window.addEventListener('load', () => {
    setTimeout(() => {
      const el = document.getElementById(STYLE_ID);
      if (el) el.remove();
    }, CLEANUP_DELAY_MS);
  }, { once: true });
};
