// @ts-check

// Fleet GUARDIAN feature — the in-game half of the post-landing watch.
//
// The watch itself is the unified FLEET-REMINDER store
// (`state/fleetReminders.js`): the producer arms a body there when a detected
// fleet-save LANDS, and the fleet1 chip (`features/manualFsMark`) arms it by
// hand — one synced, per-body set, the same one the planet badges read. This
// feature is purely the loud SURFACE on top: ONE floating warning button while
// any reminder is armed —
//
//   - TAP        → off the bare body: navigate to it (moon vs planet picked
//                  from the bodyKey `type`). On the bare body's fleetdispatch:
//                  a two-tap AGR fleet-save (routine 6) mirroring the expedition
//                  button — first tap prepares, second dispatches — then the
//                  reminder is cleared (the fleet is back in motion).
//   - LONG-PRESS → clear this reminder (the "fleet is gone / I've got it"
//                  back-door); the shared button's charge-sweep makes the hold a
//                  conscious act, not a reflex.
//
// Those two, plus un-toggling the fleet1 chip, are the ONLY ways a reminder
// clears — deliberately no automatic clearing on fleet activity (a small
// "technical" send used to kill the watch while the real fleet still sat).
//
// This feature never talks to ntfy directly. The matching OFFLINE push (one
// escalation per armed body, at landing + interval) is driven by the producer
// (`producer.js` → `sync/alarmClock` → `ntfyReconciler.reconcileGuardianQueue`);
// the ack + dismiss taps delegate to the producer's commands, which snooze or
// clear it. The ack is a DURABLE, self-expiring, single-device store
// (`./guardianDismiss.js`); the dismiss is the synced FR tombstone itself.
//
// Lives INSIDE the alarmClock feature (installed by `./index.js`).
//
// @see ../../state/fleetReminders.js — the unified watch set.

import { EVENT_BOX_LOADED_EVENT, FLEET_REMINDER_CHANGED_EVENT } from '../../lib/ogeEvents.js';
import { GAME } from '../../lib/gameDom.js';
import { denseCoords, bodyKey as toBodyKey } from '../../domain/bodies.js';
import { readCurrentBody } from '../shared/currentBody.js';
import { clock } from '../../lib/clock.js';
import { createButton, labelLines } from '../shared/button.js';
import { installButtonChrome } from '../shared/buttonChrome.js';
import { LIGHTHOUSE_GLYPH } from '../shared/buttonGlyphs.js';
import { setFabModuleAlert } from '../shared/unifiedFab.js';
import { prepareViaRoutine, dispatchPrepared } from '../shared/agrRoutine.js';
import { OWNER_FS } from '../../domain/fleetOwnership.js';
import { settingsStore } from '../../state/settings.js';
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { readFleetReminders } from '../../state/fleetReminders.js';

/** OG-E's own button id (not a game contract). */
const BTN_ID = 'oge-guardian-btn';
/** A deliberate, hard-to-fat-finger hold to dismiss a landing. */
const DISMISS_HOLD_MS = 1500;
/** Warning rim/glow colour — bright orange (the dome gradient shades it);
 *  pumped up a notch so the guardian reads louder than the other FAB modules. */
const RIM = '#f5851a';
/** AGR's fleet-save routine id (the guardian's send action). */
const FS_ROUTINE_ID = 6;

/**
 * @typedef {object} BareFleet
 * @property {string} bodyKey  `g:s:p:type`.
 * @property {string} coords   `g:s:p` (display + planet-list match).
 * @property {number} type     1 = planet, 3 = moon.
 * @property {number} landedAt
 */

/** @type {import('../shared/button.js').Button | null} */
let btn = null;
/** @type {BareFleet[]} The current bare set; the button's handlers read it live. */
let bare = [];
/** Producer command: clear a body's fleet reminder + sweep its ntfy push. */
let dismissFn = /** @type {(bodyKey: string) => void} */ (() => {});
/** Producer command: snooze a body's push by the interval (the "I'm on it" ack). */
let ackFn = /** @type {(bodyKey: string) => void} */ (() => {});
/** Current FAB diameter (settings-driven), shared with the command modules. */
let fabSize = 56;
/** Guard against re-entrant taps while a fleet-save send is in flight. */
let busy = false;
/**
 * Epoch SECONDS of the current page's load — our presence proxy. Any page reload
 * re-inits this module (back to "now"); an ack tap also resets it. The pulse
 * arms once `now - activeAt` crosses the configured ACK interval.
 */
