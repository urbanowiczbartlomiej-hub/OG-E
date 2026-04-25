// Expedition-badge feature — render green dots on `#planetList` planets
// that currently have a returning expedition fleet (`mission=15`,
// `return-flight=true`).
//
// # Why this is purely passive
//
// Every byte this module reads comes from DOM that the game itself
// renders into `#eventContent`. We never fire our own XHR / fetch —
// the game's own event ticker keeps that node up to date and we just
// mirror its state onto the planet list. Staying inside "observer of
// DOM the game already produces" is how OG-E stays on the right side
// of the TOS: no parallel request stream, no polling the server, no
// server-side surprise. All we do is styling.
//
// # Lifecycle
//
// `installBadges()` is the single public entry. It:
//
//   1. Injects the badge CSS once (idempotent via a known style id).
//   2. Applies the current `settings.expeditionBadges` flag:
//      - `true`  → render dots from whatever is in `#eventContent` now,
//      - `false` → inject a second CSS rule that hides `.ogi-exp-dots`
//                  globally. We prefer CSS-hide over "do not render" so
//                  flipping the toggle back on is instant: the dots are
//                  already in the DOM, CSS just stops hiding them. We
//                  still re-render on show-toggle to catch any
//                  expeditions that changed while hidden.
//   3. Subscribes to `settingsStore` and reacts ONLY to
//      `expeditionBadges` edge transitions (not every settings write —
//      the settings store is the whole panel, so a colonize-mode toggle
//      would spam us otherwise).
//   4. Installs a MutationObserver scoped to `#planetList` and
//      `#eventContent` (the two sources of truth). Observing the whole
//      document would fire on every unrelated game animation. If
//      neither node exists yet we fall back to `document.body` and
//      re-narrow on the next refresh — see `attachObserver`.
//   5. Refreshes are debounced at 200ms. OGame's event ticker shuffles
//      rows in bursts, and `.planetBarSpaceObjectContainer` mutations
//      cascade — without the quiet period we would re-render dozens of
//      times per visible change.
//
// Returns a `dispose` fn that disconnects the observer, unsubscribes
// from settings, clears every `.ogi-exp-dots` it created, and removes
// both style elements. Safe to call more than once (second call no-op).
//
// Idempotent install: a second `installBadges()` while already
// installed returns the existing dispose handle without touching DOM.
//
// @see ../state/settings.js — where `expeditionBadges` lives.

/** @ts-check */

import { settingsStore } from '../state/settings.js';
import { injectStyle, waitFor } from '../lib/dom.js';
import { debounce } from '../lib/debounce.js';

/**
 * Style-element id for the visible-badge CSS. Kept stable across the
 * feature's lifetime so `injectStyle` stays idempotent on repeat
 * install attempts (e.g. after dispose + re-install in tests).
 */
const STYLE_ID = 'oge-badges-style';

/**
 * Style-element id for the "hide everything" override. A second style
 * node (rather than toggling textContent on the first) keeps each
 * concern on its own `<style>` and lets us remove the hide rule with a
 * single DOM op when the user re-enables badges.
 */
const HIDE_STYLE_ID = 'oge-badges-hide-style';

/** Wrapper class for the dot cluster appended to each planet link. */
const BADGE_CLASS = 'ogi-exp-dots';

/** Single-dot class — one of these per active expedition on that planet. */
const DOT_CLASS = 'ogi-exp-dot';

/**
 * Mission-type value OGame writes into the `data-mission-type`
 * attribute for expeditions. It is an HTML attribute value, i.e. a
 * string, so we compare as strings rather than converting to int —
 * avoids a needless coerce round-trip per row.
 */
const MISSION_EXPEDITION = '15';

/**
 * Refresh debounce window. 200 ms: each refresh does real DOM work,
 * so collapsing bursts aggressively is a net win.
 */
const REFRESH_DEBOUNCE_MS = 200;

const CSS = `
.${BADGE_CLASS} {
  position: absolute;
  left: 2px;
  bottom: 2px;
  display: flex;
  gap: 2px;
  pointer-events: none;
  z-index: 5;
}
.${DOT_CLASS} {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(0, 255, 0, 0.9);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
}
`;

const HIDE_CSS = `.${BADGE_CLASS} { display: none !important; }`;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Trim whitespace and collapse runs of whitespace to single spaces.
 * Used for planet / fleet name matching where the game may indent the
 * inner text with multiple spaces or newlines depending on template.
 *
 * @param {string | null | undefined} s
 * @returns {string}
 */
