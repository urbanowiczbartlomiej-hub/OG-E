# CLAUDE.md — instructions for the AI assistant

## Release checklist (now one command)

`npm run release X.Y.Z` runs the whole checklist (`scripts/release.mjs`):
validates the CHANGELOG, bumps `package.json` + `manifest.json`, runs
tests + typecheck, `npm run package`, commits, tags, uploads to AMO
(both note fields + `source.zip`), then `git push --tags`. It is
idempotent: a re-run after a failure resumes from where it stopped.

**You do exactly two things by hand before running it:**

1. Write a dated `## [X.Y.Z] — YYYY-MM-DD` section in `CHANGELOG.md`
   (move items from `[Unreleased]` if present). The script refuses to
   run without it, and sends that section verbatim as the public AMO
   release notes — so this section *is* the release notes.
2. Have `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` available (a gitignored
   `.env` is loaded automatically — see `.env.example`).

Then (note the `--` so npm forwards the flags to the script, rather
than treating `--dry-run` as its own flag):
```
npm run release -- 1.10.0 --dry-run   # preview: validate + show notes, mutate nothing
npm run release -- 1.10.0             # the real thing
```

The script enforces the two things that have been forgotten before:
it will not bump the version without a CHANGELOG entry, and it
hard-asserts `source.zip` exists before uploading. Git stays local
until AMO accepts the archive — a rejected upload never leaves a
pushed tag pointing at a non-existent release.

## AMO note fields (sent automatically by the script)

- **Notes to Reviewer** (internal) ← `amo-reviewer-notes.txt`, verbatim.
  Stable boilerplate; edit that file if build steps or permissions change:

  ```
  Build instructions are in REVIEWERS.md inside source.zip (Node >= 20):
    npm install
    npm run build:prod
  The resulting dist/ matches the uploaded extension exactly.

  No new permissions. No new network destinations.
  ```

- **Release notes** (public) ← the `## [X.Y.Z]` section of `CHANGELOG.md`,
  verbatim. No separate short-form list is maintained any more.

## General rules

- Patch bump (`1.0.x`) for bug fixes; minor (`1.x.0`) for new
  user-visible features; major (`x.0.0`) for breaking changes to
  stored data formats or required AGR version.
- `npm run test` must be green before any commit that touches `src/`.
- `npm run typecheck` must exit 0 before any commit.
- Follow Conventional Commits: `fix:` / `feat:` / `refactor:` /
  `chore:` / `test:` / `docs:`.
