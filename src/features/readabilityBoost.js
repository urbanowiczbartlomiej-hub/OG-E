// @ts-check

import { settingsStore } from '../state/settings.js';

// Contrast + legibility boost for two chronically painful AGR / OGame
// surfaces: the fleet-event box at the top of the page and the
// "light green" fleet-movement link in the fleetdispatch header.
//
// # Toggle
//
// Gated on `settings.readabilityBoost` (default `true`). The install
// call unconditionally injects the stylesheet so there's no flash of
// un-styled content at `document_start` — any user-off preference
// then fires via the subscription after `initSettingsStore` hydrates,
// removing the node within the same tick.
//
// # Event box (`#eventboxFilled`)
//
// Out of the box the event row renders three pieces of information
// ("17 Misje:", mission-type + target, and a countdown) but pads them
// with verbose labels ("Misje:", "Następna:", "Rodzaj:") that eat more
// space than the payload itself. We nudge the box up slightly to close
// the gap under AGR's header and then collapse every label's font-size
// to 0 so only the compact payload bits remain:
//   - `.undermark` → the "17 x własna" chip (first row)
//   - `.countdown` → the big yellow time-to-next-event
//   - `.friendly` / `.hostile` / `.neutral` → the mission-type name
// Game's own layout + theme colours are preserved; no background
// override, no flex, no positioning hacks.
//
// # Movement link (`a.ago_movement.tooltip.ago_color_lightgreen`)
//
// The link is a mixed-coloured status row: "Floty: 18/37" (green) +
// inline `<span class="ago_color_palered">Ekspedycje: 14/14</span>`
// (red when full). Earlier revisions of this module forced the green
// onto every descendant via `a.xxx *`, which destroyed the native red
// "max reached" indicator. The new rule applies the green to the anchor
// ONLY (text nodes inherit, explicit `ago_color_palered` child keeps
// its red). We also reshape the anchor as a column flex container so
// the two status lines stack vertically, left-aligned, and bump the
// font to 15 px so small-screen users can read them at a glance.
//
// # Why a single stylesheet
//
// Both concerns are CSS-only, run at `document_start` before `<body>`,
// and must beat inline styles + game rules. One injected
// `<style id="oge-readability-boost">` with `!important` declarations
// is the simplest way — re-installs dedupe on the stable id and return
// the existing dispose without rewriting the stylesheet. Mirrors the
// shape of {@link ../features/blackBg.js}.

/** Stable id so repeated installs collapse to a no-op. */
const STYLE_ID = 'oge-readability-boost';

/**
 * Compact the countdown string by:
 *   1. Stripping the trailing seconds suffix entirely
 *      (`"42min. 56sek."` → `"42min. 56"`).
 *   2. Shortening the minutes suffix to a single `m`
 *      (`"42min. 56"` → `"42m 56"`).
 *
 * The result is a tighter glance-value that still reads unambiguously
 * ("42m 56" = 42 minutes 56 seconds). Hours and other units are left
 * alone — the transformation is deliberately narrow so countdowns on
 * pages using exotic unit strings degrade gracefully instead of
 * losing information.
 *
 * Seconds-strip only fires when the suffix is attached to a numeric
 * value. Expiry strings OGame might render on countdown completion
 * (`"teraz"`, `"now"`, ...) pass through untouched.
 *
 * Covered second-unit variants: Polish `sek`, English `sec` / `s`,
 * Cyrillic `с`. Minutes match `min` / `Min` case-insensitively, which
 * covers every Latin-script locale OGame ships.
 *
 * Exported so tests can pin the pattern without mounting a DOM.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripCountdownUnitSuffix = (text) => {
  const withoutSeconds = text.replace(
    /(\d)\s*(?:sek|sec|s|с)\.?\s*$/i,
    '$1',
  );
  // `min.` / `min` / `Min.` → `m`. Global + case-insensitive so every
  // minute marker in a multi-unit countdown compresses uniformly.
  return withoutSeconds.replace(/min\.?/gi, 'm');
};

/**
 * The override rules. Kept as a module-level constant so tests can
 * assert on the exact selectors + `!important` presence without
 * reaching into internals.
 */
