// Post-build step: zip the contents of `dist/` into `dist.zip` so the
// artifact can be uploaded directly to AMO / Chrome Web Store.
//
// Design choices:
//   - We do NOT vendor a JS zip library. Node's `zlib` only gzips
//     single streams; ZIP archives are a structured format. Rather
//     than pull in a dependency, we shell out to bsdtar (`tar.exe`)
//     on Windows and `zip` on POSIX. Both are stock on systems that
//     run a browser-extension dev environment.
//   - The zip contains the contents OF dist/, not the `dist/` folder
//     itself. AMO rejects archives whose manifest.json is nested.
//   - Existing dist.zip is deleted first — neither tar nor zip
//     overwrites silently in a portable way.
//
// Why NOT PowerShell's Compress-Archive on Windows:
//   It writes ZIP entries with backslash separators (`icons\icon16.png`)
//   instead of forward slashes. The ZIP spec mandates forward slashes;
//   AMO's validator rejects backslash entries with a hard error
//   ("invalid characters in filename"), forcing a manual repack on the
//   reviewer's side. Windows 10/11 ship bsdtar at C:\Windows\System32\
//   tar.exe — it produces spec-compliant archives (forward slashes,
//   no BOM, no extra metadata) and is what we shell out to instead.
//
//   Note: a `tar` on PATH may resolve to GNU tar from Git Bash, which
//   can't write zips. We invoke the system32 path explicitly to force
//   bsdtar regardless of PATH order.
//
// Run via `npm run package` after `npm run build:prod` has produced
// the minified bundle.

import { existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');
const ZIP = resolve(ROOT, 'dist.zip');

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

const isWindows = process.platform === 'win32';

try {
  if (isWindows) {
    // bsdtar from the system32 path. `--format=zip` selects the ZIP
    // container, `-C dist` enters the dist directory so stored paths
    // are relative to it (manifest.json at archive root, not
    // dist/manifest.json). The trailing entry list is each top-level
    // child of dist/ — bsdtar recurses into directories. Forward
    // slashes are produced regardless of host OS.
    const tarExe = 'C:\\Windows\\System32\\tar.exe';
    const list = distEntries.map((entry) => `"${entry}"`).join(' ');
    execSync(
      `"${tarExe}" --format=zip -cf "${ZIP}" -C "${DIST}" ${list}`,
      { stdio: 'inherit' },
    );
  } else {
    // Change into dist/ so zip stores relative paths (manifest.json at
    // archive root, not dist/manifest.json).
    execSync(`cd "${DIST}" && zip -r "${ZIP}" .`, { stdio: 'inherit' });
  }
} catch (err) {
  console.error('package: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(`package: wrote ${ZIP}`);
