// Builds source.zip for AMO source-code review. AMO requires the
// source archive when the shipped bundle is minified — reviewers must
// be able to reproduce dist/ via:
//
//   npm install
//   npm run build:prod
//
// Includes everything needed for that build, the docs the reviewer
// will read, and REVIEWERS.md (a dedicated build-and-verify guide).
// Excludes node_modules/, dist/, dist.zip, .claude/, .git/, and
// test/. Same Windows/POSIX zip strategy as scripts/package.mjs —
// bsdtar on Windows so stored paths use forward slashes (AMO's
// validator rejects PowerShell Compress-Archive output, which uses
// backslashes).

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
  'REVIEWERS.md',
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
    // bsdtar from system32 — see scripts/package.mjs header for why we
    // skip PowerShell's Compress-Archive (it writes backslashes that
    // AMO's validator rejects).
    const tarExe = 'C:\\Windows\\System32\\tar.exe';
    const list = present.map((entry) => `"${entry}"`).join(' ');
    execSync(
      `"${tarExe}" --format=zip -cf "${ZIP}" -C "${ROOT}" ${list}`,
      { stdio: 'inherit' },
    );
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
