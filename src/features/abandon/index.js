// Abandon flow (stepper) — porzucanie za małych fresh kolonii, sterowane z FAB.
//
// # What it does
//
// On the OGame overview page, when the current planet is freshly colonized
// (usedFields === 0) and below the user's keep threshold
// (config.colonyMinFields), the unified FAB's colony module relays each of the
// user's three taps to exactly ONE native game action, with a DOM-level safety
// check between every step. The flow closes with a local scansStore update and
// a page reload.
//
// Strict 1:1 user-tap → game-HTTP-request mapping (TOS) — one FAB tap per
// `advance()` call, one game request per `advance()`:
//
//   Tap 1 (`advance()` #1):
//     safeClick(.openPlanetRenameGiveupBox)  → GAME: GET /planetlayer
//     + pure-DOM: click #block, autofill password (no HTTP)
//   Tap 2 (`advance()` #2):
//     safeClick(nativeSubmit)                → GAME: POST /confirmPlanetGiveup
//   Tap 3 (`advance()` #3):
//     safeClick(yesBtn)                       → GAME: POST /planetGiveup
//     + cleanup scansStore + reload
//
// # Why a stepper driven by the FAB (and the close guard)
//
// Earlier this flow injected proxy buttons INSIDE the game popup so a tap
// counted as "inside the dialog" (jQuery UI's focus manager hides the dialog on
// a focus-leave / outside click). The unified design drives every tap from the
// FAB instead; `features/abandon/colonyFab.js` installs a close guard for the
// duration of the flow that stops the FAB's pointer/focus events from reaching
// the game's document-level close handlers and keeps focus in the dialog. This
// module stays pure flow + safety; the guard + button state live in the FAB.
//
// # Why we do NOT touch historyStore
//
// `historyStore` is the size-histogram dataset — abandoned planets are its most
// important left-tail data points. `cleanupAbandonedPlanet` only updates
// `scansStore` (so the galaxy view doesn't re-suggest the slot).
//
// # Safety gates (unchanged from the previous flow)
//
//   1. `checkAbandonState()` must hold on entry (overview + used===0 + max
//      below threshold).
//   2. After tap 1, `#giveupCoordinates` must equal the coords captured from
//      `#positionContentField` on entry (else a different planet → abort).
//   3. After tap 2, the confirm dialog text must include the captured coords.
//
// Plus a module-level guard prevents two concurrent flows.
//
// @ts-check

import { galaxyScanConfigStore } from '../../state/galaxyScanConfig.js';
import { scansStore } from '../../state/scans.js';
import {
  colonizeDecisionsStore,
  flushColonizeDecisionsStore,
} from '../../state/colonizeDecisions.js';
import { withDecision, DEC_ABANDONED } from '../../domain/colonizeDecisions.js';
import { safeClick, waitFor } from '../../lib/dom.js';
import { GAME } from '../../lib/gameDom.js';
import { hasAbandonableSurplus } from './detect.js';

/**
 * Mark a galaxy slot as abandoned in {@link scansStore} so the galaxy overlay
 * does not suggest it as a colonize target in future picks. Deliberately does
 * NOT touch `historyStore` (see module header).
 *
 * @param {number} galaxy
 * @param {number} system
 * @param {number} position
 * @returns {void}
 */
const cleanupAbandonedPlanet = (galaxy, system, position) => {
  const key = /** @type {`${number}:${number}`} */ (`${galaxy}:${system}`);
  scansStore.update((prev) => {
    const existing = prev[key] ?? { scannedAt: Date.now(), positions: {} };
    /** @type {import('../../state/scans.js').SystemScan['positions']} */
    const newPositions = {
      ...existing.positions,
      [position]: {
        status: 'abandoned',
        flags: { hasAbandonedPlanet: true },
      },
    };
    return {
      ...prev,
      [key]: { ...existing, scannedAt: Date.now(), positions: newPositions },
    };
  });

  // Durable 'abandoned' decision carrying the planet's (small) field count. The
  // public API has NO size data and may still list this slot empty after the
  // give-up, so this device-local fact — synced in Stage 4 — is what stops us
  // (and other devices) from ever re-colonizing a known-too-small slot. Read
  // the field count off the still-loaded overview; `f` is omitted if it's gone.
  const m = document.querySelector(GAME.DIAMETER_FIELD)?.textContent?.match(/\((\d+)\/(\d+)\)/);
  const f = m ? parseInt(m[2], 10) : undefined;
  const ck = /** @type {`${number}:${number}:${number}`} */ (`${galaxy}:${system}:${position}`);
  colonizeDecisionsStore.update((prev) =>
    withDecision(prev, ck, { s: DEC_ABANDONED, ts: Date.now(), f }),
  );
  void flushColonizeDecisionsStore();
};

