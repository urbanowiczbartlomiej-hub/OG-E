// @ts-check

// Lifeform-bonus capture — when the player opens the in-game "Lifeform
// bonuses" page (`component=lfbonuses`), read the Discoverer class bonus total
// off it, plus the player / alliance class from the page meta tags, and store
// them in the per-universe colonization config. The dashboard's colony
// histogram uses them to turn recorded field counts back into natural rolls
// (`domain/planetRoll.js`), and the colony recorder stamps each new colony
// with the field multiplier in force at the time.
//
// Fair-play (AGENTS.md §4, docs/fair-play.md): PASSIVE. We only read a page
// the player opened by clicking — no request of our own, no state change in
// the game. The dashboard's "Read" button just opens this page in a new tab;
// it deliberately does not fetch it in the background (a background call
// outside a page load would be forbidden and would show as activity).
//
// DOM contract (checked 2026-11-19, game 13.1.1, PL): the class section is a
// `technology-bonus-category` whose top headings are
// `inner-bonus-item-heading[data-toggable="601"|"602"|"603"]` for Collector /
// General / Discoverer, each with `.subCategoryTitle[aria-label]` and
// `.subCategoryBonus` = "Łącznie: 53,69%" — that total is the Discoverer
// Enhancement sum E. Single-feature selectors, so they stay local (CLAUDE.md).

import { applyGalaxyScanConfigPatch, whenGalaxyScanConfigHydrated } from '../state/galaxyScanConfig.js';
import { waitFor } from '../lib/dom.js';
import { sizeBonusPercent } from '../domain/planetRoll.js';
import { logger } from '../lib/logger.js';

/* global document, location */

/** Discoverer heading by its toggle id; label fallback for other layouts. */
const DISCOVERER_HEADING = 'inner-bonus-item-heading[data-toggable="603"]';
const DISCOVERER_LABELS = ['Odkrywca', 'Discoverer', 'Explorer', 'Entdecker', 'Descubridor', 'Explorateur'];
const HEADING = 'inner-bonus-item-heading';
const TITLE = '.subCategoryTitle';
const TOTAL = '.subCategoryBonus';
const META_PLAYER_CLASS = 'meta[name="ogame-player-characterclass-id"]';
const META_ALLIANCE_CLASS = 'meta[name="ogame-allianceclass-id"]';

/** Player class id 3 = Discoverer (sprite `characterclass … explorer`). */
const PLAYER_CLASS_DISCOVERER = '3';
/** Alliance class id 3 = Researchers (warrior / trader / explorer = 1 / 2 / 3). */
const ALLIANCE_CLASS_RESEARCHERS = '3';

/**
 * Parse "Łącznie: 53,69%" (any language, comma or dot decimals) to 53.69.
 *
 * @param {string | null | undefined} text
 * @returns {number | null}
 */
export const parsePercent = (text) => {
  const m = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Find the Discoverer total element on the lifeform bonuses page.
 *
 * @param {ParentNode} root
 * @returns {Element | null}
 */
export const findDiscovererTotal = (root) => {
  const byId = root.querySelector(DISCOVERER_HEADING);
  if (byId) return byId.querySelector(TOTAL);
  for (const h of root.querySelectorAll(HEADING)) {
    const label = h.querySelector(TITLE)?.getAttribute('aria-label') || '';
    if (DISCOVERER_LABELS.includes(label.trim())) return h.querySelector(TOTAL);
  }
  return null;
};

/** @returns {boolean} */
const isLfBonusesPage = () =>
  new URLSearchParams(location.search).get('component') === 'lfbonuses';

let installed = false;

/**
 * Read the bonus once the page has rendered it, and store it. Idempotent;
 * a no-op on every other page.
 *
 * @returns {void}
 */
export const installLfBonusCapture = () => {
  if (installed || !isLfBonusesPage()) return;
  installed = true;
  void (async () => {
    const totalEl = await waitFor(() => findDiscovererTotal(document), { timeoutMs: 8000 });
    const e = parsePercent(totalEl?.textContent);
    if (e == null) return;
    const playerClass = document.querySelector(META_PLAYER_CLASS)?.getAttribute('content') ?? '';
    const allianceClass = document.querySelector(META_ALLIANCE_CLASS)?.getAttribute('content') ?? '';
    // Never patch a not-yet-hydrated store: the defaults would overwrite every
    // other colonization setting of this universe.
    await whenGalaxyScanConfigHydrated();
    // One number: the planet size bonus (% of diameter) the game applies to
    // a new colony right now — classes and the Enhancement folded in.
    await applyGalaxyScanConfigPatch({
      colonySizeBonus: sizeBonusPercent({
        e: e / 100,
        discoverer: playerClass === PLAYER_CLASS_DISCOVERER,
        researcher: allianceClass === ALLIANCE_CLASS_RESEARCHERS,
      }),
      colonyBonusReadAt: Date.now(),
    });
    logger.log('lfBonusCapture: Discoverer total', e, 'class', playerClass, 'alliance', allianceClass);
  })().catch((err) => logger.error('lfBonusCapture failed', err));
};

/** Test helper: allow a fresh install. */
export const _resetLfBonusCaptureForTest = () => {
  installed = false;
};
