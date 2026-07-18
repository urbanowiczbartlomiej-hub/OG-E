// @ts-check

import { settingsStore } from '../state/settings.js';
import { createVisibilityObserver } from '../lib/visibilityObserver.js';

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
//   - `.countdown` → the big yellow time-to-next-event; the idle "done"
//     word collapses to a short locale-agnostic "Done" (see
//     `formatCountdownDisplay`) so it fits the gutter at full size
//   - `.friendly` / `.hostile` / `.neutral` → the mission-type name,
//     clamped + ellipsized so a long localized name can't slide under
//     the absolute countdown
// The card becomes a subtle themed OG-E surface with the countdown
// absolute-anchored full-size to the right; the mission counts + type
// flow in a left column behind a reserved right gutter that clears it.
// Theme colours stay the game's own.
//
// # Movement link (`a.ago_movement.tooltip.ago_color_lightgreen`)
//
// The link is a mixed-coloured status row: "Floty: 18/37" (green) +
// inline `<span class="ago_color_palered">Ekspedycje: 14/14</span>`
// (red when full). Earlier revisions of this module forced the green
// onto every descendant via `a.xxx *`, which destroyed the native red
// "max reached" indicator. The new rule applies the green to the anchor
// ONLY (text nodes inherit, explicit `ago_color_palered` child keeps
// its red). We stack the two status lines vertically in a subtle themed
// card. The host header is a FIXED 40px box, so the font is capped (~19px,
// tight line-height) to keep BOTH lines inside it — push it larger and the
// second line drops behind the component below (see the CSS size budget).
//
// On top of the CSS we FORCE the labels. OGame/AGR render the prefixes
// in the account locale ("Floty:" / "Ekspedycje:" PL, "Flotten:" RU/DE,
// …), which are long and uneven. A small MutationObserver-driven
// relabeller rewrites each line to our own short, fixed labels
// ("Fleets:" / "Expos:") while preserving the live "used/total" counts —
// locale-agnostic because it parses only the trailing `\d+/\d+` pair,
// never the label. Short fixed labels keep the inline line compact. The
// relabeller shares the
// `readabilityBoost` toggle and re-applies on every AGR re-render (count
// changes on fleet send/return), with guarded writes so it never loops.
//
// AGR renders the same status link in two distinct DOM shells across
// the two fleetdispatch steps:
//   - Step 1 (ship picker): `a.ago_movement.tooltip` in `#planet`.
//   - Step 2 (target / mission): anchor inside `#ago_summary_fleets`
//     that DROPS the `ago_movement` class. A single-class selector
//     would only catch step 1, so we pair the rules with a sibling
//     selector keyed on the step-2 wrapper id.
//
// # Why a single stylesheet
//
// Both concerns are CSS-only, run at `document_start` before `<body>`,
// and must beat inline styles + game rules. One injected
// `<style id="oge-readability-boost">` with `!important` declarations
// is the simplest way — re-installs dedupe on the stable id and return
// the existing dispose without rewriting the stylesheet. Mirrors the
// shape of {@link ../features/antiFlickerBackground.js}.

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
 * Short label shown in place of OGame's locale "done" word
 * ("wykonano" PL / "completed" EN / …) when no live countdown is running.
 */
export const COUNTDOWN_DONE_LABEL = 'Done';

/**
 * Decide what the event-box countdown should DISPLAY.
 *
 * A live countdown ALWAYS contains a digit — it is a time value. OGame's
 * idle state instead renders a locale word with no digit ("wykonano",
 * "completed", …). We discriminate on "does it contain a digit?" rather
 * than matching any specific word, so the rule holds across every locale
 * OGame ships. A live value is compacted by {@link stripCountdownUnitSuffix};
 * the idle word collapses to a short {@link COUNTDOWN_DONE_LABEL} ("Done")
 * — short enough to sit in the countdown gutter at full size instead of a
 * long locale word sprawling across the box. An empty string passes
 * through untouched: the box is only `#eventboxFilled` when there ARE
 * events, so a blank means "between renders", not "done".
 *
 * Exported so tests can pin the classification without mounting a DOM.
 *
 * @param {string} raw
 * @returns {string}
 */
