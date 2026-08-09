// @ts-check

// Remembered START body for an expedition cycle — one `cp` id in localStorage
// so a fresh cycle always begins on the SAME planet (or moon) instead of
// wherever the player happened to be standing.
//
// # Why this exists
//
// The expedition FAB's off-fleetdispatch tap walks `#planetList` from the
// ACTIVE row and takes the first body with a free slot. Mid-cycle that is
// exactly right (it is the round-robin continuation the auto-redirect drives).
// But at the START of a cycle — nothing in flight — "the active row" is
// arbitrary: it is whichever body the player was last looking at, so the cycle
// begins at a different place every day and the send order drifts.
//
// So we record ONE thing: the body the player sent the cycle's FIRST
// expedition from. The next time a cycle starts (nothing in flight) from a
// page that is NOT fleetdispatch, the FAB navigates there first and the
// round-robin walk continues from that fixed anchor.
//
// Write point (`features/sendExpedition/index.js`): the moment a send actually
// succeeds while the expedition list was still EMPTY. That is what makes the
// memory self-bootstrapping (no memory ⇒ today's behaviour picks a body, the
// send from it records it) and self-correcting (want a different anchor? send
// the first expedition of a cycle from there).
//
// Nothing subscribes to this — the FAB reads it on demand inside a click
// handler — so it is a sanctioned plain key-owner over `safeLS` with no
// reactive store (see CLAUDE.md's `state/` rules), mirroring
// `state/coloArrival.js`. Per-origin localStorage = per-universe scoping (each
// OGame universe is its own subdomain), which is what we want: the anchor is
// meaningless across servers.
//
// Staleness (the body was abandoned / sold, so the `cp` is no longer on the
// planet list) is the READER's concern — `features/sendExpedition/domHelpers.js`
// validates the id against the live list and falls back to the normal walk.
// This module just hands back what was stored.

import { safeLS } from '../lib/storage.js';

/** localStorage key holding the remembered expedition-start `cp`. */
export const EXP_START_CP_KEY = 'oge-exp-start-cp';

/**
 * The remembered start body's `cp` id. `0` = nothing remembered yet (the
 * caller then keeps the plain "first body with a free slot" behaviour).
 *
 * @returns {number}
 */
export const readExpStartCp = () => {
  const cp = safeLS.int(EXP_START_CP_KEY, 0);
  return cp > 0 ? cp : 0;
};

/**
 * Record the start body's `cp`. A non-positive value clears the memory
 * (so a caller that couldn't read the active body doesn't persist garbage).
 *
 * @param {number} cp
 * @returns {void}
 */
export const writeExpStartCp = (cp) => {
  if (cp > 0) safeLS.set(EXP_START_CP_KEY, String(cp));
  else safeLS.remove(EXP_START_CP_KEY);
};
