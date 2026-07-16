// Chrome Web Store packaging helper — turn a built `dist/` into a Chrome zip.
//
// The shipped manifest.json is authored for Firefox/AMO and carries
// `browser_specific_settings` (gecko / gecko_android). Chrome ignores unknown
// keys at RUNTIME, but the Chrome Web Store UPLOAD API is stricter and can
// reject an unrecognised top-level key — and we now upload to it unattended
// from CI, so a silent "Chrome tolerates it" assumption is not good enough.
// The Chrome artifact therefore gets a manifest with that Firefox-only block
// removed. Everything else in dist/ is already cross-browser (MV3, content
// scripts incl. `world: "MAIN"`, web_accessible_resources, permissions).
//
// This MUTATES dist/manifest.json in place before zipping. That is safe: dist/
// is a disposable, gitignored build artifact, and the AMO archive (dist.zip)
// is always produced from the un-stripped manifest BEFORE this runs (see
// scripts/package.mjs and the phase ordering in scripts/release.mjs). A fresh
// `npm run build` restores the original manifest.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipDir } from './zip.mjs';

/**
 * Strip the Firefox-only manifest keys from a built dist/ and zip its contents
 * for the Chrome Web Store.
 *
 * @param {string} distDir  Absolute path to the built dist/ folder.
 * @param {string} zipPath  Absolute output .zip path (must not already exist).
 * @returns {void}
 */
export function buildChromeZip(distDir, zipPath) {
  const manifestPath = resolve(distDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.browser_specific_settings;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  zipDir(distDir, zipPath);
}
