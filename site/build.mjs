// @ts-check

// Generator statycznej dokumentacji OG-E.
//
//   node site/build.mjs            → renderuje do site/dist/
//
// Czyta wszystkie content/<slug>.mjs (poza plikami _*.mjs), waliduje je
// kontraktem z content/_schema.mjs i renderuje:
//   dist/index.html                — strona główna: intro + sekcje kategorii z kartami
//   dist/features/<slug>.html      — strona jednego feature'a
//   dist/assets/style.css          — skopiowany arkusz stylów
//
// ZERO zależności (czysty Node ≥22). Build PRZERYWA (exit 1) przy błędzie
// walidacji — to nasz test spójności treści. `dist/` jest gitignorowane.

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
 * Kolejność: najpierw escape, potem podmiana znaczników na tagi.
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
 * Zrzut ekranu: realny <img> jeśli plik istnieje, inaczej placeholder.
 * Konwencja pliku: assets/shots/<slug>--<shotId>.png
 * @param {string} slug
 * @param {{id: string, caption: string}} shot
 * @returns {string}
 */
const shotFigure = (slug, shot, prefix) => {
  const file = `${slug}--${shot.id}.png`;
  const real = existsSync(join(SHOTS_DIR, file));
  const media = real
    ? `<img src="${prefix}assets/shots/${esc(file)}" alt="${esc(shot.caption)}" loading="lazy">`
    : `<div class="shot-ph"><span class="shot-ph-tag">screenshot: ${esc(shot.id)}</span></div>`;
  return `<figure class="shot${real ? '' : ' is-ph'}">${media}<figcaption>${inline(shot.caption)}</figcaption></figure>`;
};

/**
 * Wspólny szkielet strony.
 * @param {{title: string, prefix: string, body: string}} o
 * @returns {string}
 */
const page = ({ title, prefix, body }) => `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${prefix}assets/style.css">
</head>
<body>
<header class="site-hdr">
  <a class="brand" href="${prefix}index.html">OG-E · Dokumentacja</a>
  <span class="brand-sub">funkcje, działanie, fair-play</span>
</header>
<main>
${body}
</main>
<footer class="site-foot">
  <p>Dokumentacja OG-E. Klasyfikacja fair-play pochodzi z kanonicznego <code>docs/fair-play.md</code> w repozytorium.</p>
</footer>
</body>
</html>`;

/**
 * Strona jednego feature'a.
 * @param {import('./content/_schema.mjs').Feature} f
 * @returns {string}
 */
const featurePage = (f) => {
  const cat = CATEGORIES.find((c) => c.id === f.category);
  const prefix = '../';
  const body = `
<article class="feature">
  <nav class="crumbs"><a href="${prefix}index.html">Start</a> › <span>${esc(cat?.name ?? f.category)}</span></nav>
  <h1>${esc(f.name)}${f.flagship ? ' <span class="flag-tag">flagowa</span>' : ''}</h1>
  <p class="lead">${inline(f.oneLiner)}</p>

  <section><h2>Gdzie to znajdziesz</h2>${paras(f.where)}</section>

  <section class="shots">
    <h2>Zrzuty ekranu</h2>
    ${f.screenshots.map((s) => shotFigure(f.id, s, prefix)).join('\n')}
  </section>

  <section><h2>Jak działa</h2>${paras(f.how)}</section>
  <section><h2>Cel</h2>${paras(f.purpose)}</section>
  <section><h2>Budowana przewaga</h2>${paras(f.advantage)}</section>

  <section class="fairplay${f.fairplay.borderline ? ' is-borderline' : ''}">
    <h2>Fair-play</h2>
    ${f.fairplay.borderline ? '<p class="fp-note"><strong>Uczciwie: to funkcja graniczna.</strong> Traktujemy ją ostrożnie i mówimy o tym wprost — poniżej, dlaczego mimo to uznajemy ją za obronną.</p>' : ''}
    ${paras(f.fairplay.summary)}
  </section>

  ${f.settings ? `<section><h2>Powiązane ustawienia</h2>${list(f.settings)}</section>` : ''}
</article>`;
  return page({ title: `${f.name} — OG-E`, prefix, body });
};

/**
 * Strona główna: intro + sekcje kategorii z kartami feature'ów.
 * @param {import('./content/_schema.mjs').Feature[]} features
 * @returns {string}
 */
const indexPage = (features) => {
  const sections = CATEGORIES.map((cat) => {
    const items = features.filter((f) => f.category === cat.id);
    if (items.length === 0) return '';
    const cards = items
      .map(
        (f) => `<a class="card${f.flagship ? ' is-flagship' : ''}" href="features/${esc(f.id)}.html">
        <span class="card-name">${esc(f.name)}${f.flagship ? ' <span class="flag-tag">flagowa</span>' : ''}</span>
        <span class="card-one">${inline(f.oneLiner)}</span>
      </a>`,
      )
      .join('\n');
    return `<section class="cat">
      <h2>${esc(cat.name)}</h2>
      <p class="cat-blurb">${inline(cat.blurb)}</p>
      <div class="cards">${cards}</div>
    </section>`;
  }).join('\n');

  const total = features.length;
  const body = `
<section class="hero">
  <h1>Jak działa OG-E</h1>
  <p class="lead">Dokumentacja każdej funkcji rozszerzenia: co robi, jak działa, jaką buduje przewagę i jak trzyma się zasad fair-play OGame.</p>
  <p class="meta">Opisanych funkcji: <strong>${total}</strong>. Praca w toku — kolejne dochodzą.</p>
</section>
${sections}`;
  return page({ title: 'OG-E — dokumentacja funkcji', prefix: '', body });
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
  await mkdir(join(DIST, 'features'), { recursive: true });

  await writeFile(join(DIST, 'index.html'), indexPage(features), 'utf8');
  for (const f of features) {
    await writeFile(join(DIST, 'features', `${f.id}.html`), featurePage(f), 'utf8');
  }
  await copyDir(ASSETS_DIR, join(DIST, 'assets'));

  const drafted = features.filter((f) => f.status === 'drafted').length;
  const verified = features.filter((f) => f.status === 'verified').length;
  console.log(
    `OK — ${features.length} funkcji (${verified} verified, ${drafted} drafted) → site/dist/`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
