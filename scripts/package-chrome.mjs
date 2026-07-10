// Manual Chrome Web Store packaging step.
//
// The shipped manifest.json is already cross-browser: Chrome silently
// ignores `browser_specific_settings.gecko` (Firefox-only), so the SAME
// dist/ that AMO gets is a valid Chrome upload. The only difference here
// is cosmetic — we name the artifact `og-e-chrome-<version>.zip` so the
// hand-off file is unambiguous (vs. AMO's generic `dist.zip`).
//
// This is a deliberately MANUAL step (no CI wiring yet): run it, then
// upload the resulting zip by hand in the Chrome Web Store dashboard.
//
// Usage:
//   npm run package:chrome
// which runs `build:prod` first, then this script.

import { existsSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipDir } from './zip.mjs';

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
  zipDir(DIST, ZIP);
} catch (err) {
  console.error('package:chrome: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(`package:chrome: wrote ${ZIP}`);
console.log('package:chrome: upload this file in the Chrome Web Store dashboard.');
