// @ts-check

// Entry — MAIN-world content script.
//
// Runs in the same JavaScript realm as the game, which lets us observe
// XHR objects the game itself creates. We NEVER issue requests here —
// only passive hooks on response handling (per TOS).
//
// Each hook is installed exactly once at module eval. `galaxyHook`,
// `checkTargetHook`, `sendFleetHook`, and `expeditionRedirect`'s
// trigger all route through the shared `observeXHR` helper, which
// patches `XMLHttpRequest.prototype.open`/`send` once. The first three
// are pure observers — they read the response and dispatch `oge:*`
// CustomEvents to the isolated world. `expeditionRedirect`
// additionally overrides `responseText` per-instance on the matched
// XHR so the game's reader sees a rewritten `redirectUrl`.
// `fleetDispatcherSnapshot` is a different shape: it reads the
// page-world `window.fleetDispatcher` global and republishes a trimmed
// snapshot as an event after each `checkTarget` response.
//
// Install order is not load-bearing — every hook routes through the
// same shared observer, and the per-instance override only attaches
// inside its own handler.

import { installGalaxyHook } from './bridges/galaxyHook.js';
import { installCheckTargetHook } from './bridges/checkTargetHook.js';
import { installSendFleetHook } from './bridges/sendFleetHook.js';
import { installExpeditionRedirect } from './bridges/expeditionRedirect.js';
import { installFleetDispatcherSnapshot } from './bridges/fleetDispatcherSnapshot.js';

installGalaxyHook();
installCheckTargetHook();
installSendFleetHook();
installExpeditionRedirect();
// Publish window.fleetDispatcher state across the world boundary so
// isolated-world content scripts can read it. See that module's header
// for the cross-realm access problem it solves.
installFleetDispatcherSnapshot();
