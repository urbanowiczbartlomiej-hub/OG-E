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
sources. `npm run test` runs the vitest suite (~945 unit tests, all
synchronous, no network).

## What the source archive contains

- `src/` — every JavaScript module loaded by the manifest
- `scripts/` — build / package / clean utilities
- `icons/` — extension icons (16/48/128 px) plus the notification
  icons referenced by reminders, all PNG
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

OG-E issues outbound traffic to exactly two destinations, both
opt-in and both to a service the user controls:

- `api.github.com` — cross-device sync, gated behind the user enabling
  cloud sync and pasting their own GitHub personal-access token.
- `ntfy.sh` — fleet-landing reminders, gated behind the user enabling
  the reminders feature and pasting their own ntfy access token. OG-E
  POSTs scheduled notifications to a token-derived topic and never
  contacts any other ntfy endpoint.

Both tokens are stored locally (`localStorage`). OG-E runs no servers
of its own and ships no telemetry. See [`PRIVACY.md`](PRIVACY.md) for
the full statement.
