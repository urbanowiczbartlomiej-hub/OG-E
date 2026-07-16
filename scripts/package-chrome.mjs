// Manual Chrome Web Store packaging step — the local/break-glass twin of the
// automated CWS upload in scripts/release.mjs (which CI runs on every release).
//
// Builds a Chrome-flavoured zip via {@link buildChromeZip}: the same dist/ that
// AMO gets, but with the Firefox-only `browser_specific_settings` stripped from
// the manifest (the CWS upload API can reject that unknown key). The artifact is
// named `og-e-chrome-<version>.zip` so the hand-off file is unambiguous (vs.
// AMO's generic `dist.zip`).
//
// Use this when you want the zip in hand (e.g. to upload by hand, or without
// CWS creds). The normal path is the automated CWS upload during `npm run
// release` / the CI release job.
//
// Usage:
//   npm run package:chrome
// which runs `build:prod` first, then this script.

import { existsSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildChromeZip } from './chromeZip.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const RELEASE = resolve(ROOT, 'release');

if (!existsSync(DIST) || readdirSync(DIST).length === 0) {
  console.error('package:chrome: dist/ missing or empty. Run `npm run build:prod` first.');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
// Output into the gitignored `release/` subfolder, never the repo root.
const ZIP = resolve(RELEASE, `og-e-chrome-${version}.zip`);

if (existsSync(ZIP)) {
  rmSync(ZIP);
  console.log(`package:chrome: removed stale ${ZIP}`);
}

try {
  mkdirSync(RELEASE, { recursive: true });
  buildChromeZip(DIST, ZIP);
} catch (err) {
  console.error('package:chrome: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(`package:chrome: wrote ${ZIP}`);
console.log('package:chrome: upload this file in the Chrome Web Store dashboard.');