let activeAt = Math.floor(Date.now() / 1000);
/** Whether the NEXT off-fleetdispatch tap should navigate (armed by a prior ack). */
let navArmed = false;
/** The pulse poll subscription — lives only while the button is mounted. */
let unsubClock = /** @type {(() => void) | null} */ (null);
/** Timer that disarms the two-step navigation and repaints to the idle face. */
let navTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

/** Configured "minutes idle before pulsing for an ACK", in seconds (min 60). */
const ackIntervalSec = () =>
  Math.max(60, (galaxyScanConfigStore.get().guardianAckIntervalMin || 3) * 60);

/**
 * Navigate to the bare fleet's body's FLEET-DISPATCH page (ready to re-save) via
 * the left planet list — moon vs planet picked from `type` (3 = moon, else
 * planet). Reuses the planet-list link's own `cp` + base URL and swaps the
 * component to `fleetdispatch`; falls back to the plain link if it carries no `cp`.
 *
 * @param {BareFleet} t
 * @returns {void}
 */
const navigateToBody = (t) => {
  for (const sp of document.querySelectorAll(GAME.SMALL_PLANET_ONLY)) {
    if (denseCoords(sp.querySelector(GAME.PLANET_KOORDS)?.textContent) !== t.coords) continue;
    const href = sp
      .querySelector(t.type === 3 ? GAME.MOON_LINK : GAME.PLANET_LINK)
      ?.getAttribute('href');
    if (!href) return;
    const u = new URL(href, location.href);
    if (u.searchParams.get('cp')) {
      u.searchParams.set('page', 'ingame');
      u.searchParams.set('component', 'fleetdispatch');
      window.location.href = u.href;
    } else {
      window.location.href = href;
    }
    return;
  }
};

/**
 * Body key (`g:s:p:type`) of the body the current page belongs to, or ''
 * when unreadable. Type-aware on purpose: a bare fleet on PLANET A and the
 * page being MOON A's fleetdispatch share coords but are different bodies —
 * saving from the wrong one is exactly what the tap gate prevents.
 */
const currentBodyKey = () => {
  const b = readCurrentBody();
  return b ? toBodyKey(`${b.galaxy}:${b.system}:${b.position}`, b.type) : '';
};

/**
 * Repaint the idle button face. OG-E does NOT watch the game — this button is
 * here only because YOU landed a fleet yourself. The primary word splits by
 * context: away from a BARE body's fleetdispatch it's "You here?" (a tap there
 * only confirms you're present + snoozes — it never yanks you away); on a bare
 * body's own fleetdispatch it's the actionable "Fleet save". A fleetdispatch
 * page of some OTHER body counts as "away" — the tap there won't save (see
 * handleGuardianTap's active-body gate), so the label must not promise it.
 * Subtitle = landing coords (`+n` for extras); hint = hold-to-dismiss.
 */
const paint = () => {
  if (!btn || bare.length === 0) return;
  const t = bare[0];
  const sub = bare.length > 1 ? `${t.coords} +${bare.length - 1}` : t.coords;
  const onBareDispatch =
    location.search.includes('component=fleetdispatch') &&
    bare.some((b) => b.bodyKey === currentBodyKey());
  btn.paintLines('g', labelLines({
    main: onBareDispatch ? 'Fleet save' : 'You here?',
    sub,
    hint: '(hold to skip)',
  }));
};

/**
 * ACK confirmed → you snoozed it by being here; invite the second (navigating)
 * tap. @param {{ coords: string }} t
 */
const paintAcked = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Snoozed', sub: t.coords, hint: 'tap → save' }));

/**
 * Re-evaluate the pulse. ON once we've gone the configured ACK interval with no
 * page reload or ack (the player seems parked while a fleet sits bare); OFF
 * otherwise. Visibility-gated by the shared clock, so a hidden tab never pulses.
 *
 * @returns {void}
 */
