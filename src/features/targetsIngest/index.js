// @ts-check

// Isolated-world espionage-report ingester — DOM-based.
//
// OGame's messages UI renders each message's <div class="rawMessageData"
// data-raw-*> block straight into the page DOM (both the inbox LIST and a
// single report's "więcej detali" detail). We observe the DOM for those
// elements appearing and read their dataset directly — no XHR/fetch hook and no
// MAIN↔isolated boundary, so it's robust to HOW the game fetches the messages.
// (The messages component fetches via `fetch()`, which the XHR observer can't
// see — hence reading the rendered DOM instead.) Every genuine TARGET espionage
// report is normalised (domain/espionageReport) and recorded (state/targets).

import {
  normalizeSpyReport,
  isEspionageReportBag,
  normalizeProximityReport,
  isProximityReportBag,
} from '../../domain/espionageReport.js';
import { recordReport } from '../../state/targets.js';
import { recordProximityReport } from '../../state/proximityReports.js';
import { GAME } from '../../lib/gameDom.js';
import { bagFromElement } from '../../lib/rawMessageBag.js';

/* global MutationObserver, document */

/** Elements already processed, so repeated mutations don't re-ingest them. */
let seen = new WeakSet();

/**
 * Ingest one rawMessageData element. A genuine target spy report feeds the
 * hidden-fleet store; a proximity "spotted near you" alert (distinguished by
 * carrying a `sourceplayerid`) feeds the device-local probe feed. The two
 * predicates are mutually exclusive on that field.
 * @param {Element} el
 * @returns {void}
 */
function ingest(el) {
  if (seen.has(el)) return;
  seen.add(el);
  const bag = bagFromElement(/** @type {HTMLElement} */ (el));
  if (isEspionageReportBag(bag)) {
    const report = normalizeSpyReport(bag);
    if (report) void recordReport(report);
  } else if (isProximityReportBag(bag)) {
    const pr = normalizeProximityReport(bag);
    if (pr) void recordProximityReport(pr);
  }
}

/**
 * Ingest every rawMessageData element at or under `root`.
 * @param {Document | Element} root
 * @returns {void}
 */
function sweep(root) {
  if (root instanceof Element && root.matches(GAME.MESSAGES_RAW_DATA)) ingest(root);
  for (const el of root.querySelectorAll(GAME.MESSAGES_RAW_DATA)) ingest(el);
}

/** @type {MutationObserver | null} */
let observer = null;

/**
 * Install the DOM-based espionage-report ingester. Idempotent. Top-frame only
 * (the messages UI is the top-level page) — gated by the caller.
 * @returns {void}
 */
export const installTargetsIngest = () => {
  if (observer) return;
  // Catch anything already rendered (e.g. a deep-link straight to messages).
  sweep(document);
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element) sweep(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};

/**
 * Test-only: disconnect the observer and reset the de-dup set.
 * @returns {void}
 */
export const _resetTargetsIngestForTest = () => {
  if (observer) observer.disconnect();
  observer = null;
  seen = new WeakSet();
};