export const formatCountdownDisplay = (raw) => {
  const text = raw ?? '';
  if (/\d/.test(text)) return stripCountdownUnitSuffix(text);
  if (text.trim() === '') return text;
  return COUNTDOWN_DONE_LABEL;
};

/**
 * Forced, language-independent labels for the fleetdispatch movement
 * link. We discard whatever prefix OGame/AGR emit per locale and keep
 * only the numeric "used/total" pair behind these short, equal-width
 * labels. Exported so tests can pin the exact strings.
 */
export const MOVEMENT_LINK_LABELS = { fleets: 'Fleets:', expeditions: 'Expos:' };

/**
 * Rewrite one movement-link status line ("<locale label> 18/37") to a
 * forced label while preserving the live "used/total" counts. Locale-
 * agnostic: it parses only the trailing `\d+/\d+` pair, so PL "Floty:",
 * DE "Flotten:", RU "Флот:", … all collapse to the same output.
 *
 * Returns the input untouched when no count pair is present — a future
 * AGR shell without counts degrades to its native text instead of losing
 * information. Idempotent on already-relabelled text (it rebuilds the
 * same string from the counts), which is what lets the observer's own
 * write settle without looping.
 *
 * Exported so tests can pin the transform without mounting a DOM.
 *
 * @param {string} text
 * @param {string} label  one of {@link MOVEMENT_LINK_LABELS}.
 * @returns {string}
 */
export const relabelStatusLine = (text, label) => {
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return text;
  return `${label} ${m[1]}/${m[2]}`;
};

/**
 * The override rules. Kept as a module-level constant so tests can
 * assert on the exact selectors + `!important` presence without
 * reaching into internals.
 */
