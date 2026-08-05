// @ts-check

// LIVE demo of the Spyglass → Home watch card, for the docs site.
//
// It renders the REAL component (`src/features/dashboard/homeWatch.js`) over a
// fixture, in a headless DOM, at site-build time. That is the whole point: a
// hand-written HTML mock of a card drifts from the card the day after it is
// written, while this one cannot — if the component changes, the picture on the
// site changes with it, and if the component breaks the build says so.
//
// The data is FICTION on purpose: invented nicknames, invented alliance tags and
// coordinates that belong to nobody. Documentation must not publish a real
// player's position — not the author's, not anyone else's.
//
// Fails soft: any problem (no headless DOM available, a renderer signature
// change) returns '' and the generator falls back to the pre-rendered
// `_generated/home-watch.html` — and, failing that, to no figure at all — so a
// docs build never dies on a decorative element. That committed copy is what
// GitHub Pages actually serves, because CI has no `happy-dom`; see
// site/README.md § Żywe demo.

import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** Fictional scenario — see the header note on anonymity. */
const FIXTURE = () => {
  const NOW = 1_800_000_000_000;
  /** Our own systems (fictional). */
  const systems = new Set([
    '2:117', '2:118', '2:119', '2:143', '2:144', '2:187', '2:203', '2:266',
    '3:288', '3:301', '3:302', '3:377', '4:412', '4:498', '6:104', '6:155',
  ]);
  // NOVA: Kestrel (2:117, 2:119, 3:301) + Wren (2:143) → ×4 together vs ×3 alone.
  // KRAB: Boro (2:117) + Ilex (6:104)                  → ×2 together vs ×1 alone.
  // Tanhil: no alliance, one system.
  const occupants = {
    '2:117': [{ playerId: '101', position: 8 }, { playerId: '303', position: 6 },
      { playerId: '404', position: 12 }],
    '2:119': [{ playerId: '101', position: 3 }],
    '3:301': [{ playerId: '101', position: 11 }],
    '2:143': [{ playerId: '202', position: 4 }],
    '6:104': [{ playerId: '505', position: 9 }],
  };
  const names = {
    101: { name: 'Kestrel', alliance: 'AL1' },
    202: { name: 'Wren', alliance: 'AL1' },
    303: { name: 'Boro', alliance: 'AL2' },
    404: { name: 'Tanhil' },
    505: { name: 'Ilex', alliance: 'AL2' },
  };
  const alliances = { AL1: { tag: 'NOVA', name: 'Nova Ordo' }, AL2: { tag: 'KRAB', name: 'Krab Klan' } };
  const danger = new Map([
    [101, { id: 101, danger: 0.88, label: 'apex', reasons: ['2.9M combat fleet (strong)', 'Bandit tier 2/3'] }],
    [202, { id: 202, danger: 0.31, label: 'fleeter', reasons: ['380K combat fleet'] }],
    [303, { id: 303, danger: 0.22, label: 'eco', reasons: ['huddled empire — 5 planets packed together'] }],
    [404, { id: 404, danger: 0.11, label: 'eco', reasons: ['90K combat fleet'] }],
  ]);
  /** @type {Record<string, { scannedAt?: number }>} */
  const scans = {};
  for (const s of systems) scans[s] = { scannedAt: NOW - 4 * 60_000 };
  scans['3:377'] = { scannedAt: NOW - 40 * 3600_000 };
  return {
    NOW,
    systems,
    occupants,
    names,
    alliances,
    danger,
    scans,
    arrivals: [{ system: '2:143', coord: '2:143:4', playerId: 202, atMs: NOW - 8 * 60_000 }],
  };
};

/**
 * Wrap the rendered body in the card's frame with INLINE styles — the site does
 * not (and should not) carry the dashboard's stylesheet, and the component's own
 * rows are inline-styled already, so the result is self-contained.
 * @param {string} state  The fold bar's state text.
 * @param {string} body   The card body's markup.
 * @returns {string}
 */
const frame = (state, body) => `
<div style="max-width:470px;background:#0f151c;border:1px solid #223044;border-left:3px solid #e06c5f;border-radius:8px;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <div style="display:flex;align-items:center;gap:10px;padding:11px 14px;">
    <span style="flex:0 0 auto;width:6px;height:6px;margin-top:-3px;border-right:2px solid #7f8ea0;border-bottom:2px solid #7f8ea0;transform:rotate(45deg);"></span>
    <span style="color:#c9d4de;font-size:14px;font-weight:bold;">Home watch</span>
    <span style="margin-left:auto;font-size:11px;color:#e06c5f;font-weight:600;white-space:nowrap;">${state}</span>
  </div>
  <div style="padding:0 14px 12px;">${body}</div>
</div>`;

/**
 * Render the demo. Returns '' when the headless DOM or the component cannot be
 * loaded (see the header note on failing soft).
 * @returns {Promise<string>}
 */
export const render = async () => {
  try {
    const { Window } = await import('happy-dom');
    const win = new Window({ url: 'https://localhost/' });
    const g = /** @type {any} */ (globalThis);
    const prev = { document: g.document, window: g.window, HTMLElement: g.HTMLElement };
    g.window = win;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    try {
      const mod = await import(
        pathToFileURL(join(REPO, 'src', 'features', 'dashboard', 'homeWatch.js')).href
      );
      const f = FIXTURE();
      const host = win.document.createElement('div');
      const state = win.document.createElement('span');
      mod.renderHomeWatchCard({
        summaryEl: state,
        hostEl: host,
        systems: f.systems,
        occupants: f.occupants,
        arrivals: f.arrivals,
        names: f.names,
        alliances: f.alliances,
        danger: f.danger,
        scans: f.scans,
        staleMs: 24 * 3600_000,
        nowMs: f.NOW,
      });
      return frame(String(state.textContent || ''), String(host.innerHTML || ''));
    } finally {
      g.document = prev.document;
      g.window = prev.window;
      g.HTMLElement = prev.HTMLElement;
    }
  } catch {
    return '';
  }
};
