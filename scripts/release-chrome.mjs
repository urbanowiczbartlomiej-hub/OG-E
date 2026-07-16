// Local Chrome-only publish / test helper — build the Chrome zip and upload it
// to the Chrome Web Store (submitting for publication by default), using the
// CWS_* creds from the env (`npm run release:chrome` auto-loads .env).
//
// This is the ISOLATED Chrome path: no git, no AMO, no version bump. The full
// release (scripts/release.mjs phase 6b) does the same CWS upload automatically
// on a `chore(release)` push; use THIS to test the CWS credentials/pipeline, or
// to (re)publish only the Chrome build by hand. It reuses the very same
// buildChromeZip + uploadToCws the automated path does, so a green run here
// proves the automated path too.
//
// Usage:
//   npm run release:chrome              # build, upload, submit for publication
//   npm run release:chrome -- --draft   # build, upload as a DRAFT (no publish)
//
// Requires CWS_EXTENSION_ID / CWS_CLIENT_ID / CWS_CLIENT_SECRET /
// CWS_REFRESH_TOKEN in .env (or the shell). See .env.example.

import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildChromeZip } from './chromeZip.mjs';
import { uploadToCws } from './cws.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const RELEASE = resolve(ROOT, 'release');

function die(msg) {
  console.error(`release:chrome: ${msg}`);
  process.exit(1);
}

const itemId = process.env.CWS_EXTENSION_ID;
const clientId = process.env.CWS_CLIENT_ID;
const clientSecret = process.env.CWS_CLIENT_SECRET;
const refreshToken = process.env.CWS_REFRESH_TOKEN;
if (!(itemId && clientId && clientSecret && refreshToken)) {
  die('missing CWS_* creds in the env — set them in .env (see .env.example).');
}

if (!existsSync(DIST) || !existsSync(resolve(DIST, 'manifest.json'))) {
  die('dist/ (or its manifest.json) is missing — run `npm run build:prod` first.');
}

const { version } = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const publish = !process.argv.includes('--draft');
const zip = resolve(RELEASE, `og-e-chrome-${version}.zip`);

if (existsSync(zip)) rmSync(zip);

try {
  mkdirSync(RELEASE, { recursive: true });
  buildChromeZip(DIST, zip);
  await uploadToCws({
    itemId,
    clientId,
    clientSecret,
    refreshToken,
    version,
    zip,
    publish,
    log: (m) => console.log(`release:chrome: ${m}`),
  });
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

console.log(
  `release:chrome: ${version} done` +
    (publish ? ' — uploaded + submitted to the Chrome Web Store.' : ' — uploaded as a draft (not published).'),
);
