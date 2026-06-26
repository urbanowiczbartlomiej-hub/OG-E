// @ts-check

// Shared legend swatch builder — a coloured square + label, used by the
// galaxy pixel-map legend (`galaxy.js`) and the Top-region strip legend
// (`freeStreak.js`). Both painted identical swatches inline; this is the
// single source of truth so a swatch-style tweak lands in both at once.
//
// Pure DOM factory: builds and returns a detached `<span>`. The `border`
// option draws a faint outline for swatches whose colour is close to the
// page background (e.g. the "Not scanned" key).

/**
 * @param {string} color  CSS colour for the swatch fill.
 * @param {string} label  Text shown beside the swatch.
 * @param {{ border?: boolean }} [opts]  `border: true` outlines the swatch
 *   (for near-background colours like the unscanned key).
 * @returns {HTMLSpanElement}
 */
export const makeLegendSwatch = (color, label, opts = {}) => {
  const item = document.createElement('span');
  item.style.cssText = 'display:flex;align-items:center;gap:4px;';

  const dot = document.createElement('span');
  const border = opts.border ? ';border:1px solid #333' : '';
  dot.style.cssText =
    'width:10px;height:10px;border-radius:2px;background:' +
    color +
    border +
    ';display:inline-block;';

  const txt = document.createElement('span');
  txt.style.color = '#888';
  txt.textContent = label;

  item.append(dot, txt);
  return item;
};

/**
 * Build one stat card — a coloured value over a muted label. Used by the
 * galaxy "Scanned data" stats row (`galaxy.js`) and the Colony-Scout top-region
 * neighbourhood stats (`freeStreak.js`); shared so the two read identically.
 * Relies on the `.stat-card` / `.stat-value` / `.stat-label` classes in
 * `dashboard.html`; only the value colour (per status) is set inline.
 *
 * @param {string} color  Value colour (the status colour).
 * @param {string | number} value  The count (or a short string like `#3` / `56/56`).
 * @param {string} label  The status label.
 * @param {string} [title]  Optional hover tooltip on the whole card.
 * @returns {HTMLDivElement}
 */
export const makeStatCard = (color, value, label, title) => {
  const card = document.createElement('div');
  card.className = 'stat-card';
  if (title) card.title = title;

  const valEl = document.createElement('div');
  valEl.className = 'stat-value';
  valEl.style.color = color;
  valEl.textContent = String(value);
  card.appendChild(valEl);

  const labEl = document.createElement('div');
  labEl.className = 'stat-label';
  labEl.textContent = label;
  card.appendChild(labEl);

  return card;
};
