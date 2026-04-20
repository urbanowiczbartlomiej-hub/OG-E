// Post-build step: copy non-JS artefacts into dist/ so the entire folder can
// be loaded as a temporary add-on straight from disk.
//
//   manifest.json          → dist/manifest.json           (Chrome)
//   manifest.firefox.json  → dist/manifest.firefox.json   (Firefox)
//   src/histogram.html     → dist/histogram.html
//   icons/*.png            → dist/icons/*.png             (if any)
//
// During dev the user points FF at dist/manifest.firefox.json as a temporary
// add-on and reloads after each `npm run build` (or `npm run dev` on watch).

import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** @param {string} src  @param {string} dest */
const copy = (src, dest) => {
  const absSrc = resolve(ROOT, src);
  const absDest = resolve(ROOT, dest);
  if (!existsSync(absSrc)) return;
  mkdirSync(dirname(absDest), { recursive: true });
  copyFileSync(absSrc, absDest);
  console.log('  copied', src, '→', dest);
};

/** Recursively mirror a directory. Safe no-op if source missing. */
const copyDir = (srcDir, destDir) => {
  const absSrc = resolve(ROOT, srcDir);
  if (!existsSync(absSrc)) return;
  const entries = readdirSync(absSrc);
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    const destPath = join(destDir, name);
    const absEntry = resolve(ROOT, srcPath);
    if (statSync(absEntry).isDirectory()) copyDir(srcPath, destPath);
    else copy(srcPath, destPath);
  }
};

console.log('copy-static: populating dist/ ...');
mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
copy('manifest.json', 'dist/manifest.json');
copy('manifest.firefox.json', 'dist/manifest.firefox.json');
copy('src/histogram.html', 'dist/histogram.html');
copyDir('icons', 'dist/icons');
console.log('copy-static: done.');
