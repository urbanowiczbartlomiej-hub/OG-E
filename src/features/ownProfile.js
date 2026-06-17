// Own-profile reader — scrapes our standing off the in-game header bar once
// per page load and stores it (`state/ownProfile.js`) so Colony Scout can
// score neighbours RELATIVE to us.
//
// The header bar (`#headerbarcomponent`) is present on every game page and
// carries everything we need:
//   - honour rank class on `.honorRank` (e.g. `rank_starlord2`);
//   - highscore position as a parenthesised number next to the "Statystyki"
//     link in `#headerBarLinks` (e.g. `… (250)`), with our id in the same
//     link's `searchRelId=`;
//   - display name in `.textBeefy`.
//
// These selectors are read by exactly ONE feature, so per the gameDom.js rule
// they stay local here rather than being hoisted to the shared selector file.
// The game's own markup, scraped defensively — any missing piece is simply
// omitted, and a header with nothing recognisable writes nothing.
//
// @ts-check

import { writeOwnProfile } from '../state/ownProfile.js';

/** Matches the honour-rank token in a `.honorRank` className. */
const RANK_CLASS_RE = /\brank_[a-z0-9]+/i;
/** Matches the parenthesised highscore position, e.g. "Statystyki (250)". */
const PAREN_NUM_RE = /\((\d{1,7})\)/;

/**
 * Read our profile from a header-bar DOM subtree. Pure-ish: only READS the
 * DOM (no writes, no storage), so it's unit-testable by handing in a parsed
 * `document`. Returns `null` when nothing recognisable is present.
 *
 * @param {ParentNode} [root] Defaults to the live `document`.
 * @returns {import('../state/ownProfile.js').OwnProfile | null}
 */
export const extractOwnProfile = (root = document) => {
  /** @type {import('../state/ownProfile.js').OwnProfile} */
  const out = {};

  // Honour rank class: <span class="honorRank rank_starlord2 …">
  const honor = root.querySelector('#bar .honorRank, .honorRank');
  if (honor) {
    const m = honor.className.match(RANK_CLASS_RE);
    if (m) out.rankClass = m[0];
  }

  // Highscore link → the rank lives as "(250)" in its parent span's text, and
  // our id in the link's `searchRelId`.
  const hs = root.querySelector('#headerBarLinks a[href*="page=highscore"]');
  if (hs) {
    const span = hs.closest('span') || hs.parentElement;
    const rankM = (span?.textContent || '').match(PAREN_NUM_RE);
    if (rankM) out.rank = parseInt(rankM[1], 10);
    const idM = (hs.getAttribute('href') || '').match(/searchRelId=(\d+)/);
    if (idM) out.id = parseInt(idM[1], 10);
  }

  // Fallback id from the own-profile link (`profileId=`), if the highscore
  // link didn't carry one.
  if (out.id === undefined) {
    const prof = root.querySelector('a[href*="profileId="]');
    const idM = (prof?.getAttribute('href') || '').match(/profileId=(\d+)/);
    if (idM) out.id = parseInt(idM[1], 10);
  }

  // Display name: the clean player name in `.textBeefy` (its inner link).
  const nameEl = root.querySelector('#bar .textBeefy a, #bar .textBeefy, .textBeefy a, .textBeefy');
  const name = (nameEl?.textContent || '').trim();
  if (name) out.name = name;

  return Object.keys(out).length > 0 ? out : null;
};

/** Idempotency guard so a double install reads the header only once. */
let installed = false;

/**
 * Read the header bar and persist our profile. Best-effort and idempotent:
 * a page without the header (or an unexpected shape) simply writes nothing.
 * Safe in node-env tests (no `document` → no-op).
 *
 * @returns {void}
 */
export const installOwnProfile = () => {
  if (installed) return;
  installed = true;
  if (typeof document === 'undefined') return;
  try {
    const profile = extractOwnProfile(document);
    if (profile) void writeOwnProfile(profile);
  } catch {
    /* header absent / unexpected shape — best-effort, stay silent */
  }
};

/**
 * Test-only: re-open the idempotency gate.
 * @returns {void}
 */
export const _resetOwnProfileForTest = () => {
  installed = false;
};
