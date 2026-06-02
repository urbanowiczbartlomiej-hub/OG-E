# CLAUDE.md — instructions for the AI assistant

## Release checklist (now one command)

`npm run release X.Y.Z` runs the whole checklist (`scripts/release.mjs`):
validates the CHANGELOG, bumps `package.json` + `manifest.json`, runs
tests + typecheck, `npm run package`, commits, tags, uploads to AMO
(both note fields + `source.zip`), then `git push --tags`. It is
idempotent: a re-run after a failure resumes from where it stopped.

**You do these by hand before running it:**

1. **Commit the code + tests** for the release. The script requires a
   clean tree EXCEPT `CHANGELOG.md` / `package.json` / `manifest.json`
   (those are the release's own edits), so everything else must already
   be committed. Code/tests get their own descriptive `fix:`/`feat:`
   commit; the release commit stays just CHANGELOG + version bump.
2. Write a dated `## [X.Y.Z] — YYYY-MM-DD` section in `CHANGELOG.md`
   (move items from `[Unreleased]` if present) and **leave it
   uncommitted** — the script commits it together with the version bump
   into the single `chore(release): X.Y.Z` commit the tag points at. The
   script refuses to run without the section, and sends it verbatim as
   the public AMO release notes — so this section *is* the release notes.
3. Have `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` available (a gitignored
   `.env` is loaded automatically — see `.env.example`).

The real release (the `--` forwards the version to the script):
```
npm run release -- 1.10.0
```

**To PREVIEW, do NOT pass a `--flag` through npm.** This npm swallows
every `--flag` as its own config even after `--` (you'll see "Unknown env
config …"), so `npm run release -- 1.10.0 --preview` / `--dry-run` reaches
the script with NO flag and performs a REAL release. This already bit us —
a "dry-run" published 1.9.1. Preview one of these two ways instead:
```
# robust: run the script directly so the flag actually arrives
node --env-file-if-exists=.env scripts/release.mjs 1.10.0 --preview

# or via npm using the env escape hatch (PowerShell shown)
$env:RELEASE_PREVIEW=1; npm run release -- 1.10.0; Remove-Item Env:RELEASE_PREVIEW
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

  Permissions: storage. Host permissions: *.ogame.gameforge.com (content
  scripts), api.github.com (opt-in gist sync), ntfy.sh (opt-in fleet-landing
  reminders). All outbound traffic is user-initiated and goes only to those
  hosts; no telemetry, no analytics. See PRIVACY.md in source.zip for detail.
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

## Context hygiene (read this every session)

This repo is large (`src/` ~830 KB, `test/` ~600 KB, single files up to
~1100 lines) and OGame HTML dumps the user pastes are huge. A naive
session burns hundreds of thousands of tokens. Keep context lean:

- **Read narrowly.** Prefer `Grep`/`Glob` to locate, then `Read` with
  `offset`/`limit` for just the relevant span. Don't slurp whole large
  files when you need one function. Never read a file already pasted into
  the conversation.
- **Don't read tests you aren't changing.** To copy a harness pattern
  (e.g. the fake-XHR helper), open ONE example with a tight `limit`, not
  every test file.
- **Truncate every command's output.** Pipe through
  `Select-String`/`Select-Object -Last N`; never dump full `npm test` /
  `npm run build` / `tsc` logs — capture the summary line only (e.g.
  `Select-String "Test Files|Tests |FAIL"`).
- **Delegate broad search to an agent, ask for conclusions.** When using
  the Explore/general agent, instruct it to return file:line pointers and
  a short verdict — not large code excerpts.
- **Never echo back the user's pasted HTML.** Extract the few selectors /
  IDs / values you need and reference those; quoting the blob doubles its
  cost.
- `dist/` is gitignored — building never dirties the tree, so a build for
  manual testing is free of release-process side effects.
