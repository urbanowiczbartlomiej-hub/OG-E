// @ts-check

// Fleet GUARDIAN feature — the in-game half of the post-landing watch.
//
// Detection lives in the PRODUCER: it classifies a landed-but-unsaved
// fleet-save (row gone, fleet sitting exposed, not yet departed) and publishes
// it via `state/fleetSaveSet.readLandedFs()` as `{ bodyKey: 'g:s:p:type',
// landedAt, expiresAt }` — the same channel the planet badges consume. This
// feature is purely the loud SURFACE on top: ONE floating warning button while
// any tracked fleet sits bare —
//
//   - TAP        → off the bare body: navigate to it (moon vs planet picked
//                  from the bodyKey `type`). On the bare body's fleetdispatch:
//                  a two-tap AGR fleet-save (routine 6) mirroring the expedition
//                  button — first tap prepares, second dispatches — then the
//                  watch is dropped (the fleet is back in motion).
//   - LONG-PRESS → dismiss this landing (the "fleet is gone / I've got it"
//                  back-door); the shared button's charge-sweep makes the hold a
//                  conscious act, not a reflex.
//
// This feature is the loud SURFACE only — it never talks to ntfy directly. The
// matching OFFLINE push (one escalation per bare body, at landing + interval) is
// driven by the producer (`producer.js` → `sync/reminders` →
// `ntfyReconciler.reconcileGuardianQueue`); the ack + dismiss taps delegate to
// the producer's commands, which snooze or cancel it. Dismiss + ack are DURABLE,
// self-expiring, single-device stores (`./guardianDismiss.js`); the bare set
// follows the producer's TTL (`expiresAt`). A manual "Mark FS"
// (`features/manualFsMark`) feeds the SAME union, arming both this button and
// the push.
//
// Lives INSIDE the reminders feature (installed by `./index.js`).
//
// @see ../../state/fleetSaveSet.js — readLandedFs() (the producer's output).

import { EVENT_BOX_LOADED_EVENT, MANUAL_FS_CHANGED_EVENT } from '../../lib/ogeEvents.js';
import { GAME } from '../../lib/gameDom.js';
import { clock } from '../../lib/clock.js';
import { createButton, labelLines } from '../shared/button.js';
import { installButtonChrome } from '../shared/buttonChrome.js';
import { LIGHTHOUSE_GLYPH } from '../shared/buttonGlyphs.js';
import { setFabModuleAlert } from '../shared/unifiedFab.js';
import { prepareViaRoutine, dispatchPrepared } from '../shared/agrRoutine.js';
import { OWNER_FS } from '../../domain/fleetOwnership.js';
import { settingsStore } from '../../state/settings.js';
import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { readLandedFs } from '../../state/fleetSaveSet.js';
import { readManualLandedFs, removeManualLandedFs } from '../../state/manualLandedFs.js';
import { guardianDismissedLandings } from './guardianDismiss.js';

/** OG-E's own button id (not a game contract). */
const BTN_ID = 'oge-guardian-btn';
/** A deliberate, hard-to-fat-finger hold to dismiss a landing. */
const DISMISS_HOLD_MS = 1500;
/** Warning rim/glow colour — orange (the dome gradient shades it). */
const RIM = '#e67e22';
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
/** Producer command: cancel a body's ntfy push + persist the dismissal. */
let dismissFn = /** @type {(bodyKey: string, landedAt: number) => void} */ (() => {});
/** Producer command: snooze a body's push by the interval (the "I'm on it" ack). */
let ackFn = /** @type {(bodyKey: string) => void} */ (() => {});
/** This universe's id, for reading the persisted dismiss store. */
let universeId = '';
/** Whether the unified FAB is active — the guardian rides it like the command buttons. */
let fabOn = false;
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

/** @param {string|null|undefined} s @returns {string} dense `g:s:p` */
const dense = (s) => (s || '').replace(/[\s[\]]/g, '');

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
    if (dense(sp.querySelector(GAME.PLANET_KOORDS)?.textContent) !== t.coords) continue;
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
 * Repaint the idle button face. The primary word splits by context: off a
 * fleetdispatch screen it's a passive "On watch" (a tap there only ACKs, never
 * yanks you away); on the bare body's fleetdispatch it's the actionable
 * "Re-Save". Subtitle = landing coords (`+n` for extras), hint = hold-to-dismiss.
 */