/**
 * Sync DOM read: is the current overview page a fresh colony below the user's
 * keep threshold? All must hold: `component=overview` in the URL,
 * `#diameterContentField` matches `(used/max)`, `used === 0`, and
 * `max < config.colonyMinFields`.
 *
 * @param {{ colonyMinFields: number }} [config]  Optional config snapshot;
 *   defaults to the current per-universe `galaxyScanConfigStore.get()`.
 * @returns {{ used: number, max: number, minFields: number } | null}
 */
export const checkAbandonState = (config) => {
  const s = config ?? galaxyScanConfigStore.get();
  if (!location.search.includes('component=overview')) return null;
  // The last planet can never be given up (OGame forbids a 0-planet account),
  // and early game that IS this page: the small, empty starting homeworld reads
  // as a fresh too-small colony. See `detect.hasAbandonableSurplus`.
  if (!hasAbandonableSurplus()) return null;
  // Moons are never abandonable — the game has no "abandon" for them, and a
  // fresh moon reads used===0 with a small field max, so without this guard the
  // FAB wrongly offered "Abandon · N fields · too small" on a moon. The body
  // type comes from OGame's own authoritative `ogame-planet-type` meta.
  if (document.querySelector(GAME.META_PLANET_TYPE)?.getAttribute('content') === 'moon') return null;
  const diameterEl = document.querySelector(GAME.DIAMETER_FIELD);
  if (!diameterEl) return null;
  const m = diameterEl.textContent?.match(/\((\d+)\/(\d+)\)/);
  if (!m) return null;
  const used = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (used !== 0) return null;
  if (max >= s.colonyMinFields) return null;
  return { used, max, minFields: s.colonyMinFields };
};

/**
 * One step's outcome. `phase` tells the FAB how to repaint the button:
 *   - `opened`    popup is up + password autofilled; next tap submits.
 *   - `submitted` confirm dialog is up; next tap confirms the delete.
 *   - `done`      delete fired; cleanup done + reload scheduled.
 *   - `aborted`   a safety gate failed / a wait timed out — flow is dead.
 *
 * @typedef {{ phase: 'opened' | 'submitted' | 'done' | 'aborted' }} AdvanceResult
 */

/** Re-entry guard: at most one abandon flow may exist at a time. */
let flowActive = false;

/**
 * Build a single-use abandon flow. Each {@link AbandonFlow.advance} call
 * performs the next game request (a 1:1 map to a user tap) and resolves with
 * the new {@link AdvanceResult}. The flow is dead after a `done`/`aborted`
 * result; the FAB discards it and rebuilds on the next entry.
 *
 * Returns `null` when the entry gate fails (not a fresh small colony, no
 * password, or a flow is already active) so the caller can leave the button in
 * its idle state.
 *
 * @param {{ colonyMinFields: number, colonyPassword: string }} [config]
 *   Optional config snapshot (defaults to the per-universe store) — passing it
 *   makes the flow pure w.r.t. the store for tests.
 * @returns {AbandonFlow | null}
 *
 * @typedef {object} AbandonFlow
 * @property {() => Promise<AdvanceResult>} advance  Drive the next step.
 * @property {() => void} cancel  Release the re-entry guard without acting.
 */
