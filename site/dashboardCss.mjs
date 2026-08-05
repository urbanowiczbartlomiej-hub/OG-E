// @ts-check

// Wyciąga arkusz dashboardu z `src/dashboard.html` i ZAWĘŻA go do sceny demo.
//
// Po co: żywe demo renderuje PRAWDZIWY komponent, a te komponenty w dużej
// części nie stylują się inline — używają klas z jedynego arkusza OG-E
// (`<style>` w `src/dashboard.html`): `.gv-card`, `.smap-info`, `.dossier-grid`…
// Bez tego arkusza demo byłoby gołym HTML-em, a jedyną alternatywą jest
// przepisanie palety do dokumentacji — czyli dokładnie ten fork, którego
// IDEAS.md § 5 zakazuje (i który zaczyna się starzeć w dniu przepisania).
//
// Dlatego bierzemy arkusz U ŹRÓDŁA, przy każdym buildzie. Zmiana wyglądu
// dashboardu przechodzi na stronę sama, tak jak zmiana markupu.
//
// Zawężenie jest konieczne, bo arkusz zawiera reguły dla `body`, `*` i `:root`
// — bez prefiksu przemalowałyby całą dokumentację. Każdy selektor dostaje
// prefiks `.shot-demo`, a selektory korzenia (`body`, `:root`, `html`) mapują
// się NA samą scenę.
//
// Zero zależności (czysty string) — działa na CI Pages bez `npm ci`, inaczej
// niż render markupu (patrz site/README.md § Żywe demo).
//
// Świadomie NIE ruszamy media queries: pytają o viewport, nie o rozmiar sceny,
// więc na wąskiej stronie demo pokazuje mobilny wariant dashboardu, a na
// szerokiej desktopowy. To jest pożądane — dokumentacja pokazuje wtedy ten
// wariant, który czytelnik zobaczyłby u siebie.

import { readFile } from 'node:fs/promises';

/** Selektory korzenia dokumentu — mapują się na kontener sceny, nie pod niego. */
const ROOT_SELECTORS = new Set(['html', 'body', ':root', 'html body']);

/**
 * Dzieli listę selektorów na przecinkach najwyższego poziomu (nawiasy i
 * cudzysłowy są chronione, np. `:not(a, b)`).
 * @param {string} list
 * @returns {string[]}
 */
const splitSelectors = (list) => {
  /** @type {string[]} */
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  for (const ch of list) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
};

/**
 * Prefiksuje jeden selektor scope'em sceny.
 * @param {string} sel
 * @param {string} scope
 * @returns {string}
 */
const scopeSelector = (sel, scope) => {
  const s = sel.trim();
  if (!s) return s;
  // `body`, `:root` → sama scena. `body .foo` → `.scene .foo` (bez tego
  // dostalibyśmy `.scene body .foo`, które nigdy nie trafi).
  for (const root of ROOT_SELECTORS) {
    if (s === root) return scope;
    if (s.startsWith(`${root} `)) return `${scope} ${s.slice(root.length + 1)}`;
    if (s.startsWith(`${root}.`) || s.startsWith(`${root}[`) || s.startsWith(`${root}:`)) {
      return `${scope}${s.slice(root.length)}`;
    }
  }
  return `${scope} ${s}`;
};

/**
 * Iteruje po kolejnych kawałkach arkusza na JEDNYM poziomie zagnieżdżenia.
 *
 * Woła `cb(chunk, prelude, body)`, gdzie `prelude` to `null` dla białych znaków
 * i komentarzy między regułami (wtedy `chunk` jest do przepisania w całości),
 * a dla reguły — jej selektory albo at-rule, już bez komentarzy. Zawartość
 * `{…}` jest wycinana z uwzględnieniem zagnieżdżeń, stringów i komentarzy.
 * @param {string} css
 * @param {(chunk: string, prelude: string | null, body: string) => void} cb
 * @returns {void}
 */
const eachRule = (css, cb) => {
  let i = 0;
  while (i < css.length) {
    // Białe znaki i komentarze MIĘDZY regułami muszą zejść z drogi przed
    // czytaniem preludium: komentarz wciągnięty do listy selektorów rozjechałby
    // ją na własnych przecinkach.
    const ws = /^\s*/.exec(css.slice(i));
    if (ws && ws[0]) { cb(ws[0], null, ''); i += ws[0].length; continue; }
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      cb(css.slice(i, stop), null, '');
      i = stop;
      continue;
    }
    const brace = css.indexOf('{', i);
    if (brace === -1) { cb(css.slice(i), null, ''); break; }

    let depth = 0;
    let quote = '';
    let end = brace;
    for (let j = brace; j < css.length; j++) {
      const ch = css[j];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '/' && css[j + 1] === '*') {
        const c = css.indexOf('*/', j + 2);
        j = c === -1 ? css.length : c + 1;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    const body = css.slice(brace + 1, end);
    // Komentarz doklejony do selektora (`.a /* czemu */ {`) nie niesie nic dla
    // wyjścia, a niósłby własne przecinki do splitera — znika.
    const prelude = css.slice(i, brace).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    cb(css.slice(i, end + 1), prelude, body);
    i = end + 1;
  }
};

