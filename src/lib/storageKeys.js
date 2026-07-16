// Shared storage-key constants — the one place both worlds agree on the
// raw localStorage / chrome.storage key strings.
//
// These bare string consts live in `lib/` (the dependency-free foundation)
// specifically so MAIN-world bridges can import a key without dragging in
// the isolated-world `state/` store machinery. Importing a const from a
// `state/` module is not free: those modules run a top-level
// `createStore(...)` and reference `chrome.storage`, neither of which exists
// in the MAIN-world page bundle. Keeping the canonical key strings here
// keeps `bridges/ → lib only` true while letting the reactive stores in
// `state/` re-export the same string (so isolated-world importers are
// unchanged).
//
// Pure data: no imports, no side effects.

/**
 * localStorage key for the colonization registry (pending colonize fleets).
 * Owned by `state/registry.js` (reactive store); written by hand from
 * `bridges/sendFleetHook.js` in the MAIN world.
 */
export const REGISTRY_KEY = 'oge_colonizationRegistry';

/**
 * localStorage key for the one-shot Daily Run redirect hint. A transient,
 * non-namespaced value the isolated world writes before dispatch and
 * `bridges/deployRedirect.js` consumes to rewrite the post-send redirect.
 * Owned (and re-exported) by `state/dailyRunRoutes.js`.
 */
export const DAILY_RUN_REDIRECT_KEY = 'oge_dailyRunRedirect';

/**
 * localStorage key for fleet-save send hints — one small record per own
 * fleet SEND, captured at dispatch time by `bridges/fleetSaveSendHint.js`
 * (MAIN world, written by hand via `safeLS`) and read by the alarmClock
 * producer (isolated world, via `state/fsSendHints.js`). A hint carries the
 * TRUE flight duration the event list can never tell us, so the FS
 * classifier's minimum-flight-time gate doesn't mis-read a long fleet-save
 * first observed late (hidden tab, killed debounce, reload near arrival) as
 * a short hop. Self-pruning: entries expire shortly after their leg lands.
 */
export const FS_SEND_HINTS_KEY = 'oge_fsSendHints';
