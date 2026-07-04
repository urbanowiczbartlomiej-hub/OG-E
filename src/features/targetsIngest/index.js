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

import { normalizeSpyReport, isEspionageReportBag } from '../../domain/espionageReport.js';
import { recordReport } from '../../state/targets.js';
import { GAME } from '../../lib/gameDom.js';

/* global MutationObserver, document */

/**
 * `data-raw-defenseValue` → dataset key `rawDefenseValue`. Strip the leading
 * `raw` and lowercase the next char to recover the attribute name the domain
 * normaliser expects (`defenseValue`).
 * @param {string} datasetKey
 * @returns {string}
 */
function stripRawPrefix(datasetKey) {
  if (!datasetKey.startsWith('raw') || datasetKey.length < 4) return datasetKey;
  const rest = datasetKey.slice(3);
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

/**
 * Read a rawMessageData element's `data-raw-*` attributes into a flat bag.
 * @param {HTMLElement} el
 * @returns {Record<string, string>}
 */
function bagFromElement(el) {
  /** @type {Record<string, string>} */
  const bag = {};
  const ds = el.dataset;
  for (const k of Object.keys(ds)) {
    const v = ds[k];
    if (typeof v === 'string') bag[stripRawPrefix(k)] = v;
  }
  return bag;
}

/** Elements already processed, so repeated mutations don't re-ingest them. */
let seen = new WeakSet();

/**
 * Ingest one rawMessageData element if it's a genuine target spy report.
 * @param {Element} el
 * @returns {void}
 */
function ingest(el) {
  if (seen.has(el)) return;
  seen.add(el);
  const bag = bagFromElement(/** @type {HTMLElement} */ (el));
  if (!isEspionageReportBag(bag)) return;
  const report = normalizeSpyReport(bag);
  if (report) void recordReport(report);
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
