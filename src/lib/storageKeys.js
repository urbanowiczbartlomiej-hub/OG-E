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
 * localStorage key for the one-shot fleetsave redirect hint. A transient,
 * non-namespaced value the isolated world writes before dispatch and
 * `bridges/deployRedirect.js` consumes to rewrite the post-send redirect.
 * Owned (and re-exported) by `state/fsRoutes.js`.
 */
export const FS_REDIRECT_KEY = 'oge_fsRedirect';
