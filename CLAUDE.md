# CLAUDE.md — instructions for the AI assistant

## Release checklist (non-negotiable order)

Every version bump **requires all four steps in the same commit**:

1. Add a `[X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md` with the
   changes being shipped. Move items from `[Unreleased]` if present.
2. Update `"version"` in both `package.json` and `manifest.json`.
3. Run `npm run package` — this produces **both** `dist.zip` and
   `source.zip`. Never produce a release without `source.zip`; AMO
   requires the source archive for every minified submission.
4. Commit, tag `vX.Y.Z`, push with `--tags`.
5. Upload `dist.zip` + `source.zip` to AMO. Fill in **both** fields:
   - **Notes to Reviewer** (internal) — build instructions + permissions note.
   - **Release notes** (public) — short one-liner bullets only, no details.
   See the templates below.

**Never bump the version without a CHANGELOG entry. Never upload to
AMO without `source.zip`.** These are the two things that have been
forgotten before.

## AMO submission — two separate fields

### "Notes to Reviewer" (internal, technical)

```
Build instructions are in REVIEWERS.md inside source.zip (Node ≥ 20):
  npm install
  npm run build:prod
The resulting dist/ matches the uploaded extension exactly.

No new permissions. No new network destinations.
```

### "Release notes" (public, shown to users)

Short one-liners only — no implementation detail. Full detail lives in
`CHANGELOG.md`. Template:

```
Changes in vX.Y.Z:
- <one short phrase per Added item>
- <one short phrase per Changed item>
- <one short phrase per Fixed item>
```

Example for v1.8.0:
```
Changes in v1.8.0:
- Ad-hoc fleet reminders from the event list
- Expedition waves cancellable/resendable inline
- ntfy topic decoupled from cloud-sync setup
- "Enable reminders" master switch in settings
- Dashboard: ad-hoc reminders view with cancel button
- Badge clicks now update immediately (no reload needed)
```

## General rules

- Patch bump (`1.0.x`) for bug fixes; minor (`1.x.0`) for new
  user-visible features; major (`x.0.0`) for breaking changes to
  stored data formats or required AGR version.
- `npm run test` must be green before any commit that touches `src/`.
- `npm run typecheck` must exit 0 before any commit.
- Follow Conventional Commits: `fix:` / `feat:` / `refactor:` /
  `chore:` / `test:` / `docs:`.
