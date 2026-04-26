# Build instructions for AMO / Chrome Web Store reviewers

OG-E ships a minified bundle. This archive is the unminified source
required by the AMO source-code-review policy. Reproducing the
uploaded `dist.zip` from this archive requires only Node.js.

## Environment

- Node.js **≥ 20** (any LTS line — tested on 20.x and 22.x)
- npm **≥ 10** (ships with Node 20+)
- No native toolchain. Pure JavaScript build.

## Steps

```bash
npm install
npm run build:prod
```

`build:prod` writes the production bundle to `dist/` (terser-minified,
`console.*` calls dropped). The contents of `dist/` are byte-for-byte
identical to the contents of the uploaded `dist.zip` — manifest.json
at the archive root, all assets in their declared paths.

To produce the zip exactly as uploaded:

```bash
npm run package
```

This writes `dist.zip` next to `dist/`. The script uses bsdtar
(`C:\Windows\System32\tar.exe`) on Windows and `zip` on POSIX —
both produce ZIP archives with forward-slash separators as required
by the ZIP spec and AMO's validator.

## Verifying the build

`npm run typecheck` runs `tsc --noEmit` against the JSDoc-as-types
sources. `npm run test` runs the vitest suite (~700 unit tests, all
synchronous, no network).

## What the source archive contains

- `src/` — every JavaScript module loaded by the manifest
- `scripts/` — build / package / clean utilities
- `icons/` — extension icons (16/48/128 px PNG)
- `manifest.json`, `package.json`, `package-lock.json`,
  `rollup.config.mjs`, `tsconfig.json` — build configuration
- `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `PRIVACY.md`,
  `LICENSE` — user / developer / privacy / licence docs

`node_modules/`, `dist/`, `dist.zip`, `.git/`, and the `test/`
directory are intentionally excluded — they are not needed to
reproduce the build and would inflate the archive significantly.

## Compliance summary

OG-E is a UI helper layered on top of OGame. The extension never
originates HTTP traffic to the game server: every request the user
sees in DevTools is initiated by OGame's own code in response to a
user click. The MAIN-world bridges (`src/bridges/*.js`) only observe
XHRs the game already fires; nowhere in the codebase does OG-E call
`fetch()` or `xhr.send()` for a game endpoint.

The only outbound traffic OG-E may issue is to `api.github.com`,
gated behind the user enabling cloud sync and pasting their own
GitHub personal-access token. The token is stored locally
(`localStorage`); OG-E has no servers and no telemetry.
See [`PRIVACY.md`](PRIVACY.md) for the full statement.
