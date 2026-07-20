// @ts-check

// Generator statycznej dokumentacji OG-E.
//
//   node site/build.mjs            → renderuje do site/dist/
//
// Wynik to JEDNA długa, wycentrowana strona `dist/index.html`: wszystkie
// funkcje jedna pod drugą (pogrupowane w kategorie), z pływającym menu-kotwicą
// po lewej (na desktopie przyklejone przy scrollu; na mobile chowane pod
// przyciskiem w duchu FAB-a OG-E). Scroll-spy podświetla aktywną sekcję.
//
// Treść czyta z content/<slug>.mjs (poza _*.mjs), waliduje kontraktem z
// content/_schema.mjs. Build PRZERYWA (exit 1) przy błędzie walidacji — to nasz
// test spójności. ZERO zależności (czysty Node ≥22). `dist/` jest gitignorowane.

import { readdir, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { CATEGORIES, CATEGORY_IDS } from './content/_categories.mjs';
import { validateFeature } from './content/_schema.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(ROOT, 'content');
const ASSETS_DIR = join(ROOT, 'assets');
const SHOTS_DIR = join(ASSETS_DIR, 'shots');
const DIST = join(ROOT, 'dist');

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
 * @param {string} slug
 * @param {{id: string, caption: string}} shot
 * @returns {string}
 */
const shotFigure = (slug, shot) => {
  const file = `${slug}--${shot.id}.png`;
  const real = existsSync(join(SHOTS_DIR, file));
  const media = real
    ? `<img src="assets/shots/${esc(file)}" alt="${esc(shot.caption)}" loading="lazy">`
    : `<div class="shot-ph"><span class="shot-ph-tag">makieta / screen: ${esc(shot.id)}</span></div>`;
  return `<figure class="shot${real ? '' : ' is-ph'}">${media}<figcaption>${inline(shot.caption)}</figcaption></figure>`;
};

/**
 * Blok jednej funkcji (kotwica = slug), renderowany inline na długiej stronie.
 * @param {import('./content/_schema.mjs').Feature} f
 * @returns {string}
 */
const sec = (cls, label, body) =>
  `<section class="fsec ${cls}"><h4 class="fsec-label">${esc(label)}</h4>${body}</section>`;

const featureBlock = (f) => {
  const flag = f.flagship ? ' <span class="flag-tag">flagowa</span>' : '';
  const fpNote = f.fairplay.borderline
    ? '<p class="fp-note"><strong>Uczciwie: to funkcja graniczna.</strong> Traktujemy ją ostrożnie i mówimy o tym wprost — poniżej, dlaczego mimo to uznajemy ją za obronną.</p>'
    : '';
  return `
<article class="feature" id="${esc(f.id)}">
  <h3 class="feature-name">${esc(f.name)}${flag}</h3>
  <p class="lead">${inline(f.oneLiner)}</p>

  <div class="shots">
    ${f.screenshots.map((s) => shotFigure(f.id, s)).join('\n')}
  </div>

  ${sec('fsec-idea', 'Jak to działa', paras(f.idea))}
  ${sec('fsec-value', 'Po co to', paras(f.value))}
  ${f.details ? sec('fsec-details', 'Dodatkowe informacje', list(f.details)) : ''}
  ${sec(`fsec-fair${f.fairplay.borderline ? ' is-borderline' : ''}`, 'Fair-play', fpNote + paras(f.fairplay.summary))}
  ${f.settings ? sec('fsec-settings', 'Powiązane ustawienia', list(f.settings)) : ''}
</article>`;
};

/**
 * Pływające menu-kotwica: kategorie → linki do funkcji.
 * @param {{cat: import('./content/_categories.mjs').Category, items: import('./content/_schema.mjs').Feature[]}[]} groups
 * @returns {string}
 */
const tocNav = (groups) => {
  const blocks = groups
    .map(
      ({ cat, items }) => `<li class="toc-cat"><a href="#cat-${esc(cat.id)}">${esc(cat.name)}</a></li>
      ${items.map((f) => `<li class="toc-item"><a href="#${esc(f.id)}">${esc(f.name)}</a></li>`).join('\n      ')}`,
    )
    .join('\n');
  return `<nav class="toc" id="toc" aria-label="Spis funkcji">
    <div class="toc-inner">
      <p class="toc-title">Funkcje OG-E</p>
      <ul class="toc-list">
${blocks}
      </ul>
    </div>
  </nav>`;
};

/** Inline JS: przełącznik menu na mobile + scroll-spy podświetlający sekcję. */
const SCRIPT = `
(function () {
  var toc = document.getElementById('toc');
  var fab = document.getElementById('tocFab');
  var open = function (v) {
    document.body.classList.toggle('toc-open', v);
    fab.setAttribute('aria-expanded', String(v));
  };
  fab.addEventListener('click', function () { open(!document.body.classList.contains('toc-open')); });
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
})();
`;

/**
 * Cała strona (jedna długa, wycentrowana).
 * @param {import('./content/_schema.mjs').Feature[]} features
 * @returns {string}
 */
const buildPage = (features) => {
  // Kolejność w kategorii: po `order` rosnąco (brak = na koniec), potem po nazwie.
  const byOrder = (a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name, 'pl');
  const groups = CATEGORIES.map((cat) => ({
    cat,
    items: features.filter((f) => f.category === cat.id).sort(byOrder),
  })).filter((g) => g.items.length > 0);

  const sections = groups
    .map(
      ({ cat, items }) => `<section class="cat-block" id="cat-${esc(cat.id)}">
      <h2>${esc(cat.name)}</h2>
      <p class="cat-blurb">${inline(cat.blurb)}</p>
      ${items.map(featureBlock).join('\n')}
    </section>`,
    )
    .join('\n');

  const total = features.length;
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OG-E — jak działa każda funkcja</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header class="site-hdr">
  <span class="brand">OG-E · Dokumentacja</span>
  <span class="brand-sub">funkcje, działanie, fair-play</span>
</header>

<button class="toc-fab" id="tocFab" aria-controls="toc" aria-expanded="false">Funkcje</button>
<div class="toc-scrim" aria-hidden="true"></div>

<div class="layout">
  ${tocNav(groups)}
  <main>
    <section class="hero">
      <h1>OG-E (OGame Expeditions)</h1>
      <p class="lead">OG-E to <strong>wyłącznie nakładka na interfejs</strong> — nie automatyzuje gry, nie jest botem, nie monitoruje Twojej floty i nie powiadomi Cię, kiedy jesteś atakowany.</p>
      <p class="statement">Nie wysyła też żadnych żądań do serwera gry. Każde kliknięcie pozostaje <strong>świadomym kliknięciem gracza</strong>, a OG-E jest jedynie pośrednikiem: naciska natywny element interfejsu gry — nawet jeśli sam go ukrył i zastąpił własnym, czytelniejszym. OG-E nie tworzy ani nie modyfikuje żądań gry; jedynie <strong>zapisuje i analizuje odpowiedzi</strong>, które gra zwraca, oraz odczytuje to, co i tak jest wyświetlone na stronie.</p>
      <p class="statement">Projekt jest <strong>w pełni open source</strong> i w całości wygenerowany przez AI.</p>
      <p class="meta">Poniżej każda funkcja opisana jedna pod drugą: co robi, jak działa, jaką buduje przewagę i dlaczego jest fair. Opisanych funkcji: <strong>${total}</strong>. Praca w toku — kolejne dochodzą.</p>
    </section>
    ${sections}
  </main>
</div>

<footer class="site-foot">
  <p>Dokumentacja OG-E. Wewnętrzna analiza fair-play mieszkania w repozytorium (<code>docs/fair-play.md</code>); tu prezentujemy argumenty za każdą funkcją.</p>
</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
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

const main = async () => {
  // 1. Wczytaj + zwaliduj całą treść.
  const files = (await readdir(CONTENT_DIR)).filter((n) => n.endsWith('.mjs') && !n.startsWith('_'));
  /** @type {import('./content/_schema.mjs').Feature[]} */
  const features = [];
  /** @type {string[]} */
  const allErrors = [];

  for (const file of files.sort()) {
    const slug = file.replace(/\.mjs$/, '');
    const mod = await import(pathToFileURL(join(CONTENT_DIR, file)).href);
    const f = mod.default;
    const errs = validateFeature(f, slug, CATEGORY_IDS);
    if (errs.length) {
      allErrors.push(`✗ ${file}:`);
      errs.forEach((e) => allErrors.push(`    - ${e}`));
    } else {
      features.push(f);
    }
  }

  if (allErrors.length) {
    console.error('Walidacja treści nie powiodła się:\n' + allErrors.join('\n'));
    process.exit(1);
  }

  // 2. Wyczyść i odbuduj dist.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, 'index.html'), buildPage(features), 'utf8');
  await copyDir(ASSETS_DIR, join(DIST, 'assets'));

  const drafted = features.filter((f) => f.status === 'drafted').length;
  const verified = features.filter((f) => f.status === 'verified').length;
  console.log(`OK — ${features.length} funkcji (${verified} verified, ${drafted} drafted) → site/dist/index.html`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