const trim = (s) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Normalise a coord cell for map-key comparison between the event
 * ticker and the planet list. Two normalisations matter:
 *
 *   - whitespace: `.coordsOrigin` / `.planet-koords` sometimes render
 *     with padding around the colons (`"[1: 2: 3]"`) depending on the
 *     template — strip every whitespace character so the string is
 *     dense `"1:2:3"`-shaped,
 *   - brackets: `.coordsOrigin` and `.planet-koords` are inconsistent
 *     about rendering the `[ ]` delimiters. Some OGame server versions
 *     emit the event-ticker coords bare (`"1:2:3"`) while the planet
 *     list keeps the brackets (`"[1:2:3]"`). Stripping brackets from
 *     both sides collapses them to the same key and lets the Map
 *     lookup in `renderBadges` succeed.
 *
 * The `g:s:p` triple remains uniquely identifying after stripping —
 * it is the game-wide coordinate format with no ambiguity.
 *
 * @param {string | null | undefined} s
 * @returns {string}
 */
const trimCoords = (s) => trim(s).replace(/[\s\[\]]/g, '');

/**
 * Parse a ship-count cell. OGame uses non-breaking spaces and dots as
 * thousand separators, so we simply strip every non-digit before
 * parsing. Empty / non-numeric input returns 0 — the caller treats
 * that as "unknown" and it just makes the tooltip sum shorter.
 *
 * @param {string | null | undefined} text
 * @returns {number}
 */
