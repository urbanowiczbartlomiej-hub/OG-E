// @ts-check

// Generator statycznej dokumentacji OG-E.
//
//   node site/build.mjs            → renderuje do site/dist/
//
// Wynik to po JEDNEJ długiej, wycentrowanej stronie na język:
//   dist/index.html      (PL — baza)
//   dist/en/index.html   (EN — lustro)
// Wszystkie funkcje jedna pod drugą (pogrupowane w kategorie), z bocznym
// spisem treści (na desktopie przyklejonym, ze scroll-spy; na mobile chowanym
// pod przyciskiem w duchu FAB-a OG-E). W nagłówku przełącznik motywu
// ciemny/jasny (zapamiętywany, domyślnie wg preferencji systemu) oraz
// przełącznik języka PL/EN (przenosi na tę samą sekcję drugiej wersji —
// kotwice-slugi są wspólne).
//
// Warstwa i18n:
//   content/_strings.mjs     stringi CHROME szablonu per język,
//   content/_categories.mjs  nazwy/blurby kategorii per język (wspólne id),
//   content/<slug>.mjs       treść PL (baza),
//   content/en/<slug>.mjs    treść EN (lustro 1:1 — build wymusza komplet).
//
// Treść jest walidowana kontraktem z content/_schema.mjs. Build PRZERYWA
// (exit 1) przy błędzie walidacji ORAZ gdy zbiór slugów EN nie pokrywa się
// z PL — to nasz test spójności. ZERO zależności (czysty Node ≥22).
// `dist/` jest gitignorowane: output buduje i wdraża na GitHub Pages
// .github/workflows/pages.yml (patrz site/README.md § Publikacja).

