// @ts-check
//
// Shared debounced autosave for the dashboard's per-universe config editors
// (routes / scanConfig / alarmClockConfig). One implementation of the subtle
// part — the debounce timer, the universe captured at SCHEDULE time, and the
// flush semantics — so a fix here fixes every editor at once (the three
// hand-rolled copies had already drifted apart).
//
// # The captured-universe contract
//
// `schedule()` records the universe the edit belongs to; when the timer fires
// (or `flush()` runs), `save(universeId)` receives THAT id — never a live
// re-read. All editor keys are per-universe, so a save for the previous
// universe is always valid; passing the id (instead of aborting on a
// mismatch, as the first version did) is what makes flush-on-switch safe: an
// edit made moments before the user switches universes is persisted for the
// universe it was made in, not dropped.
//
// # Flush points
//
// The owning editor calls `flush()` at the top of its `refresh()` (universe
// switch), and the helper itself flushes on `pagehide` — closing the
// dashboard tab inside the debounce window must not silently discard the
// user's last edit (best-effort: the storage write races tab teardown, which
// is still strictly better than never issuing it).
//
// # save() must snapshot synchronously
//
// `save(uni)` runs while a universe switch may be mid-flight: it MUST read
// everything it persists (widgets, in-memory model) synchronously before its
// first `await`, so a concurrent `refresh()` repainting the editor for the
// next universe can't bleed into the old universe's payload. Each editor's
// save documents this at its definition.

/**
 * @param {object} opts
 * @param {() => string} opts.getUniverseId  Resolves the ACTIVE universe; read
 *   at schedule time only (see the captured-universe contract above).
 * @param {(universeId: string) => void | Promise<void>} opts.save
 * @param {number} [opts.delayMs]
 * @returns {{ schedule: () => void, flush: () => void, dispose: () => void }}
 */
export const createAutosave = ({ getUniverseId, save, delayMs = 500 }) => {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let uni = '';

  const fire = () => {
    timer = null;
    if (uni) void save(uni);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    uni = getUniverseId();
    timer = setTimeout(fire, delayMs);
  };

  /** Run a pending save NOW (universe switch, tab close). No-op when idle. */
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    fire();
  };

  window.addEventListener('pagehide', flush);

  return {
    schedule,
    flush,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      window.removeEventListener('pagehide', flush);
    },
  };
};
