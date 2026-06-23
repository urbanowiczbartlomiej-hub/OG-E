// Artifact-Shop watcher — detects when every reward rank of the Artifact
// Shop event is claimed and stamps the event's end time so the event-menu
// highlight can stop pulsing the (still-running) Artifact-Shop button.
//
// # Problem
//
// The Artifact Shop is a multi-day event that appears in the left toolbar as
// an ephemeral `premiumHighligt` item — so `eventMenuHighlight` pulses it to
// draw attention. But the event keeps running (and the button keeps pulsing)
// for days after the player has already claimed every rank. Once all ranks
// are claimed there is nothing left to do, so the pulse is pure noise that
// trains the player to ignore it.
//
// # Solution
//
// Only on the Artifact-Shop page (`?page=ingame&component=artifactshop`) we
// inspect the rank scrollbar. When EVERY `<tier>` carries the `tierClaimed`
// class the event is fully done. We then stamp `artifactShopDoneUntil` (epoch
// ms) to the event's own end time and dispatch `oge:dailyStateChanged` so the
// sync scheduler uploads it. The highlighter suppresses the button while
// `Date.now()` is before that timestamp.
//
// # Why an end-TIME (not a boolean)
//
// The suppression must AUTO-clear when the next Artifact-Shop event begins,
// and the menu button carries no event identity to compare against. Stamping
// the current event's end time means the window expires exactly when the
// event does, so a fresh event lights up again with zero extra bookkeeping.
// See `ARTIFACT_SHOP_DONE_KEY` in `state/dailyActions.js`.
//
// # End-time source
//
// The page renders an inline `new CountdownTimer('eventTime', <seconds>, …)`
// — `<seconds>` is the authoritative server remaining-time, locale-independent
// (the visible `<time class="eventTime">6d 12g…` text is localized and
// fragile, so we read the integer instead). If it can't be parsed we fall
// back to a conservative fixed window (the event's tail after all ranks are
// claimed is at most a handful of days).
//
// # Completion rule
//
// Every `<tier>` inside `<tier-scrollbar>` must carry the `tierClaimed` class,
// and the list must be non-empty (guards the transient empty DOM while the
// AJAX render is in flight). Ranks not yet unlocked are NOT `tierClaimed`, so
// partial progress never counts as done.
//
// # Lifecycle  (mirrors rewardingWatcher.js)
//
//   1. `installArtifactShopWatcher()` is a no-op on every other page.
//   2. A MutationObserver on `document.body` re-checks on every DOM change
//      (debounced 200 ms) — covers claiming the final rank in-place.
//   3. A 5-second safety-poll covers observer gaps after a server re-render.
//   4. `checkCompletion` short-circuits while the stored window is still in
//      the future (`cur > now`) — self-limiting, so no write churn and no
//      window creep across repeat visits.
//   5. Dispose disconnects the observer and clears the poll.
//
// Idempotent install: a second call returns the same dispose fn.
//
// @ts-check

/* global document, CustomEvent, location */

import { debounce } from '../lib/debounce.js';
import { createVisibilityObserver } from '../lib/visibilityObserver.js';
import { writeDailyState, readDailyState } from '../state/dailyActions.js';
import { DAILY_STATE_CHANGED_EVENT } from '../lib/ogeEvents.js';
import { clock } from '../lib/clock.js';

// ── Game-DOM contract (local — only this feature reads it) ─────────────────
// Verbatim OGame selectors/classes for the Artifact-Shop rank scrollbar.
// Kept here (not in lib/gameDom.js) because no other feature reads them.
/** Each reward rank in the scrollbar. */
const TIER_SEL = 'tier-scrollbar tier';
/** Class OGame puts on a fully-claimed rank. */
const TIER_CLAIMED_CLASS = 'tierClaimed';

/**
 * Fallback suppression window when the event countdown can't be parsed. The
 * Artifact-Shop event's tail after the last rank is claimed is at most a few
 * days, so a week is a safe ceiling that still self-expires before any next
 * event could realistically start.
 */
const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return true iff the page is the Artifact-Shop component. Locale-independent.
 *
 * @returns {boolean}
 */
const isArtifactShopPage = () => {
  try {
    return new URLSearchParams(location.search).get('component') === 'artifactshop';
  } catch {
    return false;
  }
};

