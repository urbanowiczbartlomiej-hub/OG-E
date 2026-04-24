// Post-build step: copy non-JS artefacts into dist/ so the entire
// folder can be loaded as a temporary add-on straight from disk.
//
//   manifest.json       → dist/manifest.json
//   src/histogram.html  → dist/histogram.html
//   icons/icon{16,48,128}.png → dist/icons/…
//
// One unified manifest.json serves both Chrome and Firefox. Firefox
// reads `browser_specific_settings.gecko` for its id +
// `strict_min_version`; Chrome ignores unknown fields.
//
// Dev flow: point Firefox at `dist/manifest.json` as a temporary
// add-on (`about:debugging`) and reload after each `npm run build`.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

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

console.log('copy-static: populating dist/ ...');
mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
copy('manifest.json', 'dist/manifest.json');
copy('src/histogram.html', 'dist/histogram.html');
// Only the three sizes the manifest references. The 500×500
// `icon.png` master stays in the repo as source material but never
// ships — it's an 87 KB asset that the browser never resolves.
copy('icons/icon16.png', 'dist/icons/icon16.png');
copy('icons/icon48.png', 'dist/icons/icon48.png');
copy('icons/icon128.png', 'dist/icons/icon128.png');
console.log('copy-static: done.');