const CSS = `/* OG-E: readability boost — event box + fleet movement link */

/* ===== Event box container =====
   Three pieces of information sit inside this box, across two <p> tags:
   p1 = mission counts ("35 Misje: 19 x własna, 16 przyjazny"), p2 = the
   countdown + the mission-type name.

   Layout: the countdown is the headline and lives absolute-anchored to
   the RIGHT of the card at full size; the mission counts (top) and
   mission-type (below) flow in the left column. The card itself is a
   flat, full-width OG-E surface in the game's own palette (top/bottom
   border only — left/right borders dropped so it reads edge-to-edge). */
#eventboxFilled {
  position: relative !important;
  /* Pull the card up and widen it past its container on both sides so it
     spans edge-to-edge (left/right borders dropped below). */
  margin-top: -5px !important;
  margin-left: -15px !important;
  margin-right: -10px !important;
  /* Flat dark panel in OGame's own palette; top/bottom border only
     (left/right widths zeroed) so it reads as a full-width strip. */
  background: rgba(15, 20, 26, 0.62) !important;
  border: 1px solid rgb(39 43 54) !important;
  box-shadow: 0 2px 6px rgba(1, 1, 1, 1) !important;
  border-right-width: 0px !important;
  border-left-width: 0px !important;
}

/* Row 1 (left column, top) — mission counts. Hide the verbose
   "N Misje:" prefix; the compact count chips (.undermark / .middlemark)
   carry the payload. */
#eventboxFilled > p.event_list:first-child {
  font-size: 0 !important;
  margin: 0 !important;
  line-height: 1.5 !important;
}
#eventboxFilled > p.event_list:first-child .undermark {
  font-size: 12px !important;
  font-weight: 700 !important;
  color: #40c4c1 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.3px !important;
}
/* Friendly-mission count chip (".middlemark", e.g. "16 przyjazny"). The
   game's comma separator between the chips sits in the parent text at
   font-size:0, so re-introduce the gap with an explicit margin. Renders
   only when there are friendly events; absent otherwise. */
#eventboxFilled > p.event_list:first-child .middlemark {
  font-size: 12px !important;
  font-weight: 700 !important;
  color: #4af74d !important;
  margin-left: 10px !important;
}

/* Row 2 (left column, bottom + absolute-right countdown): the second
   <p> holds BOTH .next_event spans (countdown wrapper + mission-type
   wrapper). Hide the parent font-size so the "Następna:" / "Rodzaj:"
   prefixes vanish; the nested payload re-appears via its own size. */
#eventboxFilled > p.event_list:nth-child(2) {
  font-size: 0 !important;
  margin: 0 !important;
  line-height: 1.1 !important;
}
#eventboxFilled .next_event {
  font-size: 0 !important;
  display: inline !important;
  width: auto !important;
}

/* Mission-type (friendly/hostile/neutral): readable, in the left column
   under the count chips. */
#eventboxFilled .next_event .friendly,
#eventboxFilled .next_event .hostile,
#eventboxFilled .next_event .neutral {
  font-size: 18px !important;
  font-weight: 700 !important;
  /* Clamp the mission-type to the left column so a long localized name
     ("Wyszukaj formy życia (R)") ellipsizes at the gutter instead of
     sliding under the absolute countdown. inline-block so max-width /
     overflow apply; max-width:100% resolves against the <p> content box,
     whose right edge IS the reserved countdown gutter (padding-right). */
  display: inline-block !important;
  max-width: 100% !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  vertical-align: bottom !important;
}
/* Mission-type colours mirror OGame's own event palette
   (#eventz tr.friendly/.neutral/.hostile) so they read as native. */
#eventboxFilled .friendly { color: #4af74d !important; }
#eventboxFilled .hostile  { color: #d43635 !important; }
#eventboxFilled .neutral  { color: #fcce00 !important; }

/* Countdown — the headline number, absolute-anchored to the right of
   the card and vertically centred so it stays put regardless of the
   left column's height. The container's right gutter (padding-right)
   keeps it clear of the left text; tabular-nums stops the digits
   jittering as it ticks. */
#eventboxFilled .next_event .countdown {
  position: absolute !important;
  right: 1px !important;
  top: 44% !important;
  transform: translateY(-50%) !important;
  font-size: 60px !important;
  font-weight: 900 !important;
  color: #fcce00 !important;
  /* Dark outline + halo so the gold countdown always stands out, even
     when it overlaps the mission-type text. paint-order draws the stroke
     BEHIND the fill so the digits don't thin out; the soft black shadow
     separates them from anything behind, the faint gold glow keeps the
     OG-E look. */
  -webkit-text-stroke: 1.2px #05070a !important;
  paint-order: stroke fill !important;
  text-shadow:
    0 0 6px rgba(0, 0, 0, 0.85),
    0 0 11px rgba(252, 206, 0, 0.35) !important;
  letter-spacing: 0.5px !important;
  line-height: 1 !important;
  white-space: nowrap !important;
  font-variant-numeric: tabular-nums !important;
}

/* AGR's expand/collapse toggles are irrelevant to the compact view. */
#eventboxFilled #js_eventDetailsClosed,
#eventboxFilled #js_eventDetailsOpen {
  display: none !important;
}

/* ===== Movement link (fleetdispatch header) =====
   Stack "Floty: X/Y" on top of "Ekspedycje: X/Y" left-aligned in a
   subtle themed card. AGR swaps the anchor's status colour between
   ago_color_lightgreen (slots free) and ago_color_palered (37/37 —
   fleets capped); the colour override below is opt-in to the lightgreen
   variant only, so when AGR has already swapped to palered we leave the
   native red alone. The expeditions span keeps its own native colour
   (we tint the anchor only — no universal-child cascade).

   HARD SIZE BUDGET. The host header (#planet.shortHeader) is a FIXED
   40px box (game CSS, !important). Two stacked lines must stay within
   it or the second line ("Ekspedycje") drops out of sight behind the
   component below. At 24px / line-height 0.95 each line is ~23px (2 ≈
   46px) + 0 vertical padding + 2px border ≈ 48px — about the largest
   that still shows both lines in practice. (We tightened line-height
   from 1.05 to 0.95 when bumping the font 21→24px so the taller text
   stays within the same ≈46px vertical envelope — the recipe below for
   going bigger still: raise the font only while tightening line-height/
   padding to hold the total, else the second line vanishes. Safe here
   because our forced "Fleets:" / "Expos:" labels carry no descenders.)

   Two selectors cover the two fleetdispatch steps: step 1 carries the
   ago_movement class on the anchor itself, step 2 wraps the (otherwise
   identical) anchor in #ago_summary_fleets and drops the class. */
a.ago_movement.tooltip,
#ago_summary_fleets > a.tooltip {
  /* Pin the font so the two counts read at a consistent WIDTH across
     devices. Without this we inherit OGame's Verdana — a deliberately
     WIDE screen font that ships on Windows/macOS but NOT Android, where
     mobile Firefox falls back to the much narrower Roboto. Result: the
     label looked noticeably narrower on the phone than on desktop. We
     prefer Roboto (native on Android) then Arial (the Windows/macOS
     fallback when Roboto is absent); Arial and Roboto are close in
     width, so desktop and mobile now match closely instead of diverging
     wide-Verdana vs narrow-Roboto. */
  font-family: Roboto, Arial, sans-serif !important;
  font-size: 28px !important;
  font-weight: 700 !important;
  display: inline-flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  line-height: 1.05 !important;
  gap: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 2px 0 2px 9px !important;
  letter-spacing: 1.0px !important;
  font-variant-numeric: tabular-nums !important;
  text-decoration: none !important;
  box-sizing: border-box !important;
  background: rgba(15, 20, 26, 0.62) !important;
  /* Keep mobile browsers from auto-inflating/shrinking the digits — the
     box is sized off a fixed 28px, so let the authored size stand. */
  -webkit-text-size-adjust: 100% !important;
  text-size-adjust: 100% !important;
  /* Lift the thin coloured digits off the semi-transparent card so they
     stay legible over whatever sits behind it (matters most on small
     mobile viewports, where the native palered washed out). */
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65) !important;
}

/* AGR re-pads the link inside the step-1 fleetdispatch header via an
   ID-specificity rule (#fleet1 .ago_movement { padding: 2px 4px }) that
   the bare a.ago_movement.tooltip rule above can't outrank. Zero it
   (matching ID specificity, plus !important) so the box sits flush. */
#fleet1 a.ago_movement.tooltip {
  padding: 0 !important;
}

/* Step 2 (fleet2 prepared) wraps the count in #ago_summary_fleets, which
   AGR pins to a fixed width: 185px with a top/left margin. Our bigger
   font no longer fits 185px, so each line wraps and the overflow hides
   under the component below. Let it size to content and drop the margin
   so step 2 lays out flush like step 1. Two-ID selector to match AGR's
   own #ago_fleet2 #ago_summary_fleets specificity, plus !important. */
#ago_fleet2 #ago_summary_fleets {
  width: auto !important;
  margin: 0 !important;
}

/* Colour override for the green ("slots free") variant only. The
   palered variant keeps AGR's native red so 37/37 reads as a warning
   at a glance. */
a.ago_movement.tooltip.ago_color_lightgreen,
#ago_summary_fleets > a.tooltip.ago_color_lightgreen {
  color: #4af74d !important;
}

/* Brighten AGR's pale-red "capped" variant. AGR's native salmon is too
   low-contrast on our dark card — barely legible on small mobile
   viewports. We brighten it to a vivid red (still a warning at a glance,
   just readable) for BOTH shapes the count takes: the anchor itself when
   the whole link is palered (fleets capped → the bare fleets text node),
   and the inner palered span (expeditions capped). */
a.ago_movement.tooltip.ago_color_palered,
#ago_summary_fleets > a.tooltip.ago_color_palered,
a.ago_movement.tooltip .ago_color_palered,
#ago_summary_fleets > a.tooltip .ago_color_palered {
  color: #ff5d5d !important;
}

/* Same cross-device font pin as the movement link, on OGame's
   notification bar: render its text in a typeface that exists on BOTH
   platforms (Roboto on Android, Arial on desktop) instead of inheriting
   the wide Verdana that ships only on desktop — so the bar reads at a
   consistent width phone-vs-desktop. Font only for now (no size/layout).
   The descendant selector pulls the nested message spans in with it. */
#notificationbarcomponent,
#notificationbarcomponent * {
  font-family: Roboto, Arial, sans-serif !important;
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
  // `formatCountdownDisplay` — compacting a live value's unit suffixes
  // and collapsing the locale "done" word to a short "Done". When the
  // observer's own write fires a mutation, the transform is idempotent
  // on its own output, so we don't loop. The trimmer shares the
  // `readabilityBoost` toggle — start on enable, disconnect on disable.

  /** @type {import('../lib/visibilityObserver.js').VisibilityObserver | null} */
  let countdownObserver = null;

  const trimCountdown = () => {
    const cd = document.querySelector('#eventboxFilled .countdown');
    if (!cd) return;
    const raw = cd.textContent ?? '';
    const text = formatCountdownDisplay(raw);
    if (text !== raw) cd.textContent = text;
  };

  const startCountdownTrimmer = () => {
    if (countdownObserver) return;
    const box = document.getElementById('eventboxFilled');
    if (!box) return; // nothing to observe — eventbox only exists on some pages
    trimCountdown();
    countdownObserver = createVisibilityObserver(trimCountdown);
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

  // ─── Movement-link relabeller ─────────────────────────────────────
  //
  // Force our short, locale-independent labels onto the fleet-movement
  // status link (see the header comment). AGR owns the counts and
  // re-renders the link on every fleet send/return, so we re-apply on
  // each mutation. Writes are guarded (only when the text changes), so
  // our own write can't drive an infinite loop and a re-pass is a no-op.

  /** @type {import('../lib/visibilityObserver.js').VisibilityObserver | null} */
  let movementObserver = null;

  const relabelMovementLinks = () => {
    const anchors = document.querySelectorAll(
      'a.ago_movement.tooltip, #ago_summary_fleets > a.tooltip',
    );
    const labels = [MOVEMENT_LINK_LABELS.fleets, MOVEMENT_LINK_LABELS.expeditions];
    for (const a of anchors) {
      // The two status lines, in document order: fleets first,
      // expeditions second. We key off ORDER rather than the locale
      // label or the child nodeType, so the rule survives AGR wrapping
      // either count in a span — today the fleets count is a bare text
      // node on the anchor and the expeditions count sits in its own
      // `.ago_color_palered` span (whose colour class we leave intact;
      // `textContent` touches text, not attributes).
      let i = 0;
      for (const node of a.childNodes) {
        if (i >= labels.length) break;
        const raw = node.textContent ?? '';
        if (!/\d+\s*\/\s*\d+/.test(raw)) continue; // skip whitespace / non-count nodes
        const next = relabelStatusLine(raw, labels[i]);
        if (next !== raw) node.textContent = next;
        i += 1;
      }
    }
  };

  const startMovementRelabel = () => {
    if (movementObserver) return;
    // The link lives in `#planet` (step 1) or `#ago_summary_fleets`
    // (step 2, created after load), with no single stable ancestor
    // across both, so we observe the body. The callback is cheap (one
    // querySelectorAll + guarded writes) and only mutates on a real
    // label change, so a broad observation is acceptable here.
    const root = document.body || document.documentElement;
    if (!root) return; // document_start: no body yet — retried on DOMContentLoaded
    relabelMovementLinks();
    movementObserver = createVisibilityObserver(relabelMovementLinks);
    movementObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  };

  const stopMovementRelabel = () => {
    if (movementObserver) {
      movementObserver.disconnect();
      movementObserver = null;
    }
  };

  // At document_start `#eventboxFilled` / the movement link don't exist
  // yet. Start once now (no-op if absent) and once on DOMContentLoaded.
  // Guarded on the hydrated preference: DOMContentLoaded can fire after
  // initSettingsStore() has already resolved readabilityBoost to `false`,
  // and these starters must not re-arm the DOM-rewriting observers when
  // the feature is off (mirrors the settings-hydration subscriber below).
  const onDomReady = () => {
    if (!settingsStore.get().readabilityBoost) return;
    startCountdownTrimmer();
    startMovementRelabel();
  };

  // Initial paint: inject unconditionally so nothing flashes between
  // `document_start` and the first settings-store tick. The subscription
  // below reconciles to the hydrated preference on the next microtask.
  inject();
  startCountdownTrimmer();
  startMovementRelabel();
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
      startMovementRelabel();
    } else {
      retract();
      stopCountdownTrimmer();
      stopMovementRelabel();
    }
  });

  installed = {
    dispose: () => {
      unsubscribe();
      retract();
      stopCountdownTrimmer();
      stopMovementRelabel();
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
