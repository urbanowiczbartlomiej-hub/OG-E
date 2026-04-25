// Builds source.zip for AMO source-code review. AMO requires the
// source archive when the shipped bundle is minified — reviewers must
// be able to reproduce dist/ via:
//
//   npm install
//   npm run build:prod
//
// Includes everything needed for that build (and the docs the reviewer
// will read), excludes node_modules/, dist/, dist.zip, .claude/, .git/,
// and test/.
//
// Implementation: stage the included entries into a temporary
// directory, then zip the directory with `tar -a` — picks the format
// from the extension (.zip → zip) and writes forward-slash entry
// paths on every platform, including Windows (where Compress-Archive
// and .NET Framework's ZipFile.CreateFromDirectory both write
// backslashes that AMO's validator rejects). `tar.exe` ships with
// Windows 10 1803+ (bsdtar/libarchive).

import { existsSync, rmSync, mkdtempSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
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

const STAGE = mkdtempSync(join(tmpdir(), 'oge-source-'));

try {
  for (const entry of present) {
    cpSync(resolve(ROOT, entry), join(STAGE, entry), { recursive: true });
  }

  execSync(`tar -a -c -f "${ZIP}" -C "${STAGE}" .`, { stdio: 'inherit' });
} catch (err) {
  console.error('package-source: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}

rmSync(STAGE, { recursive: true, force: true });
console.log(`package-source: wrote ${ZIP}`);
