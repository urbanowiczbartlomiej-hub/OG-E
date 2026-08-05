// @ts-check

// Wspólny warsztat żywych demo (IDEAS.md § 5).
//
// Zasada, na której stoi cała ta rodzina: demo NIE odtwarza wyglądu OG-E, tylko
// go URUCHAMIA. Bierze prawdziwy szkielet karty z `src/dashboard.html`, wstawia
// go do headless DOM, woła prawdziwy renderer z `src/features/...` i oddaje
// wynikowy markup. Arkusz dochodzi osobno (`site/dashboardCss.mjs` zawęża ten
// sam `<style>` do `.shot-demo`), więc na stronie nie ma ANI JEDNEJ linijki
// wyglądu przepisanej ręcznie — a zmiana w dashboardzie przechodzi na
// dokumentację sama.
//
// Konsekwencja praktyczna: demo psuje się dokładnie wtedy, kiedy zmieni się
// kontrakt komponentu (zniknie id hosta, zmieni się sygnatura renderera) — i
// wtedy MA się zepsuć, bo obrazek na stronie właśnie przestał być prawdą.
// Wszystkie tryby awarii są miękkie: `render()` zwraca '', generator wraca do
// wersji zacommitowanej albo pomija figurę.
//
// Dane w każdym demo są ZMYŚLONE. Dokumentacja nie publikuje pozycji żadnego
// realnego gracza — ani cudzej, ani autora.

import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
const DASHBOARD_HTML = join(REPO, 'src', 'dashboard.html');

/**
 * Ciało `dashboard.html` bez `<script>` — szkielet, w który montujemy
 * komponenty. Skrypt jest zdejmowany, bo importuje `chrome.*`, którego w
 * headless DOM nie ma (i tak nie chcemy tu uruchamiać dashboardu, tylko JEDEN
 * renderer).
 * @returns {Promise<string>}
 */
const dashboardBody = async () => {
  const html = await readFile(DASHBOARD_HTML, 'utf8');
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (m ? m[1] : '').replace(/<script[\s\S]*?<\/script>/gi, '');
};

/**
 * @typedef {object} Stage
 * @property {any} win        Okno headless DOM.
 * @property {Document} doc
 * @property {(id: string) => any} byId   Element ze szkieletu dashboardu.
 * @property {(rel: string) => Promise<any>} load  Import modułu z `src/`.
 * @property {(el: any) => string} out    Markup elementu, gotowy na stronę.
 */

/**
 * Odpala `fn` na scenie: headless DOM + szkielet dashboardu + globalne
 * `document`/`window` (komponenty wołają `document.createElement` wprost).
 *
 * Globalne są przywracane w `finally` — kilka demo renderuje się w JEDNYM
 * procesie builda i nie mogą sobie nawzajem podmienić dokumentu.
 *
 * @param {(stage: Stage) => Promise<string> | string} fn
 * @returns {Promise<string>} Markup albo '' przy dowolnym problemie.
 */
export const withStage = async (fn) => {
  try {
    const { Window } = await import('happy-dom');
    const win = new Window({ url: 'https://localhost/', width: 900, height: 1400 });
    const g = /** @type {any} */ (globalThis);
    // Globalne, po które komponenty sięgają wprost (są pisane pod przeglądarkę,
    // nie pod moduł). Zapamiętane i przywracane w `finally` — kilka demo jedzie
    // w JEDNYM procesie builda i nie mogą sobie podmienić dokumentu.
    const COPY = [
      'document', 'HTMLElement', 'Node', 'Element', 'SVGElement', 'CustomEvent',
      'DOMParser', 'localStorage', 'sessionStorage',
    ];
    const BIND = ['getComputedStyle', 'matchMedia', 'requestAnimationFrame'];
    /** @type {Record<string, any>} */
    const prev = { window: g.window };
    for (const k of [...COPY, ...BIND]) prev[k] = g[k];
    g.window = win;
    for (const k of COPY) g[k] = win[k];
    for (const k of BIND) g[k] = typeof win[k] === 'function' ? win[k].bind(win) : win[k];
    try {
      win.document.body.innerHTML = await dashboardBody();
      /** @param {string} id */
      const byId = (id) => {
        const el = win.document.getElementById(id);
        if (!el) throw new Error(`brak #${id} w src/dashboard.html`);
        return el;
      };
      /** @param {string} rel */
      const load = (rel) => import(pathToFileURL(join(REPO, 'src', rel)).href);
      const html = await fn({ win, doc: win.document, byId, load, out });
      return String(html || '');
    } finally {
      Object.assign(g, prev);
    }
  } catch (e) {
    // Miękka awaria jest właściwa dla builda, ale zabójcza przy PISANIU demo —
    // `DEMO_DEBUG=1 node site/build.mjs` pokazuje, co naprawdę poszło nie tak.
    if (process.env.DEMO_DEBUG) console.error(e);
    return '';
  }
};