import { readdir, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { CATEGORIES, CATEGORY_IDS } from './content/_categories.mjs';
import { validateFeature } from './content/_schema.mjs';
import { STRINGS } from './content/_strings.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, '..');
const CONTENT_DIR = join(ROOT, 'content');
const ASSETS_DIR = join(ROOT, 'assets');
const SHOTS_DIR = join(ASSETS_DIR, 'shots');
const DEMOS_DIR = join(ROOT, 'demos');
const DEMOS_OUT = join(DEMOS_DIR, '_generated');
const DIST = join(ROOT, 'dist');

/**
 * Wejście ŻYWEGO przycisku (patrz site/live/fab-playground.js) — ścieżka
 * względem korzenia repo. Generator kopiuje ten plik razem z całym jego grafem
 * importów, więc lista dotkniętych modułów `src/` NIGDY nie jest utrzymywana
 * ręcznie.
 */
const LIVE_ENTRIES = ['site/live/fab-playground.js'];

/**
 * Katalog w `dist/`, pod który mirrorujemy drzewo repo (`assets/site/live/...`
 * + `assets/src/...`). Prefiks zachowuje WZAJEMNE głębokości ścieżek, więc
 * relatywne importy w skopiowanych plikach rozwiązują się bez przepisywania
 * ani jednej linijki kodu.
 */
const LIVE_OUT_PREFIX = 'assets';

/** @typedef {'pl'|'en'} Locale */

/**
 * Języki builda. PL to baza (renderowana w korzeniu), każdy kolejny język
 * ląduje w podkatalogu dist/<lang>/ i czyta treść z content/<lang>/.
 * @type {Locale[]}
 */
const LOCALES = ['pl', 'en'];

// Kontekst renderowania bieżącego języka (ustawiany per iteracja builda).
let /** @type {any} */ L = STRINGS.pl;
let /** @type {Locale} */ LOCALE = 'pl';
let BASE = ''; // prefiks ścieżek do assets ('' w korzeniu, '../' w dist/<lang>/)

/** Escape do bezpiecznego wstrzyknięcia tekstu w HTML. */
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Lekki inline-markdown: **pogrubienie** i `kod`. Reszta jest escapowana.
 * @param {string} s
 * @returns {string}
 */
const inline = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/** Tablica akapitów → HTML `<p>`. */
const paras = (arr) => arr.map((p) => `<p>${inline(p)}</p>`).join('\n');

/** Tablica stringów → `<ul>`. */
const list = (arr) => `<ul>${arr.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`;

/**
 * Zrzut/makieta: realny <img> jeśli plik istnieje, inaczej ramka-placeholder
 * (makieta do podmiany). Konwencja pliku: assets/shots/<slug>--<shotId>.png
 * — zrzuty są WSPÓLNE dla języków (podpisy są per język w treści).
 * @param {string} slug
 * @param {{id: string, caption: string}} shot
 * @returns {string}
 */
const shotFigure = (slug, shot) => {
  const file = `${slug}--${shot.id}.png`;
  const real = existsSync(join(SHOTS_DIR, file));
  const media = real
    ? `<button class="shot-zoom" type="button" data-full="${BASE}assets/shots/${esc(file)}" data-caption="${esc(shot.caption)}"><img src="${BASE}assets/shots/${esc(file)}" alt="${esc(shot.caption)}" loading="lazy"></button>`
    : `<div class="shot-ph"><span class="shot-ph-tag">${esc(L.shotPlaceholder(shot.id))}</span></div>`;
  return `<figure class="shot${real ? '' : ' is-ph'}">${media}<figcaption>${inline(shot.caption)}</figcaption></figure>`;
};

/**
 * Wyrenderowane ŻYWE komponenty: demoId → HTML. Wypełniane raz, przed budowaniem
 * stron (markup jest niezależny od języka — podpis przychodzi z treści).
 * @type {Map<string, string>}
 */
const DEMO_HTML = new Map();

/**
 * Renderuje wszystkie demo z `site/demos/` użyte w treści — a gdy się nie da,
 * sięga po wersję ZACOMMITOWANĄ.
 *
 * Powód tej dwutorowości: demo renderuje prawdziwy komponent w headless DOM
 * (`happy-dom`), a to devDependency — CI Pages celowo nie robi `npm ci`
 * (generator jest zero-dependency), więc na Pages żywy render nigdy się nie uda.
 * Dlatego udany render zapisuje markup do `site/demos/_generated/<id>.html`,
 * który JEST w repo: to on ląduje na opublikowanej stronie. Efekt uboczny jest
 * pożądany — nieodświeżone demo widać w `git status` jako niezacommitowaną
 * zmianę, a sam markup jest czytelny w diffie.
 *
 * Gdy nie ma ani jednego, ani drugiego, demo zostaje puste i strona pokazuje
 * same zrzuty; build nie umiera na elemencie dekoracyjnym.
 * @param {Iterable<string>} ids
 * @returns {Promise<string[]>} Ostrzeżenia (nie błędy).
 */
const renderDemos = async (ids) => {
  /** @type {string[]} */
  const warnings = [];
  for (const id of new Set(ids)) {
    const cached = join(DEMOS_OUT, `${id}.html`);
    let html = '';
    try {
      const mod = await import(pathToFileURL(join(DEMOS_DIR, `${id}.mjs`)).href);
      html = typeof mod.render === 'function' ? String((await mod.render()) || '') : '';
    } catch {
      html = '';
    }
    if (html) {
      // Zapis tylko przy realnej zmianie — bez tego każdy build brudziłby drzewo.
      const prev = existsSync(cached) ? await readFile(cached, 'utf8') : null;
      if (prev !== html) {
        await mkdir(DEMOS_OUT, { recursive: true });
        await writeFile(cached, html);
        warnings.push(`↻ demo "${id}" odświeżone — zacommituj site/demos/_generated/${id}.html`);
      }
    } else if (existsSync(cached)) {
      html = await readFile(cached, 'utf8');
    }
    if (html) DEMO_HTML.set(id, html);
    else warnings.push(`⚠ demo "${id}" nie wyrenderowało się — strona pokaże tylko zrzuty`);
  }
  return warnings;
};

/**
 * ŻYWY komponent: prawdziwy kod OG-E wklejony w stronę, zamiast zrzutu, który
 * starzeje się w tym samym tempie co kod.
 * @param {{id: string, caption: string} | undefined} demo
 * @returns {string}
 */
const demoFigure = (demo) => {
  const html = demo ? DEMO_HTML.get(demo.id) : '';
  if (!demo || !html) return '';
  return `<figure class="shot is-demo"><div class="shot-demo">${html}</div>`
    + `<figcaption>${inline(demo.caption)}</figcaption></figure>`;
};

/**
 * Sekcja funkcji: labelowany blok prozy/listy.
 * @param {string} cls  Modyfikator klasy (fsec-idea | fsec-value | ...).
 * @param {string} label
 * @param {string} body
 */
const sec = (cls, label, body) =>
  `<section class="fsec ${cls}"><h4 class="fsec-label">${esc(label)}</h4>${body}</section>`;

/**
 * Blok jednej funkcji (kotwica = slug), renderowany inline na długiej stronie.
 * @param {import('./content/_schema.mjs').Feature} f
 * @returns {string}
 */
const featureBlock = (f) => {
  const flag = f.flagship ? ` <span class="flag-tag">${esc(L.flagship)}</span>` : '';
  const fpNote = f.fairplay.borderline ? `<p class="fp-note">${inline(L.borderlineNote)}</p>` : '';
  // "Dodatkowe informacje" jako natywny <details> — domyślnie zwinięte:
  // detale są bardziej zmienne niż idea, więc nie konkurują z nią wizualnie.
  const details = f.details
    ? `<details class="fsec fsec-details"><summary class="fsec-label">${esc(L.sections.details)}</summary>${list(f.details)}</details>`
    : '';
  return `
<article class="feature${f.flagship ? ' is-flagship' : ''}" id="${esc(f.id)}">
  <header class="feature-hdr">
    <h3 class="feature-name"><a class="feature-anchor" href="#${esc(f.id)}" aria-label="${esc(L.anchorLabel(f.name))}">${esc(f.name)}</a>${flag}</h3>
    <p class="feature-lead">${inline(f.oneLiner)}</p>
  </header>

  <div class="shots">
    ${demoFigure(f.demo)}
    ${f.screenshots.map((s) => shotFigure(f.id, s)).join('\n')}
  </div>

  ${sec('fsec-idea', L.sections.idea, paras(f.idea))}
  ${sec('fsec-value', L.sections.value, paras(f.value))}
  ${details}
  ${sec(`fsec-fair${f.fairplay.borderline ? ' is-borderline' : ''}`, L.sections.fairplay, fpNote + paras(f.fairplay.summary))}
</article>`;
};

/**
 * Boczny spis treści: kategorie → linki do funkcji.
 * @param {{cat: import('./content/_categories.mjs').Category, items: import('./content/_schema.mjs').Feature[]}[]} groups
 * @returns {string}
 */
const tocNav = (groups) => {
  const blocks = groups
    .map(
      ({ cat, items }) => `<li class="toc-cat"><a href="#cat-${esc(cat.id)}">${esc(cat.name[LOCALE])}</a></li>
      ${items.map((f) => `<li class="toc-item"><a href="#${esc(f.id)}">${esc(f.name)}</a></li>`).join('\n      ')}`,
    )
    .join('\n');
  return `<nav class="toc" id="toc" aria-label="${esc(L.tocTitle)}">
    <div class="toc-inner">
      <ul class="toc-list">
${blocks}
      </ul>
    </div>
  </nav>`;
};

/**
 * Przełącznik języka PL/EN — segmentowany kontrolek w nagłówku. Linki
 * względne między korzeniem a dist/<lang>/; skrypt dokleja bieżącą kotwicę,
 * więc lądujesz na tej samej funkcji w drugim języku.
 * @returns {string}
 */
const langSwitch = () => {
  const links = LOCALES.map((loc) => {
    const active = loc === LOCALE;
    // Ścieżka z bieżącej strony do strony języka `loc`.
    const href = active ? './' : loc === 'pl' ? '../' : `${loc}/`;
    return `<a href="${href}"${active ? ' class="is-active" aria-current="page"' : ''} lang="${loc}">${loc.toUpperCase()}</a>`;
  }).join('');
  return `<nav class="lang-switch" aria-label="${esc(L.langSwitchLabel)}">${links}</nav>`;
};

/** Ikony SVG przełącznika motywu (słońce/księżyc) — inline, zero zależności. */
const ICON_SUN =
  '<svg class="ico-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/></svg>';
const ICON_MOON =
  '<svg class="ico-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.4 14.2A8.4 8.4 0 0 1 9.8 3.6a8.4 8.4 0 1 0 10.6 10.6Z"/></svg>';

/**
 * Boot motywu — inline w <head>, PRZED stylami, żeby uniknąć błysku złego
 * motywu: localStorage → preferencja systemowa → dark.
 */
const THEME_BOOT = `
(function () {
  var t = null;
  try { t = localStorage.getItem('oge-doc-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = t;
})();
`;

/**
 * Inline JS: motyw, przełącznik języka (z kotwicą), drawer mobile, scroll-spy,
 * żywy przycisk OG-E. Funkcja (nie stała), bo ścieżka do modułu żywego
 * przycisku zależy od języka — `import()` rozwiązuje się względem dokumentu,
 * a EN mieszka w podkatalogu.
 * @param {string} base Prefiks ścieżek do assets ('' w korzeniu, '../' w /en/).
 * @returns {string}
 */
const SCRIPT = (base) => `
(function () {
  // Przełącznik motywu (zapamiętywany).
  var themeBtn = document.getElementById('themeBtn');
  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('oge-doc-theme', next); } catch (e) {}
  });

  // Przełącznik języka: dopnij bieżącą kotwicę, żeby wylądować na tej samej
  // funkcji w drugim języku (slugi są wspólne).
  document.querySelectorAll('.lang-switch a:not(.is-active)').forEach(function (a) {
    a.addEventListener('click', function () {
      a.href = a.getAttribute('href').split('#')[0] + location.hash;
    });
  });

  // Drawer spisu funkcji na mobile.
  var toc = document.getElementById('toc');
  var fab = document.getElementById('tocFab');
  var open = function (v) {
    document.body.classList.toggle('toc-open', v);
    fab.setAttribute('aria-expanded', String(v));
  };
  fab.addEventListener('click', function () { open(!document.body.classList.contains('toc-open')); });
  document.querySelector('.toc-scrim').addEventListener('click', function () { open(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') open(false); });
  // Zamknij po kliknięciu w link (mobile).
  toc.addEventListener('click', function (e) {
    if (e.target.closest('a') && window.matchMedia('(max-width: 1039px)').matches) open(false);
  });

  // Scroll-spy: podświetl link odpowiadający widocznej funkcji.
  var links = {};
  toc.querySelectorAll('a[href^="#"]').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
  var setActive = function (id) {
    toc.querySelectorAll('a.active').forEach(function (a) { a.classList.remove('active'); });
    if (links[id]) {
      links[id].classList.add('active');
      links[id].scrollIntoView({ block: 'nearest' });
    }
  };
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { if (en.isIntersecting) setActive(en.target.id); });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  document.querySelectorAll('.feature[id], .cat-block[id]').forEach(function (el) { obs.observe(el); });

  // Lightbox: podgląd zrzutu w pełnym rozmiarze (zrzuty bywają różnych proporcji).
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightboxImg');
  var lightboxCaption = document.getElementById('lightboxCaption');
  var openLightbox = function (btn) {
    lightboxImg.src = btn.getAttribute('data-full');
    lightboxImg.alt = btn.getAttribute('data-caption') || '';
    lightboxCaption.textContent = btn.getAttribute('data-caption') || '';
    lightbox.hidden = false;
    document.body.classList.add('lightbox-open');
  };
  var closeLightbox = function () {
    lightbox.hidden = true;
    document.body.classList.remove('lightbox-open');
    lightboxImg.src = '';
  };
  document.querySelectorAll('.shot-zoom').forEach(function (btn) {
    btn.addEventListener('click', function () { openLightbox(btn); });
  });
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !lightbox.hidden) closeLightbox(); });

  // ── Żywy przycisk OG-E ────────────────────────────────────────────────
  // Prawdziwy FAB rozszerzenia, pływający po całej stronie. Moduł (i cały
  // skopiowany graf 'src/') ładuje się LENIWIE — dopiero gdy ktoś włączy
  // przycisk albo otworzy panel; kto tylko czyta dokumentację, nie płaci za
  // to ani jednym żądaniem.
  var FAB_KEY = 'oge-doc-fab';
  var fabBtn = document.getElementById('fabBtn');
  var fabPanel = document.getElementById('fabPanel');
  var fabSwitch = document.getElementById('fabSwitch');
  var fabBody = document.getElementById('fabPanelBody');
  var fabReset = document.getElementById('fabReset');
  var mod = null;
  var load = function () {
    // Dynamiczny import wymaga specyfikatora, który JEST URL-em — ścieżka
    // relatywna bez './' nim nie jest, więc rozwiązujemy ją wobec adresu
    // dokumentu (i tym samym poprawnie dla /en/, o katalog głębiej).
    if (!mod) mod = import(new URL('${base}assets/site/live/fab-playground.js', document.baseURI).href);
    return mod;
  };
  var stored = null;
  try { stored = localStorage.getItem(FAB_KEY); } catch (e) {}
  fabSwitch.checked = stored === '1';
  var apply = function (on) {
    try { localStorage.setItem(FAB_KEY, on ? '1' : '0'); } catch (e) {}
    // Wyłączenie nigdy nie ŚCIĄGA modułu — jeśli go nie ma, nie ma też czego
    // zdejmować ze strony.
    if (!on) { if (mod) mod.then(function (m) { m.disableFab(); }); return; }
    load().then(function (m) { m.enableFab(); });
  };
  if (fabSwitch.checked) apply(true);
  fabSwitch.addEventListener('change', function () { apply(fabSwitch.checked); });
  fabReset.addEventListener('click', function () { load().then(function (m) { m.resetFab(); }); });

  var fabPanelOpen = function (v) {
    fabPanel.hidden = !v;
    fabBtn.setAttribute('aria-expanded', String(v));
    // Blok ustawień budujemy raz, przy pierwszym otwarciu (to prawdziwy
    // komponent panelu rozszerzenia — patrz site/live/fab-playground.js).
    if (v && !fabBody.firstChild) {
      load().then(function (m) {
        if (!fabBody.firstChild) fabBody.appendChild(m.buildSettingsBlock());
      });
    }
  };
  fabBtn.addEventListener('click', function () { fabPanelOpen(fabPanel.hidden); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !fabPanel.hidden) fabPanelOpen(false); });
  document.addEventListener('click', function (e) {
    if (fabPanel.hidden) return;
    if (fabPanel.contains(e.target) || fabBtn.contains(e.target)) return;
    fabPanelOpen(false);
  });
})();
`;

/**
 * Cała strona (jedna długa, wycentrowana) dla bieżącego języka.
 * @param {import('./content/_schema.mjs').Feature[]} features
 * @returns {string}
 */
const buildPage = (features) => {
  // Kolejność w kategorii: po `order` rosnąco (brak = na koniec), potem po nazwie.
  const byOrder = (a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name, LOCALE);
  const groups = CATEGORIES.map((cat) => ({
    cat,
    items: features.filter((f) => f.category === cat.id).sort(byOrder),
  })).filter((g) => g.items.length > 0);

  const sections = groups
    .map(
      ({ cat, items }) => `<section class="cat-block" id="cat-${esc(cat.id)}">
      <header class="cat-hdr">
        <h2>${esc(cat.name[LOCALE])}<span class="cat-count">${esc(L.featureCount(items.length))}</span></h2>
        <p class="cat-blurb">${inline(cat.blurb[LOCALE])}</p>
      </header>
      ${items.map(featureBlock).join('\n')}
    </section>`,
    )
    .join('\n');

  const chips = L.hero.chips.map((c) => `<li>${inline(c)}</li>`).join('');
  const statements = L.hero.statements
    .map((s) => `<p class="statement">${inline(s)}</p>`)
    .join('\n');

  return `<!doctype html>
<html lang="${LOCALE}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(L.metaDescription)}">
<meta name="color-scheme" content="dark light">
<title>${esc(L.title)}</title>
<link rel="icon" href="${BASE}assets/favicon.png">
<script>${THEME_BOOT}</script>
<link rel="stylesheet" href="${BASE}assets/style.css">
</head>
<body>
<a class="skip-link" href="#main">${esc(L.skipLink)}</a>

<header class="site-hdr">
  <div class="site-hdr-inner">
    <a class="brand" href="#top">
      <img class="brand-mark" src="${BASE}assets/logo.png" alt="${esc(L.brand)}" width="32" height="32" decoding="async">
      <span class="brand-name">${esc(L.brandSub)}</span>
    </a>
    <div class="hdr-actions">
      ${langSwitch()}
      <button class="fab-btn" id="fabBtn" type="button" aria-controls="fabPanel" aria-expanded="false" title="${esc(L.fab.btnLabel)}">${esc(L.fab.btn)}</button>
      <button class="theme-btn" id="themeBtn" type="button" aria-label="${esc(L.themeToggleLabel)}">${ICON_SUN}${ICON_MOON}</button>
    </div>
  </div>
</header>

<!-- Panel żywego przycisku: przełącznik + PRAWDZIWY blok ustawień FAB-a z
     rozszerzenia (module bar + suwak rozmiaru), wstrzykiwany do #fabPanelBody. -->
<div class="fab-panel" id="fabPanel" role="dialog" aria-label="${esc(L.fab.panelLabel)}" hidden>
  <p class="fab-panel-title">${esc(L.fab.title)}</p>
  <label class="fab-switch">
    <!-- autocomplete=off: bez tego przeglądarka ODTWARZA stan checkboxa przy
         przeładowaniu (i potrafi przy tym wystrzelić zdarzenie change), co
         rozjeżdża go z localStorage — a to on jest tu źródłem prawdy. -->
    <input type="checkbox" id="fabSwitch" autocomplete="off">
    <span>${esc(L.fab.show)}</span>
  </label>
  <div class="fab-panel-body" id="fabPanelBody"></div>
  <p class="fab-note">${inline(L.fab.note)}</p>
  <button class="fab-reset" id="fabReset" type="button">${esc(L.fab.reset)}</button>
</div>

<button class="toc-fab" id="tocFab" type="button" aria-controls="toc" aria-expanded="false" aria-label="${esc(L.tocButtonLabel)}">${esc(L.tocButton)}</button>
<div class="toc-scrim" aria-hidden="true"></div>

<div class="layout" id="top">
  ${tocNav(groups)}
  <main id="main">
    <section class="hero">
      <img class="hero-logo" src="${BASE}assets/logo.png" alt="${esc(L.brand)}" width="88" height="88" decoding="async">
      <p class="hero-kicker">${esc(L.hero.kicker)}</p>
      <h1>${esc(L.hero.title)} <span class="hero-sub">${esc(L.hero.subtitle)}</span></h1>
      <p class="hero-lead">${inline(L.hero.lead)}</p>
      <ul class="hero-chips" role="list">${chips}</ul>
      ${statements}
      <p class="hero-meta">${inline(L.hero.meta)}</p>
    </section>
    ${sections}
  </main>
</div>

<footer class="site-foot">
  <p>${inline(L.footer)}</p>
</footer>
<div class="lightbox" id="lightbox" hidden>
  <button class="lightbox-close" id="lightboxClose" type="button" aria-label="${esc(L.lightboxClose)}">&times;</button>
  <img class="lightbox-img" id="lightboxImg" src="" alt="">
  <p class="lightbox-caption" id="lightboxCaption"></p>
</div>
<script>${SCRIPT(BASE)}</script>
</body>
</html>`;
};

// ─── Żywy przycisk: graf modułów → dist ──────────────────────────────────
//
// Strona wpuszcza PRAWDZIWY kod przycisku OG-E (nie zrzut, nie makietę, nie
// fork), a robi to najprostszym możliwym sposobem: kopiuje dotknięte pliki
// `src/` verbatim i ładuje je jako natywne ESM. Dlatego generator zostaje
// zero-dependency (żadnego bundlera, więc CI Pages nadal nie potrzebuje
// `npm ci` — patrz .github/workflows/pages.yml), a w repo nie ma ani jednego
// zbudowanego artefaktu, który mógłby się zestarzeć.
//
// Zbiór plików NIE jest listą do utrzymywania — wychodzi z przejścia grafu
// importów od wejścia. Brakujący plik PRZERYWA build: cichy 404 na module
// oznaczałby przycisk, który po prostu się nie pojawia.

/**
 * Relatywne importy w kodzie źródłowym: `from './x.js'` oraz `import './x.js'`.
 * Świadomie NIE łapie `import('./x.js')` (z nawiasem) — w `src/` ta forma
 * występuje wyłącznie w typach JSDoc, które w runtime nie istnieją.
 */
const REL_IMPORT_RE = /(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g;

/**
 * Przejdź graf importów od podanych wejść i zwróć KAŻDY dotknięty plik jako
 * ścieżkę względną wobec korzenia repo (z `/` jako separatorem).
 * @param {string[]} entries Ścieżki wejść względem korzenia repo.
 * @returns {Promise<string[]>}
 */
const collectModuleGraph = async (entries) => {
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = entries.map((p) => join(REPO, p));
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    const rel = relative(REPO, file).split(sep).join('/');
    if (seen.has(rel)) continue;
    if (!existsSync(file)) {
      throw new Error(
        `żywy przycisk: import wskazuje na nieistniejący plik "${rel}" ` +
          '(literówka w imporcie albo przeniesiony moduł)',
      );
    }
    seen.add(rel);
    const code = await readFile(file, 'utf8');
    for (const m of code.matchAll(REL_IMPORT_RE)) queue.push(resolve(dirname(file), m[1]));
  }
  return [...seen].sort();
};

/**
 * Skopiuj graf do `dist/`, mirrorując drzewo repo pod {@link LIVE_OUT_PREFIX}.
 * Prefiks jest wspólny dla wszystkich plików, więc wzajemne głębokości ścieżek
 * są zachowane i relatywne importy działają bez przepisywania.
 * @param {string[]} files
 * @returns {Promise<void>}
 */
const copyLiveGraph = async (files) => {
  for (const rel of files) {
    const dst = join(DIST, LIVE_OUT_PREFIX, ...rel.split('/'));
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(join(REPO, ...rel.split('/')), dst);
  }
};

/** Rekurencyjne kopiowanie katalogu (assets). */
const copyDir = async (src, dst) => {
  if (!existsSync(src)) return;
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
};

/**
 * Wczytuje i waliduje treść jednego języka.
 * PL czyta z content/, inne języki z content/<lang>/.
 * @param {Locale} locale
 * @returns {Promise<{features: import('./content/_schema.mjs').Feature[], errors: string[]}>}
 */
const loadLocale = async (locale) => {
  const dir = locale === 'pl' ? CONTENT_DIR : join(CONTENT_DIR, locale);
  /** @type {import('./content/_schema.mjs').Feature[]} */
  const features = [];
  /** @type {string[]} */
  const errors = [];

  if (!existsSync(dir)) {
    errors.push(`✗ brak katalogu treści dla języka "${locale}": ${dir}`);
    return { features, errors };
  }

  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();

  for (const file of files) {
    const slug = file.replace(/\.mjs$/, '');
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const errs = validateFeature(mod.default, slug, CATEGORY_IDS, locale);
    if (errs.length) {
      errors.push(`✗ ${locale}/${file}:`);
      errs.forEach((e) => errors.push(`    - ${e}`));
    } else {
      features.push(mod.default);
    }
  }

  return { features, errors };
};

const main = async () => {
  // 1. Wczytaj + zwaliduj treść wszystkich języków.
  /** @type {Map<Locale, import('./content/_schema.mjs').Feature[]>} */
  const byLocale = new Map();
  /** @type {string[]} */
  const allErrors = [];

  for (const locale of LOCALES) {
    const { features, errors } = await loadLocale(locale);
    byLocale.set(locale, features);
    allErrors.push(...errors);
  }

  // 2. Test lustra: każdy język ma dokładnie te same slugi co baza PL.
  const baseSlugs = new Set((byLocale.get('pl') ?? []).map((f) => f.id));
  for (const locale of LOCALES) {
    if (locale === 'pl') continue;
    const slugs = new Set((byLocale.get(locale) ?? []).map((f) => f.id));
    for (const s of baseSlugs) {
      if (!slugs.has(s)) allErrors.push(`✗ ${locale}: brak tłumaczenia content/${locale}/${s}.mjs`);
    }
    for (const s of slugs) {
      if (!baseSlugs.has(s)) allErrors.push(`✗ ${locale}: osierocone content/${locale}/${s}.mjs (brak bazy PL)`);
    }
  }

  if (allErrors.length) {
    console.error('Walidacja treści nie powiodła się:\n' + allErrors.join('\n'));
    process.exit(1);
  }

  // 2b. Żywe komponenty — raz dla wszystkich języków (markup jest wspólny).
  const demoIds = [...byLocale.values()].flat().map((f) => f.demo?.id).filter(Boolean);
  for (const w of await renderDemos(/** @type {string[]} */ (demoIds))) console.warn(w);

  // 3. Wyczyść i odbuduj dist (wszystkie języki + wspólne assets).
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  for (const locale of LOCALES) {
    LOCALE = locale;
    L = STRINGS[locale];
    BASE = locale === 'pl' ? '' : '../';
    const outDir = locale === 'pl' ? DIST : join(DIST, locale);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'index.html'), buildPage(byLocale.get(locale) ?? []), 'utf8');
  }
  await copyDir(ASSETS_DIR, join(DIST, 'assets'));

  // 3b. Żywy przycisk: prawdziwy kod `src/` + jego wejście, skopiowane verbatim.
  const liveFiles = await collectModuleGraph(LIVE_ENTRIES);
  await copyLiveGraph(liveFiles);

  // GitHub Pages: bez tego pliku hosting przepuszcza output przez Jekylla,
  // który POMIJA ścieżki zaczynające się od `_`. Nic takiego dziś nie
  // publikujemy, ale plik jest darmowy i zdejmuje całą klasę niespodzianek.
  await writeFile(join(DIST, '.nojekyll'), '', 'utf8');

  const pl = byLocale.get('pl') ?? [];
  const drafted = pl.filter((f) => f.status === 'drafted').length;
  const verified = pl.filter((f) => f.status === 'verified').length;
  console.log(
    `OK — ${pl.length} funkcji (${verified} verified, ${drafted} drafted), języki: ${LOCALES.join(', ')},`
      + ` żywy przycisk: ${liveFiles.length} modułów → site/dist/`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
