// Post-build step: zip the contents of `dist/` into `dist.zip` so the
// artifact can be uploaded directly to AMO / Chrome Web Store.
//
// Design choices:
//   - We do NOT recurse into a vendored zip library. Node's `zlib` only
//     gzips single streams; ZIP archives are a structured format.
//     Rather than pull in a dependency, we shell out to PowerShell's
//     `Compress-Archive` on Windows and `zip` on POSIX. Both are
//     present on every platform that has a stable home for browser
//     extension dev.
//   - The zip contains the contents OF dist/, not the `dist/` folder
//     itself. AMO rejects archives whose manifest.json is nested.
//   - Existing dist.zip is deleted first — Compress-Archive refuses to
//     overwrite silently.
//
// Run via `npm run package` after `npm run build:prod` has produced
// the minified bundle.

import { existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipDir } from './zip.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
// Zip artefacts live in a gitignored `release/` subfolder — never in the repo
// root — so `npm run package`/`release` cannot litter it.
const RELEASE = resolve(ROOT, 'release');
const ZIP = resolve(RELEASE, 'dist.zip');

if (!existsSync(DIST)) {
  console.error('package: dist/ does not exist. Run `npm run build:prod` first.');
  process.exit(1);
}

const distEntries = readdirSync(DIST);
if (distEntries.length === 0) {
  console.error('package: dist/ is empty. Run `npm run build:prod` first.');
  process.exit(1);
}

if (existsSync(ZIP)) {
  rmSync(ZIP);
  console.log('package: removed stale dist.zip');
}

try {
  mkdirSync(RELEASE, { recursive: true });
  zipDir(DIST, ZIP);
} catch (err) {
  console.error('package: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(`package: wrote ${ZIP}`);
