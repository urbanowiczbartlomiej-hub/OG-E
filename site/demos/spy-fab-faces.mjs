// @ts-check

// LIVE demo: the Spy FAB's faces. See `_kit.mjs`.
//
// The button says what it will do next, and the wording is not decoration — it
// is the whole safety story of the feature (it never claims more than the
// signals support). So the docs must not PARAPHRASE it: each face below is the
// real `renderSpy()` verdict, painted onto the real `createButton()` chrome.
//
// Three states, in the order a round actually goes: a queued galaxy look, a
// catchable moon, and Home watch calling you back to the dashboard.

import { withStage } from './_kit.mjs';

/**
 * Zmyślone konteksty FAB-a. Zawierają dokładnie te pola, które czyta
 * `renderSpy` — reszta stanu przycisku jest liczona, nie podawana.
 * @type {Array<{ label: string, ctx: any }>}
 */
const FACES = [
  {
    label: 'a queued galaxy look',
    ctx: {
      hasWatched: true,
      proposal: 'look',
      look: { galaxy: 2, system: 143, bodies: 3, home: true },
      remaining: 11,
    },
  },
  {
    label: 'a catchable moon',
    ctx: {
      hasWatched: true,
      proposal: 'probe',
      candidate: { galaxy: 2, system: 116, position: 4, playerId: '101', bodyType: 3, name: 'Kestrel' },
      strike: true,
      strikeTier: 'lone',
      remaining: 9,
    },
  },
  {
    label: 'unread home news',
    ctx: { hasWatched: true, proposal: 'homeReport', homeUnread: 2, remaining: 0 },
  },
];

export const render = () => withStage(async ({ doc, load }) => {
  const btn = await load('features/shared/button.js');
  const glyphs = await load('features/shared/buttonGlyphs.js');
  const spy = await load('features/sendSpy/pure.js');

  const row = doc.createElement('div');
  row.style.cssText = 'display:flex;gap:34px;flex-wrap:wrap;justify-content:center;'
    + 'align-items:flex-start;padding:6px 0 2px;';

  FACES.forEach((face, i) => {
    const paint = spy.renderSpy(face.ctx);
    const id = `oge-demo-fab-${i}`;
    const controller = btn.createButton({
      id,
      title: 'Spyglass',
      ringId: `oge-ring-demo-${i}`,
      size: 74,
      fontScale: 0.18,
      zones: [{
        key: 'send',
        id: `${id}-send`,
        ariaLabel: paint.text,
        bg: paint.bg,
        glyph: glyphs.EYE_GLYPH,
        onTap: () => {},
      }],
    });
    if (!controller) return;
    // Ta sama ścieżka malowania, co w `sendSpy/index.js` paintZone().
    if (paint.subtext || paint.hint) {
      controller.paintLines('send', btn.labelLines({
        main: paint.text, sub: paint.subtext, hint: paint.hint,
      }));
    } else {
      controller.setText('send', paint.text);
    }
    controller.setBg('send', paint.bg);
    controller.setDim('send', paint.dim === true);
    controller.setError(paint.bg === spy.BG_SPY_ERROR);

    // Przycisk w grze jest `position:fixed` i przyklejony do rogu ekranu —
    // w dokumentacji ma stać w rzędzie. To JEDYNA rzecz, którą demo nadpisuje.
    const el = doc.getElementById(id);
    if (!el) return;
    el.style.position = 'static';
    el.style.right = '';
    el.style.bottom = '';
    el.style.zIndex = '';

    const cell = doc.createElement('div');
    cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';
    cell.appendChild(el);
    const cap = doc.createElement('span');
    cap.style.cssText = 'font:11px/1.3 monospace;color:#8a97a3;letter-spacing:.4px;';
    cap.textContent = face.label;
    cell.appendChild(cap);
    row.appendChild(cell);
  });

  return row.children.length ? String(row.outerHTML) : '';
});
