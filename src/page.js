// @ts-check

// Entry — MAIN-world content script.
//
// Runs in the same JavaScript realm as the game, which lets us observe
// XHR objects the game itself creates. We NEVER issue requests here (per
// TOS) — every hook below attaches to a request the page had already
// decided to make. Two of them do more than read it: expeditionRedirect
// overrides the response the game reads, and ajaxTokenKeeper repairs a
// spent session token in the request the game is about to send. Neither
// changes how many requests leave the browser.
//
// Each hook is installed exactly once at module eval. `galaxyHook`,
// `checkTargetObserver`, `sendFleetHook`, and `expeditionRedirect`'s
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
//
// RUN_AT — this script MUST stay `document_start` (manifest.json).
//   It used to be `document_idle`, and that quietly made every hook here
//   blind to the game's page-INITIALISATION traffic. Measured on a 13.0
//   universe (HAR, 2026-07-28): the game's own `checkTarget` fires at
//   page+244 ms and a third-party script (AGR) submits fleet1 at +644 ms,
//   while `DOMContentLoaded` lands at +811 ms — i.e. the whole
//   fleet1→fleet2 handshake that produced the "try again" token error had
//   already happened before an idle-installed script existed. Same story
//   for the galaxy view's first fetch and the load-time eventbox refresh.
//   Every install below is written to tolerate an empty DOM and absent
//   page globals (fleetDispatcherSnapshot defers on `readyState`,
//   ajaxTokenKeeper re-seeds lazily), which is what makes this safe.

import { installAjaxTokenKeeper } from './bridges/ajaxTokenKeeper.js';
import { installGalaxyHook } from './bridges/galaxyHook.js';
import { installCheckTargetObserver } from './bridges/checkTargetObserver.js';
import { installSendFleetHook } from './bridges/sendFleetHook.js';
import { installFleetSaveSendHint } from './bridges/fleetSaveSendHint.js';
import { installExpeditionRedirect } from './bridges/expeditionRedirect.js';
import { installDeployRedirect } from './bridges/deployRedirect.js';
import { installFleetDispatcherSnapshot } from './bridges/fleetDispatcherSnapshot.js';
import { installEventBoxObserver } from './bridges/eventBoxObserver.js';
import { installTraderActionHook } from './bridges/traderActionHook.js';
import { installFleetExecutor } from './bridges/fleetExecutor.js';
import { installSendFleetResultHook } from './bridges/sendFleetResultHook.js';
import { installSystemDiscoveryObserver } from './bridges/systemDiscoveryObserver.js';

// FIRST, deliberately: keep the session's single rotating ajax token in sync
// with what the server last issued, so no script in the page (the game
// included) sends a spent one and eats the "try again" refusal. Install order
// is otherwise not load-bearing, but the earlier this one sees a response the
// fewer requests can go out on a retired token. See that module's header.
installAjaxTokenKeeper();
installGalaxyHook();
installCheckTargetObserver();
installSendFleetHook();
// Record a fleet-save send hint (true flight duration + expected landing) on
// every own sendFleet, so the FS classifier's flight-time gate can judge a leg
// it first observes late by its TRUE duration instead of the time remaining.
installFleetSaveSendHint();
installExpeditionRedirect();
// Rewrite the post-send redirect for fleet-save deployment sends. Unlike
// expeditionRedirect it computes nothing — the isolated-world dailyRun
// orchestrator hands it a precomputed URL via the `oge_dailyRunRedirect`
// localStorage key. See that module's header for the handoff contract.
installDeployRedirect();
// Publish window.fleetDispatcher state across the world boundary so
// isolated-world content scripts can read it. See that module's header
// for the cross-realm access problem it solves.
installFleetDispatcherSnapshot();
// Observe the eventbox refresh XHR so the isolated-world sendExpedition button
// can gate its click handler on a "fresh eventbox" signal — without
// this, a user tapping immediately on fleetdispatch enters Phase 2
// polling against a half-hydrated DOM and locks the button for 15 s.
installEventBoxObserver();
// Observe the two daily Trader actions (auctioneer bid / import trade) so
// the isolated-world trader highlight can clear the matching glow only
// when the player actually performs the action — not on a mere menu open.
installTraderActionHook();
// Perform the fleetdispatch actions the isolated world can't: ship
// selection + target/mission setting go through window.fleetDispatcher.
// The isolated-world fleet courier (features/shared/fleetCourier.js)
// drives this via oge:fd:cmd / oge:fd:res events. See that module's header.
installFleetExecutor();
// Publish the result of every sendFleet XHR so the courier's dispatch()
// can distinguish a real send from a 200-but-rejected one (e.g. no fuel).
installSendFleetResultHook();
// Observe the lifeform system-discovery send (sendSystemDiscoveryFleet) so
// the isolated-world Lifeforms button can mark the discovered system with a
// 7-day retention and read shipsSent / the fleet-cap rejection message.
installSystemDiscoveryObserver();
