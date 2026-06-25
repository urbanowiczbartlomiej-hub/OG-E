// Shared archive helper for the two packaging scripts (package.mjs /
// package-source.mjs).
//
// Why not a zip library: Node's `zlib` only gzips single streams; a ZIP is a
// structured format. Rather than add a dependency we shell out to bsdtar
// (`tar.exe`, shipped with Windows 10 1803+) / the POSIX `zip` CLI. Both write
// forward-slash entry paths — Windows' Compress-Archive and .NET's
// ZipFile.CreateFromDirectory both emit BACKSLASHES, which AMO's validator
// rejects. bsdtar's `-a` picks the zip format from the `.zip` extension; GNU
// tar (Linux/macOS) does NOT support zip via `-a`, hence `zip` there.

import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

/**
 * Zip the CONTENTS of `srcDir` (not the directory itself — AMO rejects an
 * archive whose manifest.json is nested) into `zipPath`. Throws on failure;
 * the caller owns any staging cleanup + exit code.
 *
 * We pass the top-level entries explicitly rather than `.`: handing tar a
 * literal `.` makes it emit `./`-prefixed entry names (and a `./` root
 * entry), which Windows Explorer renders as an EMPTY archive even though the
 * files are present. Naming the entries directly drops the prefix while still
 * writing forward-slash paths (the reason we use tar over Compress-Archive).
 *
 * @param {string} srcDir   Absolute path whose contents become the archive root.
 * @param {string} zipPath  Absolute output `.zip` path (should not already exist).
 * @returns {void}
 */
export function zipDir(srcDir, zipPath) {
  const entries = readdirSync(srcDir);
  if (process.platform === 'win32') {
    const list = entries.map((e) => `"${e}"`).join(' ');
    execSync(`"C:\\Windows\\System32\\tar.exe" -a -c -f "${zipPath}" -C "${srcDir}" ${list}`, {
      stdio: 'inherit',
    });
  } else {
    const list = entries.map((e) => `"${e}"`).join(' ');
    execSync(`zip -r "${zipPath}" ${list}`, { cwd: srcDir, stdio: 'inherit' });
  }
}