/**
 * Whether every reward rank is claimed. True only when the rank list is
 * non-empty and every `<tier>` carries the `tierClaimed` class.
 *
 * @param {ParentNode} root  Element/document containing the rank scrollbar.
 * @returns {boolean}
 */
export const allTiersClaimed = (root) => {
  const tiers = [...root.querySelectorAll(TIER_SEL)];
  return tiers.length > 0 && tiers.every((t) => t.classList.contains(TIER_CLAIMED_CLASS));
};

/**
 * Parse the Artifact-Shop event's remaining seconds from the inline
 * `new CountdownTimer('eventTime', <seconds>, …)` call. Returns 0 when no
 * such timer is present (caller then uses the fallback window).
 *
 * @param {string} scriptText
 * @returns {number}  Remaining seconds, or 0 if not found.
 */
export const parseEventRemainingSeconds = (scriptText) => {
  const m = /CountdownTimer\(\s*['"]eventTime['"]\s*,\s*(\d+)/.exec(scriptText);
  return m ? Number(m[1]) : 0;
};

/**
 * Compute the suppression-until timestamp: the event end (now + remaining)
 * when the countdown was parsed, else a conservative fixed window from now.
 *
 * @param {number} nowMs
 * @param {number} remainingSeconds  0 ⇒ use the fallback window.
 * @returns {number} Epoch-ms.
 */
export const artifactShopDoneUntil = (nowMs, remainingSeconds) =>
  remainingSeconds > 0 ? nowMs + remainingSeconds * 1000 : nowMs + FALLBACK_WINDOW_MS;

/**
 * Read the event's remaining seconds from the page's inline scripts. Scans
 * `<script>` text (the timer call lives in an inline script appended after
 * the component markup). Returns 0 if absent.
 *
 * @returns {number}
 */
const readRemainingSeconds = () => {
  for (const s of document.getElementsByTagName('script')) {
    if (s.textContent && s.textContent.includes('CountdownTimer')) {
      const secs = parseEventRemainingSeconds(s.textContent);
      if (secs > 0) return secs;
    }
  }
  return 0;
};

/** @type {{ dispose: () => void } | null} */
let installed = null;

/**
 * Inspect the page; if every rank is claimed and we are not already
 * suppressing an active window, stamp the event's end time and dispatch the
 * sync event.
 *
 * @returns {void}
 */
const checkCompletion = () => {
  if (!allTiersClaimed(document)) return;

  const now = Date.now();
  // Already suppressing this (or another active) event — leave it untouched.
  // Self-limiting: prevents re-writes on every observer/poll tick and stops
  // the window from creeping forward across repeat visits.
  if (readDailyState().artifactShopDoneUntil > now) return;

  writeDailyState({ artifactShopDoneUntil: artifactShopDoneUntil(now, readRemainingSeconds()) });
  document.dispatchEvent(new CustomEvent(DAILY_STATE_CHANGED_EVENT));
};

/**
 * Install the Artifact-Shop watcher feature.
 *
 * No-op (returns a trivial dispose) on pages other than
 * `component=artifactshop`. Idempotent: a second call while already installed
 * returns the existing dispose fn.
 *
 * @returns {() => void} Dispose handle.
 */
export const installArtifactShopWatcher = () => {
  if (installed) return installed.dispose;
  if (!isArtifactShopPage()) {
    const noop = () => {};
    return noop;
  }

  checkCompletion();

  const scheduleCheck = debounce(() => {
    if (installed) checkCompletion();
  }, 200);

  const observer = createVisibilityObserver(scheduleCheck);
  observer.observe(document.body, { childList: true, subtree: true });

  // Backstop for a missed observer tick, on the shared visibility-aware
  // clock — pauses while the tab is hidden, snaps once on return.
  const unsubPoll = clock.subscribe(() => {
    if (installed) checkCompletion();
  }, { everyMs: 5000 });

  installed = {
    dispose: () => {
      observer.disconnect();
      unsubPoll();
      installed = null;
    },
  };
  return installed.dispose;
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetArtifactShopWatcherForTest = () => {
  if (installed) {
    installed.dispose();
    installed = null;
  }
};