const parseShipCount = (text) => {
  if (!text) return 0;
  const digits = text.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

/**
 * @typedef {object} ExpeditionInfo
 * @property {number} count  How many active expedition fleets share this origin.
 * @property {number} ships  Sum of ship counts across those fleets (for tooltip).
 * @property {string} name   Fleet / origin name (fallback match key).
 * @property {string} coords Origin coords string `"[g:s:p]"` (primary match key).
 */

/**
 * Scan `#eventContent` for expedition-mission rows whose return-flight
 * flag is set, and group them by origin coords. When origin coords are
 * missing (rare — typically mid-mutation), fall back to grouping by
 * fleet name under the `name:` prefix so we still render something on
 * the matching planet.
 *
 * Pure DOM read. Returns a fresh Map on every call.
 *
 * @returns {Map<string, ExpeditionInfo>}
 */
const collectActiveExpeditions = () => {
  /** @type {Map<string, ExpeditionInfo>} */
  const map = new Map();
  const rows = document.querySelectorAll(
    `#eventContent tr.eventFleet[data-mission-type="${MISSION_EXPEDITION}"][data-return-flight="true"]`,
  );
  for (const row of rows) {
    const name = trim(row.querySelector('.originFleet')?.textContent);
    const coords = trimCoords(row.querySelector('.coordsOrigin')?.textContent);
    const ships = parseShipCount(row.querySelector('.detailsFleet span')?.textContent);
    const key = coords || (name ? `name:${name}` : '');
    if (!key) continue;
    const entry = map.get(key) || { count: 0, ships: 0, name, coords };
    entry.count += 1;
    entry.ships += ships;
    map.set(key, entry);
  }
  return map;
};

/**
 * Remove every `.ogi-exp-dots` element from the document. Called
 * before each render pass so we never accumulate stale dots, and on
 * dispose so we leave the page clean for the next feature owner.
 *
 * @returns {void}
 */
const clearBadges = () => {
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
};

/**
 * One render pass: wipe existing dots, read the current expedition
 * state out of `#eventContent`, then walk every `#planetList
 * .smallplanet` and append a `.ogi-exp-dots` cluster wherever we find
 * a match by coords (or by fleet name as fallback).
 *
 * The match-by-coords-first rule matters: two colonies can theoretically
 * share a fleet name (same user alias across planets), but they cannot
 * share coords, so the coord lookup is the authoritative key and the
 * name key is a best-effort fallback.
 *
 * @returns {void}
 */
const renderBadges = () => {
  clearBadges();
  const expeditions = collectActiveExpeditions();
  if (expeditions.size === 0) return;
  const planets = document.querySelectorAll('#planetList .smallplanet');
  for (const planet of planets) {
    const link = planet.querySelector('a.planetlink');
    if (!link) continue;
    const name = trim(link.querySelector('.planet-name')?.textContent);
    const coords = trimCoords(link.querySelector('.planet-koords')?.textContent);
    const info = expeditions.get(coords) || expeditions.get(`name:${name}`);
    if (!info) continue;
    const container = link.querySelector('.planetBarSpaceObjectContainer');
    if (!container) continue;
    const dots = document.createElement('div');
    dots.className = BADGE_CLASS;
    dots.title = `Expeditions: ${info.count} | Ships: ${info.ships.toLocaleString('en-US')}`;
    for (let i = 0; i < info.count; i++) {
      const dot = document.createElement('div');
      dot.className = DOT_CLASS;
      dots.appendChild(dot);
    }
    container.appendChild(dots);
  }
};

// ── Install / dispose ────────────────────────────────────────────────

/**
 * Module-scope install handle. Holds the dispose fn AND a direct
 * reference to the MutationObserver so a test harness could in theory
 * poke at it — but production code just calls dispose. `null` when
 * not installed, non-null between install and dispose.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Attach the MutationObserver to `#planetList` and `#eventContent`
 * when those nodes exist, or fall back to observing `document.body`
 * when neither is present yet (early-install case: the game is still
 * hydrating and the containers haven't landed).
 *
 * The fallback is important because `installBadges` is called once
 * at boot time from `content.js` — if we refused to observe anything
 * when the containers are missing we would never pick up the first
 * render. Observing body is noisier but correct; once the refresh
 * loop runs we do narrow observation in subsequent passes (see
 * `scheduleRefresh`).
 *
 * @param {MutationObserver} observer
 * @returns {{ observedScoped: boolean }}
 *   Reports whether at least one scoped target was attached. Callers
 *   (scheduleRefresh) use this to decide if a rewire attempt is worth
 *   making after the DOM settles.
 */
const attachObserver = (observer) => {
  const planetList = document.getElementById('planetList');
  const eventContent = document.getElementById('eventContent');
  let observedScoped = false;
  if (planetList) {
    observer.observe(planetList, { childList: true, subtree: true });
    observedScoped = true;
  }
  if (eventContent) {
    observer.observe(eventContent, { childList: true, subtree: true });
    observedScoped = true;
  }
  // Always observe body in addition. OGame AJAX-swaps #planetList and
  // especially #eventContent on mission refresh — the new instance
  // replaces the old node, so a scoped observer attached to the old
  // (now-detached) instance stops firing. Body-level observation is
  // slightly noisier but survives the swap.
  observer.observe(document.body, { childList: true, subtree: true });
  return { observedScoped };
};

/**
 * Install the expedition-badge feature.
 *
 * Idempotent: calling this a second time while already installed is a
 * no-op and returns the SAME dispose fn as the first call. This
 * mirrors `installColonyRecorder` and keeps boot code from having to
 * track install state itself.
 *
 * Contract for the returned dispose fn:
 *
 *   - Disconnects the MutationObserver so no further refresh is
 *     scheduled. A pending debounced refresh from before dispose
 *     (fired within the last `REFRESH_DEBOUNCE_MS`) is NOT cancelled —
 *     it will run, but since it only calls `renderBadges` via a guard
 *     that checks `installed !== null`, and `installed` is nulled
 *     before the disposer returns, any queued refresh is a safe no-op.
 *   - Unsubscribes from `settingsStore`.
 *   - Removes every `.ogi-exp-dots` element and both style nodes.
 *   - Flips the module-scope `installed` sentinel back to `null`.
 *
 * @returns {() => void} Dispose handle.
 */
export const installBadges = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);

  /**
   * MutationObserver instance, declared up front so {@link renderGuarded}
   * can pause it during our own DOM writes and avoid a feedback loop.
   * Assigned below once the observer is constructed; `null` until then,
   * so the very first `renderGuarded` call (during initial visibility
   * apply) just no-ops the disconnect/reattach.
   *
   * @type {MutationObserver | null}
   */
  let observer = null;

  /**
   * Run {@link renderBadges} with the observer paused. Without this
   * wrapper, our own `clearBadges` + `container.appendChild` mutations
   * fire the MutationObserver, which schedules a refresh, which renders
   * again — a 200 ms (debounce-limited) feedback loop that visibly
   * flickers the planet list every tick.
   *
   * Single-threaded JS means nothing else can mutate the DOM while
   * `renderBadges` runs synchronously, so the disconnect window only
   * drops OUR own (intentional) mutations. External mutations (game
   * AJAX, AGR rebuilds) re-fire normally after the reattach, and the
   * 3 s safety poll catches anything we'd theoretically miss in the
   * tiny disconnect gap.
   *
   * No-op observer-side when `observer` is still null (initial render
   * runs before the observer is constructed) — the inner
   * `renderBadges()` still happens.
   *
   * @returns {void}
   */
  const renderGuarded = () => {
    if (observer) observer.disconnect();
    try {
      renderBadges();
    } finally {
      if (observer) attachObserver(observer);
    }
  };

  /**
   * Apply the current visibility flag. `enabled=true` removes the hide
   * rule (if present) and triggers a render so any expeditions that
   * started while hidden show up immediately. `enabled=false` installs
   * the hide rule — we keep the rendered dots in place so re-enabling
   * is a zero-work DOM diff.
   *
   * @param {boolean} enabled
   * @returns {void}
   */
  const applyVisibility = (enabled) => {
    if (enabled) {
      const hideEl = document.getElementById(HIDE_STYLE_ID);
      if (hideEl) hideEl.remove();
      renderGuarded();
      // Post-reload race: at DOMContentLoaded, #planetList and
      // #eventContent are in the DOM but empty — OGame's inline
      // scripts populate them moments later. If the observer
      // attached during that empty window, later hydration happens
      // before it starts listening and we miss the only DOM change
      // that would have triggered a refresh. Poll until the planet
      // list actually has rows, then render once more. 5 s timeout
      // is well past any realistic load time and a no-op if the
      // initial render already succeeded (renderBadges is idempotent
      // and cheap).
      void waitFor(
        () => document.querySelectorAll('#planetList .smallplanet').length > 0,
        { timeoutMs: 5000, intervalMs: 250 },
      ).then(() => {
        if (installed && settingsStore.get().expeditionBadges) renderGuarded();
      });
    } else {
      injectStyle(HIDE_STYLE_ID, HIDE_CSS);
    }
  };

  // Initial state — snapshot the flag once and apply.
  applyVisibility(settingsStore.get().expeditionBadges);

  /**
   * Debounced refresh used by both the MutationObserver and (in
   * principle) any future caller that needs to nudge the render loop.
   * The guard on `expeditionBadges` means we don't waste work
   * re-rendering dots that are CSS-hidden anyway.
   */
  const scheduleRefresh = debounce(() => {
    if (!installed) return;
    if (settingsStore.get().expeditionBadges) renderGuarded();
  }, REFRESH_DEBOUNCE_MS);

  // React to settings toggles. The settings store is the whole panel,
  // so we diff against the previous `expeditionBadges` value to avoid
  // re-applying visibility on unrelated field changes (colMinGap
  // edits, colPassword edits, ...).
  let prevEnabled = settingsStore.get().expeditionBadges;
  const unsubSettings = settingsStore.subscribe((next) => {
    if (next.expeditionBadges !== prevEnabled) {
      applyVisibility(next.expeditionBadges);
      prevEnabled = next.expeditionBadges;
    }
  });

  observer = new MutationObserver(() => {
    scheduleRefresh();
  });
  attachObserver(observer);

  // Safety-net poll. OGame refreshes #eventContent on a ~30s AJAX
  // tick and has historically found ways to dodge every scoped
  // observer we attach. 3s is tight enough that missions show up
  // almost immediately after the AJAX lands and far wider than any
  // user interaction cadence — the re-render is O(#planets) DOM
  // ops, practically free. Gated on `expeditionBadges` so a disabled
  // feature costs literally one settings read per interval.
  const safetyPoll = setInterval(() => {
    if (settingsStore.get().expeditionBadges) renderGuarded();
  }, 3000);

  installed = {
    dispose: () => {
      observer.disconnect();
      clearInterval(safetyPoll);
      unsubSettings();
      clearBadges();
      const styleEl = document.getElementById(STYLE_ID);
      if (styleEl) styleEl.remove();
      const hideEl = document.getElementById(HIDE_STYLE_ID);
      if (hideEl) hideEl.remove();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Unlike
 * a bare `installed = null`, this also runs the current dispose fn
 * (when one exists) so DOM is left clean between test cases —
 * otherwise a leaked observer from test N could react to DOM churn
 * in test N+1 and double-render.
 *
 * Exported under a `_` prefix to signal "do not import from
 * production code".
 *
 * @returns {void}
 */
export const _resetBadgesForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
