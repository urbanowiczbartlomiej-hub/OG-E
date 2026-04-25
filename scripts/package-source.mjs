// Builds source.zip for AMO source-code review. AMO requires the
// source archive when the shipped bundle is minified — reviewers must
// be able to reproduce dist/ via:
//
//   npm install
//   npm run build:prod
//
// Includes everything needed for that build (and the docs the reviewer
// will read), excludes node_modules/, dist/, dist.zip, .claude/, .git/,
// and test/. Uses PowerShell's Compress-Archive on Windows and `zip`
// elsewhere — same pattern as scripts/package.mjs.

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const ZIP = resolve(ROOT, 'source.zip');

const INCLUDE = [
  'src',
  'scripts',
  'icons',
  'manifest.json',
  'package.json',
  'package-lock.json',
  'rollup.config.mjs',
  'tsconfig.json',
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'PRIVACY.md',
  'LICENSE',
];

const present = INCLUDE.filter((p) => existsSync(resolve(ROOT, p)));
const missing = INCLUDE.filter((p) => !existsSync(resolve(ROOT, p)));
if (missing.length) {
  console.warn('package-source: skipping missing entries:', missing.join(', '));
}

if (existsSync(ZIP)) {
  rmSync(ZIP);
  console.log('package-source: removed stale source.zip');
}

const isWindows = process.platform === 'win32';

try {
  if (isWindows) {
    const paths = present
      .map((entry) => `"${resolve(ROOT, entry)}"`)
      .join(',');
    const cmd = `Compress-Archive -Path ${paths} -DestinationPath "${ZIP}" -Force`;
    execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, {
      stdio: 'inherit',
    });
  } else {
    const list = present.map((p) => `"${p}"`).join(' ');
    execSync(`cd "${ROOT}" && zip -r "${ZIP}" ${list}`, { stdio: 'inherit' });
  }
} catch (err) {
  console.error('package-source: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(`package-source: wrote ${ZIP}`);