const paint = () => {
  if (!btn || bare.length === 0) return;
  const sub = bare.length > 1 ? `${bare[0].coords} +${bare.length - 1}` : bare[0].coords;
  const onDispatch = location.search.includes('component=fleetdispatch');
  btn.paintLines('g', labelLines({
    main: onDispatch ? 'Re-Save' : 'Watch',
    sub,
    hint: '(hold to dismiss)',
  }));
};

/** ACK confirmed → invite the second (navigating) tap. @param {{ coords: string }} t */
const paintAcked = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Acked!', sub: t.coords, hint: 'tap → go save' }));

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
  setFabModuleAlert('guard', now - activeAt >= ackIntervalSec());
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
};

/**
 * Dismiss the primary bare fleet's landing (the long-press back-door): cancel
 * its ntfy push + persist the suppression (via the producer), then repaint.
 */
const dismissPrimary = () => {
  const t = bare[0];
  if (!t) return;
  navArmed = false;
  if (navTimer) {
    clearTimeout(navTimer);
    navTimer = null;
  }
  dismissFn(t.bodyKey, t.landedAt);
  removeManualLandedFs(t.bodyKey); // hold = "it's gone" → drop a manual mark too
  refresh();
};

/** Active body's coords on the current page (dense `g:s:p`), or '' if unknown. */
const currentBodyCoords = () =>
  dense(
    document.querySelector(GAME.ACTIVE_PLANET)?.querySelector(GAME.PLANET_KOORDS)?.textContent,
  );

/** "Wait…" while AGR's routine is being driven. */
const paintBusy = () =>
  btn?.paintLines('g', labelLines({ main: 'Wait…', sub: bare[0]?.coords, hint: '' }));
/** Prepared → invite the second tap. @param {{ coords: string }} t */
const paintReady = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Send FS', sub: t.coords, hint: '' }));
/** Dispatched. @param {{ coords: string }} t */
const paintSent = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Saved!', sub: t.coords, hint: '' }));
/** AGR's fleet-save routine is disabled — tell the user where to enable it. */
const paintFsOff = () =>
  btn?.paintLines('g', labelLines({ main: 'FS off', sub: 'enable Fleet', hint: 'Save in AGR' }));

/**
 * Button TAP. Two-tap fleet-save flow, mirroring sendExpedition:
 *   - Off a bare body's fleetdispatch → ack ("I'm on it") + navigate to the
 *     primary bare body.
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

  // Off a fleetdispatch screen → two-step, so the pulse never yanks the player
  // away by reflex. FIRST tap = ACK only (silence the pulse, snooze the push,
  // stay put). A SECOND tap (while armed) navigates to the bare body to save.
  if (!location.search.includes('component=fleetdispatch')) {
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
    return;
  }

  // On fleetdispatch → drive the fleet-save for the body we're on. Like the
  // expedition button, being on fleetdispatch is enough to proceed — we do NOT
  // gate on a coords match (AGR's routine itself is the real "is there a fleet
  // here to save?" check). The active-body coords just pick WHICH bare entry to
  // clear on success; fall back to the primary when they can't be read.
  const here = currentBodyCoords();
  const target = bare.find((b) => b.coords === here) || t;

  busy = true;
  try {
    // Phase 1 — fleet2 already prepared → fire the fleet save.
    if (document.querySelector(GAME.FD_DISPATCH) && document.getElementById('ago_fleet2_main')) {
      const r = dispatchPrepared({ owner: OWNER_FS });
      if (r === 'sent') {
        paintSent(target);
        dismissFn(target.bodyKey, target.landedAt); // saved → drop the watch
        removeManualLandedFs(target.bodyKey); // and clear a manual mark for it
      }
      return; // 'foreign' / 'notReady' → leave the form be; the player can retry
    }
    // Phase 2 — click AGR's fleet-save routine and wait for the transition.
    // Fleet save has no expedition-style "no ships" check states, so don't
    // require `ago_routine_check_3` — clicking routine 6 when present is enough.
    paintBusy();
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
  }
};

/**
 * Show / repaint / hide the button to match the bare set. The guardian rides the
 * unified FAB as its own module (like the command buttons), so it only mounts
 * when a fleet is bare AND the FAB is enabled; the shell owns its position/drag.
 */
