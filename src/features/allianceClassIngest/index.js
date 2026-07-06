// @ts-check

// Isolated-world alliance-CLASS harvester — DOM-based.
//
// OGame's ALLIANCE highscore (page=highscore&category=2) renders every alliance
// row with its class as a CSS token on the name cell's `span.alliance_class`
// (e.g. `class="alliance_class small warrior"`). This is the ONLY
// machine-readable source for the alliance class besides a spied report — the
// public XML API omits it entirely. We observe those rows appearing — the
// server-rendered first page on a direct nav / deep-link AND the pages the pager
// injects via ajax into `#stat_list_content` — and record `allianceId → class`
// for the current universe (state/allianceClass). The danger model
// (domain/dangerJoin) then joins player→alliance (players.xml) to alliance→class
// here, lighting the 'warrior alliance' apex tell without spying every member.
//
// DOM-based (not an XHR hook), like features/targetsIngest: robust to HOW the
// pager fetches (ajax today; could change), and it reads the exact rendered
// markup. Passive: we harvest only what the user opens (the ranking they are
// already viewing) — no background fetches (fair-play).

import {
  allianceClassFromTokens,
  allianceIdFromPositionId,
} from '../../domain/allianceClass.js';
import { mergeAllianceClasses } from '../../state/allianceClass.js';

/* global MutationObserver, document */

// ── OGame alliance-highscore selectors (category=2). Local to this one feature
// per CLAUDE.md's gameDom rule (single-consumer selectors stay put). The
// `.allyHighscore` table class is absent on the PLAYER highscore, so it doubles
// as the "is this the alliance ranking?" gate. ──
/** The alliance-ranking table (also the presence gate). */
const ALLY_HIGHSCORE_TABLE = '#ranks.allyHighscore';
/** One alliance row within it — `id="position<allianceId>"`. */
const ALLY_HIGHSCORE_ROW = `${ALLY_HIGHSCORE_TABLE} tbody tr`;
/** The class-bearing span in a row's name cell. */
const ALLIANCE_CLASS_SPAN = 'span.alliance_class';

/**
 * Read every alliance row currently in the document into an `allianceId → class`
 * bag ('none' included — a KNOWN no-class, distinct from never-seen). Skips rows
 * whose id or class span can't be parsed.
 * @returns {Record<string, string>}
 */
function harvest() {
  /** @type {Record<string, string>} */
  const found = {};
  for (const row of document.querySelectorAll(ALLY_HIGHSCORE_ROW)) {
    const id = allianceIdFromPositionId(row.id);
    if (!id) continue;
    const span = row.querySelector(ALLIANCE_CLASS_SPAN);
    if (!span) continue;
    const cls = allianceClassFromTokens(span.classList);
    if (cls) found[id] = cls;
  }
  return found;
}

/**
 * Signature of the last harvested page — a burst of MutationObserver callbacks
 * during one render should collapse to a single `mergeAllianceClasses` (which
 * does an async storage read); this skips the redundant reads within a page.
 * Cleared on teardown.
 */
let lastSig = '';

/** Harvest the current ranking and merge it into the store (change-gated). */
function sweepAndMerge() {
  const found = harvest();
  const ids = Object.keys(found);
  if (ids.length === 0) return;
  const sig = ids.sort().map((k) => `${k}:${found[k]}`).join(',');
  if (sig === lastSig) return;
  lastSig = sig;
  void mergeAllianceClasses(found);
}

/** @type {MutationObserver | null} */
let observer = null;

/**
 * Install the DOM-based alliance-class harvester. Idempotent. Top-frame only
 * (the highscore UI is the top-level page) — gated by the caller.
 * @returns {void}
 */
export const installAllianceClassIngest = () => {
  if (observer) return;
  // Catch a server-rendered ranking already present (direct nav / deep-link).
  sweepAndMerge();
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element
          && (node.matches(ALLY_HIGHSCORE_TABLE) || node.querySelector(ALLY_HIGHSCORE_TABLE))) {
          sweepAndMerge(); // one sweep covers the whole (re)injected table
          return;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};

/**
 * Test-only: disconnect the observer and reset the de-dup signature.
 * @returns {void}
 */
export const _resetAllianceClassIngestForTest = () => {
  if (observer) observer.disconnect();
  observer = null;
  lastSig = '';
};
