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

/**
 * Zip the CONTENTS of `srcDir` (not the directory itself — AMO rejects an
 * archive whose manifest.json is nested) into `zipPath`. Throws on failure;
 * the caller owns any staging cleanup + exit code.
 *
 * @param {string} srcDir   Absolute path whose contents become the archive root.
 * @param {string} zipPath  Absolute output `.zip` path (should not already exist).
 * @returns {void}
 */
export function zipDir(srcDir, zipPath) {
  if (process.platform === 'win32') {
    execSync(`"C:\\Windows\\System32\\tar.exe" -a -c -f "${zipPath}" -C "${srcDir}" .`, {
      stdio: 'inherit',
    });
  } else {
    execSync(`zip -r "${zipPath}" .`, { cwd: srcDir, stdio: 'inherit' });
  }
}