const pulseTick = () => {
  if (!btn || bare.length === 0) {
    setFabModuleAlert('guard', false);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - activeAt;
  const interval = ackIntervalSec();
  btn.setProgress(Math.min(elapsed / interval, 1));
  setFabModuleAlert('guard', elapsed >= interval);
};

/**
 * The light "I'm here" ack: reset the presence clock (silences the pulse) and
 * snooze the body's ntfy push by the interval — WITHOUT leaving the page. Used by
 * the first off-fleetdispatch tap; the second tap then navigates.
 *
 * @param {BareFleet} t
 * @returns {void}
 */
const ackPresence = (t) => {
  activeAt = Math.floor(Date.now() / 1000);
  ackFn(t.bodyKey);
  setFabModuleAlert('guard', false);
  btn?.setProgress(0);
};

/**
 * Clear the primary bare fleet's reminder (the long-press back-door): the
 * producer command writes the synced FR tombstone and sweeps the ntfy push.
 */
const dismissPrimary = () => {
  const t = bare[0];
  if (!t) return;
  navArmed = false;
  if (navTimer) {
    clearTimeout(navTimer);
    navTimer = null;
  }
  dismissFn(t.bodyKey); // hold = "it's gone"
  refresh();
};

/** "Wait…" while AGR's routine is being driven. */
const paintBusy = () =>
  btn?.paintLines('g', labelLines({ main: 'Wait…', sub: bare[0]?.coords, hint: '' }));
/** Prepared → invite the second tap. @param {{ coords: string }} t */
const paintReady = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Send FS', sub: t.coords, hint: '' }));
/** Dispatched. @param {{ coords: string }} t */
const paintSent = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Saved', sub: t.coords, hint: '' }));
/** AGR's fleet-save routine is disabled — tell the user where to enable it. */
const paintFsOff = () =>
  btn?.paintLines('g', labelLines({ main: 'FS off', sub: 'enable Fleet', hint: 'Save in AGR' }));

/**
 * The two-step flow used whenever the tap can NOT fleet-save right here
 * (off fleetdispatch, or on the WRONG body's fleetdispatch), so the pulse
 * never yanks the player away by reflex. FIRST tap = ACK only (silence the
 * pulse, snooze the push, stay put). A SECOND tap (while armed) navigates
 * to the bare body to save.
 *
 * @param {BareFleet} t
 * @returns {void}
 */
const ackOrNavigate = (t) => {
  if (navArmed) {
    navigateToBody(t);
    return;
  }
  ackPresence(t);
  navArmed = true;
  paintAcked(t);
  if (navTimer) clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    navTimer = null;
    navArmed = false;
    paint();
  }, 5000);
};

/**
 * Button TAP. Two-tap fleet-save flow, mirroring sendExpedition:
 *   - Off the bare body's fleetdispatch (any other page, OR fleetdispatch of
 *     a DIFFERENT body) → ack ("I'm on it") + navigate to the primary bare
 *     body.
 *   - On a bare body's fleetdispatch, fleet2 NOT up yet → prepare AGR's
 *     fleet-save routine (6) and flip to "Send FS".
 *   - On a bare body's fleetdispatch, fleet2 up → fire the dispatch, then drop
 *     the watch (the fleet is back in motion).
 *
 * @returns {Promise<void>}
 */
const handleGuardianTap = async () => {
  if (busy) return;
  const t = bare[0];
  if (!t) return;

  if (!location.search.includes('component=fleetdispatch')) {
    ackOrNavigate(t);
    return;
  }

  // On fleetdispatch → only drive the fleet-save when the ACTIVE body is one
  // of the bare ones. The page alone is NOT enough: fleetdispatch opens on
  // whatever body is currently selected, and AGR's routine would happily save
  // THAT fleet — so with planet A bare and the player on planet B's (or even
  // moon A's) fleet page, an ungated tap fleet-saves the wrong fleet. Wrong
  // (or unreadable) body → same two-step as off-page: ack, then navigate.
  const here = currentBodyKey();
  const target = here ? bare.find((b) => b.bodyKey === here) : undefined;
  if (!target) {
    ackOrNavigate(t);
    return;
  }

  busy = true;
  try {
    // Phase 1 — fleet2 already prepared → fire the fleet save.
    if (document.querySelector(GAME.FD_DISPATCH) && document.getElementById(GAME.AGO_FLEET2_MAIN)) {
      const r = dispatchPrepared({ owner: OWNER_FS });
      if (r === 'sent') {
        paintSent(target);
        dismissFn(target.bodyKey); // saved → clear the reminder
      }
      return; // 'foreign' / 'notReady' → leave the form be; the player can retry
    }
    // Phase 2 — click AGR's fleet-save routine and wait for the transition.
    // Fleet save has no expedition-style "no ships" check states, so don't
    // require `ago_routine_check_3` — clicking routine 6 when present is enough.
    paintBusy();
    // Grey the working state like every other FAB (fill + label + logo to .5,
    // rim kept) instead of leaving "Wait…" at full strength — routed through the
    // shared setDim so it matches sendExpedition's lock. Cleared on every exit in
    // finally; the post-await paints below run before the browser repaints, so
    // 'prepared'/'off'/idle never flash dimmed.
    btn?.setDim('g', true);
    const state = await prepareViaRoutine({
      routineId: FS_ROUTINE_ID,
      owner: OWNER_FS,
      requireCheckReady: false,
    });
    if (state === 'prepared') paintReady(target);
    else if (state === 'routineOff') paintFsOff();
    else paint(); // 'timeout' → idle face
  } finally {
    busy = false;
    btn?.setDim('g', false);
  }
};

