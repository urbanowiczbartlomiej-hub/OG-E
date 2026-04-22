// Post-build step: copy non-JS artefacts into dist/ so the entire folder can
// be loaded as a temporary add-on straight from disk.
//
//   manifest.json       → dist/manifest.json       (shared Chrome + FF)
//   src/histogram.html  → dist/histogram.html
//   ../icons/*.png      → dist/icons/*.png         (shared with v4)
//
// Icons live in the parent repo's `icons/` directory (next to the v4 source).
// v5 doesn't ship its own icon set yet — see DESIGN.md §11. When v5 grows
// its own brand the source path here moves to `icons/` (local to v5.0.0/).
//
// One unified manifest.json serves both Chrome and Firefox. Firefox reads
// `browser_specific_settings.gecko` for its id + strict_min_version; Chrome
// ignores unknown fields. This avoids Firefox's temporary-add-on loader
// silently picking up `manifest.json` (which it always does, regardless of
// which file the user selects in about:debugging) when we were trying to
// use a separate `manifest.firefox.json`.
//
// During dev the user points FF at dist/manifest.json as a temporary
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
copy('src/histogram.html', 'dist/histogram.html');
copyDir('../icons', 'dist/icons');
console.log('copy-static: done.');
