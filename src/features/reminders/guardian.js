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
//   - TAP        → navigate to that body (go re-save it; moon vs planet picked
//                  from the bodyKey `type`);
//   - LONG-PRESS → dismiss this landing (the "fleet is gone / I've got it"
//                  back-door); the shared button's charge-sweep makes the hold a
//                  conscious act, not a reflex.
//
// Etap 1 is DOM-only: zero ntfy, the dismiss is in-memory (per session), and the
// bare set follows the producer's TTL (`expiresAt`). The offline push, a
// persistent dismiss and the budget config are Etap 2/3.
//
// Lives INSIDE the reminders feature (installed by `./index.js`).
//
// @see ../../state/fleetSaveSet.js — readLandedFs() (the producer's output).

import { EVENT_BOX_LOADED_EVENT } from '../../lib/ogeEvents.js';
import { GAME } from '../../lib/gameDom.js';
import { createButton } from '../shared/button.js';
import { installButtonChrome } from '../shared/buttonChrome.js';
import { readLandedFs } from '../../state/fleetSaveSet.js';
import { guardianDismissedLandings } from './guardianDismiss.js';

/** OG-E's own button id (not a game contract). */
const BTN_ID = 'oge-guardian-btn';
/** A deliberate, hard-to-fat-finger hold to dismiss a landing. */
const DISMISS_HOLD_MS = 1500;
/** Warning rim/glow colour — orange (the dome gradient shades it). */
const RIM = '#e67e22';

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
/** This universe's id, for reading the persisted dismiss store. */
let universeId = '';

/** @param {string|null|undefined} s @returns {string} dense `g:s:p` */
const dense = (s) => (s || '').replace(/[\s[\]]/g, '');

/**
 * Navigate to the bare fleet's body via the left planet list — moon vs planet
 * picked from `type` (the badge bodyKey convention: 3 = moon, else planet).
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
    if (href) {
      window.location.href = href;
      return;
    }
  }
};

/** Repaint the button face for the current bare set (small landing coords). */
const paint = () => {
  if (!btn || bare.length === 0) return;
  const sub = bare.length > 1 ? `${bare[0].coords} +${bare.length - 1}` : bare[0].coords;
  btn.paintLines('g', [{ text: sub, em: '0.42em', opacity: 0.95 }]);
};

/**
 * Dismiss the primary bare fleet's landing (the long-press back-door): cancel
 * its ntfy push + persist the suppression (via the producer), then repaint.
 */
const dismissPrimary = () => {
  const t = bare[0];
  if (!t) return;
  dismissFn(t.bodyKey, t.landedAt);
  refresh();
};

/** Show / repaint / hide the button to match the bare set. */
const render = () => {
  if (bare.length > 0) {
    if (!btn) {
      installButtonChrome();
      btn = createButton({
        id: BTN_ID,
        title: 'Goła flota — kliknij, by przejść; przytrzymaj, by odrzucić',
        ringId: 'oge-guardian-ring',
        size: 64,
        fontScale: 0.45,
        posKey: 'oge_guardianBtnPos',
        holdMs: DISMISS_HOLD_MS,
        zones: [
          {
            key: 'g',
            id: 'oge-guardian-z',
            ariaLabel: 'Goła flota',
            bg: RIM,
            glyph: BANG_GLYPH,
            labelShiftY: 9,
            onTap: () => {
              if (bare[0]) navigateToBody(bare[0]);
            },
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
  bare = readLandedFs()
    .filter((e) => Number(e.expiresAt) > now && dismissed[e.bodyKey] !== e.landedAt)
    .map((e) => {
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
 * @param {string} [opts.universeId]  This universe's id (persisted dismiss store).
 * @returns {() => void} dispose
 */
export const installGuardian = ({ dismiss, universeId: uid } = {}) => {
  if (installed) return installed;
  dismissFn = typeof dismiss === 'function' ? dismiss : () => {};
  universeId = uid || '';
  document.addEventListener(EVENT_BOX_LOADED_EVENT, refresh);
  refresh();
  installed = () => {
    document.removeEventListener(EVENT_BOX_LOADED_EVENT, refresh);
    if (btn) {
      btn.dispose();
      btn = null;
    }
    bare = [];
    dismissFn = () => {};
    universeId = '';
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