const CSS = `/* OG-E: readability boost — event box + fleet movement link */

/* ===== Event box container =====
   Three pieces of information sit inside this box: the mission count
   summary ("17 Misje: 17 x własna"), the countdown to the next event,
   and the mission-type name. OGame renders them across two <p> tags
   at small default text. Our reshape keeps the game's background /
   border / theme colour / position untouched and only:
     1. Makes the container a positioning context for the countdown.
     2. Reserves enough right-padding for the countdown to float on
        top without overlapping the left column text. */
#eventboxFilled {
  position: relative !important;
  padding-right: 130px !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
}

/* Row 1 (left column, top): hide the verbose "N Misje:" prefix — the
   compact "N x type" span (.undermark) carries the same information
   at half the width. */
#eventboxFilled > p.event_list:first-child {
  font-size: 0 !important;
  margin: 0 !important;
  line-height: 1.2 !important;
}
#eventboxFilled > p.event_list:first-child .undermark {
  font-size: 13px !important;
  font-weight: 700 !important;
  color: #7ecfff !important;
}

/* Row 2 (left column, bottom + absolute right): the second <p>
   contains BOTH .next_event spans — the one wrapping the countdown
   and the one wrapping the mission-type name. We hide the parent
   font-size so the "Następna:" / "Rodzaj:" prefixes vanish; the
   nested payload re-appears via its own explicit font-size. */
#eventboxFilled > p.event_list:nth-child(2) {
  font-size: 0 !important;
  margin: 0 !important;
  line-height: 1.2 !important;
}

/* Reset the block override we used to carry from a previous revision
   — both .next_event spans flow inline again, which is what lets the
   mission-type sit naturally on its line in the left column. The
   countdown escapes the flow via the absolute rule below. */
#eventboxFilled .next_event {
  font-size: 0 !important;
  display: inline !important;
}

/* Mission-type (friendly/hostile/neutral): small but readable, left
   column, right under the undermark chip. */
#eventboxFilled .next_event .friendly,
#eventboxFilled .next_event .hostile,
#eventboxFilled .next_event .neutral {
  font-size: 13px !important;
  font-weight: bold !important;
}
#eventboxFilled .friendly { color: #55e87a !important; }
#eventboxFilled .hostile  { color: #ff4d4d !important; }
#eventboxFilled .neutral  { color: #ffaa33 !important; }

/* Countdown: escapes the left column via absolute positioning so it
   can grow arbitrarily large without pushing the mission-type line
   around. Right-anchored to the container, vertically centred.
   Inset-right matches the container's 130px padding reservation
   minus ~110px for the countdown width — keeps it just inside the
   box's right edge. */
#eventboxFilled .next_event .countdown {
  position: absolute !important;
  right: 12px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  font-size: 35px !important;
  font-weight: 900 !important;
  color: #ffe04b !important;
  letter-spacing: 0.5px !important;
  line-height: 1 !important;
  white-space: nowrap !important;
}

/* AGR's expand/collapse toggles are irrelevant to the compact view. */
#eventboxFilled #js_eventDetailsClosed,
#eventboxFilled #js_eventDetailsOpen {
  display: none !important;
}

/* ===== Movement link (fleetdispatch header) =====
   Stack "Floty: X/Y" on top of "Ekspedycje: X/Y" left-aligned. Colour
   the anchor only (not every descendant) so the child
   .ago_color_palered keeps its native red "max reached" tint.
   height:auto cancels any inline workaround the user might have left
   behind. */
a.ago_movement.tooltip.ago_color_lightgreen {
  color: #a0ff60 !important;
  font-size: 15px !important;
  font-weight: bold !important;
  display: inline-flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  line-height: 1.2 !important;
  height: auto !important;
  padding: 2px 0 !important;
  gap: 1px !important;
}
`;

