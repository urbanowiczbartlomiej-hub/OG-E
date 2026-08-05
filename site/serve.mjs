// @ts-check

// Podgląd lokalny wygenerowanej strony (site/dist/).
//
//   node site/serve.mjs [port]      → http://localhost:4173/
//
// Przeglądarka nie ładuje tego layoutu z `file://` (ścieżki katalogowe,
// przełącznik języka), więc do weryfikacji potrzebny jest statyczny serwer.
// To najmniejszy możliwy — ZERO zależności, czysty Node ≥22, tylko GET,
// wyłącznie z `site/dist/`. Nie jest to serwer produkcyjny: publikacją
// zajmuje się GitHub Pages (patrz .github/workflows/pages.yml).

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const DIST = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

if (!existsSync(DIST)) {
  console.error('Brak site/dist/ — zbuduj najpierw: npm run site:build');
  process.exit(1);
}

createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  // normalize() + odrzucenie wyjścia z DIST — nawet lokalnie nie serwujemy
  // niczego spoza katalogu wynikowego.
  let file = join(DIST, normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`site/dist → http://localhost:${PORT}/   (EN: /en/)`);
});
