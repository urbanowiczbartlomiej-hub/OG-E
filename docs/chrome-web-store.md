# Chrome Web Store — manual release (interim)

This is the **manual** path for publishing OG-E to the Chrome Web Store.
There is no CI wiring for Chrome yet (unlike AMO/Firefox — see `CLAUDE.md`
for that automated flow). Run the steps below by hand each time.

## Why the same build works on both stores

`manifest.json` is a single cross-browser file. It is already
`manifest_version: 3`. The `browser_specific_settings.gecko` block is
Firefox-only and **Chrome silently ignores it**, so the exact `dist/` we
ship to AMO is a valid Chrome upload. No separate manifest is needed.

## Build the package

```
npm run package:chrome
```

This runs `build:prod` and writes `og-e-chrome-<version>.zip` to the repo
root (gitignored). That zip is the file you upload — its contents are the
files **inside** `dist/` (manifest.json at the archive root, no nested
folder), which is what the Chrome Web Store expects.

> Sanity gate before packaging (same as any commit): `npm run typecheck`
> and `npm run lint` should exit 0.

## Upload (hand-off)

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   (First-time only: register the developer account and pay the one-time fee.)
2. **Add new item** (or pick the existing OG-E item for an update) and
   upload `og-e-chrome-<version>.zip`.
3. Fill the store listing: description, screenshots, category, the single
   `storage` permission justification, and the host-permission
   justifications (`*.ogame.gameforge.com`, `api.github.com`, `ntfy.sh`).
   Privacy practices: data handling is described in `PRIVACY.md` — mirror
   it in the dashboard's privacy section.
4. Submit for review.

## Version bumps

Keep the Chrome version in lockstep with AMO: bump `package.json` **and**
`manifest.json` together (the AMO release flow in `CLAUDE.md` already does
this). Re-run `npm run package:chrome` after the bump so the zip filename
carries the new version.