export const createAbandonFlow = (config) => {
  if (flowActive) return null;
  const cfg = config ?? galaxyScanConfigStore.get();

  // Entry gate (Safety 1): fresh small colony on the overview.
  if (!checkAbandonState(cfg)) return null;

  // Capture the planet coords for the mid-flow verification gates (Safety 2/3).
  const posEl = document.querySelector(GAME.POSITION_FIELD_LINK);
  const coordsMatch = posEl?.textContent?.trim()?.match(/\[(\d+):(\d+):(\d+)\]/);
  if (!coordsMatch) return null;
  const galaxy = parseInt(coordsMatch[1], 10);
  const system = parseInt(coordsMatch[2], 10);
  const position = parseInt(coordsMatch[3], 10);
  const expectedCoords = `[${galaxy}:${system}:${position}]`;

  // Safety 3 (password configured) — without it the game form can't submit.
  if (!cfg.colonyPassword) return null;

  flowActive = true;
  let step = 0;
  let busy = false;
  let dead = false;
  /** @type {HTMLInputElement | null} */
  let nativeSubmit = null;
  /** @type {Element | null} */
  let yesBtn = null;

  /** @param {AdvanceResult['phase']} phase @returns {AdvanceResult} */
  const finish = (phase) => {
    if (phase === 'done' || phase === 'aborted') {
      dead = true;
      flowActive = false;
    }
    return { phase };
  };

  const advance = async () => {
    if (dead || busy) return /** @type {AdvanceResult} */ ({ phase: 'aborted' });
    busy = true;
    try {
      // ═══ Tap 1: open giveup popup + reveal + autofill ═══════════════════
      if (step === 0) {
        const giveupLink = document.querySelector('.openPlanetRenameGiveupBox');
        if (!giveupLink) return finish('aborted');
        safeClick(giveupLink); // HTTP: GET /planetlayer

        const giveupCoordsEl = await waitFor(() => {
          const el = document.getElementById('giveupCoordinates');
          return el?.textContent?.trim() ? el : null;
        }, { timeoutMs: 5000 });
        if (!giveupCoordsEl) return finish('aborted');
        // Safety 2: the popup opened for OUR planet.
        if (giveupCoordsEl.textContent?.trim() !== expectedCoords) return finish('aborted');

        // Pure-DOM: reveal the password form (no HTTP).
        const blockBtn = document.getElementById('block');
        if (!blockBtn) return finish('aborted');
        safeClick(blockBtn);

        const validateDiv = await waitFor(() => {
          const el = document.getElementById('validate');
          return el && el.offsetParent !== null ? el : null;
        }, { timeoutMs: 3000 });
        if (!validateDiv) return finish('aborted');

        const pwField = /** @type {HTMLInputElement | null} */ (
          validateDiv.querySelector('input[type="password"]')
        );
        nativeSubmit = /** @type {HTMLInputElement | null} */ (
          validateDiv.querySelector('input[type="submit"]')
        );
        if (!pwField || !nativeSubmit) return finish('aborted');

        // Autofill (no HTTP); fire input + change so framework listeners see it.
        pwField.value = cfg.colonyPassword;
        pwField.dispatchEvent(new Event('input', { bubbles: true }));
        pwField.dispatchEvent(new Event('change', { bubbles: true }));

        step = 1;
        return finish('opened');
      }

      // ═══ Tap 2: submit the password ═════════════════════════════════════
      if (step === 1) {
        if (!nativeSubmit) return finish('aborted');
        safeClick(nativeSubmit); // HTTP: POST /confirmPlanetGiveup

        yesBtn = await waitFor(() => {
          const btn = document.querySelector('#errorBoxDecision .yes')
            ?? document.querySelector('.errorBox .yes');
          if (!btn) return null;
          const dialog = document.querySelector('#errorBoxDecision')
            ?? document.querySelector('.errorBox');
          const text = dialog?.textContent ?? '';
          // Safety 3: the confirm dialog references our planet.
          if (!text.includes(expectedCoords)) return null;
          return btn;
        }, { timeoutMs: 5000 });
        if (!yesBtn) return finish('aborted');

        step = 2;
        return finish('submitted');
      }

      // ═══ Tap 3: confirm the delete ══════════════════════════════════════
      if (step === 2) {
        if (!yesBtn) return finish('aborted');
        safeClick(yesBtn); // HTTP: POST /planetGiveup
        cleanupAbandonedPlanet(galaxy, system, position);
        setTimeout(() => location.reload(), 800);
        return finish('done');
      }

      return finish('aborted');
    } finally {
      busy = false;
    }
  };

  return {
    advance,
    cancel: () => { if (!dead) { dead = true; flowActive = false; } },
  };
};

/**
 * Test-only reset: clears the module-level re-entry guard so each case starts
 * fresh. Prefixed with `_` to signal "do not import from production code".
 *
 * @returns {void}
 */
export const _resetAbandonForTest = () => {
  flowActive = false;
};
