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
import { installDeployRedirect } from './bridges/deployRedirect.js';
import { installFleetDispatcherSnapshot } from './bridges/fleetDispatcherSnapshot.js';
import { installEventBoxHook } from './bridges/eventBoxHook.js';
import { installTraderActionHook } from './bridges/traderActionHook.js';
import { installFleetExecutor } from './bridges/fleetExecutor.js';

installGalaxyHook();
installCheckTargetHook();
installSendFleetHook();
installExpeditionRedirect();
// Rewrite the post-send redirect for fleet-save deployment sends. Unlike
// expeditionRedirect it computes nothing — the isolated-world fsCollect
// orchestrator hands it a precomputed URL via the `oge_fsRedirect`
// localStorage key. See that module's header for the handoff contract.
installDeployRedirect();
// Publish window.fleetDispatcher state across the world boundary so
// isolated-world content scripts can read it. See that module's header
// for the cross-realm access problem it solves.
installFleetDispatcherSnapshot();
// Observe the eventbox refresh XHR so the isolated-world sendExp button
// can gate its click handler on a "fresh eventbox" signal — without
// this, a user tapping immediately on fleetdispatch enters Phase 2
// polling against a half-hydrated DOM and locks the button for 15 s.
installEventBoxHook();
// Observe the two daily Trader actions (auctioneer bid / import trade) so
// the isolated-world trader highlight can clear the matching glow only
// when the player actually performs the action — not on a mere menu open.
installTraderActionHook();
// Perform the fleetdispatch actions the isolated world can't: ship
// selection + target/mission setting go through window.fleetDispatcher.
// The isolated-world fleet courier (features/shared/fleetCourier.js)
// drives this via oge:fd:cmd / oge:fd:res events. See that module's header.
installFleetExecutor();