/**
 * Warunek `@media`, jeśli pyta WYŁĄCZNIE o szerokość (`min-width`/`max-width`,
 * ewentualnie połączone `and`). Inaczej null.
 *
 * Po co: taki warunek da się przetłumaczyć 1:1 na `@container`, a warunki o
 * urządzeniu (`pointer: coarse`, `hover: hover`) nie — kontener nie ma
 * wskaźnika, tylko rozmiar.
 * @param {string} prelude
 * @returns {string | null}
 */
const widthOnlyCondition = (prelude) => {
  const m = /^@media\s+([\s\S]+)$/.exec(prelude);
  if (!m) return null;
  const cond = m[1].trim();
  const features = cond.match(/\(([^()]*)\)/g) || [];
  if (!features.length) return null;
  // Poza nawiasami wolno zostać tylko spójnikom `and`.
  const glue = cond.replace(/\(([^()]*)\)/g, ' ').trim();
  if (glue && !/^(and\s*)+$/i.test(`${glue} `.trim() + ' ')) return null;
  for (const f of features) {
    if (!/^\(\s*(min|max)-width\s*:/i.test(f)) return null;
  }
  return cond;
};

/**
 * Dzieli już zawężony blok reguł na te, które celują w SAM kontener sceny, i
 * całą resztę. Patrz wywołanie: container query nie stylizuje własnego
 * kontenera, więc tamte muszą zostać przy `@media`.
 * @param {string} css
 * @param {string} scope
 * @returns {{self: string, rest: string}}
 */
const splitSelfRules = (css, scope) => {
  let self = '';
  let rest = '';
  eachRule(css, (chunk, prelude) => {
    const targetsSelf = prelude !== null
      && splitSelectors(prelude).every((s) => s.trim() === scope);
    if (targetsSelf) self += chunk;
    else rest += chunk;
  });
  return { self, rest };
};

/**
 * Przechodzi po regułach CSS na danym poziomie i zawęża selektory. Wchodzi
 * rekurencyjnie w bloki warunkowe (`@media`, `@supports`); reguły, których
 * wnętrze NIE jest listą selektorów (`@keyframes`, `@font-face`), przepisuje
 * bez zmian.
 * @param {string} css
 * @param {string} scope
 * @returns {string}
 */
const scopeRules = (css, scope) => {
  let out = '';
  eachRule(css, (chunk, prelude, body) => {
    if (prelude === null) { out += chunk; return; }
    if (prelude.startsWith('@')) {
      const conditional = /^@(media|supports|layer|container)\b/.test(prelude);
      const inner = conditional ? scopeRules(body, scope) : body;
      const width = conditional && widthOnlyCondition(prelude);
      if (width) {
        // Zapytanie o samą szerokość → pytamy o szerokość SCENY, nie okna.
        // Wyjątkiem są reguły celujące w sam kontener: element nie może być
        // stylowany własnym container query, więc te zostają przy @media.
        const { self, rest } = splitSelfRules(inner, scope);
        if (self.trim()) out += `@media ${width} {${self}}`;
        if (rest.trim()) out += `@container ${width} {${rest}}`;
      } else {
        out += `${prelude} {${inner}}`;
      }
    } else {
      const sel = splitSelectors(prelude).map((s) => scopeSelector(s, scope)).join(', ');
      out += `${sel} {${body}}`;
    }
  });
  return out;
};

/**
 * Zawęża dowolny arkusz do `scope` (patrz nagłówek pliku). Wystawione osobno,
 * bo demo potrzebuje tego samego zabiegu na stylu FAB-a — ten NIE mieszka w
 * `dashboard.html`, tylko w `features/shared/buttonChrome.js`, bo wstrzykuje
 * się na stronę gry.
 * @param {string} css
 * @param {string} scope
 * @returns {string}
 */
export const scopeCss = (css, scope) => scopeRules(css, scope).trim();

/**
 * Czyta `<style>` z pliku dashboardu i zwraca wersję zawężoną do `scope`.
 * Zwraca '' gdy pliku nie ma albo nie zawiera arkusza — wołający pomija wtedy
 * link (demo pokaże goły markup zamiast wywalić build).
 * @param {string} dashboardHtmlPath
 * @param {string} scope  Selektor sceny, np. `.shot-demo`.
 * @returns {Promise<string>}
 */
export const buildScopedDashboardCss = async (dashboardHtmlPath, scope) => {
  let html = '';
  try {
    html = await readFile(dashboardHtmlPath, 'utf8');
  } catch {
    return '';
  }
  const m = /<style>([\s\S]*?)<\/style>/i.exec(html);
  if (!m) return '';
  return scopeCss(m[1], scope);
};