const render = () => {
  if (bare.length > 0 && fabOn) {
    if (!btn) {
      installButtonChrome();
      btn = createButton({
        id: BTN_ID,
        title: 'Fleet guardian',
        ringId: 'oge-guardian-ring',
        size: fabSize,
        // Match the 1-zone command buttons (sendExpedition / sendLifeform) so the
        // label reads at the same size across the FAB cluster.
        fontScale: 0.18,
        module: { id: 'guard', name: 'Fleet guardian', color: RIM, glyph: LIGHTHOUSE_GLYPH },
        holdMs: DISMISS_HOLD_MS,
        zones: [
          {
            key: 'g',
            id: 'oge-guardian-z',
            ariaLabel: 'Fleet guardian',
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
 * Re-read the producer's landed-FS set (TTL-filtered, minus dismissed) and
 * refresh the button. Cheap; called on every event-box refresh — the producer
 * republishes the set on its own sync, so a slightly-stale read self-corrects
 * on the next event.
 *
 * @returns {void}
 */
const refresh = () => {
  const now = Math.floor(Date.now() / 1000);
  const dismissed = universeId ? guardianDismissedLandings(universeId, now) : {};
  // Producer's auto set (TTL- + dismiss-filtered) ∪ the user's MANUAL marks (no
  // TTL, no dismiss filter — an explicit override). Auto wins on a clash: it
  // carries the real landing `landedAt`/TTL identity.
  /** @type {Map<string, { bodyKey: string, landedAt: number }>} */
  const byKey = new Map();
  for (const e of readManualLandedFs()) {
    byKey.set(e.bodyKey, { bodyKey: e.bodyKey, landedAt: e.markedAt });
  }
  for (const e of readLandedFs()) {
    if (Number(e.expiresAt) > now && dismissed[e.bodyKey] !== e.landedAt) {
      byKey.set(e.bodyKey, { bodyKey: e.bodyKey, landedAt: e.landedAt });
    }
  }
  bare = [...byKey.values()].map((e) => {
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
 * @param {(bodyKey: string, landedAt: number) => void} [opts.dismiss]  Producer
 *   command that cancels a body's ntfy push + persists the dismissal.
 * @param {(bodyKey: string) => void} [opts.ack]  Producer command that snoozes a
 *   body's push by the interval (the tap = "I'm on it" ack).
 * @param {string} [opts.universeId]  This universe's id (persisted dismiss/ack store).
 * @returns {() => void} dispose
 */
export const installGuardian = ({ dismiss, ack, universeId: uid } = {}) => {
  if (installed) return installed;
  dismissFn = typeof dismiss === 'function' ? dismiss : () => {};
  ackFn = typeof ack === 'function' ? ack : () => {};
  universeId = uid || '';
  activeAt = Math.floor(Date.now() / 1000); // this page's load = fresh presence

  // Ride the unified FAB: mirror the command buttons' fabMode visibility +
  // fabBtnSize live-resize, so the guardian appears/sizes with the cluster.
  const s0 = settingsStore.get();
  fabOn = s0.fabMode;
  fabSize = s0.fabBtnSize;
  let prevSize = fabSize;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.fabMode !== fabOn) {
      fabOn = next.fabMode;
      render();
    }
    if (next.fabBtnSize !== prevSize) {
      prevSize = fabSize = next.fabBtnSize;
      if (btn) btn.resize(fabSize);
    }
  });

  document.addEventListener(EVENT_BOX_LOADED_EVENT, refresh);
  // A manual mark toggled on fleet1 should arm/disarm the guardian at once,
  // not wait for the next event-box load (both ride the same fleetdispatch page).
  document.addEventListener(MANUAL_FS_CHANGED_EVENT, refresh);
  refresh();
  installed = () => {
    document.removeEventListener(EVENT_BOX_LOADED_EVENT, refresh);
    document.removeEventListener(MANUAL_FS_CHANGED_EVENT, refresh);
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
    universeId = '';
    fabOn = false;
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
