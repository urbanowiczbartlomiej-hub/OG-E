// @ts-check
//
// Manual landed-FS mark — an inline toggle on the fleet1 dispatch screen that
// lets the player flag "the fleet sitting on THIS body is a fleet-save, watch
// it". It writes `state/manualLandedFs.js`; the badges feature and the bare-fleet
// guardian read that store in UNION with the producer's auto set, so a mark
// lights up the exposed-FS badge AND arms the guardian — covering the two gaps
// auto-detection can't see (a freshly-bought fleet that never flew, and a watch
// the user dismissed and wants back). See `state/manualLandedFs.js`.
//
// Inline, not on the FAB: the mark is contextual to the body you're dispatching
// from, so it belongs at the form. We anchor it after the first present of a
// small ordered list (AGR's fleet1 target-type row, the native continue control,
// then `#fleet1`) and a MutationObserver re-injects it if AGR rebuilds the form.
//
// The body it marks is resolved from the page's `cp` mapped onto the planet
// list's planet/moon links — that yields coords AND the planet-vs-moon type
// (`g:s:p:type`) without leaning on a fragile "active body" class.

import { GAME } from '../../lib/gameDom.js';
import { injectStyle } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { MANUAL_FS_CHANGED_EVENT } from '../../lib/ogeEvents.js';
import { hasManualLandedFs, toggleManualLandedFs } from '../../state/manualLandedFs.js';

/** OG-E-owned ids (NOT a game contract — ours to rename). */
const CHIP_ID = 'oge-mfs-chip';
const STYLE_ID = 'oge-mfs-style';

/** Anchors tried in order; the chip mounts after the first one present. */
const ANCHORS = ['#ago_type', GAME.FD_CONTINUE, GAME.FD_FLEET1];

const CSS = `
#${CHIP_ID}{
  display:inline-flex;align-items:center;gap:6px;
  margin:6px 4px;padding:4px 9px;vertical-align:middle;
  border:1px solid #6b4a1f;border-radius:6px;
  background:#241a0c;color:#e8902e;
  font:700 11px/1 Verdana,sans-serif;cursor:pointer;user-select:none;
}
#${CHIP_ID}:hover{border-color:#e8902e;}
#${CHIP_ID}.on{background:#3a2a10;border-color:#e8902e;}
#${CHIP_ID} .dot{width:8px;height:8px;border-radius:50%;border:1px solid #e8902e;box-sizing:border-box;}
#${CHIP_ID}.on .dot{background:#e8902e;}
`;

/** @param {string|null|undefined} s @returns {string} dense `g:s:p` */
const dense = (s) => (s || '').replace(/[\s[\]]/g, '');

/** Parse a link href's `cp` query param, or '' on failure. @param {string} href */
const cpOf = (href) => {
  try {
    return new URL(href, location.href).searchParams.get('cp') || '';
  } catch {
    return '';
  }
};

/**
 * Resolve the body the fleetdispatch form dispatches FROM, as `g:s:p:type`.
 * Maps the page's `cp` onto the planet-list row whose planet- or moon-link
 * points at that same `cp` (the moon link carries its own cp) — giving coords
 * AND the planet/moon type. `null` off fleetdispatch or when unresolved.
 *
 * @returns {{ bodyKey: string } | null}
 */
const currentBody = () => {
  if (!location.search.includes('component=fleetdispatch')) return null;
  const cp = new URLSearchParams(location.search).get('cp') || '';
  if (!cp) return null;
  for (const row of document.querySelectorAll(GAME.SMALL_PLANET_ONLY)) {
    const coords = dense(row.querySelector(GAME.PLANET_KOORDS)?.textContent);
    if (!coords) continue;
    const planet = row.querySelector(`a${GAME.PLANET_LINK}`)?.getAttribute('href') || '';
    if (cpOf(planet) === cp) return { bodyKey: `${coords}:1` };
    const moon = row.querySelector(GAME.MOON_LINK)?.getAttribute('href') || '';
    if (cpOf(moon) === cp) return { bodyKey: `${coords}:3` };
  }
  return null;
};

/**
 * Reflect the mark state onto the chip. Writes the label's text ONLY when it
 * changes — the install observer watches childList, so an unconditional rewrite
 * would re-trigger itself in a loop (class/title are attributes, not watched).
 *
 * @param {HTMLElement} chip
 * @param {string} bodyKey
 */
const paintChip = (chip, bodyKey) => {
  const on = hasManualLandedFs(bodyKey);
  chip.classList.toggle('on', on);
  chip.title = on
    ? 'This body is marked as a landed fleet-save — tap to clear'
    : 'Mark the fleet on this body as a landed fleet-save (badge + guardian)';
  const label = chip.querySelector('.lbl');
  const txt = on ? 'FS marked' : 'Mark FS';
  if (label && label.textContent !== txt) label.textContent = txt;
};

/** Build the chip. It reads the body LIVE on click so it never goes stale. */
const buildChip = () => {
  const chip = document.createElement('div');
  chip.id = CHIP_ID;
  chip.innerHTML = '<span class="dot"></span><span class="lbl"></span>';
  chip.addEventListener('click', () => {
    const b = currentBody();
    if (!b) return;
    toggleManualLandedFs(b.bodyKey, Math.floor(Date.now() / 1000));
    paintChip(chip, b.bodyKey);
    // Arm/disarm the guardian (same fleetdispatch page) at once.
    document.dispatchEvent(new CustomEvent(MANUAL_FS_CHANGED_EVENT));
  });
  return chip;
};

/** Inject / refresh / remove the chip to match the current page + mark state. */
const sync = () => {
  const body = currentBody();
  const existing = /** @type {HTMLElement | null} */ (document.getElementById(CHIP_ID));
  if (!body) {
    existing?.remove();
    return;
  }
  let chip = existing;
  if (!chip) {
    const anchor = ANCHORS.map((s) => document.querySelector(s)).find(Boolean);
    if (!anchor) return; // form not ready yet — the observer retries
    chip = buildChip();
    anchor.insertAdjacentElement('afterend', chip);
  }
  paintChip(chip, body.bodyKey);
};

/** @type {MutationObserver | null} */
let observer = null;
/** @type {(() => void) | null} */
let installed = null;

/**
 * Install the manual FS-mark chip. Idempotent.
 *
 * @returns {() => void} dispose
 */
export const installManualFsMark = () => {
  if (installed) return installed;
  injectStyle(STYLE_ID, CSS);
  const debounced = debounce(sync, 150);
  observer = new MutationObserver(debounced);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  installed = () => {
    observer?.disconnect();
    observer = null;
    document.getElementById(CHIP_ID)?.remove();
    installed = null;
  };
  return installed;
};

/**
 * Test-only reset.
 *
 * @returns {void}
 */
export const _resetManualFsMarkForTest = () => {
  if (installed) installed();
  installed = null;
};
