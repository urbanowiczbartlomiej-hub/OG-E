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
// from, so it belongs at the fleet1 form, where your eyes already are when
// sending. PRIMARY home: the empty grid cell that trails the espionage probe in
// the civil-ships list (`#civil`). OGame's 5 civil ships (202/203/208/209/210)
// wrap 3-to-a-row in an 80px-tile flex grid, so the last row is `209 210 ▢` —
// one open cell right next to the probe. We drop an 80×80 tile there. That keeps
// the mark clear of the "Dalej"/continue control, whose row reflows when the
// player has no Fleet-Admiral premium (the old top-right chip crowded it and
// shrank the button). FALLBACKS (non-fleet1 / gridless layouts): top-right of
// the native `#allornone` block, then AGR's target-type row, then `#fleet1`. The
// two homes are styled differently (`.tile` 80×80 vs the default inline chip).
// A MutationObserver re-injects it if the game / AGR rebuilds the grid or form.
//
// The body it marks is resolved from the page's `cp` mapped onto the planet
// list's planet/moon links — that yields coords AND the planet-vs-moon type
// (`g:s:p:type`) without leaning on a fragile "active body" class.

import { GAME } from '../../lib/gameDom.js';
import { denseCoords, bodyKey as toBodyKey } from '../../domain/bodies.js';
import { injectStyle, parseSvg } from '../../lib/dom.js';
import { debounce } from '../../lib/debounce.js';
import { MANUAL_FS_CHANGED_EVENT } from '../../lib/ogeEvents.js';
import { hasManualLandedFs, toggleManualLandedFs } from '../../state/manualLandedFs.js';
import { LIGHTHOUSE_GLYPH } from '../shared/buttonGlyphs.js';

/** OG-E-owned ids (NOT a game contract — ours to rename). */
const CHIP_ID = 'oge-mfs-chip';
const STYLE_ID = 'oge-mfs-style';

/** The guardian's lighthouse glyph, wrapped for inline use; tints to the chip's
 *  `color` (the art paints with `currentColor`). Same mark as the FAB button so
 *  the "Set FR" chip and the Fleet-reminder button read as one feature. */
const GLYPH_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true">${LIGHTHOUSE_GLYPH}</svg>`;

/**
 * Anchors tried in order; the chip mounts at the first one present, using that
 * anchor's `pos` and `cls` (extra class controlling its look there). Primary:
 * appended to `#civil` (the civil-ships flex grid), where it flows into the
 * empty cell trailing the espionage probe as an 80×80 `.tile`. Fallbacks: the
 * FIRST child of `#allornone` (a stable sibling BEFORE the volatile
 * `.allornonewrap`, floated top-right above "Dalej"), then AGR's target-type
 * row, then after `#fleet1`.
 *
 * @type {ReadonlyArray<{ sel: string, pos: InsertPosition, cls: string }>}
 */
const ANCHORS = [
  { sel: '#civil', pos: 'beforeend', cls: 'tile' },
  { sel: '#allornone', pos: 'afterbegin', cls: '' },
  { sel: '#ago_type', pos: 'afterend', cls: '' },
  { sel: GAME.FD_FLEET1, pos: 'afterend', cls: '' },
];

