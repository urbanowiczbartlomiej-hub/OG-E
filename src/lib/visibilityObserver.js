// @ts-check
//
// A MutationObserver that only watches while the tab is VISIBLE.
//
// While the tab is hidden it disconnects entirely, so OG-E reacts to ZERO
// game-DOM changes while the player is away — the ToolDev toleration
// condition ("never track the game while the player is not present"). On
// regaining visibility it reconnects every tracked target with its options and
// fires the callback once, so any change missed while away is reconciled (the
// cosmetic re-render snaps to the truth the moment the player can see it again).
//
// Drop-in for `new MutationObserver(cb)`: exposes the same
// `observe(target, options)` / `disconnect()` surface, and — like the native
// observer — `observe()` is ADDITIVE, so a feature can watch several nodes with
// one instance. Foundation module: DOM only, no app-layer imports.

/**
 * @typedef {object} VisibilityObserver
 * @property {(target: Node, options?: MutationObserverInit) => void} observe
 *   Track `target` and watch it while visible. Additive across calls.
 * @property {() => void} disconnect  Stop watching and drop all tracked targets.
 */

/**
 * @param {MutationCallback} callback
 * @returns {VisibilityObserver}
 */
export const createVisibilityObserver = (callback) => {
  const mo = new MutationObserver(callback);
  /** @type {Array<{ target: Node, options?: MutationObserverInit }>} */
  const targets = [];
  let watching = false;

  const start = () => {
    if (watching || document.hidden || targets.length === 0) return;
    for (const t of targets) mo.observe(t.target, t.options);
    watching = true;
  };
  const stop = () => {
    if (!watching) return;
    mo.disconnect(); // drops every observation; re-added from `targets` on resume
    watching = false;
  };

  const onVisibility = () => {
    if (document.hidden) {
      stop();
      return;
    }
    start();
    // Snap: reconcile anything that changed while we were away, the moment the
    // player can see it again. The callbacks are idempotent re-renders.
    callback([], mo);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    observe: (target, options) => {
      targets.push({ target, options });
      // Native observe() is additive; mirror that when already running.
      if (watching && !document.hidden) mo.observe(target, options);
      else start();
    },
    disconnect: () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      targets.length = 0;
    },
  };
};
