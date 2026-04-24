// Colony recorder — passive histogram-dataset collection.
//
// # What it does
//
// When the user loads the OGame overview page for a planet that has never
// had anything built on it (`usedFields === 0`), this feature captures the
// planet's `cp`, max `fields`, `coords` and `position` and appends a
// {@link ColonyEntry}-shaped row to {@link historyStore}. Deduplication is
// by `cp` — if we have already recorded the planet, the second overview
// visit is a no-op.
//
// # Why only `usedFields === 0`
//
// Max `fields` is fixed per planet for its lifetime, so in principle we
// could record any overview visit. But overview visits to developed
// planets happen constantly (every login, every tab switch, every menu
// action) and each one would force a write-through to chrome.storage.
// Gating on `usedFields === 0` narrows the trigger to the one moment that
// actually produces a new row: the first overview-load of a fresh colony.
// After that, the dedup-by-cp check makes repeat attempts cheap.
//
// # Why we do NOT prune abandoned colonies
//
// This is documented at length in `src/state/history.js`: the
// histogram is meant to estimate
// the real shape of OGame's `fields` distribution, which means every
// observation counts, including planets the player later abandoned. If
// we only kept "current" colonies the small-fields bucket would look
// artificially empty — small planets get abandoned fast — biasing every
// downstream statistic toward the large end. The recorder therefore
// only ever appends; removal lives in a separate user-driven tombstone
// path and is not this module's concern.
//
// # Why a single attempt (with retry) per install
//
// The content script runs the install once on boot. OGame reloads the
// whole page on every navigation, so a new process runs for each
// overview visit. We do not listen for SPA nav or mutations — one install
// per page-load is both simpler and exactly right for the trigger we
// want. The `waitFor` retry exists only because the overview DOM can
// still be hydrating when `content.js` fires; once the relevant nodes
// are present (or 5s has elapsed), the recorder is done.
//
// @see ../state/history.js — the store this feature writes into, and the
//   canonical explanation of the "keep every observation" invariant.

/** @ts-check */

import { historyStore } from '../state/history.js';
import { waitFor } from '../lib/dom.js';

/**
 * Parse the bracketed coord string OGame renders inside
 * `#positionContentField a`, e.g. `"[4:30:8]"`.
 *
 * Returns both the trimmed coord string (to preserve the game-DOM format
 * downstream consumers expect) and the integer `position` (slot number
 * 1..15). Anything that does not match the exact bracketed form is
 * treated as unparseable — we never record partial coords.
 *
 * @param {string | null | undefined} text
 * @returns {{ coords: string, position: number } | null}
 */
const parseCoords = (text) => {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^\[(\d+):(\d+):(\d+)\]$/);
  if (!match) return null;
  return {
    coords: trimmed,
    position: parseInt(match[3], 10),
  };
};

/**
 * Parse the `#diameterContentField` text, which mixes a diameter number
 * with a `(usedFields/maxFields)` pair, e.g. `"12345km (0/163)"`.
 *
 * We only care about the parenthesised pair; the diameter number itself
 * is irrelevant for histogram collection. Returns `null` when the pair
 * is missing or malformed — the feature then skips the write.
 *
 * @param {string | null | undefined} text
 * @returns {{ usedFields: number, maxFields: number } | null}
 */
const parseDiameter = (text) => {
  if (typeof text !== 'string') return null;
  const match = text.match(/\((\d+)\/(\d+)\)/);
  if (!match) return null;
  return {
    usedFields: parseInt(match[1], 10),
    maxFields: parseInt(match[2], 10),
  };
};

/**
 * Read the currently-selected planet's `cp` from `#planetList
 * .hightlightPlanet` (note the OGame-native spelling, not "highlight").
 * The node's id is `"planet-<cpId>"`.
 *
 * Returns `null` when the highlighted planet is missing, the id is not
 * the expected form, or the numeric tail is zero / NaN. We never accept
 * `cp === 0`: OGame's planet ids are strictly positive, and 0 would
 * silently collide with an "unset" sentinel elsewhere.
 *
 * @returns {number | null}
 */
const readActiveCp = () => {
  const active = document.querySelector('#planetList .hightlightPlanet');
  if (!active) return null;
  const id = active.id;
  if (typeof id !== 'string' || !id.startsWith('planet-')) return null;
  const cp = parseInt(id.slice('planet-'.length), 10);
  return Number.isFinite(cp) && cp > 0 ? cp : null;
};

