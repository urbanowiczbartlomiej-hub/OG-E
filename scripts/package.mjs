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

// Windows 10 1803+ ships bsdtar (libarchive) as `tar.exe`. Both
// PowerShell's `Compress-Archive` and .NET Framework's
// `ZipFile.CreateFromDirectory` write backslashes in archive entry
// paths (the latter only fixed in .NET 7+, which Windows PowerShell
// 5.1 does not use). Backslash entry paths violate the ZIP spec and
// trip AMO's validator: `Invalid file name in archive: icons\…`.
// `tar -a` picks the format from the extension (.zip → zip) and
// writes forward-slash entries on every platform.
try {
  execSync(`tar -a -c -f "${ZIP}" -C "${DIST}" .`, { stdio: 'inherit' });
} catch (err) {
  console.error('package: archive command failed');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(`package: wrote ${ZIP}`);
