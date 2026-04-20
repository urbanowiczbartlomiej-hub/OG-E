// Entry — MAIN-world content script.
//
// Runs in the same JavaScript realm as the game, which lets us observe
// XHR objects the game itself creates. We NEVER issue requests here —
// only passive hooks on response handling (per TOS; see DESIGN.md §3).
//
// Currently empty. Bridge modules (galaxyHook, checkTargetHook,
// sendFleetHook, expeditionRedirect) plug in as the rewrite progresses.

// Phase-6 placeholder. Bridges land here in DESIGN.md §16 step 6.