const CSS = `
#${CHIP_ID}{
  display:inline-flex;align-items:center;gap:6px;
  float:right;clear:right;
  margin:6px 25px 6px 4px;padding:4px 9px;vertical-align:middle;
  border:1px solid #6b4a1f;border-radius:6px;
  background:#241a0c;color:#e8902e;
  font:700 11px/1 Verdana,sans-serif;cursor:pointer;user-select:none;
}
#${CHIP_ID}:hover{border-color:#e8902e;}
/* Active = marked. The label stays "Set FR"; this highlight (brighter fill,
   lit border + glow) is what signals the on-state now that the text is fixed. */
#${CHIP_ID}.on{background:#3a2a10;border-color:#e8902e;box-shadow:0 0 6px rgba(245,133,26,.55);}
#${CHIP_ID} .ico{display:inline-flex;align-items:center;justify-content:center;}
#${CHIP_ID} .ico svg{width:14px;height:14px;display:block;}
/* Tile mode: fills the empty 80×80 cell next to the espionage probe in #civil.
   margin-bottom matches the game's .technology.interactive so it lines up. The
   lighthouse sits big over the label, a mini echo of the guardian FAB button. */
#${CHIP_ID}.tile{
  flex-direction:column;justify-content:center;text-align:center;gap:5px;
  float:none;clear:none;
  width:80px;height:80px;margin:0 0 30px;padding:4px;
  box-sizing:border-box;border-width:2px;line-height:1.2;
}
#${CHIP_ID}.tile .ico svg{width:36px;height:36px;}
`;

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
 * PRIMARY source: OGame's per-page `ogame-planet-coordinates` / `-type` meta
 * tags — present on every ingame page, so the body resolves however you reached
 * fleetdispatch. FALLBACK: map the page `cp` onto the planet-list row's
 * planet/moon link — but the URL only carries `cp` when you arrive via a
 * planet/moon link, NOT via the top "Fleet" menu (that empty-cp case is exactly
 * why this used to silently show no chip). `null` off fleetdispatch or unresolved.
 *
 * @returns {{ bodyKey: string } | null}
 */
const currentBody = () => {
  if (!location.search.includes('component=fleetdispatch')) return null;
  const metaCoords = denseCoords(
    document.querySelector(GAME.META_PLANET_COORDS)?.getAttribute('content'),
  );
  if (/^\d+:\d+:\d+$/.test(metaCoords)) {
    const isMoon =
      document.querySelector(GAME.META_PLANET_TYPE)?.getAttribute('content') === 'moon';
    return { bodyKey: toBodyKey(metaCoords, isMoon ? 3 : 1) };
  }
  const cp = new URLSearchParams(location.search).get('cp') || '';
  if (!cp) return null;
  for (const row of document.querySelectorAll(GAME.SMALL_PLANET_ONLY)) {
    const coords = denseCoords(row.querySelector(GAME.PLANET_KOORDS)?.textContent);
    if (!coords) continue;
    const planet = row.querySelector(`a${GAME.PLANET_LINK}`)?.getAttribute('href') || '';
    if (cpOf(planet) === cp) return { bodyKey: toBodyKey(coords, 1) };
    const moon = row.querySelector(GAME.MOON_LINK)?.getAttribute('href') || '';
    if (cpOf(moon) === cp) return { bodyKey: toBodyKey(coords, 3) };
  }
  return null;
};

/**
 * Reflect the mark state onto the chip. Touches only the `on` class + `title`
 * (both attributes, NOT watched by the install observer) — the label is the
 * fixed "Set FR" set once at build, so the active state shows purely as the
 * highlight, and there is no childList write that could re-trigger the observer.
 *
 * @param {HTMLElement} chip
 * @param {string} bodyKey
 */
const paintChip = (chip, bodyKey) => {
  const on = hasManualLandedFs(bodyKey);
  chip.classList.toggle('on', on);
  chip.title = on
    ? 'Fleet reminder is set for this body — tap to clear'
    : 'Set a Fleet reminder for the fleet on this body (FR badge + reminder push)';
};

/** Build the chip. It reads the body LIVE on click so it never goes stale. */
const buildChip = () => {
  const chip = document.createElement('div');
  chip.id = CHIP_ID;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.appendChild(parseSvg(GLYPH_SVG));
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = 'Set FR';
  chip.append(ico, lbl);
  chip.addEventListener('click', (e) => {
    // In the #civil grid our tile sits among the game's ship cells; keep the
    // click from bubbling into OGame's delegated ship-select handler.
    e.stopPropagation();
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
    let anchorEl = null;
    let pos = /** @type {InsertPosition} */ ('afterend');
    let cls = '';
    for (const a of ANCHORS) {
      const el = document.querySelector(a.sel);
      if (el) {
        anchorEl = el;
        pos = a.pos;
        cls = a.cls;
        break;
      }
    }
    if (!anchorEl) return; // form not ready yet — the observer retries
    chip = buildChip();
    if (cls) chip.classList.add(cls);
    anchorEl.insertAdjacentElement(pos, chip);
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
  const debounced = debounce(() => { if (installed) sync(); }, 150);
  observer = new MutationObserver(debounced);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  installed = () => {
    observer?.disconnect();
    observer = null;
    document.getElementById(CHIP_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
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