/**
 * Single collection attempt. Returns `true` if a new entry was appended
 * to {@link historyStore}, `false` in every other case (wrong page, DOM
 * not ready, already-recorded `cp`, non-fresh colony, malformed parse).
 *
 * The function is pure-ish: it reads `location.search` and the document,
 * and writes to `historyStore`. All branches that do NOT append return
 * early without any side effect, which is what lets `installColonyRecorder`
 * call this twice (sync + post-waitFor) without double-recording.
 *
 * @returns {boolean}
 */
const tryCollect = () => {
  if (!location.search.includes('component=overview')) return false;

  const cp = readActiveCp();
  if (cp === null) return false;

  const diameterEl = document.getElementById('diameterContentField');
  const diameter = parseDiameter(diameterEl?.textContent);
  if (!diameter) return false;
  // Fresh colonies only — see module header on why this gate matters.
  if (diameter.usedFields !== 0) return false;

  const coordsEl = document.querySelector('#positionContentField a');
  const parsed = parseCoords(coordsEl?.textContent);
  if (!parsed) return false;

  // Dedup by cp: OGame's cp-ids are globally unique and monotonically
  // increasing, so a matching cp means we already have this observation.
  const current = historyStore.get();
  if (current.some((h) => h.cp === cp)) return false;

  historyStore.update((prev) => [
    ...prev,
    {
      cp,
      fields: diameter.maxFields,
      coords: parsed.coords,
      position: parsed.position,
      timestamp: Date.now(),
    },
  ]);
  return true;
};

/**
 * The installed-dispose handle, or `null` when the recorder is not
 * currently installed. Kept at module scope so repeat installs collapse
 * to a no-op — returning the same dispose fn — rather than queuing
 * redundant collection attempts for the same page-load.
 *
 * @type {(() => void) | null}
 */
let installed = null;

/**
 * Install the colony recorder for the current page-load.
 *
 * Behaviour:
 *   1. First synchronous attempt. If the overview DOM is already
 *      populated and the planet is fresh, the write happens immediately
 *      and the returned dispose is effectively a no-op.
 *   2. If the sync attempt did not record anything, schedule a
 *      {@link waitFor} poll for `#diameterContentField` (the last DOM
 *      node the overview page paints). When it appears we retry exactly
 *      once; on timeout we silently give up. We never retry on "present
 *      but malformed" — that indicates the page is not the overview we
 *      expected and polling will not fix it.
 *   3. Idempotent per page-load: calling `installColonyRecorder()` a
 *      second time returns the dispose handle from the first call
 *      without scheduling a second attempt. The OGame content script
 *      only runs once per navigation, so this guards against accidental
 *      double-calls from boot code rather than a real multi-install
 *      lifecycle.
 *
 * The returned dispose flips `installed` back to `null`, re-enabling a
 * future install. It does NOT cancel a still-pending `waitFor` poll —
 * the poll's resolution always goes through `tryCollect`, which is a
 * no-op once the entry exists in history (dedup by cp) or once the page
 * has navigated away (location.search check). No cleanup is necessary
 * for correctness; the dispose is there for API symmetry with other
 * features (blackBg, expeditionRedirect, ...).
 *
 * @returns {() => void} Dispose handle — currently just flips the
 *   module-scope `installed` sentinel back to `null`.
 */
export const installColonyRecorder = () => {
  if (installed) return installed;
  installed = () => {
    installed = null;
  };

  // Synchronous first try — avoids a pointless waitFor roundtrip when
  // the overview DOM is already hydrated (the common case once OGame's
  // own scripts have finished running before us).
  if (tryCollect()) return installed;

  // Retry path: poll for the diameter element, then attempt once more.
  // The poll itself aborts (returns truthy) when location.search stops
  // saying `component=overview`, so a user navigating away mid-wait
  // does not leave us stuck until the 5s timeout.
  waitFor(
    () => {
      if (!location.search.includes('component=overview')) return true;
      return document.getElementById('diameterContentField') !== null;
    },
    { timeoutMs: 5000, intervalMs: 200 },
  ).then(() => {
    tryCollect();
  });

  return installed;
};

/**
 * Test-only reset for the module-scope `installed` sentinel. Production
 * code never needs this — the recorder lives for the page-load and is
 * replaced by a fresh module on navigation — but between vitest cases
 * we need a clean slate so idempotency tests do not see leftover state
 * from the previous case.
 *
 * Exported under a `_` prefix to signal "do not import from production
 * code". Kept in the public API surface because vitest files cannot
 * reach module-scope `let` bindings any other way.
 *
 * @returns {void}
 */
export const _resetColonyRecorderForTest = () => {
  installed = null;
};
