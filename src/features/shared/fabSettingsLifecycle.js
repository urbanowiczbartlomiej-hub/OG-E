// features/shared/fabSettingsLifecycle.js
//
// The settings-driven mount/teardown wiring shared verbatim by every
// send* FAB feature (sendExpedition / sendColony / sendLifeform). Each
// feature owns its own `mount` / `removeButton` / `updateButtonSize` —
// what gets painted and how is feature-specific — but the wiring ABOVE
// those is identical boilerplate:
//
//   • on install, mount once when `fabMode` is on (deferring to
//     DOMContentLoaded when `document.body` isn't ready yet);
//   • react to live `fabMode` flips (mount / remove) and `fabBtnSize`
//     edits (live resize), ignoring every other settings field.
//
// Pulling it here keeps each orchestrator down to its own decision logic
// and gives the wiring a single tested home. No DOM is read beyond
// `document.body` / the DOMContentLoaded event; the store is injected so
// this stays decoupled from `state/` (type-only JSDoc reference, erased
// at runtime — invisible to the import-zone lint rule).

/**
 * @typedef {import('../../lib/createStore.js').Store<
 *   import('../../state/settings.js').Settings
 * >} SettingsStore
 */

/**
 * Wire the standard FAB settings lifecycle. Returns the settings-store
 * unsubscribe so the caller can drop it from its own `dispose`.
 *
 * The deferred initial mount re-checks `isInstalled()` because a dispose
 * can land between install and DOMContentLoaded; without the guard a
 * torn-down feature would still mount its button.
 *
 * @param {object} cfg
 * @param {SettingsStore} cfg.settingsStore  the global settings store.
 * @param {() => void} cfg.mount  build + attach the button (no-op safe to
 *   call only when unmounted — callers guarantee that here).
 * @param {() => void} cfg.removeButton  detach the button; safe unmounted.
 * @param {(size: number) => void} cfg.updateButtonSize  live-resize the
 *   mounted button; no-op when unmounted.
 * @param {() => boolean} cfg.isInstalled  guards the deferred mount
 *   against a dispose that runs before DOMContentLoaded fires.
 * @param {() => void} [cfg.onSettingsChange]  extra reaction run on EVERY
 *   settings notification (sendColony repaints here; others omit it).
 * @returns {() => void} the settings-store unsubscribe.
 */
export const installFabSettingsLifecycle = ({
  settingsStore,
  mount,
  removeButton,
  updateButtonSize,
  isInstalled,
  onSettingsChange,
}) => {
  // Initial render based on current settings.
  const initial = settingsStore.get();
  if (initial.fabMode) {
    if (document.body) {
      mount();
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          // Re-check in case dispose ran before DOMContentLoaded fired.
          if (isInstalled() && settingsStore.get().fabMode) mount();
        },
        { once: true },
      );
    }
  }

  // Live settings reactions. React ONLY to the two fields we care about —
  // the settings store carries the whole panel, so unrelated edits would
  // otherwise spam this callback.
  let prevFabMode = initial.fabMode;
  let prevFabBtnSize = initial.fabBtnSize;
  return settingsStore.subscribe((next) => {
    if (next.fabMode !== prevFabMode) {
      if (next.fabMode) {
        if (document.body) mount();
      } else {
        removeButton();
      }
      prevFabMode = next.fabMode;
    }
    if (next.fabBtnSize !== prevFabBtnSize) {
      updateButtonSize(next.fabBtnSize);
      prevFabBtnSize = next.fabBtnSize;
    }
    onSettingsChange?.();
  });
};
