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
// In-game it stays DOM-only: zero ntfy, the dismiss is in-memory (per session),
// and the bare set follows the producer's TTL (`expiresAt`). The offline push, a
// persistent dismiss and the budget config are later stages.
//
// Lives INSIDE the reminders feature (installed by `./index.js`).
//
// @see ../../state/fleetSaveSet.js — readLandedFs() (the producer's output).

import { EVENT_BOX_LOADED_EVENT, MANUAL_FS_CHANGED_EVENT } from '../../lib/ogeEvents.js';
import { GAME } from '../../lib/gameDom.js';
import { createButton, labelLines } from '../shared/button.js';
import { installButtonChrome } from '../shared/buttonChrome.js';
import { prepareViaRoutine, dispatchPrepared } from '../shared/agrRoutine.js';
import { OWNER_FS } from '../../domain/fleetOwnership.js';
import { settingsStore } from '../../state/settings.js';
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
 * Simple exclamation-mark glyph — inner markup of a `0 0 64 64` SVG painted in
 * `currentColor` so it tints to the orange `--rim` (same convention as
 * `buttonGlyphs.js`). A bold bar + dot reads as "warning" at a glance.
 */
const BANG_GLYPH = [
  '<g fill="currentColor" stroke="currentColor" stroke-linecap="round">',
  '<line x1="32" y1="16" x2="32" y2="38" stroke-width="9"/>',
  '<circle cx="32" cy="50" r="5.5" stroke="none"/>',
  '</g>',
].join('');

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
 * Repaint the button face: "Re-Save" primary, the landing coords as subtitle, and
 * a "hold to dismiss" hint — the shared 3-line command-button label.
 */
const paint = () => {
  if (!btn || bare.length === 0) return;
  const sub = bare.length > 1 ? `${bare[0].coords} +${bare.length - 1}` : bare[0].coords;
  btn.paintLines('g', labelLines({ main: 'Re-Save', sub, hint: 'hold to dismiss' }));
};

/**
 * Dismiss the primary bare fleet's landing (the long-press back-door): cancel
 * its ntfy push + persist the suppression (via the producer), then repaint.
 */
const dismissPrimary = () => {
  const t = bare[0];
  if (!t) return;
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
  btn?.paintLines('g', labelLines({ main: '→ Send FS', sub: t.coords, hint: 'tap to send' }));
/** Dispatched. @param {{ coords: string }} t */
const paintSent = (t) =>
  btn?.paintLines('g', labelLines({ main: 'Saved!', sub: t.coords, hint: '' }));
/** AGR's fleet-save routine is disabled — tell the user where to enable it. */
const paintFsOff = () =>
  btn?.paintLines('g', labelLines({ main: 'AGR FS off', sub: 'enable Fleet', hint: 'Save in AGR' }));

/**
 * Button TAP. Two-tap fleet-save flow, mirroring sendExpedition:
 *   - Off a bare body's fleetdispatch → ack ("I'm on it") + navigate to the
 *     primary bare body.
 *   - On a bare body's fleetdispatch, fleet2 NOT up yet → prepare AGR's
 *     fleet-save routine (6) and flip to "→ Send FS".
 *   - On a bare body's fleetdispatch, fleet2 up → fire the dispatch, then drop
 *     the watch (the fleet is back in motion).
 *
 * @returns {Promise<void>}
 */
const handleGuardianTap = async () => {
  if (busy) return;
  const t = bare[0];
  if (!t) return;

  const onFd = location.search.includes('component=fleetdispatch');
  const here = onFd ? currentBodyCoords() : '';
  const match = here ? bare.find((b) => b.coords === here) : undefined;

  // Off a bare body's fleetdispatch → "I'm on it" + navigate to the primary.
  if (!match) {
    ackFn(t.bodyKey);
    navigateToBody(t);
    return;
  }

  busy = true;
  try {
    // Phase 1 — fleet2 already prepared → fire the fleet save.
    if (document.querySelector(GAME.FD_DISPATCH) && document.getElementById('ago_fleet2_main')) {
      const r = dispatchPrepared({ owner: OWNER_FS });
      if (r === 'sent') {
        paintSent(match);
        dismissFn(match.bodyKey, match.landedAt); // saved → drop the watch
        removeManualLandedFs(match.bodyKey); // and clear a manual mark for it
      }
      return; // 'foreign' / 'notReady' → leave the form be; the player can retry
    }
    // Phase 2 — click AGR's fleet-save routine and wait for the transition.
    paintBusy();
    const state = await prepareViaRoutine({ routineId: FS_ROUTINE_ID, owner: OWNER_FS });
    if (state === 'prepared') paintReady(match);
    else if (state === 'routineOff') paintFsOff();
    else paint(); // 'noShips' (nothing to save here) / 'timeout' → idle face
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
        title: 'Bare fleet',
        ringId: 'oge-guardian-ring',
        size: fabSize,
        // Match the 1-zone command buttons (sendExpedition / sendLifeform) so the
        // label reads at the same size across the FAB cluster.
        fontScale: 0.18,
        module: { id: 'guard', name: 'Bare fleet', color: RIM, glyph: BANG_GLYPH },
        holdMs: DISMISS_HOLD_MS,
        zones: [
          {
            key: 'g',
            id: 'oge-guardian-z',
            ariaLabel: 'Bare fleet',
            bg: RIM,
            glyph: BANG_GLYPH,
            onTap: () => void handleGuardianTap(),
            onHold: dismissPrimary,
          },
        ],
      });
    }
    paint();
  } else if (btn) {
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