/**
 * Active install handle, or `null` when not installed. Held at module
 * scope so a second call to {@link installReadabilityBoost} collapses
 * to a no-op returning the same dispose.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Inject the contrast-boost stylesheet. Safe to call synchronously
 * from the content-script entry at `document_start` — the parent
 * resolution falls back to `document.documentElement` when the browser
 * hasn't produced `<head>` yet.
 *
 * Idempotent per document: the stable `STYLE_ID` guards against
 * duplicate `<style>` nodes even if this module is imported twice.
 *
 * @returns {() => void} Dispose fn that removes the `<style>` element.
 */
export const installReadabilityBoost = () => {
  if (installed) return installed.dispose;

  // Happy-dom strips `document` in some edge-case test environments.
  // Bail out cleanly rather than throwing on module import.
  if (typeof document === 'undefined' || !document) {
    return () => {};
  }

  // Defensive: a previous page load / dev-reload may have left the
  // node behind. Drop it so we don't end up with two stylesheets when
  // the fresh install runs `inject()` below.
  const existing = document.getElementById(STYLE_ID);
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  /** @type {HTMLStyleElement | null} */
  let styleEl = null;

  /**
   * Put the <style> node into the document. Idempotent: returns early
   * if already mounted. `document.head` may still be null at
   * `document_start`; we fall back to `documentElement`.
   *
   * @returns {void}
   */
  const inject = () => {
    if (styleEl && styleEl.parentNode) return;
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    const parent = document.head || document.documentElement;
    parent.appendChild(styleEl);
  };

  /**
   * Remove the <style> node if mounted.
   *
   * @returns {void}
   */
  const retract = () => {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
  };

  // ─── Countdown suffix trimmer ─────────────────────────────────────
  //
  // `#eventboxFilled .countdown` is refreshed once per second by
  // OGame. A MutationObserver catches every refresh and re-applies
  // `stripCountdownUnitSuffix`. When the observer's own write fires a
  // mutation, the regex is idempotent on the already-stripped text,
  // so we don't loop. The trimmer shares the `readabilityBoost`
  // toggle — start on enable, disconnect on disable.

  /** @type {MutationObserver | null} */
  let countdownObserver = null;

  const trimCountdown = () => {
    const cd = document.querySelector('#eventboxFilled .countdown');
    if (!cd) return;
    const raw = cd.textContent ?? '';
    const stripped = stripCountdownUnitSuffix(raw);
    if (stripped !== raw) cd.textContent = stripped;
  };

  const startCountdownTrimmer = () => {
    if (countdownObserver) return;
    const box = document.getElementById('eventboxFilled');
    if (!box) return; // nothing to observe — eventbox only exists on some pages
    trimCountdown();
    countdownObserver = new MutationObserver(trimCountdown);
    countdownObserver.observe(box, {
      subtree: true,
      characterData: true,
      childList: true,
    });
  };

  const stopCountdownTrimmer = () => {
    if (countdownObserver) {
      countdownObserver.disconnect();
      countdownObserver = null;
    }
  };

  // At document_start `#eventboxFilled` doesn't exist yet. Start once
  // now (no-op if absent) and once on DOMContentLoaded.
  const onDomReady = () => startCountdownTrimmer();

  // Initial paint: inject unconditionally so nothing flashes between
  // `document_start` and the first settings-store tick. The subscription
  // below reconciles to the hydrated preference on the next microtask.
  inject();
  startCountdownTrimmer();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  }

  // React to preference changes. When the user toggles the setting off,
  // remove the stylesheet AND disconnect the countdown trimmer; back
  // on, re-inject + re-observe. `prev` is tracked so the subscriber is
  // a no-op on unrelated settings changes.
  let prev = settingsStore.get().readabilityBoost;
  const unsubscribe = settingsStore.subscribe((next) => {
    if (next.readabilityBoost === prev) return;
    prev = next.readabilityBoost;
    if (prev) {
      inject();
      startCountdownTrimmer();
    } else {
      retract();
      stopCountdownTrimmer();
    }
  });

  installed = {
    dispose: () => {
      unsubscribe();
      retract();
      stopCountdownTrimmer();
      document.removeEventListener('DOMContentLoaded', onDomReady);
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope install sentinel. Production
 * code never needs this — the leading underscore is a hard signal.
 *
 * @returns {void}
 */
export const _resetReadabilityBoostForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