/**
 * Escape'uje wartości WSZYSTKICH atrybutów w poddrzewie.
 *
 * Musi tu być, bo serializator happy-doma nie escape'uje w atrybutach NICZEGO
 * — ani `&`, ani `"`. Wystarczy jeden cudzysłów w `title=` (a komponenty OG-E
 * cytują w podpowiedziach: „«Nh» = quiet at every look"), żeby atrybut urwał
 * się w połowie, a jego reszta wylała się na stronę jako goły tekst.
 *
 * Podmieniamy w DOM przed serializacją: skoro serializator przepisuje wartość
 * bajt w bajt, wstawiona encja trafia do wyjścia dosłownie i przeglądarka
 * czyta ją poprawnie. Kolejność ma znaczenie — `&` musi iść pierwsze.
 * @param {any} root
 * @returns {void}
 */
const escapeAttrs = (root) => {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const name of el.getAttributeNames()) {
      const v = el.getAttribute(name);
      if (typeof v !== 'string' || !/[&"<>]/.test(v)) continue;
      el.setAttribute(name, v
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;'));
    }
  }
};

/**
 * Sprząta element przed wypuszczeniem na stronę:
 * - zdejmuje `display:none` z korzenia (na dashboardzie karty startują ukryte
 *   i odsłania je repaint, którego tu nie ma),
 * - rozwija `<details>` (dokumentacja pokazuje ZAWARTOŚĆ, nie zwiniętą belkę),
 * - wycina kontrolki, które bez dashboardu nic nie robią, a kuszą do kliknięcia
 *   (`[data-demo-drop]` wstawia demo samo — patrz `drop()`),
 * - usuwa wszystko schowane inline'owym `display:none`.
 *
 * To ostatnie nie jest kosmetyką: komponenty budują na zapas panele, które
 * odsłania dopiero klik (tabela celów trzyma ZWINIĘTE dossier przy każdym
 * wierszu). Na statycznej stronie nikt ich nie otworzy, a w markupie ważą
 * wielokrotnie więcej niż to, co widać.
 * @param {any} el
 * @returns {string}
 */
export const out = (el) => {
  if (el.style && el.style.display === 'none') el.style.display = '';
  for (const d of el.querySelectorAll('details')) d.setAttribute('open', '');
  if (el.tagName === 'DETAILS') el.setAttribute('open', '');
  for (const x of el.querySelectorAll('[data-demo-drop]')) x.remove();
  for (const h of el.querySelectorAll('[style*="display: none"], [style*="display:none"]')) h.remove();
  escapeAttrs(el);
  // Statyczna strona nie ma stanu: pola i przyciski są dekoracją, więc niech
  // nie łapią fokusu ani nie udają działających.
  for (const c of el.querySelectorAll('button, input, select, textarea')) {
    c.setAttribute('tabindex', '-1');
    if (c.tagName !== 'BUTTON') c.setAttribute('readonly', '');
    c.setAttribute('aria-hidden', 'true');
  }
  return String(el.outerHTML || '');
};

/**
 * Oznacza element do usunięcia z demo (patrz `out()`).
 * @param {any} el
 */
export const drop = (el) => { if (el) el.setAttribute('data-demo-drop', ''); };

/**
 * Karta (`.gv-card`), w której siedzi dany host. Kilka kart w `dashboard.html`
 * nie ma własnego id — a nie chcemy dokładać id do rozszerzenia tylko po to,
 * żeby miała je dokumentacja.
 * @param {any} el
 * @returns {any}
 */
export const card = (el) => el.closest('.gv-card') || el;

// Dane (obsada, sojusze, planety, profile zagrożenia) mieszkają w `_world.mjs`
// — jeden zmyślony wszechświat na wszystkie demo. Tu jest tylko maszyneria.
