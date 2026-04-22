// @ts-check

// Entry — MAIN-world content script.
//
// Runs in the same JavaScript realm as the game, which lets us observe
// XHR objects the game itself creates. We NEVER issue requests here —
// only passive hooks on response handling (per TOS; see DESIGN.md §3).
//
// Each hook is installed exactly once at module eval. They all patch
// `XMLHttpRequest.prototype` (`galaxyHook`, `checkTargetHook`,
// `sendFleetHook` via the shared `observeXHR` helper;
// `expeditionRedirect` via its own per-instance `open`/`send` override
// chain). The hooks dispatch `oge5:*` CustomEvents to the isolated
// world; `content.js` features listen for those.
//
// Order of install matters for a single subtlety: `expeditionRedirect`
// installs AFTER the three generic observer hooks so that its
// per-instance `open` override sees whatever `observeXHR`'s prototype
// patch did to `open`, not the other way around. In practice both
// orderings work today (the shared observer patches once then
// dispatches), but the convention keeps the feature-specific hook
// outermost so future refactors don't accidentally hide it behind the
// generic layer.

import { installGalaxyHook } from './bridges/galaxyHook.js';
import { installCheckTargetHook } from './bridges/checkTargetHook.js';
import { installSendFleetHook } from './bridges/sendFleetHook.js';
import { installExpeditionRedirect } from './bridges/expeditionRedirect.js';

// TEMP debug — remove once smoke-test confirms the MAIN-world script is
// being injected. Paired with the console.log in src/content.js.
console.log('[OG-E v5] page.js MAIN world — top-level entry reached');

installGalaxyHook();
installCheckTargetHook();
installSendFleetHook();
installExpeditionRedirect();