/**
 * Show / repaint / hide the button to match the bare set. The guardian rides the
 * unified FAB as its own module (like the command buttons), mounting whenever
 * a fleet is bare; the shell owns its position/drag.
 */
const render = () => {
  if (bare.length > 0) {
    if (!btn) {
      installButtonChrome();
      btn = createButton({
        id: BTN_ID,
        title: 'Fleet reminder',
        ringId: 'oge-guardian-ring',
        size: fabSize,
        // Match the 1-zone command buttons (sendExpedition / sendLifeform) so the
        // label reads at the same size across the FAB cluster.
        fontScale: 0.18,
        module: { id: 'guard', name: 'Fleet reminder', color: RIM, glyph: LIGHTHOUSE_GLYPH },
        holdMs: DISMISS_HOLD_MS,
        zones: [
          {
            key: 'g',
            id: 'oge-guardian-z',
            ariaLabel: 'Fleet reminder',
            bg: RIM,
            glyph: LIGHTHOUSE_GLYPH,
            onTap: () => void handleGuardianTap(),
            onHold: dismissPrimary,
          },
        ],
      });
    }
    // Poll for the "you've gone quiet" pulse only while the button is mounted.
    if (!unsubClock) unsubClock = clock.subscribe(pulseTick, { everyMs: 15000 });
    paint();
    pulseTick();
  } else if (btn) {
    if (unsubClock) {
      unsubClock();
      unsubClock = null;
    }
    setFabModuleAlert('guard', false);
    btn.dispose();
    btn = null;
  }
};

/**
 * Re-read the fleet-reminder store (the ONE armed set — auto landings and
 * manual marks alike) and refresh the button. Cheap; called on every
 * event-box refresh and on every reminder change.
 *
 * @returns {void}
 */
const refresh = () => {
  bare = readFleetReminders().map((e) => {
    const parts = String(e.bodyKey).split(':');
    return {
      bodyKey: e.bodyKey,
      coords: parts.slice(0, 3).join(':'),
      type: Number(parts[3]) || 1,
      landedAt: e.landedAt,
    };
  });
  render();
};

/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the fleet guardian. Idempotent.
 *
 * @param {object} [opts]
 * @param {(bodyKey: string) => void} [opts.dismiss]  Producer command that
 *   clears a body's fleet reminder (synced tombstone) + sweeps its ntfy push.
 * @param {(bodyKey: string) => void} [opts.ack]  Producer command that snoozes a
 *   body's push by the interval (the tap = "I'm on it" ack).
 * @returns {() => void} dispose
 */
export const installGuardian = ({ dismiss, ack } = {}) => {
  if (installed) return installed;
  dismissFn = typeof dismiss === 'function' ? dismiss : () => {};
  ackFn = typeof ack === 'function' ? ack : () => {};
  activeAt = Math.floor(Date.now() / 1000); // this page's load = fresh presence

  // Ride the unified FAB: mirror the cluster's fabBtnSize live-resize. No
  // settings visibility gate — the guardian is a safety prompt, it appears
  // whenever a bare fleet needs one.
  fabSize = settingsStore.get().fabBtnSize;
  let prevSize = fabSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fabBtnSize !== prevSize) {
      prevSize = fabSize = next.fabBtnSize;
      if (btn) btn.resize(fabSize);
    }
  });

  document.addEventListener(EVENT_BOX_LOADED_EVENT, refresh);
  // A reminder toggled elsewhere (the fleet1 chip, a producer landing arm)
  // should arm/disarm the guardian at once, not wait for the next event-box
  // load (the chip rides the same fleetdispatch page).
  document.addEventListener(FLEET_REMINDER_CHANGED_EVENT, refresh);
  refresh();
  installed = () => {
    document.removeEventListener(EVENT_BOX_LOADED_EVENT, refresh);
    document.removeEventListener(FLEET_REMINDER_CHANGED_EVENT, refresh);
    unsubSettings();
    if (unsubClock) {
      unsubClock();
      unsubClock = null;
    }
    if (navTimer) {
      clearTimeout(navTimer);
      navTimer = null;
    }
    navArmed = false;
    setFabModuleAlert('guard', false);
    if (btn) {
      btn.dispose();
      btn = null;
    }
    bare = [];
    dismissFn = () => {};
    ackFn = () => {};
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetGuardianForTest = () => {
  if (installed) installed();
  installed = null;
};
