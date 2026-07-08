// @ts-check

// Reader for OGame's per-message `<div class="rawMessageData" data-raw-*>`
// metadata blocks (see lib/gameDom.js GAME.MESSAGES_RAW_DATA): dataset →
// flat attribute bag with the `raw` prefix stripped, i.e. the exact key
// shape the domain/espionageReport predicates and normalisers expect.
// Shared by features/targetsIngest (records reports/alerts) and
// features/whosSpyingPanel (spy-tab detection for its game-owned anchor).
//
// lib/ layer: DOM-reading helper with zero app dependencies (the same
// standing as lib/dom.js).

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
export function bagFromElement(el) {
  /** @type {Record<string, string>} */
  const bag = {};
  const ds = el.dataset;
  for (const k of Object.keys(ds)) {
    const v = ds[k];
    if (typeof v === 'string') bag[stripRawPrefix(k)] = v;
  }
  return bag;
}
